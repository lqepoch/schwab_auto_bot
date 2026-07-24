import assert from "node:assert/strict";
import test from "node:test";
import { FixedPriceReplenishmentGuard, FIXED_PRICE_MAX_ACTIVE_ORDERS, FIXED_PRICE_STARTUP_FILL_GRACE_MS, STALE_ORDER_RECREATE_AGE_MS, STALE_ORDER_RECREATE_RETRY_MS, mayRecreateStaleOrder, mayRecoverFixedPriceFill, mayReplenishFixedPrice } from "../src/fixed_price_cycle.ts";

test("fixed-price mode keeps exactly one working opening order per strategy", () => {
  assert.equal(FIXED_PRICE_MAX_ACTIVE_ORDERS, 1);
  assert.equal(mayReplenishFixedPrice(0), true);
  assert.equal(mayReplenishFixedPrice(1), false);
  assert.equal(mayReplenishFixedPrice(2), false);
});

test("recovers a recent pre-start fill but ignores historical initial-snapshot fills", () => {
  const startedAt = 1_000_000;
  assert.equal(mayRecoverFixedPriceFill(startedAt - FIXED_PRICE_STARTUP_FILL_GRACE_MS, startedAt), true);
  assert.equal(mayRecoverFixedPriceFill(startedAt - FIXED_PRICE_STARTUP_FILL_GRACE_MS - 1, startedAt), false);
  assert.equal(mayRecoverFixedPriceFill(startedAt + 90_000, startedAt), true);
});

test("recreates each old working order on its own ten-second retry clock", () => {
  assert.equal(STALE_ORDER_RECREATE_RETRY_MS, 10_000);
  assert.equal(mayRecreateStaleOrder(1_000, 1_000 + STALE_ORDER_RECREATE_AGE_MS - 1, 0), false);
  assert.equal(mayRecreateStaleOrder(1_000, 1_000 + STALE_ORDER_RECREATE_AGE_MS, 0), true);
  assert.equal(mayRecreateStaleOrder(1_000, 1_000 + STALE_ORDER_RECREATE_AGE_MS, 2_000_000), false);
});

test("reserves one immediate replenishment per strategy and cools down a rejected fill", () => {
  const guard = new FixedPriceReplenishmentGuard();
  assert.equal(guard.reserve("QQQ:741:742", "fill-1", 1_000), true);
  assert.equal(guard.reserve("QQQ:741:742", "fill-1", 1_000), false);
  assert.equal(guard.reserve("QQQ:741:742", "fill-2", 1_000), false);
  guard.release("QQQ:741:742", "fill-1");
  guard.defer("fill-1", 31_000);
  assert.equal(guard.reserve("QQQ:741:742", "fill-1", 30_999), false);
  assert.equal(guard.reserve("QQQ:741:742", "fill-1", 31_000), true);
});
