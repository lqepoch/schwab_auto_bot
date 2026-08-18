from pathlib import Path

state_path = Path("src/automation/state/unknownWriteReconciliation.ts")
text = state_path.read_text()
old = '''export function classifyUnknownReason(failure: Pick<UnknownWriteFailure, "status" | "reason">): UnknownWriteReason | null {
  const status = failure.status;
  if (status !== undefined && status >= 400 && status < 500) return null;
  const reason = String(failure.reason ?? "").toLowerCase();
  if (reason.includes("missing-location")) return "missing-location";
  if (reason.includes("timeout") || reason.includes("aborted")) return "timeout";
  if (reason.includes("network") || status === 0) return "network-error";
  if (status !== undefined && status >= 500) return "server-error";
  return "unknown-error";
}
'''
new = '''/**
 * HTTP 4xx responses normally prove that Schwab rejected the mutation. A 408
 * is different: it is a timeout signal whose end-to-end execution outcome is
 * not strong enough for an automated trader to erase its durable intent.
 */
export function isExplicitBrokerRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}

export function classifyUnknownReason(failure: Pick<UnknownWriteFailure, "status" | "reason">): UnknownWriteReason | null {
  const status = failure.status;
  if (status !== undefined && isExplicitBrokerRejection(status)) return null;
  const reason = String(failure.reason ?? "").toLowerCase();
  if (reason.includes("missing-location")) return "missing-location";
  if (status === 408 || reason.includes("timeout") || reason.includes("aborted")) return "timeout";
  if (reason.includes("network") || status === 0) return "network-error";
  if (status !== undefined && status >= 500) return "server-error";
  return "unknown-error";
}
'''
if text.count(old) != 1:
    raise SystemExit(f"unknown reason patch point count={text.count(old)}")
state_path.write_text(text.replace(old, new))

coordinator_path = Path("src/automation/broker/writeCoordinator.ts")
text = coordinator_path.read_text()
old_import = '''import type {
  UnknownWriteFailure,
  UnknownWriteOperation,
  UnknownWriteRecord,
} from "../state/unknownWriteReconciliation.ts";
'''
new_import = '''import {
  isExplicitBrokerRejection,
  type UnknownWriteFailure,
  type UnknownWriteOperation,
  type UnknownWriteRecord,
} from "../state/unknownWriteReconciliation.ts";
'''
if text.count(old_import) != 1:
    raise SystemExit("write coordinator import patch point missing")
text = text.replace(old_import, new_import)
text = text.replace('if (status !== null && isExplicitRejection(status)) {', 'if (status !== null && isExplicitBrokerRejection(status)) {')
text = text.replace('if (isExplicitRejection(response.status)) {', 'if (isExplicitBrokerRejection(response.status)) {')
old_reason = '''function reasonOf(error: unknown, status: number | null): string {
  if (status !== null && status >= 500) return "server-error";
'''
new_reason = '''function reasonOf(error: unknown, status: number | null): string {
  if (status === 408) return "timeout";
  if (status !== null && status >= 500) return "server-error";
'''
if text.count(old_reason) != 1:
    raise SystemExit("reasonOf patch point missing")
text = text.replace(old_reason, new_reason)
old_helper = '''function isExplicitRejection(status: number): boolean {
  return status >= 400 && status < 500;
}

'''
if text.count(old_helper) != 1:
    raise SystemExit("legacy explicit rejection helper missing")
text = text.replace(old_helper, "")
coordinator_path.write_text(text)

coord_test_path = Path("test/broker_write_coordinator.test.ts")
text = coord_test_path.read_text()
old_cases = '''  const cases: Array<[string, Outcome]> = [
    ["5xx", rejected(503)],
    ["timeout", Object.assign(new Error("request timeout"), { status: 0 })],
'''
new_cases = '''  const cases: Array<[string, Outcome]> = [
    ["5xx", rejected(503)],
    ["HTTP 408", rejected(408)],
    ["timeout", Object.assign(new Error("request timeout"), { status: 0 })],
'''
if text.count(old_cases) != 1:
    raise SystemExit("coordinator ambiguous cases patch point missing")
coord_test_path.write_text(text.replace(old_cases, new_cases))

recon_test_path = Path("test/unknown_write_reconciliation.test.ts")
text = recon_test_path.read_text()
anchor = '''test("cancel unknown resolves only when the exact target is explicitly canceled", async () => {
'''
new_test = '''test("HTTP 408 remains pending as an ambiguous timeout outcome", async () => {
  const { root, store } = await makeStore();
  try {
    const record = await store.recordFailure({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "submit-timeout",
      path: "/trader/v1/accounts/hash/orders",
      payload: order("payload"),
      status: 408,
      reason: "SCHWAB_HTTP_408",
    });
    assert.equal(record?.reason, "timeout");
    assert.equal(record?.status, 408);
    assert.equal(store.hasPending(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

'''
if anchor not in text:
    raise SystemExit("unknown-write test anchor missing")
if 'HTTP 408 remains pending as an ambiguous timeout outcome' not in text:
    text = text.replace(anchor, new_test + anchor)
recon_test_path.write_text(text)
