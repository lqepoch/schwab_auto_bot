import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_IDLE_BUY_FILL_DELAY_MS, EXIT_INVENTORY_TRIGGER, EXIT_REFRESH_MS, LIQUIDITY_EXIT_DELAY_MS, LIQUIDITY_EXIT_REFRESH_MS, LIQUIDITY_EXIT_REFRESH_ROUNDS, exitEligibility } from "../src/exit_policy.ts";

test("resets a vertical's full-exit countdown on its most recent buy fill", () => {
  const lastBuyFillAt = 1_000_000;
  assert.deepEqual(exitEligibility(4, lastBuyFillAt, lastBuyFillAt + EXIT_IDLE_BUY_FILL_DELAY_MS - 1), {
    targetQuantity: 0,
    reason: "waiting-for-idle-window",
    remainingDelayMs: 1,
  });
  assert.deepEqual(exitEligibility(4, lastBuyFillAt, lastBuyFillAt + EXIT_IDLE_BUY_FILL_DELAY_MS), {
    targetQuantity: 4,
    reason: "idle-after-buy-fill",
    remainingDelayMs: 0,
  });
});

test("inventory threshold starts exits immediately and refresh interval is eight seconds", () => {
  assert.equal(EXIT_INVENTORY_TRIGGER, 5);
  assert.equal(EXIT_REFRESH_MS, 8_000);
  assert.equal(LIQUIDITY_EXIT_DELAY_MS, 15_000);
  assert.equal(LIQUIDITY_EXIT_REFRESH_MS, 5_000);
  assert.equal(LIQUIDITY_EXIT_REFRESH_ROUNDS, 2);
  assert.deepEqual(exitEligibility(5, 1_000_000, 1_000_001), {
    targetQuantity: 5,
    reason: "inventory-threshold",
    remainingDelayMs: 0,
  });
});
