import assert from "node:assert/strict";
import { before, test } from "node:test";
import { initTheme, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import keepCacheWarm from "../index.ts";

const ARMED = "Keeping the cache warm until 50 min from now (7:20:00 PM). Warming starts when this turn ends, unless it fails or is cancelled.";
const CAPPED =
  "Keeping the cache warm until 54 min from now (7:24:00 PM), not 120: past that, a cold restart is cheaper than keeping it warm. Warming starts when this turn ends, unless it fails or is cancelled.";
const CAPPED_LINE = "● Keep Cache Warm · until 7:24 PM · 54 min · capped from 120 min: past that, a cold restart is cheaper";

type Result = { content: { type: "text"; text: string }[]; details?: unknown; isError: boolean };

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

let tool: any;
/** The theme Pi hands to renderers, captured through a probe tool. */
let theme: Theme;
const handlers = new Map<string, Function>();
const ctx: any = { model, thinkingLevel: "low", ui: { setStatus() {} } };

before(() => {
  initTheme("dark");
  const probe: any = { name: "probe", renderShell: "self", renderCall: (_args: unknown, piTheme: Theme) => ((theme = piTheme), new Text("", 0, 0)) };
  new ToolExecutionComponent("probe", "probe-1", {}, {}, probe, { requestRender() {} } as any, "/");
  const pi: any = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerTool: (definition: unknown) => (tool = definition),
    appendEntry() {},
    getSettings: () => ({}),
  };
  keepCacheWarm(pi);
  handlers.get("before_provider_request")!({ payload: { model: model.id } }, ctx);
  handlers.get("message_end")!({ message: { role: "assistant", usage: { cacheRead: 0, cacheWrite: 3_000 } } }, ctx);
});

const plain = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "").trimEnd();
const textResult = (text: string, isError = false): Result => ({ content: [{ type: "text", text }], isError });

/** Renders the tool through Pi's own tool-execution component, as the transcript does. */
function renderTool({ result, executionStarted = true, width = 110 }: { result?: Result; executionStarted?: boolean; width?: number }): string[] {
  const component = new ToolExecutionComponent("keep_cache_warm", "warm-1", { minutes: 50 }, {}, tool, { requestRender() {} } as any, "/");
  if (executionStarted) component.markExecutionStarted();
  if (result) component.updateResult(result, false);
  return component.render(width);
}

test("an armed result renders as the approved one-line receipt, with an accent bullet", () => {
  const lines = renderTool({ result: textResult(ARMED) });
  assert.deepEqual(lines.map(plain), ["", "● Keep Cache Warm · until 7:20 PM · 50 min · starts when this turn ends"]);
  assert.ok(lines[1]!.startsWith(theme.fg("accent", "● ")));
});

test("a cancellation renders as one muted line", () => {
  const lines = renderTool({ result: textResult("Cache warming cancelled.") });
  assert.deepEqual(lines.map(plain), ["", "● Keep Cache Warm · cancelled"]);
  assert.ok(lines[1]!.startsWith(theme.fg("muted", "● ")));
});

test("a capped result says what was asked and why it was capped; the hint goes first when the line does not fit", () => {
  assert.deepEqual(renderTool({ result: textResult(CAPPED), width: 140 }).map(plain), ["", `${CAPPED_LINE} · starts when this turn ends`]);
  assert.deepEqual(renderTool({ result: textResult(CAPPED), width: 110 }).map(plain), ["", CAPPED_LINE]);
});

test("results that execute returns render as receipts, not as the fallback", async () => {
  const armed = await tool.execute("call", { minutes: 40 }, undefined, undefined, ctx);
  assert.match(plain(renderTool({ result: { ...armed, isError: false } })[1]!), /^● Keep Cache Warm · until \d.* · 40 min · starts when this turn ends$/);
  const capped = await tool.execute("call", { minutes: 120 }, undefined, undefined, ctx);
  assert.match(plain(renderTool({ result: { ...capped, isError: false }, width: 140 })[1]!), /^● Keep Cache Warm · until \d.* · 54 min · capped from 120 min: past that, a cold restart is cheaper · starts when this turn ends$/);
  const cancelled = await tool.execute("call", { minutes: 0 }, undefined, undefined, ctx);
  assert.deepEqual(renderTool({ result: { ...cancelled, isError: false } }).map(plain), ["", "● Keep Cache Warm · cancelled"]);
});

test("a retained result from an older version, without the start hint and on a 24-hour clock, shows no hint", () => {
  const lines = renderTool({ result: textResult("Keeping the cache warm until 25 min from now (19:20:00).") });
  assert.deepEqual(lines.map(plain), ["", "● Keep Cache Warm · until 19:20 · 25 min"]);
});

test("narrow widths wrap instead of dropping anything but the hint", () => {
  for (let width = 1; width <= 120; width++) {
    const lines = renderTool({ result: textResult(ARMED), width }).slice(1);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `Line exceeds width ${width}: ${JSON.stringify(plain(line))}`);
    const joined = lines.map(plain).join("").replace(/\s+/g, "");
    assert.ok(joined.startsWith("●KeepCacheWarm·until7:20PM·50min"), `Width ${width} lost a figure: ${JSON.stringify(lines.map(plain))}`);
  }
  assert.equal(renderTool({ result: textResult(ARMED), width: 72 }).length, 2);
});

test("an error shows the label and the full error text in the error color, wrapped", () => {
  const lines = renderTool({ result: textResult("Pi declares no prompt cache lifetime for openai-codex/gpt-6-astra.", true) });
  assert.deepEqual(lines.map(plain), ["", "● Keep Cache Warm · Pi declares no prompt cache lifetime for openai-codex/gpt-6-astra."]);
  assert.ok(lines[1]!.startsWith(theme.fg("error", "● ")));
  const validation = 'Validation failed for tool "keep_cache_warm":\n  - minutes: must be >= 0';
  const wrapped = renderTool({ result: textResult(validation, true), width: 40 }).map(plain);
  assert.ok(wrapped.every((line) => visibleWidth(line) <= 40), JSON.stringify(wrapped));
  assert.match(wrapped.join(" ").replace(/\s+/g, " "), /Keep Cache Warm · Validation failed for tool "keep_cache_warm": - minutes: must be >= 0/);
});

test("text the renderer does not recognize is shown in full, never as an armed receipt", () => {
  const text = "[removed: keep_cache_warm result; the call above records the action]";
  const lines = renderTool({ result: textResult(text) });
  assert.deepEqual(lines.map(plain), ["", `● Keep Cache Warm · ${text}`]);
  assert.ok(!lines[1]!.startsWith(theme.fg("accent", "● ")));
});

test("a running call shows only the label in the warning color, and nothing before execution starts", () => {
  assert.deepEqual(renderTool({ executionStarted: false }), []);
  const lines = renderTool({});
  assert.deepEqual(lines.map(plain), ["", "● Keep Cache Warm"]);
  assert.ok(lines[1]!.startsWith(theme.fg("warning", "● ")));
});
