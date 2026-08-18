import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  UnknownWriteReconciliation,
  fingerprintPayload,
  fingerprintOrder,
  safePath,
} from "../src/automation/state/unknownWriteReconciliation.ts";

function order(
  id: string,
  status = "WORKING",
  price = "0.90",
  enteredTime = "2026-08-12T00:00:01.000Z",
): Record<string, any> {
  return {
    orderId: id,
    status,
    enteredTime,
    session: "NORMAL",
    duration: "DAY",
    orderType: "NET_DEBIT",
    price,
    quantity: 1,
    orderStrategyType: "SINGLE",
    complexOrderStrategyType: "VERTICAL",
    orderLegCollection: [
      {
        instruction: "BUY_TO_OPEN",
        positionEffect: "OPENING",
        quantity: 1,
        instrument: { symbol: "QQQ   260812P00740000", assetType: "OPTION" },
      },
      {
        instruction: "SELL_TO_OPEN",
        positionEffect: "OPENING",
        quantity: 1,
        instrument: { symbol: "QQQ   260812P00739000", assetType: "OPTION" },
      },
    ],
  };
}

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), "schwab-unknown-write-"));
  const statePath = join(root, "state", "unknown-writes.json");
  const store = new UnknownWriteReconciliation(statePath, {
    idFactory: (() => {
      let index = 0;
      return () => `id-${++index}`;
    })(),
    now: () => "2026-08-12T00:00:00.000Z",
  });
  await store.load();
  return { root, statePath, store };
}

test("persists an unknown write and restores the pending isolation after restart", async () => {
  const { root, statePath, store } = await makeStore();
  try {
    const payload = order("payload");
    const record = await store.recordFailure({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "price-explorer:QQQ:submit",
      path: "/trader/v1/accounts/account-hash/orders",
      payload,
      status: 503,
      reason: "SCHWAB_HTTP_503",
    });
    assert.equal(record?.reason, "server-error");
    assert.equal(record?.path, "/trader/v1/accounts/[REDACTED]/orders");
    assert.equal(record?.payloadFingerprint, fingerprintPayload(payload));
    const persisted = await readFile(statePath, "utf8");
    assert.doesNotMatch(persisted, /account-hash|260812P00740000/);

    const restored = new UnknownWriteReconciliation(statePath);
    await restored.load();
    assert.equal(restored.hasPending(), true);
    assert.equal(restored.pending()[0]?.id, record?.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit 4xx rejection is not recorded as unknown", async () => {
  const { root, store } = await makeStore();
  try {
    const record = await store.recordFailure({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "submit",
      path: "/trader/v1/accounts/hash/orders",
      payload: order("payload"),
      status: 400,
      reason: "SCHWAB_HTTP_400",
    });
    assert.equal(record, null);
    assert.equal(store.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP 408 remains pending as an ambiguous timeout outcome", async () => {
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

test("cancel unknown remains pending while the exact target can still transition", async (t) => {
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

test("no match or ambiguous matches remain fail-closed", async () => {
  const { root, store } = await makeStore();
  try {
    const payload = order("payload");
    await store.recordFailure({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "submit",
      path: "/trader/v1/accounts/hash/orders",
      payload,
      status: 201,
      reason: "missing-location",
    });
    const noMatch = await store.reconcile([order("other", "WORKING", "0.91")]);
    assert.equal(noMatch.pending[0]?.matchingOrderCount, 0);
    assert.equal(store.hasPending(), true);

    const ambiguous = await store.reconcile([order("one"), order("two")]);
    assert.equal(ambiguous.pending[0]?.matchingOrderCount, 2);
    assert.equal(store.hasPending(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same broker order cannot resolve two identical unknown write intents", async () => {
  const { root, store } = await makeStore();
  try {
    const payload = order("payload");
    await Promise.all([
      store.recordFailure({
        operation: "PLACE_ORDER",
        method: "POST",
        key: "submit:one",
        path: "/trader/v1/accounts/hash/orders",
        payload,
        preSendAt: "2026-08-12T00:00:00.000Z",
        status: 503,
        reason: "server-error",
      }),
      store.recordFailure({
        operation: "PLACE_ORDER",
        method: "POST",
        key: "submit:two",
        path: "/trader/v1/accounts/hash/orders",
        payload,
        preSendAt: "2026-08-12T00:00:00.000Z",
        status: 503,
        reason: "server-error",
      }),
    ]);

    const result = await store.reconcile([order("broker-order")]);

    assert.equal(result.resolved.length, 0);
    assert.equal(result.pending.length, 2);
    assert.equal(result.pending.every((entry) => entry.matchingOrderCount === 1), true);
    assert.equal(store.pending().length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution fingerprints include stop price, special instructions, asset type, and child strategies", () => {
  const base = order("payload");
  const variants = [
    { ...base, stopPrice: 0.8 },
    { ...base, cancelTime: "2026-08-12T15:00:00.000Z" },
    { ...base, specialInstruction: "ALL_OR_NONE" },
    {
      ...base,
      orderLegCollection: base.orderLegCollection.map((leg: Record<string, any>) => ({
        ...leg,
        instrument: { ...leg.instrument, assetType: "EQUITY" },
      })),
    },
    {
      ...base,
      childOrderStrategies: [{ orderStrategyType: "TRIGGER", orderType: "LIMIT", price: "0.10" }],
    },
  ];

  for (const variant of variants) {
    assert.notEqual(fingerprintPayload(base), fingerprintPayload(variant));
  }
});

test("execution fingerprints normalize numeric representations without dropping unknown execution fields", () => {
  const left = {
    ...order("left", "WORKING", "0.90"),
    stopPrice: "0.800",
    childOrderStrategies: [{ orderType: "LIMIT", price: "0.100" }],
  };
  const right = {
    ...order("right", "FILLED", "0.900"),
    stopPrice: 0.8,
    childOrderStrategies: [{ price: 0.1, orderType: "LIMIT" }],
  };

  assert.equal(fingerprintPayload(left), fingerprintPayload(right));
});

test("broker response metadata does not make a request and its order snapshot differ", () => {
  const request = order("request");
  const response = {
    ...request,
    orderId: 123,
    status: "WORKING",
    statusDescription: "Working",
    filledQuantity: 0,
    remainingQuantity: 1,
    cancelable: true,
    editable: true,
    enteredTime: "2026-08-12T00:00:01.000Z",
    accountNumber: "hashed-account",
    replacingOrderCollection: ["old-order"],
    orderActivityCollection: [],
    orderLegCollection: request.orderLegCollection.map((leg: Record<string, any>) => ({
      ...leg,
      legId: 1,
      instrument: {
        ...leg.instrument,
        cusip: "broker-cusip",
        description: "broker description",
        instrumentId: 42,
        netChange: 0,
        type: "OPTION",
      },
    })),
  };

  assert.equal(fingerprintOrder(request), fingerprintOrder(response));
});

test("reconciliation never resends or mutates broker state", async () => {
  const { root, store } = await makeStore();
  try {
    await store.recordFailure({
      operation: "REPLACE_ORDER",
      method: "PUT",
      key: "replace:42",
      path: "/trader/v1/accounts/hash/orders/42",
      payload: order("payload", "WORKING", "0.91"),
      targetOrderId: "42",
      targetOrder: order("42"),
      status: 503,
      reason: "server-error",
    });
    let writes = 0;
    const snapshot = [order("42", "WORKING")];
    const result = await store.reconcile(snapshot);
    writes += result.resolved.length;
    assert.equal(writes, 0);
    assert.equal(store.hasPending(), true);
    assert.equal(snapshot[0]?.status, "WORKING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redacts account path segments before persistence", () => {
  assert.equal(
    safePath("/trader/v1/accounts/sensitive-account/orders/42"),
    "/trader/v1/accounts/[REDACTED]/orders/42",
  );
});

test("a pre-existing matching order is a baseline and cannot resolve the unknown write", async () => {
  const { root, store } = await makeStore();
  try {
    const payload = order("payload");
    await store.recordFailure({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "submit",
      path: "/trader/v1/accounts/hash/orders",
      payload,
      baselineOrderIds: ["old-order"],
      preSendAt: "2026-08-12T00:00:00.000Z",
      status: 503,
      reason: "server-error",
    });
    const oldOnly = await store.reconcile([order("old-order")]);
    assert.equal(oldOnly.resolved.length, 0);
    assert.equal(oldOnly.pending[0]?.matchingOrderCount, 0);
    assert.equal(store.hasPending(), true);

    const oldAndNew = await store.reconcile([order("old-order"), order("new-order")]);
    assert.equal(oldAndNew.resolved.length, 1);
    assert.equal(store.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("write-ahead intent survives restart and explicit settlement", async () => {
  const { root, statePath, store } = await makeStore();
  try {
    await store.bindAccount("test-account");
    const intent = await store.beginWrite({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "submit",
      path: "/trader/v1/accounts/hash/orders",
      payload: order("payload"),
      baselineOrderIds: ["old-order"],
      preSendAt: "2026-08-12T00:00:00.000Z",
    });
    assert.equal(intent.phase, "IN_FLIGHT");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).pending[0].phase, "IN_FLIGHT");

    const restored = new UnknownWriteReconciliation(statePath);
    await restored.load();
    assert.equal(restored.hasPending(), true);
    const pending = await restored.settleWrite(intent.id, { status: 503, reason: "network timeout" });
    assert.equal(pending?.phase, "PENDING");
    assert.equal(restored.hasPending(), true);
    await restored.completeWrite(intent.id);
    assert.equal(restored.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed WAL persistence removes its temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schwab-unknown-write-cleanup-"));
  const statePath = join(directory, "unknown-writes.json");
  const ledger = new UnknownWriteReconciliation(statePath, {
    idFactory: (() => {
      let index = 0;
      return () => `cleanup-${++index}`;
    })(),
  });
  await ledger.load();
  await ledger.bindAccount("hash-cleanup");
  await rm(statePath);
  await mkdir(statePath);
  await assert.rejects(
    () => ledger.beginWrite({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "cleanup",
      path: "/trader/v1/accounts/hash/orders",
      payload: { orderType: "NET_DEBIT" },
      preSendAt: "2026-08-12T00:00:00.000Z",
    }),
  );
  const files = await readdir(directory);
  assert.deepEqual(files.filter((file) => file.endsWith(".tmp")), []);
  await access(directory);
  await rm(directory, { recursive: true, force: true });
});

test("an explicit 4xx settles and removes an in-flight intent without recording unknown", async () => {
  const { root, store } = await makeStore();
  try {
    await store.bindAccount("test-account");
    const intent = await store.beginWrite({
      operation: "CANCEL_ORDER",
      method: "DELETE",
      key: "cancel:42",
      path: "/trader/v1/accounts/hash/orders/42",
      targetOrderId: "42",
      preSendAt: "2026-08-12T00:00:00.000Z",
    });
    const result = await store.settleWrite(intent.id, { status: 400, reason: "SCHWAB_HTTP_400" });
    assert.equal(result, null);
    assert.equal(store.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("account identity mismatch keeps a pending ledger fail-closed", async () => {
  const { root, store, statePath } = await makeStore();
  try {
    await store.bindAccount("account-A");
    await store.beginWrite({
      operation: "CANCEL_ORDER",
      method: "DELETE",
      key: "cancel:42",
      path: "/trader/v1/accounts/hash/orders/42",
      targetOrderId: "42",
      preSendAt: "2026-08-12T00:00:00.000Z",
    });
    const restored = new UnknownWriteReconciliation(statePath);
    await restored.load();
    await assert.rejects(() => restored.bindAccount("account-B"), /UNKNOWN_WRITE_ACCOUNT_MISMATCH/);
    assert.equal(restored.hasPending(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test("an old-time matching order remains pending despite a matching fingerprint", async () => {
  const { root, store } = await makeStore();
  try {
    await store.recordFailure({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "submit",
      path: "/trader/v1/accounts/hash/orders",
      payload: order("payload"),
      preSendAt: "2026-08-12T00:00:00.000Z",
      status: 503,
      reason: "server-error",
    });
    const result = await store.reconcile([
      order("old-time", "WORKING", "0.90", "2026-08-11T23:59:50.000Z"),
    ]);
    assert.equal(result.resolved.length, 0);
    assert.equal(result.pending[0]?.matchingOrderCount, 0);
    assert.equal(store.hasPending(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current-process in-flight intent is not reconciled until a restart recovers it", async () => {
  const { root, statePath, store } = await makeStore();
  try {
    await store.bindAccount("test-account");
    const intent = await store.beginWrite({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "submit",
      path: "/trader/v1/accounts/hash/orders",
      payload: order("payload"),
      preSendAt: "2026-08-12T00:00:00.000Z",
    });
    const current = await store.reconcile([order("new-order")]);
    assert.equal(current.resolved.length, 0);
    assert.equal(store.hasPending(), true);

    const restored = new UnknownWriteReconciliation(statePath);
    await restored.load();
    const recovered = await restored.reconcile([order("new-order")]);
    assert.equal(recovered.resolved.some((record) => record.id === intent.id), true);
    assert.equal(restored.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent WAL begins retain both intents without a lost update", async () => {
  const { root, store } = await makeStore();
  try {
    await store.bindAccount("test-account");
    const [first, second] = await Promise.all([
      store.beginWrite({
        operation: "PLACE_ORDER",
        method: "POST",
        key: "submit:one",
        path: "/trader/v1/accounts/hash/orders",
        payload: order("one"),
        preSendAt: "2026-08-12T00:00:00.000Z",
      }),
      store.beginWrite({
        operation: "PLACE_ORDER",
        method: "POST",
        key: "submit:two",
        path: "/trader/v1/accounts/hash/orders",
        payload: order("two"),
        preSendAt: "2026-08-12T00:00:00.000Z",
      }),
    ]);
    assert.notEqual(first.id, second.id);
    assert.equal(store.pending().length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("beginWrite fails closed when no account is bound", async () => {
  const { root, store } = await makeStore();
  try {
    await assert.rejects(() => store.beginWrite({
      operation: "CANCEL_ORDER",
      method: "DELETE",
      key: "cancel:42",
      path: "/trader/v1/accounts/hash/orders/42",
      targetOrderId: "42",
      preSendAt: "2026-08-12T00:00:00.000Z",
    }), /UNKNOWN_WRITE_ACCOUNT_UNBOUND/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile and begin/complete serialize without losing either ledger update", async () => {
  const { root, store } = await makeStore();
  try {
    await store.bindAccount("test-account");
    await store.recordFailure({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "submit",
      path: "/trader/v1/accounts/hash/orders",
      payload: order("payload"),
      preSendAt: "2026-08-12T00:00:00.000Z",
      status: 503,
      reason: "server-error",
    });
    const reconcile = store.reconcile([order("new-order")]);
    const beginAndComplete = store.beginWrite({
      operation: "CANCEL_ORDER",
      method: "DELETE",
      key: "cancel:42",
      path: "/trader/v1/accounts/hash/orders/42",
      targetOrderId: "42",
      preSendAt: "2026-08-12T00:00:00.000Z",
    }).then((intent) => store.completeWrite(intent.id));
    const [result] = await Promise.all([reconcile, beginAndComplete]);
    assert.equal(result.resolved.length, 1);
    assert.equal(store.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("5xx, timeout, and missing Location settle into durable pending isolation", async () => {
  const { root, store } = await makeStore();
  try {
    await store.bindAccount("test-account");
    const [server, timeout, missingLocation] = await Promise.all([
      store.beginWrite({
        operation: "PLACE_ORDER",
        method: "POST",
        key: "server-error",
        path: "/trader/v1/accounts/hash/orders",
        payload: order("server-error"),
        preSendAt: "2026-08-12T00:00:00.000Z",
      }),
      store.beginWrite({
        operation: "PLACE_ORDER",
        method: "POST",
        key: "timeout",
        path: "/trader/v1/accounts/hash/orders",
        payload: order("timeout"),
        preSendAt: "2026-08-12T00:00:00.000Z",
      }),
      store.beginWrite({
        operation: "PLACE_ORDER",
        method: "POST",
        key: "missing-location",
        path: "/trader/v1/accounts/hash/orders",
        payload: order("missing-location"),
        preSendAt: "2026-08-12T00:00:00.000Z",
      }),
    ]);
    const settled = await Promise.all([
      store.settleWrite(server.id, { status: 503, reason: "server-error" }),
      store.settleWrite(timeout.id, { reason: "network timeout" }),
      store.settleWrite(missingLocation.id, { status: 201, reason: "missing-location" }),
    ]);
    assert.deepEqual(settled.map((record) => record?.reason), ["server-error", "timeout", "missing-location"]);
    assert.equal(store.pending().every((record) => record.phase === "PENDING"), true);
    await Promise.all(settled.map((record) => store.completeWrite(record!.id)));
    assert.equal(store.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a future matching order outside the conservative window remains pending", async () => {
  const { root, store } = await makeStore();
  try {
    await store.recordFailure({
      operation: "PLACE_ORDER",
      method: "POST",
      key: "submit",
      path: "/trader/v1/accounts/hash/orders",
      payload: order("payload"),
      preSendAt: "2026-08-12T00:00:00.000Z",
      status: 503,
      reason: "server-error",
    });
    const result = await store.reconcile([
      order("future-time", "WORKING", "0.90", "2026-08-12T00:01:01.000Z"),
    ]);
    assert.equal(result.resolved.length, 0);
    assert.equal(result.pending[0]?.matchingOrderCount, 0);
    assert.equal(store.hasPending(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful DELETE completion clears the WAL without requiring Location", async () => {
  const { root, store } = await makeStore();
  try {
    await store.bindAccount("test-account");
    const intent = await store.beginWrite({
      operation: "CANCEL_ORDER",
      method: "DELETE",
      key: "cancel:42",
      path: "/trader/v1/accounts/hash/orders/42",
      targetOrderId: "42",
      preSendAt: "2026-08-12T00:00:00.000Z",
    });
    await store.completeWrite(intent.id);
    assert.equal(store.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Replace source fingerprint mismatch remains pending despite a unique successor", async () => {
  const { root, store } = await makeStore();
  try {
    await store.recordFailure({
      operation: "REPLACE_ORDER",
      method: "PUT",
      key: "replace:source",
      path: "/trader/v1/accounts/hash/orders/source",
      payload: order("successor"),
      targetOrderId: "source",
      targetOrder: order("source", "WORKING", "0.90"),
      baselineOrderIds: ["source"],
      preSendAt: "2026-08-12T00:00:00.000Z",
      status: 503,
      reason: "server-error",
    });
    const result = await store.reconcile([
      order("source", "REPLACED", "0.89"),
      order("successor", "WORKING", "0.90"),
    ]);
    assert.equal(result.resolved.length, 0);
    assert.equal(result.pending[0]?.matchingOrderCount, 0);
    assert.equal(store.hasPending(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
