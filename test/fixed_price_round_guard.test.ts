import assert from "node:assert/strict";
import test from "node:test";
import { FixedPriceRefreshRoundGuard } from "../src/automation/execution/fixedPriceRoundGuard.ts";

test("a fixed-price refresh round queues each strategy at most once", () => {
  const guard = new FixedPriceRefreshRoundGuard();
  guard.beginRound();
  assert.equal(guard.reserveStrategy("SPY:2026-07-29:P:745:746"), true);
  assert.equal(guard.reserveStrategy("SPY:2026-07-29:P:745:746"), false);
  assert.equal(guard.reserveStrategy("QQQ:2026-07-29:P:722:723"), true);
  guard.endRound();
  guard.beginRound();
  assert.equal(guard.reserveStrategy("SPY:2026-07-29:P:745:746"), true);
});
