import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import keepCacheWarm from "../index.ts";

const MINUTE = 60_000;
const TOKENS_PER_MESSAGE = 1_000;
const TTL_MS = 300_000;

/** What the simulated provider answers to the next real request. */
type Reply = { text: string } | { tool: string; arguments: Record<string, number> } | { error: string } | "hang";

type ProviderRequest = { at: number; payload: { max_tokens: number; messages: string[] }; outcome: string };

/**
 * A provider that implements Pi's custom streaming contract: it builds a payload, passes it through `onPayload`,
 * and caches each successful request's message prefix for 5 minutes after completion. Real requests take the next
 * scripted reply; one-token replays (cache warms) read the cache.
 */
function simulatedProvider(replies: Reply[], requests: ProviderRequest[]) {
  const cache = new Map<string, number>();
  const usageFor = (messages: string[], cacheRead: number) => ({
    input: 1,
    output: 1,
    cacheRead,
    cacheWrite: messages.length * TOKENS_PER_MESSAGE - cacheRead,
    totalTokens: messages.length * TOKENS_PER_MESSAGE + 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  });
  const cachedPrefixTokens = (messages: string[]) => {
    let read = 0;
    for (let length = 1; length <= messages.length; length += 1) {
      const expiresAt = cache.get(JSON.stringify(messages.slice(0, length)));
      if (expiresAt !== undefined && expiresAt >= Date.now()) read = length * TOKENS_PER_MESSAGE;
    }
    return read;
  };
  return (pi: ExtensionAPI) => {
    pi.registerProvider("sim", {
      baseUrl: "http://simulated.invalid",
      apiKey: "simulated",
      api: "sim-messages",
      models: [
        {
          id: "sim-model",
          name: "Simulated",
          reasoning: false,
          input: ["text"],
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          promptCache: { short: TTL_MS / 1000 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        },
      ],
      streamSimple(model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          const built = {
            model: model.id,
            max_tokens: options?.maxTokens ?? model.maxTokens,
            messages: context.messages.map((message) => JSON.stringify(message.content)),
          };
          const payload = ((await options?.onPayload?.(built, model)) ?? built) as ProviderRequest["payload"];
          const request: ProviderRequest = { at: Date.now(), payload, outcome: "" };
          requests.push(request);
          const message: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: usageFor([], 0),
            stopReason: "stop",
            timestamp: Date.now(),
          };
          const finish = (reason: "error" | "aborted", errorMessage: string) => {
            request.outcome = reason;
            stream.push({ type: "error", reason, error: { ...message, stopReason: reason, errorMessage } });
          };
          if (payload.max_tokens === 1) {
            request.outcome = "warm";
            message.usage = usageFor(payload.messages, cachedPrefixTokens(payload.messages));
          } else {
            const reply = replies.shift();
            if (reply === undefined) throw new Error("no scripted reply left");
            if (reply === "hang") {
              stream.push({ type: "start", partial: message });
              const signal = options!.signal!;
              return signal.addEventListener("abort", () => finish("aborted", "Request was aborted"), { once: true });
            }
            if ("error" in reply) return finish("error", reply.error);
            request.outcome = "tool" in reply ? `tool ${reply.tool}` : "text";
            message.usage = usageFor(payload.messages, cachedPrefixTokens(payload.messages));
            message.content =
              "tool" in reply
                ? [{ type: "toolCall", id: `call-${requests.length}`, name: reply.tool, arguments: reply.arguments }]
                : [{ type: "text", text: reply.text }];
            message.stopReason = "tool" in reply ? "toolUse" : "stop";
          }
          cache.set(JSON.stringify(payload.messages), Date.now() + TTL_MS);
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        })();
        return stream;
      },
    });
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function advance(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 1_000) {
    mock.timers.tick(1_000);
    await flush();
  }
}

/** Advance mocked time until `promise` settles, as Pi's retry backoff runs on timers. */
async function until(promise: Promise<unknown>) {
  let settled = false;
  void promise.finally(() => (settled = true));
  while (!settled) await advance(1_000);
  await promise;
}

/** A real Pi session (this pin's AgentSession) with the extension and the simulated provider, and no user configuration. */
async function world(replies: Reply[]) {
  const root = mkdtempSync(join(tmpdir(), "keep-cache-warm-lifecycle-"));
  const requests: ProviderRequest[] = [];
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [simulatedProvider(replies, requests), keepCacheWarm],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
    noTools: "builtin",
  });
  await session.setModel(modelRuntime.getModel("sim", "sim-model")!);
  const branch = () => session.sessionManager.getBranch();
  const armingTurn = () => session.prompt("Wait for the reminder.");
  return {
    session,
    requests,
    /** The extension's own session entries: arm, warm, pause, resume, stop. */
    entries: () =>
      branch().flatMap((entry) => (entry.type === "custom" && entry.customType === "keep-cache-warm" ? [entry.data as Record<string, unknown>] : [])),
    /** Messages the extension posted into the conversation. */
    messages: () => branch().filter((entry) => entry.type === "custom_message" && entry.customType === "keep-cache-warm"),
    /** The agent's turn that calls keep_cache_warm(20); the window arms when it settles. */
    armingTurn,
    async arm() {
      await until(armingTurn());
    },
    /** A reminder wakes the agent for one turn. */
    wake() {
      return session.sendCustomMessage({ customType: "reminder", content: "Reminder.", display: true }, { triggerTurn: true });
    },
  };
}

const ARM: Reply[] = [{ tool: "keep_cache_warm", arguments: { minutes: 20 } }, { text: "Waiting." }];
const OVERLOADED: Reply = { error: "529 overloaded_error: Overloaded" };
const warmsAfter = (requests: ProviderRequest[], time: number) => requests.filter((request) => request.outcome === "warm" && request.at > time);

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
afterEach(() => mock.timers.reset());

test("a wake that fails but succeeds on Pi's own retry resumes toward the same deadline from the successful request", async (t) => {
  const run = await world([...ARM, OVERLOADED, { text: "Done." }]);
  t.after(() => run.session.dispose());
  await run.arm();
  await advance(400_000);
  const wakeAt = Date.now();
  await until(run.wake());
  const wakeRequests = run.requests.filter((request) => request.at >= wakeAt);
  assert.deepEqual(wakeRequests.map((request) => request.outcome), ["error", "text"], "Pi retried the failed request once");
  const retried = wakeRequests[1];

  await advance(25 * MINUTE);
  const arm = run.entries().find((entry) => entry.kind === "arm")!;
  const resume = run.entries().find((entry) => entry.kind === "resume");
  assert.equal(resume?.deadline, arm.deadline, "the window resumes toward the original deadline");
  assert.equal(resume?.prefixTokens, 6_000, "from the successful request's cached prefix, not the failed request's zero usage");
  const warms = warmsAfter(run.requests, wakeAt);
  assert.deepEqual(
    warms.map((warm) => warm.at - retried.at),
    [280_000, 560_000],
    "warms one slot after the successful request, until the next slot passes the 20-minute deadline",
  );
  for (const warm of warms) assert.deepEqual(warm.payload, { ...retried.payload, max_tokens: 1 });
  assert.equal(run.entries().at(-1)?.reason, "the cache outlives the deadline");
  assert.deepEqual(run.messages(), [], "no warning in the conversation");
});

test("a wake that still fails after Pi's retries closes the window quietly, without replaying the failed request", async (t) => {
  const run = await world([...ARM, OVERLOADED, OVERLOADED, OVERLOADED, OVERLOADED]);
  t.after(() => run.session.dispose());
  await run.arm();
  await advance(400_000);
  const wakeAt = Date.now();
  await until(run.wake());
  const wakeRequests = run.requests.filter((request) => request.at >= wakeAt);
  assert.deepEqual(wakeRequests.map((request) => request.outcome), ["error", "error", "error", "error"], "Pi gave up after 3 retries");

  await advance(25 * MINUTE);
  assert.deepEqual(warmsAfter(run.requests, wakeAt), [], "no warm after the failed wake");
  assert.ok(!run.entries().some((entry) => entry.kind === "resume"));
  assert.equal(run.entries().at(-1)?.kind, "stop");
  assert.equal(run.entries().at(-1)?.reason, "turn failed");
  assert.deepEqual(run.messages(), [], "no warning in the conversation");
});

test("a wake cancelled mid-request closes the window quietly, without replaying the cancelled request", async (t) => {
  const run = await world([...ARM, "hang"]);
  t.after(() => run.session.dispose());
  await run.arm();
  await advance(400_000);
  const wakeAt = Date.now();
  const wake = run.wake();
  await advance(5_000);
  await run.session.abort();
  await until(wake);
  assert.deepEqual(run.requests.filter((request) => request.at >= wakeAt).map((request) => request.outcome), ["aborted"]);

  await advance(25 * MINUTE);
  assert.deepEqual(warmsAfter(run.requests, wakeAt), [], "no warm after the cancelled wake");
  assert.ok(!run.entries().some((entry) => entry.kind === "resume"));
  assert.equal(run.entries().at(-1)?.kind, "stop");
  assert.equal(run.entries().at(-1)?.reason, "turn aborted");
  assert.deepEqual(run.messages(), [], "no warning in the conversation");
});

test("an arming turn whose follow-up fails but succeeds on Pi's own retry arms as usual, from the successful request", async (t) => {
  const run = await world([{ tool: "keep_cache_warm", arguments: { minutes: 20 } }, OVERLOADED, { text: "Waiting." }, { text: "Done." }]);
  t.after(() => run.session.dispose());
  await run.arm();
  assert.deepEqual(run.requests.map((request) => request.outcome), ["tool keep_cache_warm", "error", "text"], "Pi retried the failed follow-up once");
  const [toolCall, , retried] = run.requests;

  await advance(25 * MINUTE);
  const arm = run.entries().find((entry) => entry.kind === "arm");
  assert.equal(arm?.deadline, new Date(toolCall.at + 20 * MINUTE).toISOString(), "the deadline the tool granted");
  const warms = warmsAfter(run.requests, retried.at);
  assert.deepEqual(
    warms.map((warm) => warm.at - retried.at),
    [280_000, 560_000, 840_000, 1_120_000],
    "warms one slot after the successful request, until the next slot passes the 20-minute deadline",
  );
  for (const warm of warms) assert.deepEqual(warm.payload, { ...retried.payload, max_tokens: 1 });
  assert.deepEqual(run.messages(), [], "no warning in the conversation");
});

test("an arming turn that still fails after keep_cache_warm and Pi's retries never starts warming", async (t) => {
  const run = await world([{ tool: "keep_cache_warm", arguments: { minutes: 20 } }, OVERLOADED, OVERLOADED, OVERLOADED, OVERLOADED]);
  t.after(() => run.session.dispose());
  await run.arm();
  assert.deepEqual(run.requests.map((request) => request.outcome), ["tool keep_cache_warm", "error", "error", "error", "error"]);

  await advance(25 * MINUTE);
  assert.deepEqual(warmsAfter(run.requests, 0), [], "no warm, so the failed request is never replayed");
  assert.ok(!run.entries().some((entry) => entry.kind === "arm"), "the window never arms");
  assert.deepEqual(run.messages(), [], "no warning in the conversation");
});

test("an arming turn cancelled after keep_cache_warm never starts warming", async (t) => {
  const run = await world([{ tool: "keep_cache_warm", arguments: { minutes: 20 } }, "hang"]);
  t.after(() => run.session.dispose());
  const arming = run.armingTurn();
  await advance(5_000);
  await run.session.abort();
  await until(arming);
  assert.deepEqual(run.requests.map((request) => request.outcome), ["tool keep_cache_warm", "aborted"]);

  await advance(25 * MINUTE);
  assert.deepEqual(warmsAfter(run.requests, 0), [], "no warm, so the cancelled request is never replayed");
  assert.ok(!run.entries().some((entry) => entry.kind === "arm"), "the window never arms");
  assert.deepEqual(run.messages(), [], "no warning in the conversation");
});
