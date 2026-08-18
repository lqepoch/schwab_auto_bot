import assert from "node:assert/strict";
import test from "node:test";
import {
  BrokerWriteCoordinator,
  BrokerWritePersistenceError,
  BrokerWriteStoppingError,
  type BrokerWriteRequest,
  type BrokerWriteResponse,
} from "../src/automation/broker/writeCoordinator.ts";
import type {
  UnknownWriteFailure,
  UnknownWriteRecord,
} from "../src/automation/state/unknownWriteReconciliation.ts";

class DeferredLedger {
  readonly records = new Map<string, UnknownWriteRecord>();
  discardCount = 0;
  failDiscard = false;
  private sequence = 0;
  private blockBegin = false;
  private beginStarted: (() => void) | null = null;
  private releaseBegin: (() => void) | null = null;

  blockNextBegin(): Promise<void> {
    this.blockBegin = true;
    return new Promise((resolve) => { this.beginStarted = resolve; });
  }

  release(): void {
    this.releaseBegin?.();
  }

  async beginWrite(failure: UnknownWriteFailure): Promise<UnknownWriteRecord> {
    this.beginStarted?.();
    this.beginStarted = null;
    if (this.blockBegin) {
      await new Promise<void>((resolve) => { this.releaseBegin = resolve; });
      this.releaseBegin = null;
      this.blockBegin = false;
    }
    const record: UnknownWriteRecord = {
      id: `intent-${++this.sequence}`,
      schemaVersion: 1,
      phase: "IN_FLIGHT",
      operation: failure.operation,
      method: failure.method,
      key: failure.key,
      path: failure.path,
      pathFingerprint: "path-fingerprint",
      payloadFingerprint: failure.payload === undefined ? null : "payload-fingerprint",
      baselineOrderIds: failure.baselineOrderIds ?? [],
      targetOrderId: failure.targetOrderId ?? null,
      targetFingerprint: failure.targetOrder === undefined ? null : "target-fingerprint",
      preSendAt: failure.preSendAt ?? new Date().toISOString(),
      createdAt: new Date().toISOString(),
      reason: "unknown-error",
      status: null,
    };
    this.records.set(record.id, record);
    return record;
  }

  async completeWrite(id: string): Promise<void> {
    this.records.delete(id);
  }

  async discardWrite(id: string): Promise<void> {
    this.discardCount += 1;
    if (this.failDiscard) throw new Error("discard fsync failed");
    if (!this.records.has(id)) throw new Error("missing intent");
    this.records.delete(id);
  }

  async settleWrite(
    id: string,
    outcome: Pick<UnknownWriteFailure, "status" | "reason">,
  ): Promise<UnknownWriteRecord | null> {
    const record = this.records.get(id);
    if (!record) throw new Error("missing intent");
    if (outcome.status !== undefined && outcome.status >= 400 && outcome.status < 500) {
      this.records.delete(id);
      return null;
    }
    const pending: UnknownWriteRecord = {
      ...record,
      phase: "PENDING",
      status: outcome.status ?? null,
      reason: String(outcome.reason).includes("timeout") ? "timeout" : "unknown-error",
    };
    this.records.set(id, pending);
    return pending;
  }
}

class CountingTransport {
  attempts = 0;

  async send(_request: BrokerWriteRequest): Promise<BrokerWriteResponse> {
    this.attempts += 1;
    return {
      status: 201,
      headers: new Headers({ location: "/trader/v1/accounts/hash/orders/12345" }),
    };
  }
}

function request(overrides: Partial<BrokerWriteRequest> = {}): BrokerWriteRequest {
  return {
    key: "post-intent-test",
    method: "POST",
    operation: "PLACE_ORDER",
    path: "/trader/v1/accounts/hash/orders",
    payload: { orderType: "NET_DEBIT", price: "0.90" },
    baselineOrderIds: [],
    ...overrides,
  };
}

function coordinator(
  ledger: DeferredLedger,
  transport: CountingTransport,
  state: {
    stopping?: boolean;
    postIntentError?: string | null;
    persistenceFault?: unknown;
  },
): BrokerWriteCoordinator {
  return new BrokerWriteCoordinator({
    ledger,
    transport,
    guards: {
      assertReady: () => undefined,
      beforeTransportSend: () => {
        if (state.postIntentError) throw new Error(state.postIntentError);
      },
      isStopping: () => state.stopping === true,
      onPersistenceFault: (error) => { state.persistenceFault = error; },
    },
  });
}

test("a stop arriving while WAL fsync is pending discards the unsent intent and sends zero broker requests", async () => {
  const ledger = new DeferredLedger();
  const transport = new CountingTransport();
  const state = { stopping: false };
  const beginStarted = ledger.blockNextBegin();
  const pending = coordinator(ledger, transport, state).execute(request());

  await beginStarted;
  state.stopping = true;
  ledger.release();

  await assert.rejects(pending, BrokerWriteStoppingError);
  assert.equal(transport.attempts, 0);
  assert.equal(ledger.discardCount, 1);
  assert.equal(ledger.records.size, 0);
});

test("request-specific validation is repeated after WAL persistence and changed broker state blocks transport", async () => {
  const ledger = new DeferredLedger();
  const transport = new CountingTransport();
  const state = { stopping: false };
  let targetWorking = true;
  let validations = 0;
  const beginStarted = ledger.blockNextBegin();
  const pending = coordinator(ledger, transport, state).execute(request({
    validateFinal: () => {
      validations += 1;
      if (!targetWorking) throw new Error("TARGET_CHANGED_DURING_WAL_FSYNC");
    },
  }));

  await beginStarted;
  targetWorking = false;
  ledger.release();

  await assert.rejects(pending, /TARGET_CHANGED_DURING_WAL_FSYNC/);
  assert.equal(validations, 2);
  assert.equal(transport.attempts, 0);
  assert.equal(ledger.discardCount, 1);
  assert.equal(ledger.records.size, 0);
});

test("post-intent runtime guard failure clears a known-unsent WAL intent", async () => {
  const ledger = new DeferredLedger();
  const transport = new CountingTransport();
  const state = { stopping: false, postIntentError: "POST_INTENT_SNAPSHOT_STALE" };

  await assert.rejects(
    () => coordinator(ledger, transport, state).execute(request()),
    /POST_INTENT_SNAPSHOT_STALE/,
  );
  assert.equal(transport.attempts, 0);
  assert.equal(ledger.discardCount, 1);
  assert.equal(ledger.records.size, 0);
});

test("failure to durably discard a known-unsent intent escalates to a persistence fault without transport", async () => {
  const ledger = new DeferredLedger();
  ledger.failDiscard = true;
  const transport = new CountingTransport();
  const state: { stopping: boolean; persistenceFault?: unknown } = { stopping: false };
  const beginStarted = ledger.blockNextBegin();
  const pending = coordinator(ledger, transport, state).execute(request());

  await beginStarted;
  state.stopping = true;
  ledger.release();

  await assert.rejects(pending, BrokerWritePersistenceError);
  assert.equal(transport.attempts, 0);
  assert.equal(ledger.records.size, 1);
  assert.match(String(state.persistenceFault), /discard fsync failed/);
});

test("successful writes pass the post-intent barrier and preserve one physical transport attempt", async () => {
  const ledger = new DeferredLedger();
  const transport = new CountingTransport();
  const state = { stopping: false };
  let validations = 0;
  const result = await coordinator(ledger, transport, state).execute(request({
    validateFinal: () => { validations += 1; },
  }));

  assert.equal(result.orderId, "12345");
  assert.equal(validations, 2);
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.discardCount, 0);
  assert.equal(ledger.records.size, 0);
});
