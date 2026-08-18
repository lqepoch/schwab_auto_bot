from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text(encoding="utf-8")

primary_anchor = 'function primaryActiveOpeningOrders(): readonly Json[] {\n'
all_closing_helper = '''function allActiveClosingOrders(): readonly Json[] {
  return runtimeOrderIndex.allActiveClosingOrders(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
  );
}

'''
if text.count(primary_anchor) != 1:
    raise SystemExit(f"PRIMARY_HELPER_ANCHOR_MISMATCH:{text.count(primary_anchor)}")
text = text.replace(primary_anchor, all_closing_helper + primary_anchor, 1)

old_adopt = '''  const active = new Set<string>();
  for (const order of orders) {
    const meta = info(order);
    if (
      !meta?.closing || !working.has(String(order.status))
      || meta.expiration !== newYorkDate() || !policy.underlyings.has(meta.underlying)
    ) continue;
    active.add(orderId(order));
    if (!sellDue.has(orderId(order))) {
      const refreshAt = Date.now() + EXIT_REFRESH_MS;
      sellDue.set(orderId(order), refreshAt);
      executionJournal.record("exit.working-sell-adopted", {
        strategy: meta.key,
        orderId: orderId(order),
        refreshAt: new Date(refreshAt).toISOString(),
      });
    }
  }
'''
new_adopt = '''  const active = new Set<string>();
  for (const order of allActiveClosingOrders()) {
    const meta = info(order);
    if (!meta) continue;
    const id = orderId(order);
    active.add(id);
    if (!sellDue.has(id)) {
      const refreshAt = Date.now() + EXIT_REFRESH_MS;
      sellDue.set(id, refreshAt);
      executionJournal.record("exit.working-sell-adopted", {
        strategy: meta.key,
        orderId: id,
        refreshAt: new Date(refreshAt).toISOString(),
      });
    }
  }
'''
if text.count(old_adopt) != 1:
    raise SystemExit(f"ADOPT_SELLS_ANCHOR_MISMATCH:{text.count(old_adopt)}")
text = text.replace(old_adopt, new_adopt, 1)

old_due = '''  const nextSellRefresh = orders
    .filter((order) => info(order)?.closing && info(order)?.key === strategy)
    .map((order) => sellDue.get(orderId(order)) ?? Number.POSITIVE_INFINITY)
    .filter((dueAt) => dueAt > now)
    .sort((left, right) => left - right)[0];
'''
new_due = '''  const nextSellRefresh = activeClosingOrders(strategy)
    .map((order) => sellDue.get(orderId(order)) ?? Number.POSITIVE_INFINITY)
    .filter((dueAt) => dueAt > now)
    .sort((left, right) => left - right)[0];
'''
if text.count(old_due) != 1:
    raise SystemExit(f"NEXT_EXIT_DUE_ANCHOR_MISMATCH:{text.count(old_due)}")
text = text.replace(old_due, new_due, 1)

old_needs = '''function exitStrategyNeedsWorker(strategy: string): boolean {
  if (liquidityExitRefreshes.has(strategy) || (inventoryByStrategy.get(strategy) ?? 0) > 0) return true;
  return orders.some((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.closing && meta.key === strategy
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying);
  });
}
'''
new_needs = '''function exitStrategyNeedsWorker(strategy: string): boolean {
  if (liquidityExitRefreshes.has(strategy) || (inventoryByStrategy.get(strategy) ?? 0) > 0) return true;
  return activeClosingOrders(strategy).length > 0;
}
'''
if text.count(old_needs) != 1:
    raise SystemExit(f"EXIT_WORKER_NEEDS_ANCHOR_MISMATCH:{text.count(old_needs)}")
text = text.replace(old_needs, new_needs, 1)

path.write_text(text, encoding="utf-8")
