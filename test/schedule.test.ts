import assert from "node:assert/strict";
import { test } from "node:test";
import { breakEvenDeadline, nextStep, readWholePrefix } from "../schedule.ts";

const MINUTE = 60_000;
const base = { delayMs: 270_000, ttlMs: 300_000, deadline: 50 * MINUTE, lastRefreshAt: 0 };

test("a Pi cache_warm in the slot makes us wait for the slot after it", () => {
  assert.deepEqual(nextStep({ ...base, now: 280_000, piWarmTimes: [270_000] }), {
    type: "wait",
    at: 270_000 + 270_000 + 10_000,
    lastRefreshAt: 270_000,
  });
});

test("no Pi cache_warm in the slot makes us warm", () => {
  assert.deepEqual(nextStep({ ...base, now: 280_000, piWarmTimes: [] }), { type: "warm", lastRefreshAt: 0 });
});

test("Pi warms that predate our last refresh do not delay us", () => {
  assert.deepEqual(nextStep({ ...base, lastRefreshAt: 1_620_000, now: 1_900_000, piWarmTimes: [1_350_000] }), {
    type: "warm",
    lastRefreshAt: 1_620_000,
  });
});

test("handover after Pi's 30-minute stop: Pi's last warm at 27 min, our warm at 31.67 min", () => {
  const piWarmTimes = [1, 2, 3, 4, 5, 6].map((k) => k * 270_000);
  assert.deepEqual(nextStep({ ...base, now: 1_620_000 + 280_000, piWarmTimes }), { type: "warm", lastRefreshAt: 1_620_000 });
});

test("done once the next slot falls after the deadline", () => {
  assert.equal(nextStep({ ...base, lastRefreshAt: base.deadline - 270_000, now: base.deadline, piWarmTimes: [] }).type, "done");
  assert.equal(nextStep({ ...base, lastRefreshAt: base.deadline - 290_000, now: base.deadline, piWarmTimes: [] }).type, "warm");
});

const economics = { warmCost: 0.1, missCost: 1.15, delayMs: 270_000, ttlMs: 300_000 };

test("break-even when Pi will not warm: about 55 minutes after the last request", () => {
  assert.equal(breakEvenDeadline({ ...economics, lastRequestAt: 0, piIdleHorizonMs: 0 }), 3_270_000);
});

test("break-even when Pi warms its idle 30 minutes for free: about 81 minutes after the last request", () => {
  const deadline = breakEvenDeadline({ ...economics, lastRequestAt: 0, piIdleHorizonMs: 30 * MINUTE });
  assert.equal(deadline, 4_890_000);
  assert.equal(Math.floor(deadline / MINUTE), 81);
});

test("break-even counts from the last request, not from arming", () => {
  assert.equal(breakEvenDeadline({ ...economics, lastRequestAt: 1_000, piIdleHorizonMs: 0 }), 3_271_000);
});

test("prefix guard", () => {
  assert.equal(readWholePrefix({ cacheRead: 2400, cacheWrite: 0 }, 2400), true);
  assert.equal(readWholePrefix({ cacheRead: 2400, cacheWrite: 15 }, 2400), false);
  assert.equal(readWholePrefix({ cacheRead: 1431, cacheWrite: 0 }, 2400), false);
});
