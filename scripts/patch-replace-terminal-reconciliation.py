from pathlib import Path

state_path = Path("src/automation/state/unknownWriteReconciliation.ts")
text = state_path.read_text()
old_constant = 'const REPLACE_SOURCE_TERMINAL_STATUSES = new Set(["REPLACED"]);'
new_constants = '''const REPLACE_SOURCE_APPLIED_STATUS = "REPLACED";
const REPLACE_SOURCE_NONREPLACE_TERMINAL_STATUSES = new Set([
  "CANCELED",
  "CANCELLED",
  "FILLED",
  "REJECTED",
  "EXPIRED",
]);'''
if text.count(old_constant) != 1:
    raise SystemExit(f"replace source status constant count={text.count(old_constant)}")
text = text.replace(old_constant, new_constants)

old_replace = '''      if (record.operation === "REPLACE_ORDER") {
        const sourceMatches = orders.filter((order) => String(order.orderId ?? "") === record.targetOrderId);
        const source = sourceMatches.length === 1 ? sourceMatches[0] : undefined;
        const sourceStatus = String(source?.status ?? "").toUpperCase();
        if (!source || !REPLACE_SOURCE_TERMINAL_STATUSES.has(sourceStatus) || record.targetFingerprint === null || fingerprintOrder(source) !== record.targetFingerprint) {
          candidates.set(record.id, []);
          pendingReason.set(record.id, "no-unique-match");
          continue;
        }
      }
'''
new_replace = '''      if (record.operation === "REPLACE_ORDER") {
        const sourceMatches = orders.filter((order) => String(order.orderId ?? "") === record.targetOrderId);
        const source = sourceMatches.length === 1 ? sourceMatches[0] : undefined;
        const sourceStatus = String(source?.status ?? "").toUpperCase();
        if (!source || record.targetFingerprint === null || fingerprintOrder(source) !== record.targetFingerprint) {
          candidates.set(record.id, []);
          pendingReason.set(record.id, "no-unique-match");
          continue;
        }
        if (REPLACE_SOURCE_NONREPLACE_TERMINAL_STATUSES.has(sourceStatus)) {
          // The exact source is durably terminal without becoming REPLACED.
          // A replayed PUT cannot be valid anymore, so the source itself is
          // sufficient proof to retire this unknown Replace intent.
          candidates.set(record.id, [source]);
          continue;
        }
        if (sourceStatus !== REPLACE_SOURCE_APPLIED_STATUS) {
          candidates.set(record.id, []);
          pendingReason.set(record.id, "no-unique-match");
          continue;
        }
        // REPLACED proves the source transition, but the successor still has
        // to match this request uniquely before the unknown intent is cleared.
      }
'''
if text.count(old_replace) != 1:
    raise SystemExit("replace reconciliation patch point missing")
state_path.write_text(text.replace(old_replace, new_replace))

test_path = Path("test/unknown_write_reconciliation.test.ts")
text = test_path.read_text()
anchor = '''test("a Replace source fingerprint mismatch remains pending despite a unique successor", async () => {
'''
new_tests = '''test("Replace unknown resolves when the exact matching source becomes terminal without REPLACED", async (t) => {
  for (const status of ["CANCELED", "CANCELLED", "FILLED", "REJECTED", "EXPIRED"]) {
    await t.test(status, async () => {
      const { root, store } = await makeStore();
      try {
        await store.recordFailure({
          operation: "REPLACE_ORDER",
          method: "PUT",
          key: `replace:source:${status}`,
          path: "/trader/v1/accounts/hash/orders/source",
          payload: order("successor", "WORKING", "0.91"),
          targetOrderId: "source",
          targetOrder: order("source", "WORKING", "0.90"),
          baselineOrderIds: ["source"],
          preSendAt: "2026-08-12T00:00:00.000Z",
          status: 503,
          reason: "server-error",
        });
        const result = await store.reconcile([order("source", status, "0.90")]);
        assert.equal(result.resolved.length, 1);
        assert.equal(result.pending.length, 0);
        assert.equal(store.hasPending(), false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("Replace unknown remains pending while the exact source can still be replaced", async (t) => {
  for (const status of ["WORKING", "QUEUED", "PENDING_REPLACE", "PENDING_CANCEL", "UNKNOWN"]) {
    await t.test(status, async () => {
      const { root, store } = await makeStore();
      try {
        await store.recordFailure({
          operation: "REPLACE_ORDER",
          method: "PUT",
          key: `replace:source:${status}`,
          path: "/trader/v1/accounts/hash/orders/source",
          payload: order("successor", "WORKING", "0.91"),
          targetOrderId: "source",
          targetOrder: order("source", "WORKING", "0.90"),
          baselineOrderIds: ["source"],
          preSendAt: "2026-08-12T00:00:00.000Z",
          status: 503,
          reason: "server-error",
        });
        const result = await store.reconcile([order("source", status, "0.90")]);
        assert.equal(result.resolved.length, 0);
        assert.equal(result.pending[0]?.matchingOrderCount, 0);
        assert.equal(store.hasPending(), true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("REPLACED source still requires one unique matching successor", async () => {
  const { root, store } = await makeStore();
  try {
    await store.recordFailure({
      operation: "REPLACE_ORDER",
      method: "PUT",
      key: "replace:source",
      path: "/trader/v1/accounts/hash/orders/source",
      payload: order("successor", "WORKING", "0.91"),
      targetOrderId: "source",
      targetOrder: order("source", "WORKING", "0.90"),
      baselineOrderIds: ["source"],
      preSendAt: "2026-08-12T00:00:00.000Z",
      status: 503,
      reason: "server-error",
    });
    const sourceOnly = await store.reconcile([order("source", "REPLACED", "0.90")]);
    assert.equal(sourceOnly.resolved.length, 0);
    assert.equal(sourceOnly.pending[0]?.matchingOrderCount, 0);
    assert.equal(store.hasPending(), true);

    const resolved = await store.reconcile([
      order("source", "REPLACED", "0.90"),
      order("successor", "WORKING", "0.91"),
    ]);
    assert.equal(resolved.resolved.length, 1);
    assert.equal(store.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

'''
if anchor not in text:
    raise SystemExit("replace reconciliation test anchor missing")
if 'Replace unknown resolves when the exact matching source becomes terminal without REPLACED' not in text:
    text = text.replace(anchor, new_tests + anchor)
test_path.write_text(text)
