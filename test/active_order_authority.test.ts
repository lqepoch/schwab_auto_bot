import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_ORDER_STATUS_FILTERS,
  ACTIVE_ORDER_SWEEP_INTERVAL_MS,
  activeOrderSweepDue,
  isPotentiallyActiveOrder,
  mergeCurrentAuthority,
  missingTrackedActiveOrderIds,
} from "../src/automation/broker/activeOrderAuthority.ts";

type Order = { orderId: string; status: string; source?: string };
const key = (order: Order) => order.orderId;

test("Schwab active status sweep covers mutable broker states needed for duplicate prevention", () => {
  for (const status of [
    "AWAITING_PARENT_ORDER",
    "PENDING_ACTIVATION",
    "QUEUED",
    "WORKING",
    "PENDING_CANCEL",
    "PENDING_REPLACE",
    "UNKNOWN",
  ]) {
    assert.equal(ACTIVE_ORDER_STATUS_FILTERS.includes(status as never), true, status);
  }
});

test("terminal statuses may age out while mutable and unknown future states are retained", () => {
  for (const status of ["REJECTED", "CANCELED", "CANCELLED", "REPLACED", "FILLED", "EXPIRED"]) {
    assert.equal(isPotentiallyActiveOrder({ status }), false, status);
  }
  for (const status of ["WORKING", "PENDING_CANCEL", "PARTIALLY_FILLED", "SOME_FUTURE_STATE", ""]) {
    assert.equal(isPotentiallyActiveOrder({ status }), true, status);
  }
});

test("tracked active orders missing from the recent window are selected for exact refresh", () => {
  const previous: Order[] = [
    { orderId: "old-working", status: "WORKING" },
    { orderId: "old-pending", status: "PENDING_REPLACE" },
    { orderId: "old-filled", status: "FILLED" },
    { orderId: "recent-working", status: "WORKING" },
  ];
  const recent: Order[] = [
    { orderId: "recent-working", status: "WORKING" },
  ];
  assert.deepEqual(
    missingTrackedActiveOrderIds(previous, recent, key),
    ["old-working", "old-pending"],
  );
});

test("recent authority wins any duplicate exact or status-sweep row", () => {
  const recent: Order[] = [{ orderId: "1", status: "WORKING", source: "recent" }];
  const supplemental: Order[] = [
    { orderId: "old", status: "WORKING", source: "sweep" },
    { orderId: "1", status: "PENDING_CANCEL", source: "sweep" },
  ];
  assert.deepEqual(mergeCurrentAuthority(recent, supplemental, key), [
    { orderId: "old", status: "WORKING", source: "sweep" },
    { orderId: "1", status: "WORKING", source: "recent" },
  ]);
});

test("active-order sweep cadence is deterministic and validates clocks", () => {
  const now = 1_000_000;
  assert.equal(activeOrderSweepDue(0, now), true);
  assert.equal(activeOrderSweepDue(now - ACTIVE_ORDER_SWEEP_INTERVAL_MS + 1, now), false);
  assert.equal(activeOrderSweepDue(now - ACTIVE_ORDER_SWEEP_INTERVAL_MS, now), true);
  assert.throws(() => activeOrderSweepDue(-1, now), /ACTIVE_ORDER_SWEEP_STATE_INVALID/);
  assert.throws(() => activeOrderSweepDue(0, Number.NaN), /ACTIVE_ORDER_SWEEP_CLOCK_INVALID/);
});

test("authority merge fails closed on rows without an order ID", () => {
  assert.throws(
    () => mergeCurrentAuthority([{ orderId: "", status: "WORKING" }], [], key),
    /AUTHORITATIVE_ORDER_ID_MISSING/,
  );
});
