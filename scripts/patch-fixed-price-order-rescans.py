from pathlib import Path

runtime_path = Path("src/automation/runtimeOrchestrator.ts")
text = runtime_path.read_text(encoding="utf-8")

old_helper = '''function primaryActiveOpeningOrderIds(): ReadonlyMap<string, string> {
  return runtimeOrderIndex.primaryOpeningOrderIds(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
  );
}
'''
new_helper = '''function primaryActiveOpeningOrders(): readonly Json[] {
  return runtimeOrderIndex.primaryOpeningOrders(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
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
if text.count(old_helper) != 1:
    raise SystemExit(f"PRIMARY_ORDER_HELPER_ANCHOR_MISMATCH:{text.count(old_helper)}")
text = text.replace(old_helper, new_helper, 1)

old_reconcile = '''  if (policy.repeatBuyAtOrderPrice && fixedPriceRefreshRoundActive) {
    const primaryOpeningIds = primaryActiveOpeningOrderIds();
    for (const order of orders) queueFixedPriceRefresh(order, "full-order-reconciliation", primaryOpeningIds);
  }
'''
new_reconcile = '''  if (policy.repeatBuyAtOrderPrice && fixedPriceRefreshRoundActive) {
    const primaryOpeningIds = primaryActiveOpeningOrderIds();
    for (const order of primaryActiveOpeningOrders()) {
      queueFixedPriceRefresh(order, "full-order-reconciliation", primaryOpeningIds);
    }
  }
'''
if text.count(old_reconcile) != 1:
    raise SystemExit(f"FULL_RECONCILE_RESCAN_ANCHOR_MISMATCH:{text.count(old_reconcile)}")
text = text.replace(old_reconcile, new_reconcile, 1)

old_round = '''    const primaryOpeningIds = primaryActiveOpeningOrderIds();
    const candidates = shuffled(orders.filter((order) => {
      const meta = managedOpening(order);
      if (meta === null || !working.has(String(order.status))) return false;
      // Existing external duplicates are left untouched, but fixed-price mode
      // maintains and refreshes only one working opening order per strategy.
      return primaryOpeningIds.get(meta.key) === orderId(order);
    }));
'''
new_round = '''    const primaryOpeningIds = primaryActiveOpeningOrderIds();
    // Existing external duplicates stay untouched. The revision-aware order
    // index has already selected exactly one managed working opening per
    // strategy, so round startup no longer rescans the full broker snapshot.
    const candidates = shuffled(primaryActiveOpeningOrders());
'''
if text.count(old_round) != 1:
    raise SystemExit(f"ROUND_RESCAN_ANCHOR_MISMATCH:{text.count(old_round)}")
text = text.replace(old_round, new_round, 1)
runtime_path.write_text(text, encoding="utf-8")

bench_path = Path("bench/runtime-benchmark.ts")
bench = bench_path.read_text(encoding="utf-8")
old_warmup = '''    orderIndexCache.primaryOpeningOrderIds(corpus, warmup, policy, TRADING_DATE, working);
    orderIndexCache.activeOpeningOrders(corpus, warmup, policy, TRADING_DATE, working, groupKey);
'''
new_warmup = '''    orderIndexCache.primaryOpeningOrders(corpus, warmup, policy, TRADING_DATE, working);
    orderIndexCache.activeOpeningOrders(corpus, warmup, policy, TRADING_DATE, working, groupKey);
'''
if bench.count(old_warmup) != 1:
    raise SystemExit(f"BENCH_WARMUP_ANCHOR_MISMATCH:{bench.count(old_warmup)}")
bench = bench.replace(old_warmup, new_warmup, 1)
old_loop = '''    orderIndexCache.primaryOpeningOrderIds(corpus, revision, policy, TRADING_DATE, working);
    orderIndexCache.activeOpeningOrders(corpus, revision, policy, TRADING_DATE, working, groupKey);
'''
new_loop = '''    orderIndexCache.primaryOpeningOrders(corpus, revision, policy, TRADING_DATE, working);
    orderIndexCache.activeOpeningOrders(corpus, revision, policy, TRADING_DATE, working, groupKey);
'''
if bench.count(old_loop) != 1:
    raise SystemExit(f"BENCH_LOOP_ANCHOR_MISMATCH:{bench.count(old_loop)}")
bench = bench.replace(old_loop, new_loop, 1)
bench_path.write_text(bench, encoding="utf-8")
