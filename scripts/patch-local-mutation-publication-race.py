from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
source = path.read_text(encoding="utf-8")

replacements = [
    (
'''function addOrder(order: Json): void {
  // An authoritative REST poll may observe a just-accepted order before the
  // caller publishes its local synthetic copy. Keep the broker row in that
  // race because it carries fresher status/execution metadata.
  if (!ordersById.addIfAbsent(order)) return;
  orders.push(order);
}''',
'''function addOrder(order: Json): boolean {
  // An authoritative REST poll may observe a just-accepted order before the
  // caller publishes its local synthetic copy. Keep the broker row in that
  // race because it carries fresher status/execution metadata.
  if (!ordersById.addIfAbsent(order)) return false;
  orders.push(order);
  return true;
}'''
    ),
    (
'''function applyLocalSubmit(payload: Json, id: string): void {
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
}''',
'''function applyLocalSubmit(payload: Json, id: string): void {
  if (!addOrder(localOrder(payload, id))) return;
  observedFillQuantities.set(id, 0);
  if (info(payload)?.closing) sellDue.set(id, Date.now() + EXIT_REFRESH_MS);
}

function applyLocalReplace(sourceId: string, payload: Json, replacementId: string): void {
  // Publish the synthetic replacement only when REST authority has not already
  // observed it. A concurrent broker poll wins, including its fill/status data.
  if (!addOrder(localOrder(payload, replacementId))) return;
  const source = getOrder(sourceId);
  // Never overwrite a broker-observed terminal or transitional state that
  // arrived while the Replace request was in flight.
  if (source && working.has(String(source.status))) source.status = "REPLACED";
  observedFillQuantities.set(replacementId, 0);
  if (info(payload)?.closing) sellDue.set(replacementId, Date.now() + EXIT_REFRESH_MS);
}'''
    ),
    (
'''  const current = getOrder(orderIdValue);
  if (current) current.status = "CANCELED";
  executionJournal.record("broker.cancel.accepted", { key, orderId: orderIdValue, path });''',
'''  const current = getOrder(orderIdValue);
  // A broker poll may have observed FILLED/REPLACED/PENDING_* while the Cancel
  // response was in flight. Preserve that fresher authority instead of
  // overwriting it with a local terminal projection.
  if (current && working.has(String(current.status))) current.status = "CANCELED";
  executionJournal.record("broker.cancel.accepted", { key, orderId: orderIdValue, path });'''
    ),
]

for old, new in replacements:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"PATCH_ANCHOR_MISMATCH count={count} anchor={old[:80]!r}")
    source = source.replace(old, new, 1)

path.write_text(source, encoding="utf-8")
