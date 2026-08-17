import assert from "node:assert/strict";
import test from "node:test";
import { RequestBudget } from "../src/automation/scheduling/requestBudget.ts";

test("follow-up and sell priorities fail fast at their reserved 108-request ceiling", async () => {
  for (const [priority, code] of [
    [1, "FOLLOWUP_QUOTA_HEADROOM"],
    [2, "SELL_QUOTA_EXHAUSTED"],
  ] as const) {
    const budget = new RequestBudget({ now: () => 10_000 });
    for (let count = 0; count < 108; count += 1) await budget.admit(priority);
    await assert.rejects(budget.admit(priority), new RegExp(code));
  }
});

test("refresh priority preserves reserved headroom and waits for rolling-window expiry", async () => {
  let now = 10_000;
  const sleeps: number[] = [];
  const waits: Array<{ usedLast60s: number; refreshCeiling: number }> = [];
  const budget = new RequestBudget({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    onRefreshHeadroomWait: (state) => waits.push({ ...state }),
  });

  for (let count = 0; count < 105; count += 1) await budget.admit(0);
  await budget.admit(3);

  assert.deepEqual(waits, [{ usedLast60s: 105, refreshCeiling: 105 }]);
  assert.deepEqual(sleeps, [60_000]);
  assert.equal(now, 70_000);
});

test("refresh priority may use urgent headroom after two seconds without priority traffic", async () => {
  let now = 10_000;
  const budget = new RequestBudget({ now: () => now });
  now += 2_000;
  for (let count = 0; count < 110; count += 1) await budget.admit(3);
});

test("broker 429 backoff clamps to 30 seconds and blocks new admission until expiry", async () => {
  let now = 10_000;
  let slept = 0;
  const backoffs: number[] = [];
  const budget = new RequestBudget({
    now: () => now,
    sleep: async (ms) => {
      slept += ms;
      now += ms;
    },
    onRateLimited: (seconds) => backoffs.push(seconds),
  });

  budget.rateLimited("1");
  await budget.admit(0);
  assert.deepEqual(backoffs, [30]);
  assert.equal(slept, 30_000);
  assert.equal(now, 40_000);
});

test("fixed-price cadence is derived from the current rolling request count", async () => {
  let now = 10_000;
  const budget = new RequestBudget({ now: () => now });
  for (let count = 0; count < 55; count += 1) await budget.admit(0);
  assert.equal(budget.fixedPriceRefreshIntervalMs(), 825);

  now += 60_000;
  assert.equal(budget.fixedPriceRefreshIntervalMs(), 700);
});
