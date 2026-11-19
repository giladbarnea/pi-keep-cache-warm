/** Pure timing and economics for keep_cache_warm. No Pi imports, so node can test it directly. */

/** Extra wait after Pi's own refresh slot, so Pi warms first when it still can. */
export const HANDOVER_GRACE_MS = 10_000;

export type NextStep =
  | { type: "wait"; at: number; lastRefreshAt: number }
  | { type: "warm"; lastRefreshAt: number }
  | { type: "done"; reason: string };

/**
 * Decide what to do when the warm timer fires. Pi's refreshes count as ours: a `cache_warm` record marks a
 * finished one, and a "warm" decision marks one in flight, whose record only lands when it completes. Wait
 * for a later slot when Pi refreshed meanwhile; finish when the next slot falls after the deadline;
 * otherwise Pi has stopped (or never started), so warm now.
 *
 * @example
 * nextStep({ now: 280_000, lastRefreshAt: 0, piWarmTimes: [], piWarmDecisionTimes: [270_000], delayMs: 270_000, ttlMs: 300_000, deadline: 3_000_000 })
 * // { type: "wait", at: 550_000, lastRefreshAt: 270_000 }
 * nextStep({ now: 280_000, lastRefreshAt: 0, piWarmTimes: [], piWarmDecisionTimes: [], delayMs: 270_000, ttlMs: 300_000, deadline: 3_000_000 })
 * // { type: "warm", lastRefreshAt: 0 }
 */
export function nextStep(input: {
  now: number;
  lastRefreshAt: number;
  piWarmTimes: number[];
  piWarmDecisionTimes: number[];
  delayMs: number;
  ttlMs: number;
  deadline: number;
}): NextStep {
  const lastRefreshAt = Math.max(input.lastRefreshAt, ...input.piWarmTimes, ...input.piWarmDecisionTimes);
  const slot = refreshSlot(lastRefreshAt, input.delayMs);
  if (slot > input.deadline) return { type: "done", reason: "the cache outlives the deadline" };
  if (input.now < slot) return { type: "wait", at: slot, lastRefreshAt };
  return { type: "warm", lastRefreshAt };
}

/** When to check again after a refresh at `lastRefreshAt`: Pi's own slot plus a grace period. */
export function refreshSlot(lastRefreshAt: number, delayMs: number): number {
  return lastRefreshAt + delayMs + HANDOVER_GRACE_MS;
}

/**
 * Latest time worth keeping the cache warm until when the next request is certain. Pi's own idle warms
 * (`piIdleHorizonMs`, 0 when Pi will not warm) come first; then our refreshes cost `warmCost` each and pay
 * until they add up to the `missCost` a cold resume would add; the last refresh's TTL covers the tail.
 *
 * @example
 * breakEvenDeadline({ lastRequestAt: 0, piIdleHorizonMs: 0, warmCost: 0.1, missCost: 1.15, delayMs: 270_000, ttlMs: 300_000 })
 * // 11 * 270_000 + 300_000 = 3_270_000 (54.5 min)
 * breakEvenDeadline({ lastRequestAt: 0, piIdleHorizonMs: 1_800_000, warmCost: 0.1, missCost: 1.15, delayMs: 270_000, ttlMs: 300_000 })
 * // 6 * 270_000 + 11 * 270_000 + 300_000 = 4_890_000 (81.5 min)
 */
export function breakEvenDeadline(input: {
  lastRequestAt: number;
  piIdleHorizonMs: number;
  warmCost: number;
  missCost: number;
  delayMs: number;
  ttlMs: number;
}): number {
  const piRefreshes = Math.floor(input.piIdleHorizonMs / input.delayMs);
  const ownRefreshes = Math.floor(input.missCost / input.warmCost);
  return input.lastRequestAt + (piRefreshes + ownRefreshes) * input.delayMs + input.ttlMs;
}

/**
 * Whether a warm read the whole saved prefix from the cache and wrote nothing.
 *
 * @example
 * readWholePrefix({ cacheRead: 2400, cacheWrite: 0 }, 2400) // true
 * readWholePrefix({ cacheRead: 1431, cacheWrite: 969 }, 2400) // false
 */
export function readWholePrefix(usage: { cacheRead: number; cacheWrite: number }, prefixTokens: number): boolean {
  return usage.cacheWrite === 0 && usage.cacheRead >= prefixTokens;
}
