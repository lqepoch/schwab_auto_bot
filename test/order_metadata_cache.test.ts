import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeOrderMetadataCache } from "../src/automation/orderMetadataCache.ts";
import type { Json } from "../src/automation/policy/order.ts";

function openingOrder(): Json {
  return {
    orderId: "101",
    status: "WORKING",
    price: 0.88,
    quantity: 1,
    orderLegCollection: [
      {
        quantity: 1,
        instruction: "BUY_TO_OPEN",
        instrument: { symbol: "QQQ  260818C00740000" },
      },
      {
        quantity: 1,
        instruction: "SELL_TO_OPEN",
        instrument: { symbol: "QQQ  260818C00741000" },
      },
    ],
  };
}

test("reuses parsed metadata when only live order state changes", () => {
  const cache = new RuntimeOrderMetadataCache();
  const order = openingOrder();
  const first = cache.get(order);
  assert.ok(first);

  order.status = "PENDING_REPLACE";
  order.price = 0.89;
  order.quantity = 2;
  order.orderLegCollection[0].quantity = 2;
  order.orderLegCollection[1].quantity = 2;

  const second = cache.get(order);
  assert.equal(second, first);
  assert.equal(second.legs[0].quantity, 2);
});

test("reparses when an OCC symbol changes in place", () => {
  const cache = new RuntimeOrderMetadataCache();
  const order = openingOrder();
  const first = cache.get(order);
  assert.ok(first);
  assert.equal(first.lowerStrike, 740);

  order.orderLegCollection[0].instrument.symbol = "QQQ  260818C00739000";
  const second = cache.get(order);
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(second.lowerStrike, 739);
});

test("reparses when an instruction changes and fails closed on a mixed open/close structure", () => {
  const cache = new RuntimeOrderMetadataCache();
  const order = openingOrder();
  assert.ok(cache.get(order));

  order.orderLegCollection[0].instruction = "BUY_TO_CLOSE";
  assert.equal(cache.get(order), null);
});

test("weak-cache entries remain isolated by broker row identity", () => {
  const cache = new RuntimeOrderMetadataCache();
  const firstOrder = openingOrder();
  const secondOrder = structuredClone(firstOrder);
  const first = cache.get(firstOrder);
  const second = cache.get(secondOrder);
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(second.key, first.key);
});
