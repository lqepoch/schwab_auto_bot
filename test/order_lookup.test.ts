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

test("authoritative observation wins a race with local accepted-order publication", () => {
  const index = lookup();
  const authoritative = { orderId: "7", status: "WORKING" };
  index.replace([authoritative]);
  assert.equal(index.addIfAbsent({ orderId: "7", status: "ACCEPTED" }), false);
  assert.equal(index.size, 1);
  assert.equal(index.get("7"), authoritative);

  const local = { orderId: "8", status: "WORKING" };
  assert.equal(index.addIfAbsent(local), true);
  assert.equal(index.get("8"), local);
});
