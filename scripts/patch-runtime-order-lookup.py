from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()

# Import the indexed lookup.
anchor = 'import { brokerOrderId } from "./broker/orderIdentity.ts";\n'
insert = anchor + 'import { OrderLookup } from "./broker/orderLookup.ts";\n'
if insert not in text:
    if text.count(anchor) != 1:
        raise SystemExit("orderIdentity import anchor missing")
    text = text.replace(anchor, insert, 1)

# Publish one index alongside the authoritative array.
old_state = 'let orders: Json[] = [];\nlet polling = false;'
new_state = 'let orders: Json[] = [];\nconst ordersById = new OrderLookup<Json>((order) => orderId(order));\nlet polling = false;'
if text.count(old_state) != 1:
    raise SystemExit("orders state anchor missing")
text = text.replace(old_state, new_state, 1)

# Centralize array/index synchronization.
old_helpers = '''function orderId(order: Json): string { return brokerOrderId(order); }
function quantity(order: Json): number { return Number(order.quantity ?? 0); }
'''
new_helpers = '''function orderId(order: Json): string { return brokerOrderId(order); }
function replaceOrders(next: readonly Json[]): void {
  const snapshot = [...next];
  ordersById.replace(snapshot);
  orders = snapshot;
}
function addOrder(order: Json): void {
  ordersById.add(order);
  orders.push(order);
}
function getOrder(orderIdValue: string): Json | undefined {
  return ordersById.get(orderIdValue);
}
function getWorkingOrder(orderIdValue: string): Json | undefined {
  const order = getOrder(orderIdValue);
  return order && working.has(String(order.status)) ? order : undefined;
}
function quantity(order: Json): number { return Number(order.quantity ?? 0); }
'''
if text.count(old_helpers) != 1:
    raise SystemExit("order helper anchor missing")
text = text.replace(old_helpers, new_helpers, 1)

# Snapshot publication becomes atomic across array and index.
text = text.replace('''  onAuthoritativeReplaced: async (incoming) => {
    orders = [...incoming];
  },''', '''  onAuthoritativeReplaced: async (incoming) => {
    replaceOrders(incoming);
  },''', 1)
text = text.replace('''  onFillsMerged: async (incoming, state) => {
    orders = [...state.authoritative] as Json[];
    recordOrderTransitions("fills", incoming);''', '''  onFillsMerged: async (incoming, state) => {
    replaceOrders(state.authoritative as Json[]);
    recordOrderTransitions("fills", incoming);''', 1)

# Local accepted orders update the lookup without rescanning authority.
old_local = '''function applyLocalSubmit(payload: Json, id: string): void {
  orders.push(localOrder(payload, id));
  observedFillQuantities.set(id, 0);
  if (info(payload)?.closing) sellDue.set(id, Date.now() + EXIT_REFRESH_MS);
}

function applyLocalReplace(sourceId: string, payload: Json, replacementId: string): void {
  const source = orders.find((order) => orderId(order) === sourceId);
  if (source) source.status = "REPLACED";
  orders.push(localOrder(payload, replacementId));
  observedFillQuantities.set(replacementId, 0);
  if (info(payload)?.closing) sellDue.set(replacementId, Date.now() + EXIT_REFRESH_MS);
}
'''
new_local = '''function applyLocalSubmit(payload: Json, id: string): void {
  addOrder(localOrder(payload, id));
  observedFillQuantities.set(id, 0);
  if (info(payload)?.closing) sellDue.set(id, Date.now() + EXIT_REFRESH_MS);
}

function applyLocalReplace(sourceId: string, payload: Json, replacementId: string): void {
  const source = getOrder(sourceId);
  if (source) source.status = "REPLACED";
  addOrder(localOrder(payload, replacementId));
  observedFillQuantities.set(replacementId, 0);
  if (info(payload)?.closing) sellDue.set(replacementId, Date.now() + EXIT_REFRESH_MS);
}
'''
if text.count(old_local) != 1:
    raise SystemExit("local order mutation anchor missing")
text = text.replace(old_local, new_local, 1)

replacements = {
    'const source = orders.find((order) => orderId(order) === replaceOrderId);':
        'const source = getOrder(replaceOrderId);',
    '? () => orders.find((order) => orderId(order) === replaceTargetOrderId)':
        '? () => getOrder(replaceTargetOrderId)',
    'const currentSource = orders.find((order) => orderId(order) === replaceTargetOrderId);':
        'const currentSource = getOrder(replaceTargetOrderId);',
    'const source = orders.find((order) => orderId(order) === orderIdValue);':
        'const source = getOrder(orderIdValue);',
    'targetOrder: () => orders.find((order) => orderId(order) === orderIdValue),':
        'targetOrder: () => getOrder(orderIdValue),',
    'const currentTarget = orders.find((order) => orderId(order) === orderIdValue);':
        'const currentTarget = getOrder(orderIdValue);',
    'const current = orders.find((order) => orderId(order) === orderIdValue);':
        'const current = getOrder(orderIdValue);',
    'const current = orders.find((order) => orderId(order) === id);':
        'const current = getWorkingOrder(id);',
    'const latest = orders.find((order) => orderId(order) === id);':
        'const latest = getWorkingOrder(id);',
    'const liveSell = orders.find((order) => orderId(order) === id);':
        'const liveSell = getWorkingOrder(id);',
}
for old, new in replacements.items():
    count = text.count(old)
    if count == 0:
        raise SystemExit(f"runtime lookup anchor missing: {old}")
    text = text.replace(old, new)

old_explorer = 'const current = logical.brokerOrderId === null ? null : orders.find((order) => orderId(order) === logical.brokerOrderId && working.has(String(order.status)));'
new_explorer = 'const current = logical.brokerOrderId === null ? null : (getWorkingOrder(logical.brokerOrderId) ?? null);'
if text.count(old_explorer) != 1:
    raise SystemExit("price explorer lookup anchor missing")
text = text.replace(old_explorer, new_explorer, 1)

# Existing guards remain deliberately redundant after indexed retrieval.
# They verify semantics at the call site and protect future lookup reuse.
if 'orders.find(' in text:
    raise SystemExit("linear order ID lookup remains")

path.write_text(text)
