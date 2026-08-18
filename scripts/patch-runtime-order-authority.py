from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text(encoding="utf-8")

imports = [
    ('import { managedOpeningInfo } from "./orderIndex.ts";\n', ''),
    ('import { RuntimeOrderMetadataCache } from "./orderMetadataCache.ts";\n', ''),
    ('import { RuntimeOrderIndexCache } from "./orderRuntimeIndex.ts";\n', ''),
    ('import { OrderLookup } from "./broker/orderLookup.ts";\n', 'import { RuntimeOrderAuthority } from "./broker/runtimeOrderAuthority.ts";\n'),
]
for old, new in imports:
    if text.count(old) != 1:
        raise SystemExit(f"IMPORT_ANCHOR_MISMATCH count={text.count(old)} value={old!r}")
    text = text.replace(old, new, 1)

old_state = '''let accountHash = "";
let orders: Json[] = [];
const ordersById = new OrderLookup<Json>((order) => orderId(order));
const orderMetadata = new RuntimeOrderMetadataCache();
const runtimeOrderIndex = new RuntimeOrderIndexCache((order) => orderMetadata.get(order));
let orderAuthorityRevision = 0;
let polling = false;
'''
new_state = '''let accountHash = "";
const orderAuthority = new RuntimeOrderAuthority({
  policy,
  tradingDate: newYorkDate,
  workingStatuses: working,
});
let polling = false;
'''
if text.count(old_state) != 1:
    raise SystemExit(f"STATE_ANCHOR_MISMATCH:{text.count(old_state)}")
text = text.replace(old_state, new_state, 1)

old_authority_helpers = '''function info(order: Json) { return orderMetadata.get(order); }

function orderId(order: Json): string { return brokerOrderId(order); }
function replaceOrders(next: readonly Json[]): void {
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
function getOrder(orderIdValue: string): Json | undefined {
  return ordersById.get(orderIdValue);
}
function getWorkingOrder(orderIdValue: string): Json | undefined {
  const order = getOrder(orderIdValue);
  return order && working.has(String(order.status)) ? order : undefined;
}
'''
new_authority_helpers = '''function info(order: Json) { return orderAuthority.info(order); }

function orderId(order: Json): string { return brokerOrderId(order); }
function replaceOrders(next: readonly Json[]): void { orderAuthority.replace(next); }
function addOrder(order: Json): boolean { return orderAuthority.addIfAbsent(order); }
function getOrder(orderIdValue: string): Json | undefined { return orderAuthority.get(orderIdValue); }
function getWorkingOrder(orderIdValue: string): Json | undefined { return orderAuthority.getWorking(orderIdValue); }
'''
if text.count(old_authority_helpers) != 1:
    raise SystemExit(f"AUTHORITY_HELPERS_ANCHOR_MISMATCH:{text.count(old_authority_helpers)}")
text = text.replace(old_authority_helpers, new_authority_helpers, 1)

old_replace_projection = '''  const source = getOrder(sourceId);
  // Never overwrite a broker-observed terminal or transitional state that
  // arrived while the Replace request was in flight.
  if (source && working.has(String(source.status))) {
    source.status = "REPLACED";
    orderAuthorityRevision += 1;
  }
'''
new_replace_projection = '''  // Never overwrite a broker-observed terminal or transitional state that
  // arrived while the Replace request was in flight. The authority owns the
  // projection and cache invalidation as one operation.
  orderAuthority.projectWorkingStatus(sourceId, "REPLACED");
'''
if text.count(old_replace_projection) != 1:
    raise SystemExit(f"REPLACE_PROJECTION_ANCHOR_MISMATCH:{text.count(old_replace_projection)}")
text = text.replace(old_replace_projection, new_replace_projection, 1)

old_cancel_projection = '''  const current = getOrder(orderIdValue);
  // A broker poll may have observed FILLED/REPLACED/PENDING_* while the Cancel
  // response was in flight. Preserve that fresher authority instead of
  // overwriting it with a local terminal projection.
  if (current && working.has(String(current.status))) {
    current.status = "CANCELED";
    orderAuthorityRevision += 1;
  }
'''
new_cancel_projection = '''  // A broker poll may have observed FILLED/REPLACED/PENDING_* while the Cancel
  // response was in flight. Preserve that fresher authority and let the
  // authority own cache invalidation for a successful local projection.
  orderAuthority.projectWorkingStatus(orderIdValue, "CANCELED");
'''
if text.count(old_cancel_projection) != 1:
    raise SystemExit(f"CANCEL_PROJECTION_ANCHOR_MISMATCH:{text.count(old_cancel_projection)}")
text = text.replace(old_cancel_projection, new_cancel_projection, 1)

old_managed = '''function managedOpening(order: Json): ReturnType<typeof info> {
  const meta = info(order);
  return managedOpeningInfo(order, policy, newYorkDate(), meta);
}
'''
new_managed = '''function managedOpening(order: Json): ReturnType<typeof info> {
  return orderAuthority.managedOpening(order);
}
'''
if text.count(old_managed) != 1:
    raise SystemExit(f"MANAGED_OPENING_ANCHOR_MISMATCH:{text.count(old_managed)}")
text = text.replace(old_managed, new_managed, 1)

old_views = '''function activeOpeningOrders(groupKey: string): readonly Json[] {
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

function workingAllowedUnderlyingOrders(): readonly Json[] {
  return runtimeOrderIndex.workingAllowedOrders(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
  );
}

function currentStrategyOrders(): readonly Json[] {
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
new_views = '''function activeOpeningOrders(groupKey: string): readonly Json[] {
  return orderAuthority.activeOpeningOrders(groupKey);
}

function activeClosingOrders(strategy: string): readonly Json[] {
  return orderAuthority.activeClosingOrders(strategy);
}

function workingAllowedUnderlyingOrders(): readonly Json[] {
  return orderAuthority.workingAllowedOrders();
}

function currentStrategyOrders(): readonly Json[] {
  return orderAuthority.currentOrders();
}

function allActiveClosingOrders(): readonly Json[] {
  return orderAuthority.allActiveClosingOrders();
}

function primaryActiveOpeningOrders(): readonly Json[] {
  return orderAuthority.primaryOpeningOrders();
}

function primaryActiveOpeningOrderIds(): ReadonlyMap<string, string> {
  return orderAuthority.primaryOpeningOrderIds();
}
'''
if text.count(old_views) != 1:
    raise SystemExit(f"VIEW_HELPERS_ANCHOR_MISMATCH:{text.count(old_views)}")
text = text.replace(old_views, new_views, 1)

# Full-authority reads that are intentionally broader than the cached policy/date
# views keep their existing semantics through orderAuthority.all().
text = text.replace('missingTrackedActiveOrderIds(orders, recent, orderId)', 'missingTrackedActiveOrderIds(orderAuthority.all(), recent, orderId)')
text = text.replace('const ids = orders\n    .filter((order) => fingerprintOrder(order) === payloadFingerprint)', 'const ids = orderAuthority.all()\n    .filter((order) => fingerprintOrder(order) === payloadFingerprint)')
text = text.replace('async function reconcileUnknownWritesAfterFullSnapshot(snapshot: readonly Json[] = orders): Promise<void> {', 'async function reconcileUnknownWritesAfterFullSnapshot(snapshot: readonly Json[] = orderAuthority.all()): Promise<void> {')
text = text.replace('orders: orders.length,', 'orders: orderAuthority.all().length,')

# Any remaining explicit full-authority iteration is read-only and should use
# the authority accessor. The compile/source-contract gate below will catch any
# overlooked state declaration or stale cache-revision mutation.
text = text.replace('for (const order of orders) {', 'for (const order of orderAuthority.all()) {')

path.write_text(text, encoding="utf-8")
