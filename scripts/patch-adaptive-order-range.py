from pathlib import Path

runtime_path = Path("src/automation/runtimeOrchestrator.ts")
text = runtime_path.read_text()

old_import = '''import {
  ACTIVE_ORDER_QUERY_LIMIT,
  ACTIVE_ORDER_STATUS_FILTERS,
  ACTIVE_ORDER_SWEEP_LOOKBACK_MS,
  activeOrderSweepDue,
  mergeCurrentAuthority,
  missingTrackedActiveOrderIds,
} from "./broker/activeOrderAuthority.ts";
'''
new_import = '''import {
  ACTIVE_ORDER_QUERY_LIMIT,
  ACTIVE_ORDER_STATUS_FILTERS,
  ACTIVE_ORDER_SWEEP_LOOKBACK_MS,
  activeOrderSweepDue,
  mergeCurrentAuthority,
  missingTrackedActiveOrderIds,
} from "./broker/activeOrderAuthority.ts";
import { fetchCompleteOrderRange } from "./broker/completeOrderRange.ts";
'''
if text.count(old_import) != 1:
    raise SystemExit("complete-order-range import patch point missing")
text = text.replace(old_import, new_import)

old_fetch = '''async function fetchOrderRange(
  fromEnteredTime: string,
  toEnteredTime: string,
  priority: Priority,
  status?: string,
): Promise<Json[]> {
  const query = new URLSearchParams({
    fromEnteredTime,
    toEnteredTime,
    maxResults: String(ACTIVE_ORDER_QUERY_LIMIT),
  });
  if (status) query.set("status", status);
  const response = await api(`/trader/v1/accounts/${accountHash}/orders?${query}`, {}, priority);
  if (!Array.isArray(response.body)) throw new Error("订单快照不是数组");
  // Treat a page exactly at Schwab's requested ceiling as potentially
  // truncated. Partial authority is less safe than keeping the write barrier
  // closed; a later adaptive-range reader can improve liveness here.
  if (response.body.length >= ACTIVE_ORDER_QUERY_LIMIT) {
    throw new Error(`ORDER_SNAPSHOT_RANGE_SATURATED status=${status ?? "ALL"}`);
  }
  return flatten(response.body);
}
'''
new_fetch = '''async function fetchOrderRangePage(
  fromEnteredTime: string,
  toEnteredTime: string,
  priority: Priority,
  status?: string,
): Promise<Json[]> {
  const query = new URLSearchParams({
    fromEnteredTime,
    toEnteredTime,
    maxResults: String(ACTIVE_ORDER_QUERY_LIMIT),
  });
  if (status) query.set("status", status);
  const response = await api(`/trader/v1/accounts/${accountHash}/orders?${query}`, {}, priority);
  if (!Array.isArray(response.body)) throw new Error("订单快照不是数组");
  return response.body as Json[];
}

async function fetchOrderRange(
  fromEnteredTime: string,
  toEnteredTime: string,
  priority: Priority,
  status?: string,
): Promise<Json[]> {
  const roots = await fetchCompleteOrderRange(
    { fromEnteredTime, toEnteredTime },
    (range) => fetchOrderRangePage(
      range.fromEnteredTime,
      range.toEnteredTime,
      priority,
      status,
    ),
    {
      maxResults: ACTIVE_ORDER_QUERY_LIMIT,
      key: (order) => orderId(order),
    },
  );
  return flatten(roots);
}
'''
if text.count(old_fetch) != 1:
    raise SystemExit("runtime saturated-range patch point missing")
text = text.replace(old_fetch, new_fetch)
runtime_path.write_text(text)

static_path = Path("test/runtime_active_order_authority.test.ts")
text = static_path.read_text()
old_test = '''test("order-range pages at the requested Schwab ceiling fail closed instead of becoming partial authority", async () => {
  const source = await readFile(runtimeSourceUrl, "utf8");
  const rangeStart = source.indexOf("async function fetchOrderRange(");
  const exactStart = source.indexOf("async function fetchExactOrderTree(", rangeStart);
  assert.notEqual(rangeStart, -1);
  assert.notEqual(exactStart, -1);
  const range = source.slice(rangeStart, exactStart);
  assert.match(range, /response\\.body\\.length >= ACTIVE_ORDER_QUERY_LIMIT/);
  assert.match(range, /ORDER_SNAPSHOT_RANGE_SATURATED/);
});
'''
new_test = '''test("order-range pages at Schwab's ceiling are adaptively partitioned before becoming authority", async () => {
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
'''
if text.count(old_test) != 1:
    raise SystemExit("runtime active-authority static test patch point missing")
static_path.write_text(text.replace(old_test, new_test))
