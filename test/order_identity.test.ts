import assert from "node:assert/strict";
import test from "node:test";

import { brokerOrderId } from "../src/automation/broker/orderIdentity.ts";

test("broker order identity accepts positive integral numbers and canonical digit strings", () => {
  assert.equal(brokerOrderId({ orderId: 12345 }), "12345");
  assert.equal(brokerOrderId({ orderId: "12345" }), "12345");
  assert.equal(brokerOrderId({ orderId: " 0012345 " }), "12345");
});

test("broker order identity rejects missing, synthetic, non-integral, and unsafe values", () => {
  const invalid: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    {},
    { orderId: undefined },
    { orderId: null },
    { orderId: "" },
    { orderId: "   " },
    { orderId: "undefined" },
    { orderId: "1.5" },
    { orderId: "-1" },
    { orderId: "0" },
    { orderId: 0 },
    { orderId: -1 },
    { orderId: 1.5 },
    { orderId: Number.MAX_SAFE_INTEGER + 1 },
    { orderId: {} },
  ];
  for (const order of invalid) {
    assert.throws(() => brokerOrderId(order), /BROKER_ORDER_ID_INVALID/);
  }
});
