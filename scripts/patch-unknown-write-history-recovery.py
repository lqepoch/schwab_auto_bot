from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()

old_import = '''import { BrokerWriteCoordinator } from "./broker/writeCoordinator.ts";
import { OrderSnapshotCoordinator, RuntimeStartupCoordinator } from "./broker/orderSnapshotCoordinator.ts";
'''
new_import = '''import { BrokerWriteCoordinator } from "./broker/writeCoordinator.ts";
import {
  DEFAULT_FULL_ORDER_LOOKBACK_MS,
  planUnknownWriteRecovery,
} from "./broker/unknownWriteRecoveryPlan.ts";
import { OrderSnapshotCoordinator, RuntimeStartupCoordinator } from "./broker/orderSnapshotCoordinator.ts";
'''
if text.count(old_import) != 1:
    raise SystemExit("runtime recovery-plan import patch point missing")
text = text.replace(old_import, new_import)

old_fetch = '''const orderSnapshotCoordinator = new OrderSnapshotCoordinator<Json>({
  fetch: async (scope, priority) => {
    const now = new Date();
    const lookbackMs = scope === "full" ? 60 * 60_000 : 5 * 60_000;
    const from = new Date(now.getTime() - lookbackMs);
    const query = new URLSearchParams({
      fromEnteredTime: from.toISOString(),
      toEnteredTime: now.toISOString(),
      maxResults: "3000",
    });
    if (scope === "fills") query.set("status", "FILLED");
    const response = await api(`/trader/v1/accounts/${accountHash}/orders?${query}`, {}, priority);
    if (!Array.isArray(response.body)) throw new Error("订单快照不是数组");
    return flatten(response.body);
  },
'''
new_fetch = '''const orderSnapshotCoordinator = new OrderSnapshotCoordinator<Json>({
  fetch: async (scope, priority) => {
    const now = new Date();
    const lookbackMs = scope === "full" ? DEFAULT_FULL_ORDER_LOOKBACK_MS : 5 * 60_000;
    const fetchRange = async (
      fromEnteredTime: string,
      toEnteredTime: string,
      status?: "FILLED",
    ): Promise<Json[]> => {
      const query = new URLSearchParams({
        fromEnteredTime,
        toEnteredTime,
        maxResults: "3000",
      });
      if (status) query.set("status", status);
      const response = await api(`/trader/v1/accounts/${accountHash}/orders?${query}`, {}, priority);
      if (!Array.isArray(response.body)) throw new Error("订单快照不是数组");
      return flatten(response.body);
    };

    const primary = await fetchRange(
      new Date(now.getTime() - lookbackMs).toISOString(),
      now.toISOString(),
      scope === "fills" ? "FILLED" : undefined,
    );
    if (scope !== "full") return primary;

    const recoveryPlan = planUnknownWriteRecovery(
      unknownWriteReconciliation.pending(),
      now.getTime(),
      lookbackMs,
    );
    if (recoveryPlan.targetOrderIds.length === 0 && recoveryPlan.historyWindows.length === 0) {
      return primary;
    }

    executionJournal.record("broker.write.recovery-read-plan", {
      pendingCount: unknownWriteReconciliation.pending().length,
      exactTargetReads: recoveryPlan.targetOrderIds.length,
      historyWindowReads: recoveryPlan.historyWindows.length,
    });

    const recovered: Json[] = [];
    const primaryIds = new Set(primary.map(orderId));
    for (const targetOrderId of recoveryPlan.targetOrderIds) {
      if (primaryIds.has(targetOrderId)) continue;
      const response = await api(
        `/trader/v1/accounts/${accountHash}/orders/${encodeURIComponent(targetOrderId)}`,
        {},
        priority,
      );
      const values = Array.isArray(response.body) ? response.body : [response.body];
      if (values.length !== 1 || !values[0] || typeof values[0] !== "object" || Array.isArray(values[0])) {
        throw new Error("UNKNOWN_WRITE_TARGET_ORDER_RESPONSE_INVALID");
      }
      recovered.push(...flatten(values as Json[]));
    }
    for (const window of recoveryPlan.historyWindows) {
      recovered.push(...await fetchRange(window.fromEnteredTime, window.toEnteredTime));
    }

    // Historical recovery rows exist only to reconcile durable unknown writes.
    // If they overlap the ordinary snapshot, the current full-window row wins.
    const merged = new Map<string, Json>();
    for (const order of recovered) merged.set(orderId(order), order);
    for (const order of primary) merged.set(orderId(order), order);
    return [...merged.values()];
  },
'''
if text.count(old_fetch) != 1:
    raise SystemExit(f"runtime order snapshot fetch patch point count={text.count(old_fetch)}")
path.write_text(text.replace(old_fetch, new_fetch))
