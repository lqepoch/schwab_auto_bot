from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()

old_import = '''import { BrokerWriteCoordinator } from "./broker/writeCoordinator.ts";
import {
  DEFAULT_FULL_ORDER_LOOKBACK_MS,
  planUnknownWriteRecovery,
} from "./broker/unknownWriteRecoveryPlan.ts";
'''
new_import = '''import { BrokerWriteCoordinator } from "./broker/writeCoordinator.ts";
import {
  ACTIVE_ORDER_QUERY_LIMIT,
  ACTIVE_ORDER_STATUS_FILTERS,
  ACTIVE_ORDER_SWEEP_LOOKBACK_MS,
  activeOrderSweepDue,
  mergeCurrentAuthority,
  missingTrackedActiveOrderIds,
} from "./broker/activeOrderAuthority.ts";
import {
  DEFAULT_FULL_ORDER_LOOKBACK_MS,
  planUnknownWriteRecovery,
} from "./broker/unknownWriteRecoveryPlan.ts";
'''
if text.count(old_import) != 1:
    raise SystemExit("active authority import patch point missing")
text = text.replace(old_import, new_import)

old_range_and_fetch = '''async function fetchOrderRange(
  fromEnteredTime: string,
  toEnteredTime: string,
  priority: Priority,
  status?: "FILLED",
): Promise<Json[]> {
  const query = new URLSearchParams({
    fromEnteredTime,
    toEnteredTime,
    maxResults: "3000",
  });
  if (status) query.set("status", status);
  const response = await api(`/trader/v1/accounts/${accountHash}/orders?${query}`, {}, priority);
  if (!Array.isArray(response.body)) throw new Error("订单快照不是数组");
  return flatten(response.body);
}

const orderSnapshotCoordinator = new OrderSnapshotCoordinator<Json>({
  fetch: async (scope, priority) => {
    const now = new Date();
    const lookbackMs = scope === "full" ? DEFAULT_FULL_ORDER_LOOKBACK_MS : 5 * 60_000;
    return fetchOrderRange(
      new Date(now.getTime() - lookbackMs).toISOString(),
      now.toISOString(),
      priority,
      scope === "fills" ? "FILLED" : undefined,
    );
  },
'''
new_range_and_fetch = '''async function fetchOrderRange(
  fromEnteredTime: string,
  toEnteredTime: string,
  priority: Priority,
  status?: string,
): Promise<Json[]> {
  const query = new URLSearchParams({
    fromEnteredTime,
    toEnteredTime,
    maxResults: String(ACTIVE_ORDER_QUERY_LIMIT),
  });
  if (status) query.set("status", status);
  const response = await api(`/trader/v1/accounts/${accountHash}/orders?${query}`, {}, priority);
  if (!Array.isArray(response.body)) throw new Error("订单快照不是数组");
  // Treat a page exactly at Schwab's requested ceiling as potentially
  // truncated. Partial authority is less safe than keeping the write barrier
  // closed; a later adaptive-range reader can improve liveness here.
  if (response.body.length >= ACTIVE_ORDER_QUERY_LIMIT) {
    throw new Error(`ORDER_SNAPSHOT_RANGE_SATURATED status=${status ?? "ALL"}`);
  }
  return flatten(response.body);
}

async function fetchExactOrderTree(orderIdValue: string, priority: Priority): Promise<Json[]> {
  if (!/^\\d+$/.test(orderIdValue)) throw new Error("AUTHORITATIVE_ORDER_ID_INVALID");
  const response = await api(
    `/trader/v1/accounts/${accountHash}/orders/${encodeURIComponent(orderIdValue)}`,
    {},
    priority,
  );
  const values = Array.isArray(response.body) ? response.body : [response.body];
  if (values.length != 1 || !values[0] || typeof values[0] !== "object" || Array.isArray(values[0])) {
    throw new Error("AUTHORITATIVE_ORDER_RESPONSE_INVALID");
  }
  return flatten(values as Json[]);
}

let lastActiveOrderSweepAt = 0;

async function fetchLiveAuthoritativeOrders(now: Date, priority: Priority): Promise<Json[]> {
  const recent = await fetchOrderRange(
    new Date(now.getTime() - DEFAULT_FULL_ORDER_LOOKBACK_MS).toISOString(),
    now.toISOString(),
    priority,
  );
  const supplemental: Json[] = [];

  if (activeOrderSweepDue(lastActiveOrderSweepAt, now.getTime())) {
    const from = new Date(now.getTime() - ACTIVE_ORDER_SWEEP_LOOKBACK_MS).toISOString();
    for (const status of ACTIVE_ORDER_STATUS_FILTERS) {
      supplemental.push(...await fetchOrderRange(from, now.toISOString(), priority, status));
    }
    lastActiveOrderSweepAt = now.getTime();
    executionJournal.record("orders.active-authority-sweep", {
      statusQueries: ACTIVE_ORDER_STATUS_FILTERS.length,
      supplementalRows: supplemental.length,
      lookbackMs: ACTIVE_ORDER_SWEEP_LOOKBACK_MS,
    });
  } else {
    const missingActiveIds = missingTrackedActiveOrderIds(orders, recent, orderId);
    for (const orderIdValue of missingActiveIds) {
      supplemental.push(...await fetchExactOrderTree(orderIdValue, priority));
    }
    if (missingActiveIds.length > 0) {
      executionJournal.record("orders.active-authority-exact-refresh", {
        exactReads: missingActiveIds.length,
        supplementalRows: supplemental.length,
      });
    }
  }

  return mergeCurrentAuthority(recent, supplemental, orderId);
}

const orderSnapshotCoordinator = new OrderSnapshotCoordinator<Json>({
  fetch: async (scope, priority) => {
    const now = new Date();
    if (scope === "full") return fetchLiveAuthoritativeOrders(now, priority);
    return fetchOrderRange(
      new Date(now.getTime() - 5 * 60_000).toISOString(),
      now.toISOString(),
      priority,
      "FILLED",
    );
  },
'''
if text.count(old_range_and_fetch) != 1:
    raise SystemExit("active authority fetch block patch point missing")
text = text.replace(old_range_and_fetch, new_range_and_fetch)

old_recovery_exact = '''      const response = await api(
        `/trader/v1/accounts/${accountHash}/orders/${encodeURIComponent(targetOrderId)}`,
        {},
        priority,
      );
      const values = Array.isArray(response.body) ? response.body : [response.body];
      if (values.length !== 1 || !values[0] || typeof values[0] !== "object" || Array.isArray(values[0])) {
        throw new Error("UNKNOWN_WRITE_TARGET_ORDER_RESPONSE_INVALID");
      }
      recovered.push(...flatten(values as Json[]));
'''
new_recovery_exact = '''      recovered.push(...await fetchExactOrderTree(targetOrderId, priority));
'''
if text.count(old_recovery_exact) != 1:
    raise SystemExit("recovery exact-read helper patch point missing")
text = text.replace(old_recovery_exact, new_recovery_exact)
path.write_text(text)
