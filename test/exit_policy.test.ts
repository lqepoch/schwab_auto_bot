import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_BUY_FILL_DELAY_MS, EXIT_INVENTORY_TRIGGER, EXIT_REFRESH_MS, LIQUIDITY_EXIT_REFRESH_MS, LIQUIDITY_EXIT_REFRESH_ROUNDS, exitEligibility } from "../src/exit_policy.ts";

test("matures every individual buy fill without delaying an older fill", () => {
  const observedAt = 1_000_000;
  assert.deepEqual(exitEligibility(4, 1, 0, observedAt, observedAt + 1), {
    targetUnitSells: 1,
    reason: "matured-individual-fills",
    remainingDelayMs: 0,
  });
  assert.deepEqual(exitEligibility(4, 0, 4, observedAt, observedAt + EXIT_BUY_FILL_DELAY_MS - 1), {
    targetUnitSells: 0,
    reason: "waiting-for-individual-fills",
    remainingDelayMs: 1,
  });
  assert.deepEqual(exitEligibility(4, 0, 4, observedAt, observedAt + EXIT_BUY_FILL_DELAY_MS), {
    targetUnitSells: 4,
    reason: "matured-individual-fills",
    remainingDelayMs: 0,
  });
});

test("inventory threshold starts exits immediately and refresh interval is eight seconds", () => {
  assert.equal(EXIT_INVENTORY_TRIGGER, 5);
  assert.equal(EXIT_REFRESH_MS, 8_000);
  assert.equal(LIQUIDITY_EXIT_REFRESH_MS, 5_000);
  assert.equal(LIQUIDITY_EXIT_REFRESH_ROUNDS, 2);
  assert.deepEqual(exitEligibility(5, 0, 5, 1_000_000, 1_000_001), {
    targetUnitSells: 5,
    reason: "inventory-threshold",
    remainingDelayMs: 0,
  });
});
