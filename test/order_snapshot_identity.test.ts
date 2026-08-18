import assert from "node:assert/strict";
import test from "node:test";

import { OrderSnapshotCoordinator } from "../src/automation/broker/orderSnapshotCoordinator.ts";

test("default snapshot merge key rejects malformed fill identities without replacing authority", async () => {
  type Order = { orderId?: unknown; status: string };
  const failures: Array<[string, unknown]> = [];
  const coordinator = new OrderSnapshotCoordinator<Order>({
    fetch: async (scope) => scope === "full"
      ? [{ orderId: "1", status: "WORKING" }]
      : [{ status: "FILLED" }],
    reconcileUnknownWrites: async () => undefined,
    onFailure: (scope, error) => failures.push([scope, error]),
  });

  assert.equal(await coordinator.pollFull(), true);
  assert.deepEqual(coordinator.authoritative, [{ orderId: "1", status: "WORKING" }]);

  assert.equal(await coordinator.pollFills(), false);
  assert.deepEqual(coordinator.authoritative, [{ orderId: "1", status: "WORKING" }]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.[0], "fills");
  assert.match(String(failures[0]?.[1]), /BROKER_ORDER_ID_INVALID/);
});

test("malformed reconciliation supplements keep the full write barrier closed", async () => {
  type Order = { orderId?: unknown; status: string };
  const failures: Array<[string, unknown]> = [];
  let reconciliations = 0;
  const coordinator = new OrderSnapshotCoordinator<Order>({
    fetch: async () => [{ orderId: "1", status: "WORKING" }],
    reconciliationSupplement: async () => [{ status: "FILLED" }],
    reconcileUnknownWrites: async () => { reconciliations += 1; },
    onFailure: (scope, error) => failures.push([scope, error]),
  });

  assert.equal(await coordinator.pollFull(), false);
  assert.equal(coordinator.fullSnapshotReconciled, false);
  assert.equal(reconciliations, 0);
  assert.equal(failures[0]?.[0], "full");
  assert.match(String(failures[0]?.[1]), /BROKER_ORDER_ID_INVALID/);
});

test("explicit mergeKey remains available for non-broker generic snapshot use", async () => {
  type Row = { key: string; status: string };
  const coordinator = new OrderSnapshotCoordinator<Row>({
    fetch: async (scope) => scope === "full"
      ? [{ key: "A", status: "WORKING" }]
      : [{ key: "A", status: "FILLED" }],
    reconcileUnknownWrites: async () => undefined,
    mergeKey: (row) => row.key,
  });

  assert.equal(await coordinator.pollFull(), true);
  assert.equal(await coordinator.pollFills(), true);
  assert.deepEqual(coordinator.authoritative, [{ key: "A", status: "FILLED" }]);
});
