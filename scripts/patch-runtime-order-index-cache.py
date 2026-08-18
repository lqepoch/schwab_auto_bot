from pathlib import Path

runtime_path = Path("src/automation/runtimeOrchestrator.ts")
text = runtime_path.read_text(encoding="utf-8")

old_import = '''import {
  buildPrimaryActiveOpeningOrderIds,
  managedOpeningInfo,
  selectActiveOpeningOrders,
} from "./orderIndex.ts";
'''
new_import = '''import { managedOpeningInfo } from "./orderIndex.ts";
import { RuntimeOrderIndexCache } from "./orderRuntimeIndex.ts";
'''
if text.count(old_import) != 1:
    raise SystemExit(f"ORDER_INDEX_IMPORT_ANCHOR_MISMATCH:{text.count(old_import)}")
text = text.replace(old_import, new_import, 1)

old_state = '''let accountHash = "";
let orders: Json[] = [];
const ordersById = new OrderLookup<Json>((order) => orderId(order));
let polling = false;
'''
new_state = '''let accountHash = "";
let orders: Json[] = [];
const ordersById = new OrderLookup<Json>((order) => orderId(order));
const runtimeOrderIndex = new RuntimeOrderIndexCache();
let orderAuthorityRevision = 0;
let polling = false;
'''
if text.count(old_state) != 1:
    raise SystemExit(f"ORDER_AUTHORITY_STATE_ANCHOR_MISMATCH:{text.count(old_state)}")
text = text.replace(old_state, new_state, 1)

old_replace_add = '''function replaceOrders(next: readonly Json[]): void {
  const snapshot = [...next];
  ordersById.replace(snapshot);
  orders = snapshot;
}
function addOrder(order: Json): boolean {
  // An authoritative REST poll may observe a just-accepted order before the
  // caller publishes its local synthetic copy. Keep the broker row in that
  // race because it carries fresher status/execution metadata.
  if (!ordersById.addIfAbsent(order)) return false;
  orders.push(order);
  return true;
}
'''
new_replace_add = '''function replaceOrders(next: readonly Json[]): void {
  const snapshot = [...next];
  ordersById.replace(snapshot);
  orders = snapshot;
  orderAuthorityRevision += 1;
}
function addOrder(order: Json): boolean {
  // An authoritative REST poll may observe a just-accepted order before the
  // caller publishes its local synthetic copy. Keep the broker row in that
  // race because it carries fresher status/execution metadata.
  if (!ordersById.addIfAbsent(order)) return false;
  orders.push(order);
  orderAuthorityRevision += 1;
  return true;
}
'''
if text.count(old_replace_add) != 1:
    raise SystemExit(f"ORDER_AUTHORITY_MUTATION_ANCHOR_MISMATCH:{text.count(old_replace_add)}")
text = text.replace(old_replace_add, new_replace_add, 1)

old_local_replace = '''  // Never overwrite a broker-observed terminal or transitional state that
  // arrived while the Replace request was in flight.
  if (source && working.has(String(source.status))) source.status = "REPLACED";
  observedFillQuantities.set(replacementId, 0);
'''
new_local_replace = '''  // Never overwrite a broker-observed terminal or transitional state that
  // arrived while the Replace request was in flight.
  if (source && working.has(String(source.status))) {
    source.status = "REPLACED";
    orderAuthorityRevision += 1;
  }
  observedFillQuantities.set(replacementId, 0);
'''
if text.count(old_local_replace) != 1:
    raise SystemExit(f"LOCAL_REPLACE_REVISION_ANCHOR_MISMATCH:{text.count(old_local_replace)}")
text = text.replace(old_local_replace, new_local_replace, 1)

old_cancel = '''  // A broker poll may have observed FILLED/REPLACED/PENDING_* while the Cancel
  // response was in flight. Preserve that fresher authority instead of
  // overwriting it with a local terminal projection.
  if (current && working.has(String(current.status))) current.status = "CANCELED";
  executionJournal.record("broker.cancel.accepted", { key, orderId: orderIdValue, path });
'''
new_cancel = '''  // A broker poll may have observed FILLED/REPLACED/PENDING_* while the Cancel
  // response was in flight. Preserve that fresher authority instead of
  // overwriting it with a local terminal projection.
  if (current && working.has(String(current.status))) {
    current.status = "CANCELED";
    orderAuthorityRevision += 1;
  }
  executionJournal.record("broker.cancel.accepted", { key, orderId: orderIdValue, path });
'''
if text.count(old_cancel) != 1:
    raise SystemExit(f"LOCAL_CANCEL_REVISION_ANCHOR_MISMATCH:{text.count(old_cancel)}")
text = text.replace(old_cancel, new_cancel, 1)

old_helpers = '''function activeOpeningOrders(groupKey: string): Json[] {
  return selectActiveOpeningOrders(orders, groupKey, newYorkDate(), policy.underlyings, working);
}

function primaryActiveOpeningOrderIds(): Map<string, string> {
  return buildPrimaryActiveOpeningOrderIds(orders, policy, newYorkDate(), working);
}
'''
new_helpers = '''function activeOpeningOrders(groupKey: string): readonly Json[] {
  return runtimeOrderIndex.activeOpeningOrders(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
    groupKey,
  );
}

function activeClosingOrders(strategy: string): readonly Json[] {
  return runtimeOrderIndex.activeClosingOrders(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
    strategy,
  );
}

function primaryActiveOpeningOrderIds(): ReadonlyMap<string, string> {
  return runtimeOrderIndex.primaryOpeningOrderIds(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
  );
}
'''
if text.count(old_helpers) != 1:
    raise SystemExit(f"ORDER_INDEX_HELPER_ANCHOR_MISMATCH:{text.count(old_helpers)}")
text = text.replace(old_helpers, new_helpers, 1)

old_closure = '''  const inventory = inventoryByStrategy.get(strategy) ?? 0;
  const activeClosingOrders = (): Json[] => orders.filter((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.closing && meta.key === strategy
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying);
  }).sort((left, right) => eventTime(left) - eventTime(right) || orderId(left).localeCompare(orderId(right)));
  const active = activeClosingOrders();
'''
new_closure = '''  const inventory = inventoryByStrategy.get(strategy) ?? 0;
  const currentActiveClosingOrders = (): readonly Json[] => activeClosingOrders(strategy);
  const active = currentActiveClosingOrders();
'''
if text.count(old_closure) != 1:
    raise SystemExit(f"ACTIVE_CLOSING_SCAN_ANCHOR_MISMATCH:{text.count(old_closure)}")
text = text.replace(old_closure, new_closure, 1)

# Only references inside evaluateExitStrategy should now call the renamed local helper.
# Global activeClosingOrders(strategy) must remain untouched.
evaluate_anchor = 'async function evaluateExitStrategy(strategy: string, template: Json, forceStartup: boolean): Promise<void> {'
if text.count(evaluate_anchor) != 1:
    raise SystemExit("EVALUATE_EXIT_ANCHOR_MISMATCH")
prefix, tail = text.split(evaluate_anchor, 1)
end_anchor = '\nfunction evaluateExits(forceStartup = false): void {'
if tail.count(end_anchor) != 1:
    raise SystemExit("EVALUATE_EXIT_END_ANCHOR_MISMATCH")
evaluate_body, suffix = tail.split(end_anchor, 1)
if evaluate_body.count('activeClosingOrders()') != 2:
    raise SystemExit(f"ACTIVE_CLOSING_CALL_COUNT_MISMATCH:{evaluate_body.count('activeClosingOrders()')}")
evaluate_body = evaluate_body.replace('activeClosingOrders()', 'currentActiveClosingOrders()')
text = prefix + evaluate_anchor + evaluate_body + end_anchor + suffix
runtime_path.write_text(text, encoding="utf-8")

bench_path = Path("bench/runtime-benchmark.ts")
bench = bench_path.read_text(encoding="utf-8")
old_bench_import = '''import {
  buildPrimaryActiveOpeningOrderIds,
  selectActiveOpeningOrders,
} from "../src/automation/orderIndex.ts";
'''
new_bench_import = '''import { RuntimeOrderIndexCache } from "../src/automation/orderRuntimeIndex.ts";
'''
if bench.count(old_bench_import) != 1:
    raise SystemExit(f"BENCH_ORDER_INDEX_IMPORT_ANCHOR_MISMATCH:{bench.count(old_bench_import)}")
bench = bench.replace(old_bench_import, new_bench_import, 1)

old_bench_loop = '''  for (let warmup = 0; warmup < 5; warmup += 1) {
    buildPrimaryActiveOpeningOrderIds(corpus, policy, TRADING_DATE, working);
    selectActiveOpeningOrders(corpus, groupKey, TRADING_DATE, policy.underlyings, working);
  }
  let startedAt = performance.now();
  for (let iteration = 0; iteration < ORDER_ITERATIONS; iteration += 1) {
    buildPrimaryActiveOpeningOrderIds(corpus, policy, TRADING_DATE, working);
    selectActiveOpeningOrders(corpus, groupKey, TRADING_DATE, policy.underlyings, working);
  }
  const orderIndex = metric(ORDER_ITERATIONS * CORPUS_SIZE * 2, startedAt);
'''
new_bench_loop = '''  const orderIndexCache = new RuntimeOrderIndexCache();
  for (let warmup = 0; warmup < 5; warmup += 1) {
    orderIndexCache.primaryOpeningOrderIds(corpus, warmup, policy, TRADING_DATE, working);
    orderIndexCache.activeOpeningOrders(corpus, warmup, policy, TRADING_DATE, working, groupKey);
  }
  let startedAt = performance.now();
  for (let iteration = 0; iteration < ORDER_ITERATIONS; iteration += 1) {
    // A single authoritative order revision is normally queried by many
    // strategies before the next REST/activity reconciliation. Force three
    // rebuilds here so the benchmark measures both rebuild and cache-hit work.
    const revision = Math.floor(iteration / 10);
    orderIndexCache.primaryOpeningOrderIds(corpus, revision, policy, TRADING_DATE, working);
    orderIndexCache.activeOpeningOrders(corpus, revision, policy, TRADING_DATE, working, groupKey);
  }
  const orderIndex = metric(ORDER_ITERATIONS * CORPUS_SIZE * 2, startedAt);
'''
if bench.count(old_bench_loop) != 1:
    raise SystemExit(f"BENCH_ORDER_INDEX_LOOP_ANCHOR_MISMATCH:{bench.count(old_bench_loop)}")
bench = bench.replace(old_bench_loop, new_bench_loop, 1)
bench_path.write_text(bench, encoding="utf-8")
