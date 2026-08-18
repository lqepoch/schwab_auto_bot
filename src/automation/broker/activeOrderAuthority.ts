export const ACTIVE_ORDER_SWEEP_INTERVAL_MS = 15 * 60_000;
// Schwab documents order-history fromEnteredTime within the last 60 days.
// Keep a full day of safety margin around that boundary.
export const ACTIVE_ORDER_SWEEP_LOOKBACK_MS = 59 * 24 * 60 * 60_000;
export const ACTIVE_ORDER_QUERY_LIMIT = 3_000;

/**
 * Trader API order states that can still transition and therefore need to stay
 * in the live authoritative view even after their enteredTime ages out of the
 * normal short full-snapshot window.
 */
export const ACTIVE_ORDER_STATUS_FILTERS = [
  "AWAITING_PARENT_ORDER",
  "AWAITING_CONDITION",
  "AWAITING_STOP_CONDITION",
  "AWAITING_MANUAL_REVIEW",
  "ACCEPTED",
  "AWAITING_UR_OUT",
  "PENDING_ACTIVATION",
  "QUEUED",
  "WORKING",
  "PENDING_CANCEL",
  "PENDING_REPLACE",
  "NEW",
  "AWAITING_RELEASE_TIME",
  "PENDING_ACKNOWLEDGEMENT",
  "PENDING_RECALL",
  "UNKNOWN",
] as const;

const TERMINAL_ORDER_STATUSES = new Set([
  "REJECTED",
  "CANCELED",
  "CANCELLED",
  "REPLACED",
  "FILLED",
  "EXPIRED",
]);

export type AuthorityOrder = Readonly<Record<string, unknown>>;

export function isPotentiallyActiveOrder(order: AuthorityOrder): boolean {
  const status = String(order.status ?? "").trim().toUpperCase();
  // Unknown future broker states are retained conservatively. A newly added
  // terminal status can cost liveness until classified, but cannot disappear
  // from authority and permit a duplicate mutation silently.
  return !TERMINAL_ORDER_STATUSES.has(status);
}

export function activeOrderSweepDue(lastSweepAt: number, now: number): boolean {
  if (!Number.isFinite(now) || now < 0) throw new Error("ACTIVE_ORDER_SWEEP_CLOCK_INVALID");
  if (!Number.isFinite(lastSweepAt) || lastSweepAt < 0) throw new Error("ACTIVE_ORDER_SWEEP_STATE_INVALID");
  return lastSweepAt === 0 || now - lastSweepAt >= ACTIVE_ORDER_SWEEP_INTERVAL_MS;
}

export function missingTrackedActiveOrderIds<T extends AuthorityOrder>(
  previous: readonly T[],
  recent: readonly T[],
  key: (order: T) => string,
): string[] {
  const recentIds = new Set(recent.map(key));
  const missing = new Set<string>();
  for (const order of previous) {
    if (!isPotentiallyActiveOrder(order)) continue;
    const id = key(order);
    if (!id || recentIds.has(id)) continue;
    missing.add(id);
  }
  return [...missing];
}

export function mergeCurrentAuthority<T>(
  recent: readonly T[],
  supplemental: readonly T[],
  key: (order: T) => string,
): T[] {
  const merged = new Map<string, T>();
  for (const order of supplemental) {
    const id = key(order);
    if (!id) throw new Error("AUTHORITATIVE_ORDER_ID_MISSING");
    merged.set(id, order);
  }
  // The short current-window query is the freshest bulk view and wins when an
  // exact/sweep read overlaps it.
  for (const order of recent) {
    const id = key(order);
    if (!id) throw new Error("AUTHORITATIVE_ORDER_ID_MISSING");
    merged.set(id, order);
  }
  return [...merged.values()];
}
