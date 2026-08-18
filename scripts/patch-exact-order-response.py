from pathlib import Path
import re

path = Path("src/automation/runtimeOrchestrator.ts")
source = path.read_text(encoding="utf-8")

import_anchor = 'import { brokerOrderId } from "./broker/orderIdentity.ts";\n'
if source.count(import_anchor) != 1:
    raise SystemExit("ORDER_IDENTITY_IMPORT_ANCHOR_MISMATCH")
source = source.replace(
    import_anchor,
    import_anchor + 'import { exactOrderRoot } from "./broker/exactOrderResponse.ts";\n',
    1,
)

pattern = re.compile(
    r'async function fetchExactOrderTree\(orderIdValue: string, priority: Priority\): Promise<Json\[]> \{.*?\n\}\n\nlet lastActiveOrderSweepAt = 0;',
    re.S,
)
replacement = '''async function fetchExactOrderTree(orderIdValue: string, priority: Priority): Promise<Json[]> {
  const canonicalOrderId = brokerOrderId({ orderId: orderIdValue });
  const response = await api(
    `/trader/v1/accounts/${accountHash}/orders/${encodeURIComponent(canonicalOrderId)}`,
    {},
    priority,
  );
  return flatten([exactOrderRoot<Json>(response.body, canonicalOrderId)]);
}

let lastActiveOrderSweepAt = 0;'''
source, count = pattern.subn(replacement, source, count=1)
if count != 1:
    raise SystemExit(f"EXACT_ORDER_FUNCTION_ANCHOR_MISMATCH:{count}")

path.write_text(source, encoding="utf-8")
