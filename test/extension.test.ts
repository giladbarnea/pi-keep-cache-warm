import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { CACHE_WARMING_MAX_IDLE_AGE_MS, getCacheWarmingDelayMs } from "@earendil-works/pi-ai";
import keepCacheWarm from "../index.ts";

const MINUTE = 60_000;

/** An Anthropic-style model with a 5-minute cache tier and replayable (adaptive) thinking. */
const model = {
  provider: "anthropic",
  id: "test-model",
  api: "anthropic-messages",
  reasoning: true,
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  promptCache: { short: 300, long: 3600 },
  compat: { forceAdaptiveThinking: true },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

/** Loads the extension against a fake Pi and drives one real request, a tool call, and the settle. */
function harness(prefixTokens: number, warmRead = prefixTokens) {
  const handlers = new Map<string, Function>();
  const entries: { customType: string; data: any }[] = [];
  const warms: unknown[] = [];
  let tool: any;
  const pi: any = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerTool: (definition: any) => (tool = definition),
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    sendMessage: (message: any) => entries.push({ customType: "message", data: message }),
    getSettings: () => ({}),
  };
  const ctx: any = {
    model,
    thinkingLevel: "low",
    ui: { setStatus() {} },
    sessionManager: { getBranch: () => [], getSessionId: () => "session" },
    modelRegistry: {
      streamSimple: (_model: unknown, _context: unknown, options: any) => {
        warms.push(options.onPayload());
        const usage = { input: 2, output: 1, cacheRead: warmRead, cacheWrite: prefixTokens - warmRead, cost: { total: 0.001 } };
        return { result: async () => ({ stopReason: "stop", provider: "anthropic", model: model.id, usage }) };
      },
    },
  };
  keepCacheWarm(pi);
  const realRequest = () => {
    handlers.get("before_provider_request")!({ payload: { model: model.id, max_tokens: 128_000 } }, ctx);
    handlers.get("message_end")!({ message: { role: "assistant", usage: { cacheRead: 0, cacheWrite: prefixTokens } } }, ctx);
  };
  return {
    entries,
    warms,
    async arm(minutes: number) {
      realRequest();
      const result = await tool.execute("call", { minutes }, undefined, undefined, ctx);
      realRequest();
      handlers.get("agent_settled")!({ aborted: false }, ctx);
      return result;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function advance(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 1_000) {
    mock.timers.tick(1_000);
    await flush();
  }
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
afterEach(() => mock.timers.reset());

test("Pi's cache-warming contract this extension builds on", () => {
  assert.equal(CACHE_WARMING_MAX_IDLE_AGE_MS, 30 * MINUTE);
  assert.equal(getCacheWarmingDelayMs(300_000), 270_000);
});

test("minutes means warm until N minutes from now", async () => {
  const result = await harness(3_000).arm(40);
  assert.match(result.content[0].text, /^Keeping the cache warm until 40 min from now/);
  assert.equal(result.details.grantedMinutes, 40);
});

test("cap is about 55 minutes when Pi will not warm this context", async () => {
  const result = await harness(3_000).arm(120);
  assert.equal(result.details.piWillWarm, false);
  assert.equal(result.details.grantedMinutes, 54);
  assert.match(result.content[0].text, /until 54 min from now .*, not 120: past that, a cold restart is cheaper/);
});

test("cap is about 81 minutes when Pi warms its idle 30 minutes", async () => {
  const result = await harness(200_000).arm(120);
  assert.equal(result.details.piWillWarm, true);
  assert.equal(result.details.grantedMinutes, 81);
});

test("Pi will not warm: first own warm one slot after the request, replaying the payload with max_tokens 1", async () => {
  const run = harness(3_000);
  await run.arm(40);
  await advance(279_000);
  assert.equal(run.warms.length, 0);
  await advance(2_000);
  assert.deepEqual(run.warms, [{ model: model.id, max_tokens: 1 }]);
});

test("Pi will warm, its refreshes in flight and not yet recorded: no own warm before Pi's 30-minute horizon", async () => {
  const run = harness(200_000);
  await run.arm(60);
  await advance(30 * MINUTE - 1_000);
  assert.equal(run.warms.length, 0);
  await advance(2 * MINUTE);
  assert.equal(run.warms.length, 1);
});

test("a warm that does not read the whole prefix stops warming and says so", async () => {
  const run = harness(3_000, 1_651);
  await run.arm(40);
  await advance(281_000);
  assert.equal(run.warms.length, 1);
  const stop = run.entries.find((entry) => entry.data.kind === "stop");
  assert.equal(stop?.data.reason, "guard");
  const message = run.entries.find((entry) => entry.customType === "message");
  assert.match(message?.data.content, /did not read the prefix from the cache: read 1651 of 3000 tokens, wrote 1349/);
  await advance(10 * MINUTE);
  assert.equal(run.warms.length, 1);
});
