import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_IDLE_BUY_FILL_DELAY_MS, EXIT_INVENTORY_TRIGGER, EXIT_REFRESH_MS, LIQUIDITY_EXIT_DELAY_MS, LIQUIDITY_EXIT_REFRESH_MS, LIQUIDITY_EXIT_REFRESH_ROUNDS, exitEligibility, exitRefreshNeeded, maySubmitExit } from "../src/exit_policy.ts";

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

test("does not start an exit countdown from inventory observation without a confirmed buy fill", () => {
  assert.deepEqual(exitEligibility(1, null, 9_000_000), {
    targetQuantity: 0,
    reason: "waiting-for-confirmed-buy-fill",
    remainingDelayMs: EXIT_IDLE_BUY_FILL_DELAY_MS,
  });
});

test("inventory threshold starts exits immediately and refresh interval is eight seconds", () => {
  assert.equal(EXIT_INVENTORY_TRIGGER, 5);
  assert.equal(EXIT_REFRESH_MS, 8_000);
  assert.equal(LIQUIDITY_EXIT_DELAY_MS, 0);
  assert.equal(LIQUIDITY_EXIT_REFRESH_MS, 5_000);
  assert.equal(LIQUIDITY_EXIT_REFRESH_ROUNDS, 2);
  assert.deepEqual(exitEligibility(5, 1_000_000, 1_000_001), {
    targetQuantity: 5,
    reason: "inventory-threshold",
    remainingDelayMs: 0,
  });
});

test("never submits a second sell while a working sell or stale submit job exists", () => {
  assert.equal(maySubmitExit(0, false), true);
  assert.equal(maySubmitExit(1, false), false);
  assert.equal(maySubmitExit(0, true), false);
});

test("does not send a broker Replace for an unchanged working sell", () => {
  assert.equal(exitRefreshNeeded(0.99, 1, 1, 0.99, 1), false);
  assert.equal(exitRefreshNeeded(0.99, 1, 1, 0.99, 2), true);
  assert.equal(exitRefreshNeeded(0.98, 1, 1, 0.99, 1), true);
  assert.equal(exitRefreshNeeded(0.99, 1, 0, 0.99, 1), true);
});
