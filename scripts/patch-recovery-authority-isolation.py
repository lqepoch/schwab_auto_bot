from pathlib import Path

coordinator_path = Path("src/automation/broker/orderSnapshotCoordinator.ts")
text = coordinator_path.read_text()

old_type = '''export type OrderSnapshotCoordinatorOptions<T> = Readonly<{
  fetch: SnapshotProvider<T>;
  reconcileUnknownWrites: (orders: readonly T[]) => Promise<void>;
'''
new_type = '''export type ReconciliationSupplementProvider<T> = (
  authoritative: readonly T[],
  priority: 0 | 1 | 2 | 3,
) => Promise<readonly T[]>;

export type OrderSnapshotCoordinatorOptions<T> = Readonly<{
  fetch: SnapshotProvider<T>;
  /**
   * Optional historical/exact rows used only to reconcile durable unknown
   * writes. These rows never enter the live authoritative order snapshot.
   */
  reconciliationSupplement?: ReconciliationSupplementProvider<T>;
  reconcileUnknownWrites: (orders: readonly T[]) => Promise<void>;
'''
if text.count(old_type) != 1:
    raise SystemExit("snapshot options patch point missing")
text = text.replace(old_type, new_type)

old_property = '''  private readonly fetch: SnapshotProvider<T>;
  private readonly reconcileUnknownWrites: (orders: readonly T[]) => Promise<void>;
'''
new_property = '''  private readonly fetch: SnapshotProvider<T>;
  private readonly reconciliationSupplement?: ReconciliationSupplementProvider<T>;
  private readonly reconcileUnknownWrites: (orders: readonly T[]) => Promise<void>;
'''
if text.count(old_property) != 1:
    raise SystemExit("snapshot property patch point missing")
text = text.replace(old_property, new_property)

old_ctor = '''    this.fetch = options.fetch;
    this.reconcileUnknownWrites = options.reconcileUnknownWrites;
'''
new_ctor = '''    this.fetch = options.fetch;
    this.reconciliationSupplement = options.reconciliationSupplement;
    this.reconcileUnknownWrites = options.reconcileUnknownWrites;
'''
if text.count(old_ctor) != 1:
    raise SystemExit("snapshot constructor patch point missing")
text = text.replace(old_ctor, new_ctor)

old_reconcile = '''      await this.onAuthoritativeReplaced?.(incoming, this.snapshotState());
      await this.reconcileUnknownWrites(incoming);
      if (this.fillsDuringFull.size > 0) {
'''
new_reconcile = '''      await this.onAuthoritativeReplaced?.(incoming, this.snapshotState());
      let reconciliationOrders: readonly T[] = incoming;
      if (this.reconciliationSupplement) {
        const supplement = [...await this.reconciliationSupplement(incoming, priority)];
        if (supplement.length > 0) {
          // Recovery-only rows are merged for reconciliation evidence, with the
          // ordinary current snapshot winning duplicate IDs. They never become
          // authoritative orders consumed by trading policy or execution logic.
          const merged = new Map(supplement.map((order) => [this.mergeKey(order), order]));
          for (const order of incoming) merged.set(this.mergeKey(order), order);
          reconciliationOrders = [...merged.values()];
        }
      }
      await this.reconcileUnknownWrites(reconciliationOrders);
      if (this.fillsDuringFull.size > 0) {
'''
if text.count(old_reconcile) != 1:
    raise SystemExit("snapshot reconciliation patch point missing")
text = text.replace(old_reconcile, new_reconcile)
coordinator_path.write_text(text)

runtime_path = Path("src/automation/runtimeOrchestrator.ts")
text = runtime_path.read_text()
old_block = '''const orderSnapshotCoordinator = new OrderSnapshotCoordinator<Json>({
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
  reconcileUnknownWrites: async () => reconcileUnknownWritesAfterFullSnapshot(),
'''
new_block = '''async function fetchOrderRange(
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
  reconciliationSupplement: async (authoritative, priority) => {
    const now = new Date();
    const recoveryPlan = planUnknownWriteRecovery(
      unknownWriteReconciliation.pending(),
      now.getTime(),
      DEFAULT_FULL_ORDER_LOOKBACK_MS,
    );
    if (recoveryPlan.targetOrderIds.length === 0 && recoveryPlan.historyWindows.length === 0) {
      return [];
    }

    executionJournal.record("broker.write.recovery-read-plan", {
      pendingCount: unknownWriteReconciliation.pending().length,
      exactTargetReads: recoveryPlan.targetOrderIds.length,
      historyWindowReads: recoveryPlan.historyWindows.length,
    });

    const recovered: Json[] = [];
    const authoritativeIds = new Set(authoritative.map(orderId));
    for (const targetOrderId of recoveryPlan.targetOrderIds) {
      if (authoritativeIds.has(targetOrderId)) continue;
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
      recovered.push(...await fetchOrderRange(
        window.fromEnteredTime,
        window.toEnteredTime,
        priority,
      ));
    }
    return recovered;
  },
  reconcileUnknownWrites: async (snapshot) => reconcileUnknownWritesAfterFullSnapshot(snapshot),
'''
if text.count(old_block) != 1:
    raise SystemExit("runtime snapshot/recovery block patch point missing")
text = text.replace(old_block, new_block)

old_function = '''async function reconcileUnknownWritesAfterFullSnapshot(): Promise<void> {
  try {
    const result = await unknownWriteReconciliation.reconcile(orders);
'''
new_function = '''async function reconcileUnknownWritesAfterFullSnapshot(snapshot: readonly Json[] = orders): Promise<void> {
  try {
    const result = await unknownWriteReconciliation.reconcile(snapshot);
'''
if text.count(old_function) != 1:
    raise SystemExit("runtime reconcile function patch point missing")
text = text.replace(old_function, new_function)
runtime_path.write_text(text)
