from pathlib import Path

state_path = Path("src/automation/state/unknownWriteReconciliation.ts")
source = state_path.read_text(encoding="utf-8")

anchors = [
    (
        "  private readonly idFactory: () => string;\n  private operationTail: Promise<void> = Promise.resolve();",
        "  private readonly idFactory: () => string;\n  private readonly orderId: (order: BrokerOrderSnapshot) => string;\n  private operationTail: Promise<void> = Promise.resolve();",
    ),
    (
        "    options: { now?: () => string; idFactory?: () => string } = {},",
        "    options: {\n      now?: () => string;\n      idFactory?: () => string;\n      orderId?: (order: BrokerOrderSnapshot) => string;\n    } = {},",
    ),
    (
        "    this.idFactory = options.idFactory ?? randomUUID;\n  }",
        "    this.idFactory = options.idFactory ?? randomUUID;\n    this.orderId = options.orderId ?? ((order) => String(order.orderId ?? \"\"));\n  }",
    ),
]
for old, new in anchors:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"UNKNOWN_WRITE_ANCHOR_MISMATCH count={count} anchor={old[:80]!r}")
    source = source.replace(old, new, 1)

# Scope the mechanical replacement to reconcile(). The constructor's generic
# default intentionally retains String(order.orderId ?? "") so the public
# abstraction remains backward-compatible for callers that do not opt into the
# strict Schwab broker identity contract.
reconcile_anchor = "  async reconcile(orders: readonly BrokerOrderSnapshot[]): Promise<ReconciliationResult> {"
if source.count(reconcile_anchor) != 1:
    raise SystemExit("UNKNOWN_WRITE_RECONCILE_ANCHOR_MISMATCH")
prefix, reconciliation = source.split(reconcile_anchor, 1)
identity_anchor = 'String(order.orderId ?? "")'
identity_count = reconciliation.count(identity_anchor)
if identity_count != 5:
    raise SystemExit(f"UNKNOWN_WRITE_ORDER_ID_USAGE_MISMATCH:{identity_count}")
reconciliation = reconciliation.replace(identity_anchor, "this.orderId(order)")
source = prefix + reconcile_anchor + reconciliation
state_path.write_text(source, encoding="utf-8")

runtime_path = Path("src/automation/runtimeOrchestrator.ts")
runtime = runtime_path.read_text(encoding="utf-8")
old_runtime = "const unknownWriteReconciliation = new UnknownWriteReconciliation(unknownWriteStatePath);"
new_runtime = '''const unknownWriteReconciliation = new UnknownWriteReconciliation(unknownWriteStatePath, {
  // Recovery supplements can include exact-order child trees. Keep every row
  // on the same strict broker identity contract as live authoritative orders.
  orderId: (order) => brokerOrderId(order),
});'''
if runtime.count(old_runtime) != 1:
    raise SystemExit("UNKNOWN_WRITE_RUNTIME_ANCHOR_MISMATCH")
runtime = runtime.replace(old_runtime, new_runtime, 1)
runtime_path.write_text(runtime, encoding="utf-8")
