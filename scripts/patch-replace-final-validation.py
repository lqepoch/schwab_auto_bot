from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()

old = '''    targetOrder: replaceTargetOrderId
      ? () => orders.find((order) => orderId(order) === replaceTargetOrderId)
      : undefined,
    priority,
    transportPriority: 0,
'''
new = '''    targetOrder: replaceTargetOrderId
      ? () => orders.find((order) => orderId(order) === replaceTargetOrderId)
      : undefined,
    validateFinal: replaceTargetOrderId
      ? () => {
        const currentSource = orders.find((order) => orderId(order) === replaceTargetOrderId);
        const violation = replacementSourceViolation(currentSource, payload);
        if (violation) throw new Error(violation);
      }
      : undefined,
    priority,
    transportPriority: 0,
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one Replace coordinator request block, found {text.count(old)}")
path.write_text(text.replace(old, new))
