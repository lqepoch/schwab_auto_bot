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
  assert.match(helper, /missingTrackedActiveOrderIds\(orderAuthority\.all\(\), recent, orderId\)/);
  assert.match(helper, /fetchExactOrderTree\(orderIdValue, priority\)/);
  assert.match(helper, /mergeCurrentAuthority\(recent, supplemental, orderId\)/);

  const coordinatorBlock = source.slice(coordinatorStart, source.indexOf("function recordOrderTransitions", coordinatorStart));
  assert.match(coordinatorBlock, /if \(scope === "full"\) return fetchLiveAuthoritativeOrders\(now, priority\)/);
  assert.match(coordinatorBlock, /reconciliationSupplement:/);
});

test("order-range pages at Schwab's ceiling are adaptively partitioned before becoming authority", async () => {
  const source = await readFile(runtimeSourceUrl, "utf8");
  const pageStart = source.indexOf("async function fetchOrderRangePage(");
  const exactStart = source.indexOf("async function fetchExactOrderTree(", pageStart);
  assert.notEqual(pageStart, -1);
  assert.notEqual(exactStart, -1);
  const range = source.slice(pageStart, exactStart);
  assert.match(range, /fetchCompleteOrderRange/);
  assert.match(range, /maxResults: ACTIVE_ORDER_QUERY_LIMIT/);
  assert.match(range, /key: \(order\) => orderId\(order\)/);
  assert.doesNotMatch(range, /ORDER_SNAPSHOT_RANGE_SATURATED/);
});
