import assert from "node:assert/strict";
import test from "node:test";
import { OrderSnapshotCoordinator, RuntimeStartupCoordinator } from "../src/order_snapshot_coordinator.ts";

type Order = { orderId: string; status: string };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

test("full poll replaces authority, reconciles, then marks fresh and emits transitions", async () => {
  let now = 10_000;
  const order: Order = { orderId: "1", status: "WORKING" };
  const events: string[] = [];
  const coordinator = new OrderSnapshotCoordinator<Order>({
    fetch: async (scope) => {
      events.push(`fetch:${scope}`);
      return [order];
    },
    reconcileUnknownWrites: async (orders) => {
      events.push(`reconcile:${orders[0]?.orderId}`);
    },
    onAuthoritativeReplaced: async () => { events.push("authoritative-replaced"); },
    onFullReconciled: async () => { events.push("transitions"); },
    clock: { now: () => now },
  });

  assert.equal(await coordinator.pollFull(), true);
  assert.deepEqual(events, ["fetch:full", "authoritative-replaced", "reconcile:1", "transitions"]);
  assert.equal(coordinator.fullSnapshotReconciled, true);
  assert.equal(coordinator.isFresh(5_000, now + 5_000), true);
  assert.equal(coordinator.isFresh(5_000, now + 5_001), false);
  assert.equal(coordinator.state.generation, 1);
  assert.deepEqual(coordinator.authoritative, [order]);
});

test("full reconciliation failure keeps write readiness false and reports failure", async () => {
  const failures: Array<[string, unknown]> = [];
  const coordinator = new OrderSnapshotCoordinator<Order>({
    fetch: async () => [{ orderId: "1", status: "WORKING" }],
    reconcileUnknownWrites: async () => { throw new Error("WAL_RECONCILIATION_FAILED"); },
    onFailure: (scope, error) => failures.push([scope, error]),
    clock: { now: () => 10_000 },
  });
  assert.equal(await coordinator.pollFull(), false);
  assert.equal(coordinator.fullSnapshotReconciled, false);
  assert.equal(coordinator.isFresh(5_000, 10_000), false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.[0], "full");
  assert.match(String(failures[0]?.[1]), /WAL_RECONCILIATION_FAILED/);
});

test("full snapshot stays blocked while consumer callback side effects are pending", async () => {
  const callback = deferred<void>();
  let callbackStarted = false;
  const coordinator = new OrderSnapshotCoordinator<Order>({
    fetch: async () => [{ orderId: "1", status: "WORKING" }],
    reconcileUnknownWrites: async () => undefined,
    onFullReconciled: async () => {
      callbackStarted = true;
      await callback.promise;
    },
    clock: { now: () => 10_000 },
  });

  const full = coordinator.pollFull();
  while (!callbackStarted) await Promise.resolve();
  assert.equal(coordinator.fullSnapshotReconciled, false);
  assert.equal(coordinator.fullReconciliationInProgress, true);
  assert.equal(coordinator.isFresh(5_000, 10_000), false);

  callback.resolve();
  assert.equal(await full, true);
  assert.equal(coordinator.fullSnapshotReconciled, true);
  assert.equal(coordinator.fullReconciliationInProgress, false);
  assert.equal(coordinator.isFresh(5_000, 10_000), true);
});

test("fill poll can finish during a slow full reconciliation but cannot open the full write barrier", async () => {
  const reconcile = deferred<void>();
  const fillFetch = deferred<readonly Order[]>();
  const events: string[] = [];
  const coordinator = new OrderSnapshotCoordinator<Order>({
    fetch: async (scope) => scope === "full"
      ? [{ orderId: "full", status: "WORKING" }]
      : fillFetch.promise,
    reconcileUnknownWrites: async () => {
      events.push("reconcile-start");
      await reconcile.promise;
      events.push("reconcile-done");
    },
    onFillsMerged: async () => { events.push("fills-merged"); },
    clock: { now: () => 10_000 },
  });

  const full = coordinator.pollFull();
  await Promise.resolve();
  assert.equal(coordinator.fullReconciliationInProgress, true);
  assert.equal(coordinator.isFresh(5_000, 10_000), false);
  const fills = coordinator.pollFills();
  fillFetch.resolve([{ orderId: "fill", status: "FILLED" }]);
  assert.equal(await fills, true);
  assert.equal(coordinator.fullReconciliationInProgress, true);
  assert.equal(coordinator.fullSnapshotReconciled, false);
  assert.deepEqual(events, ["reconcile-start", "fills-merged"]);

  reconcile.resolve();
  assert.equal(await full, true);
  assert.equal(coordinator.fullSnapshotReconciled, true);
  assert.equal(coordinator.authoritative.some((order) => order.orderId === "fill"), true);
  assert.deepEqual(events, ["reconcile-start", "fills-merged", "reconcile-done"]);
});

test("concurrent full polls collapse to one fetch and one reconciliation", async () => {
  let fetches = 0;
  let reconciliations = 0;
  const gate = deferred<void>();
  const coordinator = new OrderSnapshotCoordinator<Order>({
    fetch: async () => {
      fetches += 1;
      return [{ orderId: "1", status: "WORKING" }];
    },
    reconcileUnknownWrites: async () => {
      reconciliations += 1;
      await gate.promise;
    },
  });
  const first = coordinator.pollFull();
  const second = coordinator.pollFull();
  assert.equal(await second, false);
  await Promise.resolve();
  assert.equal(fetches, 1);
  assert.equal(reconciliations, 1);
  gate.resolve();
  assert.equal(await first, true);
});

test("startup does not start stream or timers after bootstrap/full snapshot failure", async (t) => {
  await t.test("bootstrap failure", async () => {
    const events: string[] = [];
    const startup = new RuntimeStartupCoordinator({
      bootstrap: async () => { events.push("bootstrap"); throw new Error("ACCOUNT_MISMATCH"); },
      fullSnapshot: async () => { events.push("full"); return true; },
      startActivityStream: async () => { events.push("stream"); },
      startTimers: async () => { events.push("timers"); },
      onBlocked: async (reason) => { events.push(`blocked:${reason}`); },
    });
    assert.equal(await startup.start(), false);
    assert.deepEqual(events, ["bootstrap", "blocked:bootstrap-failed"]);
  });
  await t.test("full snapshot failure", async () => {
    const events: string[] = [];
    const startup = new RuntimeStartupCoordinator({
      bootstrap: async () => { events.push("bootstrap"); },
      fullSnapshot: async () => { events.push("full"); return false; },
      startActivityStream: async () => { events.push("stream"); },
      startTimers: async () => { events.push("timers"); },
      onBlocked: async (reason) => { events.push(`blocked:${reason}`); },
    });
    assert.equal(await startup.start(), false);
    assert.deepEqual(events, ["bootstrap", "full", "blocked:full-snapshot-failed"]);
  });
  await t.test("only ready startup starts stream and timers after readiness", async () => {
    const events: string[] = [];
    const startup = new RuntimeStartupCoordinator({
      bootstrap: async () => { events.push("bootstrap"); },
      fullSnapshot: async () => { events.push("full"); return true; },
      onReady: async () => { events.push("ready"); },
      startActivityStream: async () => { events.push("stream"); },
      startTimers: async () => { events.push("timers"); },
    });
    assert.equal(await startup.start(), true);
    assert.deepEqual(events, ["bootstrap", "full", "ready", "stream", "timers"]);
  });
});
