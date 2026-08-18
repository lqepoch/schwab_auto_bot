import assert from "node:assert/strict";
import test from "node:test";

import { exactOrderRoot } from "../src/automation/broker/exactOrderResponse.ts";

test("exact-order response accepts an object or one-element array with the requested broker ID", () => {
  const object = { orderId: 42, status: "WORKING" };
  assert.equal(exactOrderRoot<typeof object>(object, "42"), object);

  const arrayRow = { orderId: "00042", status: "FILLED" };
  assert.equal(exactOrderRoot<typeof arrayRow>([arrayRow], "00042"), arrayRow);
});

test("exact-order response rejects malformed envelopes before publication", () => {
  for (const body of [null, undefined, [], [{ orderId: "42" }, { orderId: "43" }], "42"]) {
    assert.throws(() => exactOrderRoot(body, "42"), /AUTHORITATIVE_ORDER_RESPONSE_INVALID/);
  }
});

test("exact-order response fails closed when Schwab returns a different broker resource", () => {
  assert.throws(
    () => exactOrderRoot({ orderId: "43", status: "WORKING" }, "42"),
    /AUTHORITATIVE_ORDER_RESPONSE_ID_MISMATCH/,
  );
});

test("exact-order response uses the canonical strict broker identity contract", () => {
  assert.throws(() => exactOrderRoot({ orderId: "synthetic" }, "42"), /BROKER_ORDER_ID_INVALID/);
  assert.throws(() => exactOrderRoot({ orderId: "42" }, "synthetic"), /BROKER_ORDER_ID_INVALID/);
  assert.throws(() => exactOrderRoot({ orderId: 0 }, "0"), /BROKER_ORDER_ID_INVALID/);
});
