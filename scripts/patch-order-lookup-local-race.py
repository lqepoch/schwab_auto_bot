from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()
old = '''function addOrder(order: Json): void {
  ordersById.add(order);
  orders.push(order);
}
'''
new = '''function addOrder(order: Json): void {
  // An authoritative REST poll may observe a just-accepted order before the
  // caller publishes its local synthetic copy. Keep the broker row in that
  // race because it carries fresher status/execution metadata.
  if (!ordersById.addIfAbsent(order)) return;
  orders.push(order);
}
'''
if text.count(old) != 1:
    raise SystemExit("local addOrder anchor missing")
text = text.replace(old, new, 1)
path.write_text(text)
