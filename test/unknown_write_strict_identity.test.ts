import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { brokerOrderId } from "../src/automation/broker/orderIdentity.ts";
import { UnknownWriteReconciliation } from "../src/automation/state/unknownWriteReconciliation.ts";

function opening(orderId: string): Record<string, unknown> {
  return {
    orderId,
    status: "WORKING",
    enteredTime: "2026-08-18T08:00:01.000Z",
    session: "NORMAL",
    duration: "DAY",
    orderType: "NET_DEBIT",
    price: "0.90",
    quantity: 1,
    orderStrategyType: "SINGLE",
    complexOrderStrategyType: "VERTICAL",
    orderLegCollection: [
      {
        instruction: "BUY_TO_OPEN",
        positionEffect: "OPENING",
        quantity: 1,
        instrument: { symbol: "QQQ   260818P00740000", assetType: "OPTION" },
      },
      {
        instruction: "SELL_TO_OPEN",
        positionEffect: "OPENING",
        quantity: 1,
        instrument: { symbol: "QQQ   260818P00739000", assetType: "OPTION" },
      },
    ],
  };
}

async function strictStore(root: string): Promise<UnknownWriteReconciliation> {
  let id = 0;
  const store = new UnknownWriteReconciliation(join(root, "unknown-writes.json"), {
    now: () => "2026-08-18T08:00:00.000Z",
    idFactory: () => `intent-${++id}`,
    orderId: (order) => brokerOrderId(order),
  });
  await store.load();
  return store;
}

async function recordAmbiguousPlace(store: UnknownWriteReconciliation): Promise<void> {
  await store.recordFailure({
    operation: "PLACE_ORDER",
    method: "POST",
    key: "strict-id-submit",
    path: "/trader/v1/accounts/hash/orders",
    payload: opening("payload"),
    preSendAt: "2026-08-18T08:00:00.000Z",
    status: 503,
    reason: "server-error",
  });
}

test("strict reconciliation rejects a fingerprint match with a synthetic broker order ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "unknown-write-strict-id-"));
  try {
    const store = await strictStore(root);
    await recordAmbiguousPlace(store);

    await assert.rejects(
      store.reconcile([opening("synthetic-order")]),
      /BROKER_ORDER_ID_INVALID/,
    );
    assert.equal(store.hasPending(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict reconciliation canonicalizes a valid numeric broker order ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "unknown-write-strict-id-"));
  try {
    const store = await strictStore(root);
    await recordAmbiguousPlace(store);

    const result = await store.reconcile([opening("00042")]);
    assert.equal(result.resolved.length, 1);
    assert.equal(result.pending.length, 0);
    assert.equal(store.hasPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
