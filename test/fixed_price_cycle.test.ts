import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_PRICE_MAX_ACTIVE_ORDERS, mayReplenishFixedPrice } from "../src/fixed_price_cycle.ts";

test("fixed-price mode keeps exactly one working opening order per strategy", () => {
  assert.equal(FIXED_PRICE_MAX_ACTIVE_ORDERS, 1);
  assert.equal(mayReplenishFixedPrice(0), true);
  assert.equal(mayReplenishFixedPrice(1), false);
  assert.equal(mayReplenishFixedPrice(2), false);
});
