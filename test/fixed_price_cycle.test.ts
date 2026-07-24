import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_PRICE_MAX_ACTIVE_ORDERS, FIXED_PRICE_STARTUP_FILL_GRACE_MS, mayRecoverFixedPriceFill, mayReplenishFixedPrice } from "../src/fixed_price_cycle.ts";

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
