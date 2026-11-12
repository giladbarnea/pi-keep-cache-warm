import {
  CACHE_WARMING_MAX_IDLE_AGE_MS,
  evaluateCacheWarming,
  getCacheWarmingDelayMs,
  getCacheWarmingRequestOptions,
  getPromptCacheTtlMs,
  isCacheWarmingReplayable,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { breakEvenDeadline, nextStep, readWholePrefix } from "./schedule.ts";

const ENTRY_TYPE = "keep-cache-warm";
const MINUTE = 60_000;

/** The last real session request: its exact provider payload and what it cached. */
type SavedRequest = { payload: Record<string, unknown>; model: Model<any>; sentAt: number; prefixTokens: number };

type Armed = SavedRequest & {
  deadline: number;
  ttlMs: number;
  delayMs: number;
  lastRefreshAt: number;
  timer?: NodeJS.Timeout;
  controller: AbortController;
  warms: number;
  cost: number;
};

export default function keepCacheWarm(pi: ExtensionAPI): void {
  let lastPayload: { payload: Record<string, unknown>; model: Model<any>; sentAt: number } | undefined;
  let lastRequest: SavedRequest | undefined;
  let pendingDeadline: number | undefined;
  let armed: Armed | undefined;

  const status = (ctx: ExtensionContext, text: string | undefined) => ctx.ui.setStatus(ENTRY_TYPE, text);

  function disarm(ctx: ExtensionContext, reason: string): void {
    const run = armed;
    if (!run) return;
    armed = undefined;
    clearTimeout(run.timer);
    run.controller.abort();
    pi.appendEntry(ENTRY_TYPE, { kind: "stop", reason, warms: run.warms, cost: run.cost });
    status(ctx, run.warms > 0 ? `cache kept warm: ${run.warms} warms, $${run.cost.toFixed(6)} (${reason})` : undefined);
  }

  function fail(ctx: ExtensionContext, text: string): void {
    disarm(ctx, "guard");
    pi.sendMessage({ customType: ENTRY_TYPE, content: `keep_cache_warm stopped: ${text}`, display: true });
  }

  function piWarmTimes(ctx: ExtensionContext, after: number): number[] {
    return ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "usage" && entry.kind === "cache_warm")
      .map((entry) => Date.parse(entry.timestamp))
      .filter((time) => time > after);
  }

  function schedule(ctx: ExtensionContext, run: Armed, at: number): void {
    run.timer = setTimeout(() => void tick(ctx, run), Math.max(0, at - Date.now()));
    run.timer.unref?.();
  }

  async function tick(ctx: ExtensionContext, run: Armed): Promise<void> {
    if (armed !== run) return;
    const step = nextStep({
      now: Date.now(),
      lastRefreshAt: run.lastRefreshAt,
      piWarmTimes: piWarmTimes(ctx, run.lastRefreshAt),
      delayMs: run.delayMs,
      ttlMs: run.ttlMs,
      deadline: run.deadline,
    });
    if (step.type === "done") return disarm(ctx, step.reason);
    run.lastRefreshAt = step.lastRefreshAt;
    if (step.type === "wait") return schedule(ctx, run, step.at);
    await warm(ctx, run);
  }

  async function warm(ctx: ExtensionContext, run: Armed): Promise<void> {
    const startedAt = Date.now();
    const payload = { ...run.payload, max_tokens: 1 };
    const options = {
      ...getCacheWarmingRequestOptions({ sessionId: ctx.sessionManager.getSessionId() }, run.controller.signal),
      onPayload: () => payload,
    };
    const message = await ctx.modelRegistry.streamSimple(run.model, { messages: [] }, options).result();
    if (armed !== run) return;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return fail(ctx, `warm ${run.warms + 1} failed: ${message.errorMessage ?? message.stopReason}`);
    }
    const usage: Usage = message.usage;
    pi.appendEntry(ENTRY_TYPE, { kind: "warm", provider: message.provider, model: message.model, usage });
    run.warms += 1;
    run.cost += usage.cost.total;
    if (!readWholePrefix(usage, run.prefixTokens)) {
      return fail(
        ctx,
        `warm ${run.warms} did not read the prefix from the cache: read ${usage.cacheRead} of ${run.prefixTokens} tokens, wrote ${usage.cacheWrite}. The cache entry was lost; warming further would pay for writes.`,
      );
    }
    run.lastRefreshAt = startedAt;
    const remaining = Math.round((run.deadline - Date.now()) / MINUTE);
    status(ctx, `keeping cache warm: ${run.warms} warms, $${run.cost.toFixed(6)}, ${remaining} min left`);
    schedule(ctx, run, startedAt + run.delayMs);
  }

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload as Record<string, unknown>;
    if (!ctx.model || payload.model !== ctx.model.id) return;
    lastPayload = { payload: structuredClone(payload), model: ctx.model, sentAt: Date.now() };
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || !lastPayload) return;
    const { cacheRead, cacheWrite } = event.message.usage;
    lastRequest = { ...lastPayload, prefixTokens: cacheRead + cacheWrite };
  });

  pi.on("agent_start", (_event, ctx) => disarm(ctx, "next real request"));
  pi.on("model_select", (_event, ctx) => disarm(ctx, "model changed"));
  pi.on("session_shutdown", (_event, ctx) => disarm(ctx, "session shutdown"));

  pi.on("agent_settled", (event, ctx) => {
    const deadline = pendingDeadline;
    pendingDeadline = undefined;
    if (deadline === undefined || event.aborted || !lastRequest) return;
    const request = lastRequest;
    const ttlMs = getPromptCacheTtlMs(request.model)!;
    armed = {
      ...request,
      deadline,
      ttlMs,
      delayMs: getCacheWarmingDelayMs(ttlMs)!,
      lastRefreshAt: request.sentAt,
      controller: new AbortController(),
      warms: 0,
      cost: 0,
    };
    pi.appendEntry(ENTRY_TYPE, { kind: "arm", deadline: new Date(deadline).toISOString(), prefixTokens: request.prefixTokens });
    status(ctx, `keeping cache warm until ${new Date(deadline).toLocaleTimeString()}`);
    void tick(ctx, armed);
  });

  pi.registerTool(
    defineTool({
      name: "keep_cache_warm",
      label: "Keep Cache Warm",
      description:
        "Keep this session's prompt cache warm while you wait for something you know will wake you, such as a reminder you set or a report you asked for. Call it in the same turn as setting that reminder, with how many minutes from now the cache should stay warm. Warming starts when your turn ends and stops at the deadline or at your next turn. It is capped at the break-even point, past which a cold restart is cheaper.",
      parameters: Type.Object({
        minutes: Type.Number({ minimum: 1, description: "Minutes from now until you expect the next turn." }),
      }),
      async execute(_toolCallId, { minutes }, _signal, _onUpdate, ctx) {
        const model = ctx.model;
        if (!model || !lastRequest) throw new Error("No previous request to keep warm.");
        if (lastRequest.prefixTokens === 0) throw new Error("The last request cached nothing, so there is nothing to keep warm.");
        if (!isCacheWarmingReplayable(model, { reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel })) {
          throw new Error(`${model.provider}/${model.id} cannot be replayed with a one-token cap at this thinking level.`);
        }
        const ttlMs = getPromptCacheTtlMs(model);
        const delayMs = ttlMs === undefined ? undefined : getCacheWarmingDelayMs(ttlMs);
        if (ttlMs === undefined || delayMs === undefined) {
          throw new Error(`Pi declares no prompt cache lifetime for ${model.provider}/${model.id}.`);
        }
        const { warmCost, missCost } = evaluateCacheWarming(model, lastRequest.prefixTokens, "idle");
        // Pi's default cacheWarming setting is "idle"; its idle warms are free to us, so our budget starts after them.
        const piWillWarm =
          (pi.getSettings().cacheWarming ?? "idle") === "idle" &&
          evaluateCacheWarming(model, lastRequest.prefixTokens, "idle").action === "warm";
        const capDeadline = breakEvenDeadline({
          lastRequestAt: lastRequest.sentAt,
          piIdleHorizonMs: piWillWarm ? CACHE_WARMING_MAX_IDLE_AGE_MS : 0,
          warmCost,
          missCost,
          delayMs,
          ttlMs,
        });
        const now = Date.now();
        const capMinutes = Math.floor((capDeadline - now) / MINUTE);
        if (capMinutes < 1) throw new Error("Keeping the cache warm no longer pays: a cold restart is cheaper.");
        const grantedMinutes = Math.min(minutes, capMinutes);
        pendingDeadline = now + grantedMinutes * MINUTE;
        const until = `${grantedMinutes} min from now (${new Date(pendingDeadline).toLocaleTimeString()})`;
        const text =
          grantedMinutes < minutes
            ? `Keeping the cache warm until ${until}, not ${minutes}: past that, a cold restart is cheaper than keeping it warm.`
            : `Keeping the cache warm until ${until}.`;
        return {
          content: [{ type: "text" as const, text }],
          details: { grantedMinutes, capMinutes, piWillWarm, warmCost, missCost },
        };
      },
    }),
  );
}
