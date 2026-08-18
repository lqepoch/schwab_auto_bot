import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FULL_ORDER_LOOKBACK_MS,
  SCHWAB_ORDER_HISTORY_HORIZON_MS,
  planUnknownWriteRecovery,
} from "../src/automation/broker/unknownWriteRecoveryPlan.ts";
import type { UnknownWriteRecord } from "../src/automation/state/unknownWriteReconciliation.ts";

const NOW = Date.parse("2026-08-18T03:20:00.000Z");

function record(overrides: Partial<UnknownWriteRecord> = {}): UnknownWriteRecord {
  return {
    id: "pending-1",
    schemaVersion: 1,
    phase: "PENDING",
    operation: "PLACE_ORDER",
    method: "POST",
    key: "submit",
    path: "/trader/v1/accounts/[REDACTED]/orders",
    pathFingerprint: "path",
    payloadFingerprint: "payload",
    baselineOrderIds: [],
    targetOrderId: null,
    targetFingerprint: null,
    preSendAt: new Date(NOW - 30 * 60_000).toISOString(),
    createdAt: new Date(NOW - 30 * 60_000).toISOString(),
    reason: "timeout",
    status: 0,
    ...overrides,
  };
}

test("recent PLACE ambiguity is already covered by the ordinary full snapshot", () => {
  assert.deepEqual(planUnknownWriteRecovery([record()], NOW), {
    targetOrderIds: [],
    historyWindows: [],
  });
});

test("old PLACE ambiguity gets only a narrow broker-match history window", () => {
  const preSendAt = NOW - 2 * 60 * 60_000;
  const plan = planUnknownWriteRecovery([record({ preSendAt: new Date(preSendAt).toISOString() })], NOW);
  assert.deepEqual(plan.targetOrderIds, []);
  assert.deepEqual(plan.historyWindows, [{
    fromEnteredTime: new Date(preSendAt - 5_000).toISOString(),
    toEnteredTime: new Date(preSendAt + 60_000).toISOString(),
  }]);
});

test("REPLACE recovery includes the exact source and a historical successor window", () => {
  const preSendAt = NOW - 3 * 60 * 60_000;
  const plan = planUnknownWriteRecovery([record({
    operation: "REPLACE_ORDER",
    method: "PUT",
    targetOrderId: "123456",
    targetFingerprint: "source-fingerprint",
    preSendAt: new Date(preSendAt).toISOString(),
  })], NOW);
  assert.deepEqual(plan.targetOrderIds, ["123456"]);
  assert.equal(plan.historyWindows.length, 1);
});

test("CANCEL recovery uses exact-order lookup without consuming the 60-day history horizon", () => {
  const veryOld = NOW - SCHWAB_ORDER_HISTORY_HORIZON_MS - 10 * 24 * 60 * 60_000;
  const plan = planUnknownWriteRecovery([record({
    operation: "CANCEL_ORDER",
    method: "DELETE",
    targetOrderId: "555",
    targetFingerprint: "cancel-source",
    payloadFingerprint: null,
    preSendAt: new Date(veryOld).toISOString(),
  })], NOW);
  assert.deepEqual(plan.targetOrderIds, ["555"]);
  assert.deepEqual(plan.historyWindows, []);
});

test("overlapping old creation windows are coalesced to reduce recovery requests", () => {
  const first = NOW - 2 * 60 * 60_000;
  const second = first + 30_000;
  const plan = planUnknownWriteRecovery([
    record({ id: "one", preSendAt: new Date(first).toISOString() }),
    record({ id: "two", preSendAt: new Date(second).toISOString() }),
  ], NOW);
  assert.deepEqual(plan.historyWindows, [{
    fromEnteredTime: new Date(first - 5_000).toISOString(),
    toEnteredTime: new Date(second + 60_000).toISOString(),
  }]);
});

test("old creation ambiguity beyond Schwab's documented history horizon fails closed", () => {
  const tooOld = NOW - SCHWAB_ORDER_HISTORY_HORIZON_MS;
  assert.throws(
    () => planUnknownWriteRecovery([record({ preSendAt: new Date(tooOld).toISOString() })], NOW),
    /UNKNOWN_WRITE_RECONCILIATION_HORIZON_EXCEEDED/,
  );
});

test("malformed recovery identity and timestamps fail closed", () => {
  assert.throws(
    () => planUnknownWriteRecovery([record({
      operation: "CANCEL_ORDER",
      method: "DELETE",
      targetOrderId: "../../unsafe",
      targetFingerprint: "source",
      payloadFingerprint: null,
    })], NOW),
    /UNKNOWN_WRITE_TARGET_ORDER_ID_INVALID/,
  );
  assert.throws(
    () => planUnknownWriteRecovery([record({ preSendAt: "not-a-date" })], NOW),
    /UNKNOWN_WRITE_RECONCILIATION_TIMESTAMP_INVALID/,
  );
  assert.throws(
    () => planUnknownWriteRecovery([record({ preSendAt: new Date(NOW + 6_000).toISOString() })], NOW),
    /UNKNOWN_WRITE_RECONCILIATION_TIMESTAMP_IN_FUTURE/,
  );
  assert.throws(
    () => planUnknownWriteRecovery([record()], Number.NaN, DEFAULT_FULL_ORDER_LOOKBACK_MS),
    /UNKNOWN_WRITE_RECOVERY_CLOCK_INVALID/,
  );
});
