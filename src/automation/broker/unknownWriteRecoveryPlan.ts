import type { UnknownWriteRecord } from "../state/unknownWriteReconciliation.ts";

export const DEFAULT_FULL_ORDER_LOOKBACK_MS = 60 * 60_000;
export const SCHWAB_ORDER_HISTORY_HORIZON_MS = 60 * 24 * 60 * 60_000;
const BROKER_CLOCK_SKEW_MS = 5_000;
const BROKER_MATCH_WINDOW_MS = 60_000;

export type UnknownWriteHistoryWindow = Readonly<{
  fromEnteredTime: string;
  toEnteredTime: string;
}>;

export type UnknownWriteRecoveryPlan = Readonly<{
  targetOrderIds: readonly string[];
  historyWindows: readonly UnknownWriteHistoryWindow[];
}>;

type NumericWindow = { from: number; to: number };

/**
 * Build the minimum additional read plan needed beside the ordinary full-order
 * snapshot. Cancel/Replace records need their exact source order even when it
 * was entered long before the normal snapshot window. Place/Replace records
 * older than the normal window need a narrow historical range around pre-send
 * time so a uniquely matching created/replacement order can still be found.
 *
 * Schwab documents fromEnteredTime as limited to the last 60 days, so an older
 * creation/replacement ambiguity remains fail-closed for operator recovery.
 */
export function planUnknownWriteRecovery(
  records: readonly UnknownWriteRecord[],
  nowMs = Date.now(),
  standardLookbackMs = DEFAULT_FULL_ORDER_LOOKBACK_MS,
): UnknownWriteRecoveryPlan {
  if (!Number.isFinite(nowMs) || standardLookbackMs <= 0 || !Number.isFinite(standardLookbackMs)) {
    throw new Error("UNKNOWN_WRITE_RECOVERY_CLOCK_INVALID");
  }

  const targetOrderIds = new Set<string>();
  const windows: NumericWindow[] = [];
  const standardFrom = nowMs - standardLookbackMs;
  const historyFloor = nowMs - SCHWAB_ORDER_HISTORY_HORIZON_MS;

  for (const record of records) {
    if (record.phase !== "PENDING") continue;

    if (record.targetOrderId !== null) {
      if (!/^\d+$/.test(record.targetOrderId)) {
        throw new Error("UNKNOWN_WRITE_TARGET_ORDER_ID_INVALID");
      }
      targetOrderIds.add(record.targetOrderId);
    }

    if (record.operation === "CANCEL_ORDER") continue;

    const reference = record.preSendAt ?? record.createdAt;
    const preSendAt = Date.parse(reference);
    if (!Number.isFinite(preSendAt)) {
      throw new Error("UNKNOWN_WRITE_RECONCILIATION_TIMESTAMP_INVALID");
    }
    if (preSendAt > nowMs + BROKER_CLOCK_SKEW_MS) {
      throw new Error("UNKNOWN_WRITE_RECONCILIATION_TIMESTAMP_IN_FUTURE");
    }

    const from = preSendAt - BROKER_CLOCK_SKEW_MS;
    if (from >= standardFrom) continue;
    if (from < historyFloor) {
      throw new Error("UNKNOWN_WRITE_RECONCILIATION_HORIZON_EXCEEDED");
    }
    const to = Math.min(nowMs, preSendAt + BROKER_MATCH_WINDOW_MS);
    if (to < from) {
      throw new Error("UNKNOWN_WRITE_RECONCILIATION_WINDOW_INVALID");
    }
    windows.push({ from, to });
  }

  windows.sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: NumericWindow[] = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.from <= previous.to) {
      previous.to = Math.max(previous.to, window.to);
    } else {
      merged.push({ ...window });
    }
  }

  return {
    targetOrderIds: [...targetOrderIds],
    historyWindows: merged.map((window) => ({
      fromEnteredTime: new Date(window.from).toISOString(),
      toEnteredTime: new Date(window.to).toISOString(),
    })),
  };
}
