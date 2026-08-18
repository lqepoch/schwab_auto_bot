from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text(encoding="utf-8")

helper_anchor = '''function currentStrategyOrders(): readonly Json[] {
  return runtimeOrderIndex.currentOrders(
    orders,
    orderAuthorityRevision,
    policy,
    newYorkDate(),
    working,
  );
}

'''
helper_replacement = '''function workingAllowedUnderlyingOrders(): readonly Json[] {
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

'''
if text.count(helper_anchor) != 1:
    raise SystemExit(f"WORKING_POLICY_HELPER_ANCHOR_MISMATCH:{text.count(helper_anchor)}")
text = text.replace(helper_anchor, helper_replacement, 1)

old_policy = '''function reportWorkingOrderPolicyViolations(): void {
  const today = newYorkDate();
  for (const order of orders) {
    if (!working.has(String(order.status))) continue;
    const meta = info(order);
    if (!meta || !policy.underlyings.has(meta.underlying)) continue;
    const violation = orderPolicyViolation(order, policy, today, meta);
    if (violation) reportPolicyAlert("order-snapshot", order, violation.code, violation.message);
  }
}
'''
new_policy = '''function reportWorkingOrderPolicyViolations(): void {
  const today = newYorkDate();
  for (const order of workingAllowedUnderlyingOrders()) {
    const meta = info(order);
    if (!meta) continue;
    const violation = orderPolicyViolation(order, policy, today, meta);
    if (violation) reportPolicyAlert("order-snapshot", order, violation.code, violation.message);
  }
}
'''
if text.count(old_policy) != 1:
    raise SystemExit(f"WORKING_POLICY_SCAN_ANCHOR_MISMATCH:{text.count(old_policy)}")
text = text.replace(old_policy, new_policy, 1)

path.write_text(text, encoding="utf-8")
