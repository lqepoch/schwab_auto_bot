from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text(encoding="utf-8")

old_helpers = '''function allActiveClosingOrders(): readonly Json[] {
  return runtimeOrderIndex.allActiveClosingOrders(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
  );
}

function primaryActiveOpeningOrders(): readonly Json[] {
'''
new_helpers = '''function currentStrategyOrders(): readonly Json[] {
  return runtimeOrderIndex.currentOrders(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
  );
}

function allActiveClosingOrders(): readonly Json[] {
  return runtimeOrderIndex.allActiveClosingOrders(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
  );
}

function primaryActiveOpeningOrders(): readonly Json[] {
'''
if text.count(old_helpers) != 1:
    raise SystemExit(f"CURRENT_ORDER_HELPER_ANCHOR_MISMATCH:{text.count(old_helpers)}")
text = text.replace(old_helpers, new_helpers, 1)

old_spread_scan = '''function reportWorkingRefreshSpreadSkips(): void {
  const today = newYorkDate();
  for (const order of orders) {
    const meta = info(order);
    if (
      !working.has(String(order.status))
      || !meta
      || meta.expiration !== today
      || !policy.underlyings.has(meta.underlying)
      || !policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
    ) continue;
    recordRefreshSpreadSkip(order, "order-snapshot");
  }
}
'''
new_spread_scan = '''function reportWorkingRefreshSpreadSkips(): void {
  for (const order of currentStrategyOrders()) {
    const meta = info(order);
    if (
      !working.has(String(order.status))
      || !meta
      || !policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
    ) continue;
    recordRefreshSpreadSkip(order, "order-snapshot");
  }
}
'''
if text.count(old_spread_scan) != 1:
    raise SystemExit(f"SPREAD_SCAN_ANCHOR_MISMATCH:{text.count(old_spread_scan)}")
text = text.replace(old_spread_scan, new_spread_scan, 1)

old_reconcile_explorer = '''function reconcileExplorerSnapshot(): void {
  const liveByGroup = new Map<string, Set<string>>();
  for (const order of orders) {
    const meta = managedOpening(order);
'''
new_reconcile_explorer = '''function reconcileExplorerSnapshot(): void {
  const liveByGroup = new Map<string, Set<string>>();
  for (const order of currentStrategyOrders()) {
    const meta = managedOpening(order);
'''
if text.count(old_reconcile_explorer) != 1:
    raise SystemExit(f"EXPLORER_RECONCILE_ANCHOR_MISMATCH:{text.count(old_reconcile_explorer)}")
text = text.replace(old_reconcile_explorer, new_reconcile_explorer, 1)

old_detect = '''function detectExplorerFills(): void {
  const now = Date.now();
  const fillPriceSource = policy.repeatBuyAtOrderPrice ? "orderLimit" : "actualNet";
  for (const order of orders) {
    const meta = managedOpening(order);
'''
new_detect = '''function detectExplorerFills(): void {
  const now = Date.now();
  const fillPriceSource = policy.repeatBuyAtOrderPrice ? "orderLimit" : "actualNet";
  for (const order of currentStrategyOrders()) {
    const meta = managedOpening(order);
'''
if text.count(old_detect) != 1:
    raise SystemExit(f"DETECT_FILLS_ANCHOR_MISMATCH:{text.count(old_detect)}")
text = text.replace(old_detect, new_detect, 1)

old_inventory = '''function trackInventoryFillDeltas(): void {
  const today = newYorkDate();
  for (const order of orders) {
    const meta = info(order);
    if (!meta || meta.expiration !== today || !policy.underlyings.has(meta.underlying)) continue;
'''
new_inventory = '''function trackInventoryFillDeltas(): void {
  for (const order of currentStrategyOrders()) {
    const meta = info(order);
    if (!meta) continue;
'''
if text.count(old_inventory) != 1:
    raise SystemExit(f"INVENTORY_SCAN_ANCHOR_MISMATCH:{text.count(old_inventory)}")
text = text.replace(old_inventory, new_inventory, 1)

old_positions = '''async function reconcilePositions(announce = true): Promise<void> {
  const current = await positions();
  const templates = new Map<string, Json>(exitTemplatesByStrategy);
  for (const order of orders) {
    const meta = info(order);
    if (
      !meta || meta.expiration !== newYorkDate()
      || !policy.underlyings.has(meta.underlying)
    ) continue;
    if (!templates.has(meta.key) || meta.opening) {
'''
new_positions = '''async function reconcilePositions(announce = true): Promise<void> {
  const current = await positions();
  const templates = new Map<string, Json>(exitTemplatesByStrategy);
  for (const order of currentStrategyOrders()) {
    const meta = info(order);
    if (!meta) continue;
    if (!templates.has(meta.key) || meta.opening) {
'''
if text.count(old_positions) != 1:
    raise SystemExit(f"POSITION_SCAN_ANCHOR_MISMATCH:{text.count(old_positions)}")
text = text.replace(old_positions, new_positions, 1)

old_exit_templates = '''function exitTemplates(): Map<string, Json> {
  const latest = new Map<string, Json>();
  for (const order of orders) {
    const meta = info(order);
    if (
      order.status !== "FILLED" || !meta?.opening
      || !policy.underlyings.has(meta.underlying)
      || meta.expiration !== newYorkDate()
      || !policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
    ) continue;
    const previous = latest.get(meta.key);
    if (!previous || eventTime(order) > eventTime(previous)) latest.set(meta.key, order);
    recordOpeningFillLot(meta.key, order);
  }
  for (const order of orders) {
    const meta = info(order);
    if (
      meta?.closing && working.has(String(order.status))
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying)
      && policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
      && !latest.has(meta.key)
    ) {
      latest.set(meta.key, order);
    }
  }
  for (const order of orders) {
    const meta = info(order);
    if (
      meta?.opening && meta.expiration === newYorkDate()
      && policy.underlyings.has(meta.underlying)
      && policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
      && (inventoryByStrategy.get(meta.key) ?? 0) > 0
      && !latest.has(meta.key)
    ) latest.set(meta.key, order);
  }
'''
new_exit_templates = '''function exitTemplates(): Map<string, Json> {
  const latest = new Map<string, Json>();
  const currentOrders = currentStrategyOrders();
  for (const order of currentOrders) {
    const meta = info(order);
    if (
      order.status !== "FILLED" || !meta?.opening
      || !policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
    ) continue;
    const previous = latest.get(meta.key);
    if (!previous || eventTime(order) > eventTime(previous)) latest.set(meta.key, order);
    recordOpeningFillLot(meta.key, order);
  }
  for (const order of currentOrders) {
    const meta = info(order);
    if (
      meta?.closing && working.has(String(order.status))
      && policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
      && !latest.has(meta.key)
    ) {
      latest.set(meta.key, order);
    }
  }
  for (const order of currentOrders) {
    const meta = info(order);
    if (
      meta?.opening
      && policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
      && (inventoryByStrategy.get(meta.key) ?? 0) > 0
      && !latest.has(meta.key)
    ) latest.set(meta.key, order);
  }
'''
if text.count(old_exit_templates) != 1:
    raise SystemExit(f"EXIT_TEMPLATE_SCAN_ANCHOR_MISMATCH:{text.count(old_exit_templates)}")
text = text.replace(old_exit_templates, new_exit_templates, 1)

old_still_working = '''        const stillWorking = orders.some((order) => working.has(String(order.status)) && info(order)?.closing && info(order)?.key === strategy);
'''
new_still_working = '''        const stillWorking = activeClosingOrders(strategy).length > 0;
'''
if text.count(old_still_working) != 1:
    raise SystemExit(f"STALE_RECREATE_SCAN_ANCHOR_MISMATCH:{text.count(old_still_working)}")
text = text.replace(old_still_working, new_still_working, 1)

old_exit_priority = '''function hasExitPriority(groupKey: string): boolean {
  if (policy.disableSellOrders) return false;
  if (liquidityExitRefreshes.has(groupKey)) return true;
  return orders.some((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.closing && meta.key === groupKey
      && meta.expiration === newYorkDate() && policy.underlyings.has(meta.underlying);
  });
}
'''
new_exit_priority = '''function hasExitPriority(groupKey: string): boolean {
  if (policy.disableSellOrders) return false;
  if (liquidityExitRefreshes.has(groupKey)) return true;
  return activeClosingOrders(groupKey).length > 0;
}
'''
if text.count(old_exit_priority) != 1:
    raise SystemExit(f"EXIT_PRIORITY_SCAN_ANCHOR_MISMATCH:{text.count(old_exit_priority)}")
text = text.replace(old_exit_priority, new_exit_priority, 1)

path.write_text(text, encoding="utf-8")
