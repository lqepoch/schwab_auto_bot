import assert from "node:assert/strict";
import test from "node:test";

import { OrderLookup } from "../src/automation/broker/orderLookup.ts";

type Order = { orderId: string; status: string };
const lookup = () => new OrderLookup<Order>((order) => order.orderId);

test("order lookup replaces a snapshot and provides constant-key reads", () => {
  const index = lookup();
  const first = { orderId: "1", status: "WORKING" };
  const second = { orderId: "2", status: "FILLED" };
  index.replace([first, second]);
  assert.equal(index.size, 2);
  assert.equal(index.get("1"), first);
  assert.equal(index.get("2"), second);
  assert.equal(index.get("3"), undefined);
});

test("replacement validates duplicates before publishing the new index", () => {
  const index = lookup();
  const existing = { orderId: "1", status: "WORKING" };
  index.replace([existing]);
  assert.throws(
    () => index.replace([
      { orderId: "2", status: "WORKING" },
      { orderId: "2", status: "FILLED" },
    ]),
    /BROKER_ORDER_ID_DUPLICATE/,
  );
  assert.equal(index.size, 1);
  assert.equal(index.get("1"), existing);
  assert.equal(index.get("2"), undefined);
});

test("local add rejects a duplicate without overwriting broker state", () => {
  const index = lookup();
  const existing = { orderId: "7", status: "WORKING" };
  index.replace([existing]);
  assert.throws(
    () => index.add({ orderId: "7", status: "FILLED" }),
    /BROKER_ORDER_ID_DUPLICATE/,
  );
  assert.equal(index.get("7"), existing);
});
