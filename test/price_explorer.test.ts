import assert from "node:assert/strict";
import test from "node:test";
import { clampPrice, PriceExplorer } from "../src/automation/execution/priceExplorer.ts";

test("pairs only two same-price full fills within ten seconds and consumes them once", () => {
  const explorer = new PriceExplorer();
  const first = explorer.recordCompleteFill("QQQ:vertical", "1", 89, 1_000);
  assert.equal(first.triggered, false);
  assert.equal(first.actions[0].priceCents, 89);
  const mixed = explorer.recordCompleteFill("QQQ:vertical", "2", 88, 2_000);
  assert.equal(mixed.triggered, false);
  const pair = explorer.recordCompleteFill("QQQ:vertical", "3", 89, 3_000);
  assert.equal(pair.triggered, true);
  assert.deepEqual(pair.actions.map((action) => [action.kind, action.priceCents]), [["ensure", 88]]);
  assert.equal(explorer.recordCompleteFill("QQQ:vertical", "3", 89, 3_001).actions.length, 0);
  assert.equal(explorer.recordCompleteFill("QQQ:vertical", "4", 89, 14_000).triggered, false);
});

test("refuses an execution price outside the hard exploration range", () => {
  const explorer = new PriceExplorer();
  assert.equal(clampPrice(82), 82);
  assert.equal(clampPrice(92), 92);
  assert.throws(() => explorer.recordCompleteFill("QQQ:vertical", "1", 81, 1_000), /EXPLORER_FILL_PRICE_OUT_OF_RANGE/);
  assert.throws(() => explorer.recordCompleteFill("QQQ:vertical", "2", 93, 1_000), /EXPLORER_FILL_PRICE_OUT_OF_RANGE/);
});

test("persists unacknowledged actions so an interrupted broker write can resume safely", () => {
  const explorer = new PriceExplorer();
  explorer.recordCompleteFill("QQQ:vertical", "1", 90, 0);
  const transition = explorer.recordCompleteFill("QQQ:vertical", "2", 90, 1_000);
  const restored = new PriceExplorer(explorer.snapshot());
  assert.deepEqual(
    restored.due("QQQ:vertical", 1_000).map((action) => [action.kind, action.priceCents]),
    transition.actions.map((action) => [action.kind, action.priceCents]),
  );
});

test("recovers an unfilled logical order that a previous runtime acknowledged without a broker order", () => {
  const explorer = new PriceExplorer();
  const first = explorer.recordCompleteFill("QQQ:vertical", "1", 90, 1_000);
  explorer.acknowledge("QQQ:vertical", first.actions[0]);
  assert.deepEqual(explorer.planMissingOrderRecovery("QQQ:vertical", 2_000), [{
    generation: 0,
    dueAt: 2_000,
    logicalId: "l1",
    kind: "ensure",
    priceCents: 90,
    binding: false,
  }]);
});

test("generation rollover drops stale unbound recovery while retaining broker-bound orders", () => {
  const explorer = new PriceExplorer();
  const first = explorer.recordCompleteFill("QQQ:vertical", "fill-1", 90, 1_000);
  assert.equal(first.actions[0].logicalId, "l1");
  const workingId = explorer.registerWorkingOrder("QQQ:vertical", "working-1", 88, 1_500);
  assert.equal(workingId, "l2");

  const pair = explorer.recordCompleteFill("QQQ:vertical", "fill-2", 90, 2_000);
  assert.equal(pair.generation, 1);
  assert.equal(explorer.order("QQQ:vertical", "l1"), null);
  assert.equal(explorer.order("QQQ:vertical", workingId)?.brokerOrderId, "working-1");
  assert.deepEqual(explorer.activeLogicalOrders("QQQ:vertical").map((order) => order.id), [workingId]);
});

test("legacy snapshots seed missing logical generations without reusing logical ids", () => {
  const restored = new PriceExplorer({
    groups: {
      "QQQ:vertical": {
        width: 1,
        generation: 4,
        nextLogicalId: 3,
        fills: {},
        consumedFillIds: [],
        logicalOrders: {
          l2: { id: "l2", brokerOrderId: null, priceCents: 90, createdAt: 10, filled: false },
        },
        firstBatch: [],
        delayed: null,
        tasks: [],
      },
    },
  } as any);

  assert.deepEqual(restored.planMissingOrderRecovery("QQQ:vertical", 20), [{
    generation: 4,
    dueAt: 20,
    logicalId: "l2",
    kind: "ensure",
    priceCents: 90,
    binding: false,
  }]);
  assert.equal(restored.registerWorkingOrder("QQQ:vertical", "broker-3", 91, 30), "l3");
});

test("compaction keeps filled first-batch evidence until three-order resolution", () => {
  const explorer = new PriceExplorer({
    groups: {
      "QQQ:vertical": {
        width: 3,
        generation: 2,
        nextLogicalId: 5,
        fills: {},
        consumedFillIds: [],
        logicalOrders: {
          l1: { id: "l1", generation: 1, brokerOrderId: null, priceCents: 88, createdAt: 1, filled: true },
          l2: { id: "l2", generation: 2, brokerOrderId: null, priceCents: 89, createdAt: 2, filled: true },
          l3: { id: "l3", generation: 2, brokerOrderId: null, priceCents: 90, createdAt: 3, filled: false },
          l4: { id: "l4", generation: 2, brokerOrderId: null, priceCents: 90, createdAt: 4, filled: false },
        },
        firstBatch: ["l2", "l3"],
        delayed: "l4",
        tasks: [{ generation: 2, dueAt: 100, logicalId: "l2", kind: "resolve-three" }],
      },
    },
  } as any);

  assert.equal(explorer.order("QQQ:vertical", "l1"), null);
  assert.equal(explorer.order("QQQ:vertical", "l2")?.filled, true);
  assert.deepEqual(
    explorer.resolveThree("QQQ:vertical", 2, 100).map((action) => [action.kind, action.logicalId, action.priceCents]),
    [["ensure", "l2", 89], ["ensure", "l3", 90]],
  );
});

test("one logical order's scheduled action does not block a peer's round recovery", () => {
  const explorer = new PriceExplorer();
  explorer.registerWorkingOrder("QQQ:vertical", "one", 88, 1);
  explorer.registerWorkingOrder("QQQ:vertical", "two", 89, 2);
  const first = explorer.recordCompleteFill("QQQ:vertical", "fill", 89, 3);
  assert.equal(first.actions.length, 1);
  assert.deepEqual(
    explorer.planRoundRecovery("QQQ:vertical", 10).map((action) => action.logicalId),
    ["l1", "l2"],
  );
});

test("single mode creates the exact two-order exploration schedule", () => {
  const explorer = new PriceExplorer();
  explorer.recordCompleteFill("QQQ:vertical", "1", 90, 0);
  const transition = explorer.recordCompleteFill("QQQ:vertical", "2", 90, 1_000);
  assert.equal(transition.triggered, true);
  for (const action of transition.actions) explorer.acknowledge("QQQ:vertical", action);
  const later = explorer.due("QQQ:vertical", 11_001);
  assert.deepEqual(
    later.map((action) => [action.dueAt, action.kind, action.priceCents]),
    [[3_000, "ensure", 89], [5_000, "set-price", 90], [7_000, "refresh", undefined], [11_000, "set-price", 91]],
  );
});

test("a later pair enters three-order mode and invalidates earlier generation tasks", () => {
  const explorer = new PriceExplorer();
  explorer.recordCompleteFill("QQQ:vertical", "1", 89, 0);
  explorer.recordCompleteFill("QQQ:vertical", "2", 89, 1_000);
  explorer.recordCompleteFill("QQQ:vertical", "3", 89, 2_000);
  const transition = explorer.recordCompleteFill("QQQ:vertical", "4", 89, 3_000);
  assert.equal(transition.triggered, true);
  assert.equal(transition.generation, 2);
  for (const action of transition.actions) explorer.acknowledge("QQQ:vertical", action);
  const scheduled = explorer.due("QQQ:vertical", 13_000);
  assert.deepEqual(
    scheduled.map((action) => [action.dueAt, action.kind, action.priceCents]),
    [[5_000, "ensure", 89], [7_000, "refresh", undefined], [7_200, "refresh", undefined], [9_000, "resolve-three", undefined], [11_000, "refresh", undefined], [11_200, "refresh", undefined]],
  );
});

test("three-order branch chooses delayed recovery based on first-batch fills", () => {
  const explorer = new PriceExplorer();
  explorer.recordCompleteFill("QQQ:vertical", "1", 89, 0);
  explorer.recordCompleteFill("QQQ:vertical", "2", 89, 1);
  explorer.recordCompleteFill("QQQ:vertical", "3", 89, 2);
  explorer.recordCompleteFill("QQQ:vertical", "4", 89, 3);
  for (const action of explorer.due("QQQ:vertical", 6_003)) {
    if (action.kind !== "resolve-three") explorer.acknowledge("QQQ:vertical", action);
  }
  const branch = explorer.resolveThree("QQQ:vertical", 2, 6_003);
  assert.deepEqual(branch.map((action) => [action.kind, action.priceCents]), [["ensure", 89], ["ensure", 89]]);
});
