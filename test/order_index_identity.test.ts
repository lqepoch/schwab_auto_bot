import assert from "node:assert/strict";
import test from "node:test";

import { compareOpeningOrders, orderIdentifier } from "../src/automation/orderIndex.ts";

test("opening order index uses canonical strict broker IDs", () => {
  assert.equal(orderIdentifier({ orderId: 123 }), "123");
  assert.equal(orderIdentifier({ orderId: "00123" }), "123");
  assert.throws(() => orderIdentifier({}), /BROKER_ORDER_ID_INVALID/);
  assert.throws(() => orderIdentifier({ orderId: "undefined" }), /BROKER_ORDER_ID_INVALID/);
});

test("opening-order tie breaking fails closed instead of sorting malformed identities", () => {
  const base = {
    price: 0.9,
    enteredTime: "2026-08-18T13:00:00.000Z",
  };
  assert.throws(
    () => compareOpeningOrders({ ...base }, { ...base, orderId: 2 }),
    /BROKER_ORDER_ID_INVALID/,
  );
});
