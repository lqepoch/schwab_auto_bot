import assert from "node:assert/strict";
import test from "node:test";
import { isWithinExecutionWindow, isWithinInclusiveRange, parseRuntimePolicy } from "../src/runtime_policy.ts";

test("defaults permit QQQ and SPY only during the New York execution window", () => {
  const policy = parseRuntimePolicy([]);
  assert.deepEqual([...policy.underlyings], ["QQQ", "SPY"]);
  assert.equal(policy.strikeMin, 720);
  assert.equal(policy.strikeMax, 790);
  assert.deepEqual(policy.strikeRanges.get("QQQ"), [{ minimum: 720, maximum: 790 }]);
  assert.equal(policy.entryNotionalMin, 82);
  assert.equal(policy.entryNotionalMax, 92);
  assert.equal(policy.executionStart, "09:15");
  assert.equal(policy.executionEnd, "15:45");
  assert.equal(policy.orderCooldownMs, 1_000);
  assert.equal(policy.roundCooldownMs, 5_000);
  assert.equal(policy.fixedPriceRefreshIntervalMs, 2_000);
  assert.equal(policy.maxRefreshRounds, null);
  assert.equal(policy.repeatBuyAtOrderPrice, false);
  assert.equal(policy.disableSellOrders, false);
  assert.equal(isWithinExecutionWindow(new Date("2026-07-24T13:15:00Z"), "09:15", "15:45"), true);
  assert.equal(isWithinExecutionWindow(new Date("2026-07-24T19:45:00Z"), "09:15", "15:45"), false);
  assert.equal(isWithinExecutionWindow(new Date("2026-07-25T13:15:00Z"), "09:15", "15:45"), false);
});

test("runtime policy accepts explicit symbols, strike range, and entry notional range", () => {
  const policy = parseRuntimePolicy([
    "--underlyings", "SPY,QQQ",
    "--strike-min", "720",
    "--strike-max", "790",
    "--entry-notional-min", "82",
    "--entry-notional-max", "92",
    "--execution-start", "09:15",
    "--execution-end", "15:45",
    "--order-cooldown-seconds", "2.5",
    "--round-cooldown-seconds", "7",
    "--fixed-price-refresh-interval-seconds", "2.5",
    "--max-refresh-rounds", "3",
    "--repeat-buy-at-order-price",
    "--disable-sell-orders",
  ]);
  assert.deepEqual([...policy.underlyings], ["SPY", "QQQ"]);
  assert.equal(policy.entryNotionalMin, 82);
  assert.equal(policy.entryNotionalMax, 92);
  assert.equal(policy.orderCooldownMs, 2_500);
  assert.equal(policy.roundCooldownMs, 7_000);
  assert.equal(policy.fixedPriceRefreshIntervalMs, 2_500);
  assert.equal(policy.maxRefreshRounds, 3);
  assert.equal(policy.repeatBuyAtOrderPrice, true);
  assert.equal(policy.disableSellOrders, true);
  assert.equal(isWithinInclusiveRange(82, 82, 92), true);
  assert.equal(isWithinInclusiveRange(92, 82, 92), true);
  assert.equal(isWithinInclusiveRange(81.99, 82, 92), false);
  assert.equal(isWithinInclusiveRange(92.01, 82, 92), false);
});

test("runtime policy rejects inverted time and strike ranges", () => {
  assert.throws(() => parseRuntimePolicy(["--execution-start", "15:45", "--execution-end", "09:15"]), /EXECUTION_WINDOW_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--strike-min", "790", "--strike-max", "720"]), /STRIKE_RANGE_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--order-cooldown-seconds", "0"]), /ORDER_COOLDOWN_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--round-cooldown-seconds", "0"]), /ROUND_COOLDOWN_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--fixed-price-refresh-interval-seconds", "0"]), /FIXED_PRICE_REFRESH_INTERVAL_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--max-refresh-rounds", "0"]), /MAX_REFRESH_ROUNDS_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--max-refresh-rounds", "3.5"]), /MAX_REFRESH_ROUNDS_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--entry-notional-min", "84"]), /ENTRY_NOTIONAL_POLICY_FIXED/);
});

test("refresh strike ranges support multiple independent ranges per underlying", () => {
  const policy = parseRuntimePolicy([
    "--refresh-strike-ranges", "SPY:750:795,SPY:800:820,QQQ:685:790",
  ]);
  assert.deepEqual([...policy.underlyings], ["SPY", "QQQ"]);
  assert.deepEqual(policy.strikeRanges.get("SPY"), [
    { minimum: 750, maximum: 795 },
    { minimum: 800, maximum: 820 },
  ]);
  assert.equal(policy.isWithinStrikeRange("SPY", 750, 795), true);
  assert.equal(policy.isWithinStrikeRange("SPY", 795, 800), false);
  assert.equal(policy.isWithinStrikeRange("QQQ", 685, 790), true);
  assert.equal(policy.isWithinStrikeRange("QQQ", 684, 790), false);
  assert.throws(() => parseRuntimePolicy(["--refresh-strike-ranges", "SPY:795:750"]), /REFRESH_STRIKE_RANGES_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--refresh-strike-ranges", "SPY:750:795", "--strike-min", "700"]), /REFRESH_STRIKE_RANGES_CONFLICT/);
});
