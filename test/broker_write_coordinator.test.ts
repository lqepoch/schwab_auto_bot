import assert from "node:assert/strict";
import test from "node:test";
import {
  BrokerWriteCoordinator,
  BrokerWritePersistenceError,
  BrokerWriteRejectedError,
  BrokerWriteStoppingError,
  UnknownOutcomeError,
} from "../src/automation/broker/writeCoordinator.ts";
import type {
  BrokerWriteRequest,
  BrokerWriteResponse,
} from "../src/automation/broker/writeCoordinator.ts";
import {
  isExplicitBrokerRejection,
  type UnknownWriteFailure,
  type UnknownWriteRecord,
} from "../src/automation/state/unknownWriteReconciliation.ts";

type Outcome = BrokerWriteResponse | Error;

class FakeLedger {
  readonly records = new Map<string, UnknownWriteRecord>();
  failBegin = false;
  failSettle = false;
  failComplete = false;
  private sequence = 0;

  async beginWrite(failure: UnknownWriteFailure): Promise<UnknownWriteRecord> {
    if (this.failBegin) throw new Error("wal fsync failed");
    const record = {
      id: `intent-${++this.sequence}`,
      schemaVersion: 1 as const,
      phase: "IN_FLIGHT" as const,
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
      reason: "unknown-error" as const,
      status: null,
    } satisfies UnknownWriteRecord;
    this.records.set(record.id, record);
    return record;
  }

  async completeWrite(id: string): Promise<void> {
    if (this.failComplete) throw new Error("wal rename failed");
    this.records.delete(id);
  }

  async discardWrite(id: string): Promise<void> {
    if (this.failComplete) throw new Error("wal rename failed");
    this.records.delete(id);
  }

  async settleWrite(
    id: string,
    outcome: Pick<UnknownWriteFailure, "status" | "reason">,
  ): Promise<UnknownWriteRecord | null> {
    if (this.failSettle) throw new Error("wal directory fsync failed");
    const current = this.records.get(id);
    if (!current) throw new Error("missing intent");
    const status = outcome.status ?? null;
    if (status !== null && isExplicitBrokerRejection(status)) {
      this.records.delete(id);
      return null;
    }
    const pending = { ...current, phase: "PENDING" as const, reason: reasonFor(outcome.reason), status };
    this.records.set(id, pending);
    return pending;
  }

  get pendingCount(): number {
    return [...this.records.values()].filter((record) => record.phase === "PENDING").length;
  }
}

class FakeTransport {
  attempts = 0;
  preparations = 0;
  private outcomes: Outcome[] = [];
  private blocked = false;
  private started: (() => void) | null = null;
  private releaseSend: (() => void) | null = null;

  queue(...outcomes: Outcome[]): void {
    this.outcomes.push(...outcomes);
  }

  blockNext(): Promise<void> {
    this.blocked = true;
    return new Promise((resolve) => { this.started = resolve; });
  }

  release(): void {
    this.releaseSend?.();
  }

  async prepare(_request: BrokerWriteRequest) {
    this.preparations += 1;
    return {
      send: async (): Promise<BrokerWriteResponse> => {
        this.attempts += 1;
        this.started?.();
        this.started = null;
        if (this.blocked) {
          await new Promise<void>((resolve) => { this.releaseSend = resolve; });
          this.releaseSend = null;
          this.blocked = false;
        }
        const outcome = this.outcomes.shift() ?? accepted("1000");
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
  }
}

function accepted(orderId: string): BrokerWriteResponse {
  return {
    status: 201,
    headers: new Headers({ location: `/trader/v1/accounts/hash/orders/${orderId}` }),
  };
}

function rejected(status: number): BrokerWriteResponse {
  return { status, headers: new Headers() };
}

function baseRequest(overrides: Partial<BrokerWriteRequest> = {}): BrokerWriteRequest {
  return {
    key: "entry-1",
    method: "POST",
    operation: "PLACE_ORDER",
    path: "/trader/v1/accounts/hash/orders",
    payload: { orderType: "NET_DEBIT", price: "0.90" },
    baselineOrderIds: [],
    ...overrides,
  };
}

function makeCoordinator(
  ledger: FakeLedger,
  transport: FakeTransport,
  state: { ready: boolean; stopping?: boolean } = { ready: true },
) {
  return new BrokerWriteCoordinator({
    ledger,
    transport,
    guards: {
      assertReady: () => {
        if (!state.ready) throw new Error("FULL_SNAPSHOT_RECONCILIATION_REQUIRED");
        if (ledger.pendingCount > 0) throw new Error("UNKNOWN_WRITE_PENDING_RECONCILIATION");
      },
      isStopping: () => state.stopping === true,
    },
  });
}

test("PLACE success clears WAL and returns broker order ID with one physical attempt", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  transport.queue(accepted("12345"));
  const result = await makeCoordinator(ledger, transport).execute(baseRequest());
  assert.equal(result.orderId, "12345");
  assert.equal(result.status, 201);
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.records.size, 0);
});

test("explicit 4xx rejection clears WAL and never becomes unknown", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  transport.queue(rejected(422));
  await assert.rejects(
    () => makeCoordinator(ledger, transport).execute(baseRequest()),
    (error: unknown) => error instanceof BrokerWriteRejectedError && error.status === 422,
  );
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.records.size, 0);
});

test("structured HTTP 4xx transport errors are explicit rejection, not unknown outcome", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  transport.queue(Object.assign(new Error("SCHWAB_HTTP_401"), { status: 401, headers: {} }));
  await assert.rejects(
    () => makeCoordinator(ledger, transport).execute(baseRequest()),
    (error: unknown) => error instanceof BrokerWriteRejectedError && error.status === 401,
  );
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.pendingCount, 0);
});

test("5xx, timeout, socket reset, and missing Location retain one pending intent", async (t) => {
  const cases: Array<[string, Outcome]> = [
    ["5xx", rejected(503)],
    ["HTTP 408", rejected(408)],
    ["timeout", Object.assign(new Error("request timeout"), { status: 0 })],
    ["socket reset", new Error("socket reset")],
    ["missing Location", { status: 201, headers: new Headers() }],
  ];
  for (const [name, outcome] of cases) {
    await t.test(name, async () => {
      const ledger = new FakeLedger();
      const transport = new FakeTransport();
      transport.queue(outcome);
      await assert.rejects(
        () => makeCoordinator(ledger, transport).execute(baseRequest()),
        (error: unknown) => error instanceof UnknownOutcomeError,
      );
      assert.equal(transport.attempts, 1);
      assert.equal(ledger.pendingCount, 1);
    });
  }
});

test("201 plus valid Location recovers Place acceptance after response-body read failure", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  const events: string[] = [];
  transport.queue(Object.assign(new Error("response body read failed"), {
    status: 201,
    isNetworkError: true,
    headers: { location: "/trader/v1/accounts/hash/orders/98765" },
  }));
  const coordinator = new BrokerWriteCoordinator({
    ledger,
    transport,
    guards: { assertReady: () => undefined },
    emit: (event) => { events.push(event.event); },
  });
  const result = await coordinator.execute(baseRequest());
  assert.equal(result.status, 201);
  assert.equal(result.orderId, "98765");
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.records.size, 0);
  assert.equal(events.includes("acceptance-evidence-recovered"), true);
  assert.equal(events.includes("accepted"), true);
});

test("201 plus valid Location recovers Replace acceptance after response-body read failure", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  transport.queue(Object.assign(new Error("response body read failed"), {
    status: 201,
    isNetworkError: true,
    headers: new Headers({ location: "/trader/v1/accounts/hash/orders/76543" }),
  }));
  const request = baseRequest({
    method: "PUT",
    operation: "REPLACE_ORDER",
    path: "/trader/v1/accounts/hash/orders/12345",
    targetOrderId: "12345",
    targetOrder: { orderId: "12345", status: "WORKING" },
  });
  const result = await makeCoordinator(ledger, transport).execute(request);
  assert.equal(result.orderId, "76543");
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.records.size, 0);
});

test("HTTP 200 recovers Cancel acceptance after response-body read failure", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  transport.queue(Object.assign(new Error("response body read failed"), {
    status: 200,
    isNetworkError: true,
    headers: {},
  }));
  const request = baseRequest({
    method: "DELETE",
    operation: "CANCEL_ORDER",
    path: "/trader/v1/accounts/hash/orders/12345",
    payload: undefined,
    targetOrderId: "12345",
    targetOrder: { orderId: "12345", status: "WORKING" },
  });
  const result = await makeCoordinator(ledger, transport).execute(request);
  assert.equal(result.status, 200);
  assert.equal(result.orderId, null);
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.records.size, 0);
});

test("2xx transport errors require exact broker acceptance evidence", async (t) => {
  const cases: Array<[string, Error]> = [
    ["201 missing Location", Object.assign(new Error("response body read failed"), {
      status: 201, isNetworkError: true, headers: {},
    })],
    ["201 malformed Location", Object.assign(new Error("response body read failed"), {
      status: 201, isNetworkError: true, headers: { location: "/not/orders/abc" },
    })],
    ["201 non-network error", Object.assign(new Error("future schema error"), {
      status: 201, isNetworkError: false, headers: { location: "/trader/v1/accounts/hash/orders/123" },
    })],
    ["200 on Place", Object.assign(new Error("response body read failed"), {
      status: 200, isNetworkError: true, headers: {},
    })],
  ];
  for (const [name, error] of cases) {
    await t.test(name, async () => {
      const ledger = new FakeLedger();
      const transport = new FakeTransport();
      transport.queue(error);
      await assert.rejects(
        () => makeCoordinator(ledger, transport).execute(baseRequest()),
        UnknownOutcomeError,
      );
      assert.equal(transport.attempts, 1);
      assert.equal(ledger.pendingCount, 1);
    });
  }
});

test("structured 2xx response-body read failure is unknown, never a safe retry", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  transport.queue(Object.assign(new Error("response body read failed"), {
    status: 201,
    isNetworkError: true,
  }));
  await assert.rejects(
    () => makeCoordinator(ledger, transport).execute(baseRequest()),
    UnknownOutcomeError,
  );
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.pendingCount, 1);
});

test("WAL begin failure sends zero broker requests and records persistence fault", async () => {
  const ledger = new FakeLedger();
  ledger.failBegin = true;
  const transport = new FakeTransport();
  let persistenceFault: unknown = null;
  const coordinator = new BrokerWriteCoordinator({
    ledger,
    transport,
    guards: {
      assertReady: () => undefined,
      onPersistenceFault: (error) => { persistenceFault = error; },
    },
  });
  await assert.rejects(
    () => coordinator.execute(baseRequest()),
    (error: unknown) => error instanceof BrokerWritePersistenceError,
  );
  assert.equal(transport.attempts, 0);
  assert.match(String(persistenceFault), /fsync/);
});

test("WAL completion failure preserves the unresolved intent and fails closed", async () => {
  const ledger = new FakeLedger();
  ledger.failComplete = true;
  const transport = new FakeTransport();
  transport.queue(accepted("98765"));
  let persistenceFault: unknown = null;
  const coordinator = new BrokerWriteCoordinator({
    ledger,
    transport,
    guards: {
      assertReady: () => undefined,
      onPersistenceFault: (error) => { persistenceFault = error; },
    },
  });
  await assert.rejects(
    () => coordinator.execute(baseRequest()),
    (error: unknown) => error instanceof BrokerWritePersistenceError,
  );
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.records.size, 1);
  assert.match(String(persistenceFault), /rename/);
});

test("WAL settle failure after an ambiguous response preserves IN_FLIGHT and fails closed", async () => {
  const ledger = new FakeLedger();
  ledger.failSettle = true;
  const transport = new FakeTransport();
  transport.queue(new Error("socket reset"));
  await assert.rejects(
    () => new BrokerWriteCoordinator({
      ledger,
      transport,
      guards: { assertReady: () => undefined },
    }).execute(baseRequest()),
    (error: unknown) => error instanceof BrokerWritePersistenceError,
  );
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.records.size, 1);
  assert.equal([...ledger.records.values()][0]?.phase, "IN_FLIGHT");
});

test("crash/restart state permits one physical attempt and blocks every resend", async () => {
  const ledger = new FakeLedger();
  const firstTransport = new FakeTransport();
  firstTransport.queue(new Error("socket reset after broker accepted request"));
  await assert.rejects(
    () => makeCoordinator(ledger, firstTransport).execute(baseRequest()),
    UnknownOutcomeError,
  );
  assert.equal(firstTransport.attempts, 1);
  assert.equal(ledger.pendingCount, 1);

  const restartedTransport = new FakeTransport();
  restartedTransport.queue(accepted("should-not-send"));
  await assert.rejects(
    () => makeCoordinator(ledger, restartedTransport).execute(baseRequest({ key: "after-restart" })),
    /UNKNOWN_WRITE_PENDING_RECONCILIATION/,
  );
  assert.equal(restartedTransport.attempts, 0);
});

test("two queued writes re-check the final gate: first unknown blocks the second", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  const firstStarted = transport.blockNext();
  transport.queue(new Error("timeout"), accepted("second-must-not-exist"));
  const coordinator = makeCoordinator(ledger, transport);
  const first = coordinator.execute(baseRequest({ key: "first" }));
  const second = coordinator.execute(baseRequest({ key: "second" }));
  await firstStarted;
  assert.equal(transport.attempts, 1);
  transport.release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(transport.attempts, 1);
  assert.equal(ledger.pendingCount, 1);
  assert.equal(results[0]?.status, "rejected");
  assert.match(String((results[1] as PromiseRejectedResult).reason), /UNKNOWN_WRITE_PENDING/);
});

test("CANCEL success and explicit rejection clear WAL while unknown cancellation remains pending", async (t) => {
  const cases: Array<[string, Outcome, boolean]> = [
    ["success", { status: 204, headers: new Headers() }, false],
    ["explicit rejection", rejected(409), false],
    ["timeout", new Error("socket timeout"), true],
  ];
  for (const [name, outcome, pending] of cases) {
    await t.test(name, async () => {
      const ledger = new FakeLedger();
      const transport = new FakeTransport();
      transport.queue(outcome);
      const request = baseRequest({
        key: `cancel-${name}`,
        method: "DELETE",
        operation: "CANCEL_ORDER",
        path: "/trader/v1/accounts/hash/orders/12345",
        payload: undefined,
        targetOrderId: "12345",
        targetOrder: { orderId: "12345", status: "WORKING" },
      });
      if (name === "success") {
        await makeCoordinator(ledger, transport).execute(request);
      } else {
        await assert.rejects(
          () => makeCoordinator(ledger, transport).execute(request),
          pending ? UnknownOutcomeError : BrokerWriteRejectedError,
        );
      }
      assert.equal(transport.attempts, 1);
      assert.equal(ledger.pendingCount, pending ? 1 : 0);
    });
  }
});

test("final gate blocks stale snapshots and stopping state before WAL or transport", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  const state = { ready: false, stopping: false };
  const coordinator = makeCoordinator(ledger, transport, state);
  await assert.rejects(() => coordinator.execute(baseRequest()), /FULL_SNAPSHOT/);
  assert.equal(transport.attempts, 0);
  state.ready = true;
  state.stopping = true;
  await assert.rejects(
    () => coordinator.execute(baseRequest({ key: "stopping" })),
    (error: unknown) => error instanceof BrokerWriteStoppingError,
  );
  assert.equal(transport.attempts, 0);
  assert.equal(ledger.records.size, 0);
});

test("request-specific final validation blocks a changed cancel target before WAL", async () => {
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  const state = { working: true };
  const request = baseRequest({
    key: "cancel-target",
    method: "DELETE",
    operation: "CANCEL_ORDER",
    path: "/trader/v1/accounts/hash/orders/12345",
    payload: undefined,
    targetOrderId: "12345",
    targetOrder: { orderId: "12345", status: "WORKING" },
    validateFinal: () => {
      if (!state.working) throw new Error("CANCEL_TARGET_NOT_WORKING");
    },
  });
  state.working = false;
  await assert.rejects(
    () => makeCoordinator(ledger, transport).execute(request),
    /CANCEL_TARGET_NOT_WORKING/,
  );
  assert.equal(ledger.records.size, 0);
  assert.equal(transport.attempts, 0);
});

test("Location must identify a numeric order resource, not an arbitrary final path segment", async () => {
  const cases = [
    "/trader/v1/accounts/hash/orders/not-a-number",
    "/trader/v1/accounts/hash/positions/123",
    "/trader/v1/accounts/hash/orders/123/extra",
  ];
  for (const location of cases) {
    const ledger = new FakeLedger();
    const transport = new FakeTransport();
    transport.queue({ status: 201, headers: new Headers({ location }) });
    await assert.rejects(
      () => makeCoordinator(ledger, transport).execute(baseRequest()),
      UnknownOutcomeError,
    );
    assert.equal(ledger.pendingCount, 1);
  }
  const ledger = new FakeLedger();
  const transport = new FakeTransport();
  transport.queue({
    status: 201,
    headers: new Headers({ location: "https://api.schwabapi.com/trader/v1/accounts/hash/orders/123?x=1" }),
  });
  const result = await makeCoordinator(ledger, transport).execute(baseRequest());
  assert.equal(result.orderId, "123");
  assert.equal(ledger.records.size, 0);
});

function reasonFor(value: string | undefined): "network-error" | "timeout" | "server-error" | "missing-location" | "unknown-error" {
  const reason = String(value ?? "");
  if (reason.includes("timeout")) return "timeout";
  if (reason.includes("server")) return "server-error";
  if (reason.includes("missing")) return "missing-location";
  if (reason.includes("network")) return "network-error";
  return "unknown-error";
}
