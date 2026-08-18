from pathlib import Path

state_path = Path("src/automation/state/unknownWriteReconciliation.ts")
text = state_path.read_text()
text = text.replace(
    'const TERMINAL_CANCEL_STATUSES = new Set(["CANCELED", "CANCELLED"]);',
    'const TERMINAL_CANCEL_TARGET_STATUSES = new Set(["CANCELED", "CANCELLED", "FILLED", "REJECTED", "REPLACED", "EXPIRED"]);',
)
if text.count('"target-not-canceled"') != 2:
    raise SystemExit(f"expected two target-not-canceled type/reason occurrences, found {text.count(chr(34) + 'target-not-canceled' + chr(34))}")
text = text.replace('"target-not-canceled"', '"target-not-terminal"')
old_cancel = '''      if (record.operation === "CANCEL_ORDER") {
        const targetMatches = orders.filter((order) => String(order.orderId ?? "") === record.targetOrderId);
        const canceled = targetMatches.filter((order) => TERMINAL_CANCEL_STATUSES.has(String(order.status ?? "").toUpperCase()));
        if (targetMatches.length === 1 && canceled.length === 1) {
          candidates.set(record.id, canceled);
        } else {
          candidates.set(record.id, []);
          pendingReason.set(record.id, "target-not-terminal");
        }
        continue;
      }
'''
new_cancel = '''      if (record.operation === "CANCEL_ORDER") {
        const targetMatches = orders.filter((order) => String(order.orderId ?? "") === record.targetOrderId);
        const terminal = targetMatches.filter((order) => TERMINAL_CANCEL_TARGET_STATUSES.has(String(order.status ?? "").toUpperCase()));
        if (targetMatches.length === 1 && terminal.length === 1) {
          // Once the exact target is terminal, replaying the unknown cancel can
          // no longer improve the outcome. FILLED/EXPIRED/REJECTED/REPLACED are
          // therefore as conclusive for duplicate-cancel prevention as CANCELED.
          candidates.set(record.id, terminal);
        } else {
          candidates.set(record.id, []);
          pendingReason.set(record.id, "target-not-terminal");
        }
        continue;
      }
'''
if text.count(old_cancel) != 1:
    raise SystemExit("cancel reconciliation patch point missing")
state_path.write_text(text.replace(old_cancel, new_cancel))

test_path = Path("test/unknown_write_reconciliation.test.ts")
text = test_path.read_text()
old_test = '''test("cancel unknown resolves only when the exact target is explicitly canceled", async () => {
  const { root, store } = await makeStore();
  try {
    await store.recordFailure({
      operation: "CANCEL_ORDER",
      method: "DELETE",
      key: "cancel:42",
      path: "/trader/v1/accounts/hash/orders/42",
      targetOrderId: "42",
      targetOrder: order("42"),
      status: 0,
      reason: "network timeout",
    });
    const unresolved = await store.reconcile([order("42", "WORKING")]);
    assert.equal(unresolved.resolved.length, 0);
    assert.equal(unresolved.pending[0]?.reason, "target-not-canceled");
    assert.equal(store.hasPending(), true);

    const resolved = await store.reconcile([order("42", "CANCELED")]);
    assert.equal(resolved.resolved.length, 1);
    assert.equal(store.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
'''
new_test = '''test("cancel unknown remains pending while the exact target can still transition", async (t) => {
  for (const status of ["WORKING", "PENDING_CANCEL", "PENDING_REPLACE", "QUEUED", "UNKNOWN"]) {
    await t.test(status, async () => {
      const { root, store } = await makeStore();
      try {
        await store.recordFailure({
          operation: "CANCEL_ORDER",
          method: "DELETE",
          key: `cancel:42:${status}`,
          path: "/trader/v1/accounts/hash/orders/42",
          targetOrderId: "42",
          targetOrder: order("42"),
          status: 0,
          reason: "network timeout",
        });
        const unresolved = await store.reconcile([order("42", status)]);
        assert.equal(unresolved.resolved.length, 0);
        assert.equal(unresolved.pending[0]?.reason, "target-not-terminal");
        assert.equal(store.hasPending(), true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("cancel unknown resolves once the exact target is terminal", async (t) => {
  for (const status of ["CANCELED", "CANCELLED", "FILLED", "REJECTED", "REPLACED", "EXPIRED"]) {
    await t.test(status, async () => {
      const { root, store } = await makeStore();
      try {
        await store.recordFailure({
          operation: "CANCEL_ORDER",
          method: "DELETE",
          key: `cancel:42:${status}`,
          path: "/trader/v1/accounts/hash/orders/42",
          targetOrderId: "42",
          targetOrder: order("42"),
          status: 0,
          reason: "network timeout",
        });
        const resolved = await store.reconcile([order("42", status)]);
        assert.equal(resolved.resolved.length, 1);
        assert.equal(resolved.pending.length, 0);
        assert.equal(store.hasPending(), false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
'''
if text.count(old_test) != 1:
    raise SystemExit("cancel reconciliation unit-test patch point missing")
test_path.write_text(text.replace(old_test, new_test))
