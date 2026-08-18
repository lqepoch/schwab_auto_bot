import assert from "node:assert/strict";
import test from "node:test";
import { OrderSnapshotCoordinator } from "../src/automation/broker/orderSnapshotCoordinator.ts";

type Order = { orderId: string; status: string; source: string };

test("reconciliation supplements are visible to WAL recovery but never enter authoritative orders", async () => {
  const current: Order = { orderId: "current", status: "WORKING", source: "primary" };
  const historical: Order = { orderId: "historical", status: "FILLED", source: "recovery" };
  const staleDuplicate: Order = { orderId: "current", status: "CANCELED", source: "recovery" };
  let reconciled: readonly Order[] = [];
  let authoritativeCallback: readonly Order[] = [];
  let fullCallback: readonly Order[] = [];

  const coordinator = new OrderSnapshotCoordinator<Order>({
    fetch: async () => [current],
    reconciliationSupplement: async (authoritative) => {
      assert.deepEqual(authoritative, [current]);
      return [historical, staleDuplicate];
    },
    reconcileUnknownWrites: async (orders) => { reconciled = [...orders]; },
    onAuthoritativeReplaced: async (orders) => { authoritativeCallback = [...orders]; },
    onFullReconciled: async (orders) => { fullCallback = [...orders]; },
    mergeKey: (order) => order.orderId,
    clock: { now: () => 10_000 },
  });

  assert.equal(await coordinator.pollFull(), true);
  assert.deepEqual(authoritativeCallback, [current]);
  assert.deepEqual(fullCallback, [current]);
  assert.deepEqual(coordinator.authoritative, [current]);
  assert.equal(coordinator.authoritative.some((order) => order.orderId === "historical"), false);
  assert.deepEqual(
    reconciled.map((order) => [order.orderId, order.status, order.source]),
    [
      ["historical", "FILLED", "recovery"],
      ["current", "WORKING", "primary"],
    ],
  );
});

test("reconciliation supplement failure keeps the full write-readiness barrier closed", async () => {
  const current: Order = { orderId: "current", status: "WORKING", source: "primary" };
  const failures: unknown[] = [];
  let reconciliationCalls = 0;
  const coordinator = new OrderSnapshotCoordinator<Order>({
    fetch: async () => [current],
    reconciliationSupplement: async () => { throw new Error("RECOVERY_READ_FAILED"); },
    reconcileUnknownWrites: async () => { reconciliationCalls += 1; },
    onFailure: (_scope, error) => { failures.push(error); },
    mergeKey: (order) => order.orderId,
    clock: { now: () => 10_000 },
  });

  assert.equal(await coordinator.pollFull(), false);
  assert.deepEqual(coordinator.authoritative, [current]);
  assert.equal(coordinator.fullSnapshotReconciled, false);
  assert.equal(coordinator.isFresh(5_000, 10_000), false);
  assert.equal(reconciliationCalls, 0);
  assert.match(String(failures[0]), /RECOVERY_READ_FAILED/);
});
