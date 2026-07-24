import assert from "node:assert/strict";
import test from "node:test";
import { isWithinExecutionWindow, isWithinInclusiveRange, parseRuntimePolicy } from "../src/runtime_policy.ts";

test("defaults permit QQQ and SPY only during the New York execution window", () => {
  const policy = parseRuntimePolicy([]);
  assert.deepEqual([...policy.underlyings], ["QQQ", "SPY"]);
  assert.equal(policy.strikeMin, 720);
  assert.equal(policy.strikeMax, 790);
  assert.equal(policy.entryNotionalMin, 84);
  assert.equal(policy.entryNotionalMax, 90);
  assert.equal(policy.executionStart, "09:15");
  assert.equal(policy.executionEnd, "15:45");
  assert.equal(policy.orderCooldownMs, 1_000);
  assert.equal(policy.roundCooldownMs, 5_000);
  assert.equal(isWithinExecutionWindow(new Date("2026-07-24T13:15:00Z"), "09:15", "15:45"), true);
  assert.equal(isWithinExecutionWindow(new Date("2026-07-24T19:45:00Z"), "09:15", "15:45"), false);
  assert.equal(isWithinExecutionWindow(new Date("2026-07-25T13:15:00Z"), "09:15", "15:45"), false);
});

test("runtime policy accepts explicit symbols, strike range, and entry notional range", () => {
  const policy = parseRuntimePolicy([
    "--underlyings", "SPY,QQQ",
    "--strike-min", "720",
    "--strike-max", "790",
    "--entry-notional-min", "80",
    "--entry-notional-max", "100",
    "--execution-start", "09:15",
    "--execution-end", "15:45",
    "--order-cooldown-seconds", "2.5",
    "--round-cooldown-seconds", "7",
  ]);
  assert.deepEqual([...policy.underlyings], ["SPY", "QQQ"]);
  assert.equal(policy.entryNotionalMin, 80);
  assert.equal(policy.entryNotionalMax, 100);
  assert.equal(policy.orderCooldownMs, 2_500);
  assert.equal(policy.roundCooldownMs, 7_000);
  assert.equal(isWithinInclusiveRange(84, 84, 90), true);
  assert.equal(isWithinInclusiveRange(90, 84, 90), true);
  assert.equal(isWithinInclusiveRange(83.99, 84, 90), false);
  assert.equal(isWithinInclusiveRange(90.01, 84, 90), false);
});

test("runtime policy rejects inverted time and strike ranges", () => {
  assert.throws(() => parseRuntimePolicy(["--execution-start", "15:45", "--execution-end", "09:15"]), /EXECUTION_WINDOW_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--strike-min", "790", "--strike-max", "720"]), /STRIKE_RANGE_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--order-cooldown-seconds", "0"]), /ORDER_COOLDOWN_INVALID/);
  assert.throws(() => parseRuntimePolicy(["--round-cooldown-seconds", "0"]), /ROUND_COOLDOWN_INVALID/);
});
