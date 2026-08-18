import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

test("runtime hydrates and refreshes active orders outside the short recent window", async () => {
  const source = await readFile(runtimeSourceUrl, "utf8");
  const helperStart = source.indexOf("async function fetchLiveAuthoritativeOrders(now: Date, priority: Priority)");
  const coordinatorStart = source.indexOf("const orderSnapshotCoordinator = new OrderSnapshotCoordinator<Json>({", helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(coordinatorStart, -1);
  const helper = source.slice(helperStart, coordinatorStart);

  assert.match(helper, /DEFAULT_FULL_ORDER_LOOKBACK_MS/);
  assert.match(helper, /activeOrderSweepDue\(lastActiveOrderSweepAt, now\.getTime\(\)\)/);
  assert.match(helper, /for \(const status of ACTIVE_ORDER_STATUS_FILTERS\)/);
  assert.match(helper, /ACTIVE_ORDER_SWEEP_LOOKBACK_MS/);
  assert.match(helper, /missingTrackedActiveOrderIds\(orders, recent, orderId\)/);
  assert.match(helper, /fetchExactOrderTree\(orderIdValue, priority\)/);
  assert.match(helper, /mergeCurrentAuthority\(recent, supplemental, orderId\)/);

  const coordinatorBlock = source.slice(coordinatorStart, source.indexOf("function recordOrderTransitions", coordinatorStart));
  assert.match(coordinatorBlock, /if \(scope === "full"\) return fetchLiveAuthoritativeOrders\(now, priority\)/);
  assert.match(coordinatorBlock, /reconciliationSupplement:/);
});

test("order-range pages at the requested Schwab ceiling fail closed instead of becoming partial authority", async () => {
  const source = await readFile(runtimeSourceUrl, "utf8");
  const rangeStart = source.indexOf("async function fetchOrderRange(");
  const exactStart = source.indexOf("async function fetchExactOrderTree(", rangeStart);
  assert.notEqual(rangeStart, -1);
  assert.notEqual(exactStart, -1);
  const range = source.slice(rangeStart, exactStart);
  assert.match(range, /response\.body\.length >= ACTIVE_ORDER_QUERY_LIMIT/);
  assert.match(range, /ORDER_SNAPSHOT_RANGE_SATURATED/);
});
