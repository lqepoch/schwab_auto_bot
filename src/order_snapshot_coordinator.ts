export type SnapshotScope = "full" | "fills";

export type SnapshotState = Readonly<{
  generation: number;
  lastFullSnapshotAt: number;
  fullSnapshotReconciled: boolean;
  fullReconciliationInProgress: boolean;
  authoritative: readonly unknown[];
}>;

export type SnapshotClock = Readonly<{
  now: () => number;
}>;

export type SnapshotProvider<T> = (scope: SnapshotScope, priority: 0 | 1 | 2 | 3) => Promise<readonly T[]>;

export type OrderSnapshotCoordinatorOptions<T> = Readonly<{
  fetch: SnapshotProvider<T>;
  reconcileUnknownWrites: (orders: readonly T[]) => Promise<void>;
  onAuthoritativeReplaced?: (orders: readonly T[], state: SnapshotState) => void | Promise<void>;
  onFullReconciled?: (orders: readonly T[], state: SnapshotState) => void | Promise<void>;
  onFillsMerged?: (orders: readonly T[], state: SnapshotState) => void | Promise<void>;
  onFailure?: (scope: SnapshotScope, error: unknown) => void;
  clock?: SnapshotClock;
  isStopping?: () => boolean;
  mergeKey?: (order: T) => string;
}>;

/**
 * Owns the authoritative order snapshot and the write-readiness barrier.
 *
 * A full refresh invalidates readiness before any network I/O.  The incoming
 * list becomes authoritative before unknown-write reconciliation, but the
 * snapshot is not considered fresh/reconciled until reconciliation completes.
 * This lets fill/activity polls proceed as read-only hints while a slow full
 * reconciliation still blocks the final broker-write gate.
 */
export class OrderSnapshotCoordinator<T> {
  private readonly fetch: SnapshotProvider<T>;
  private readonly reconcileUnknownWrites: (orders: readonly T[]) => Promise<void>;
  private readonly onAuthoritativeReplaced?: (orders: readonly T[], state: SnapshotState) => void | Promise<void>;
  private readonly onFullReconciled?: (orders: readonly T[], state: SnapshotState) => void | Promise<void>;
  private readonly onFillsMerged?: (orders: readonly T[], state: SnapshotState) => void | Promise<void>;
  private readonly onFailure?: (scope: SnapshotScope, error: unknown) => void;
  private readonly clock: SnapshotClock;
  private readonly isStopping: () => boolean;
  private readonly mergeKey: (order: T) => string;
  private authoritativeOrders: readonly T[] = [];
  private generationValue = 0;
  private lastFullSnapshotAtValue = 0;
  private fullSnapshotReconciledValue = false;
  private fullReconciliationInProgressValue = false;
  private fullPollInFlight = false;
  private fillsDuringFull = new Map<string, T>();

  constructor(options: OrderSnapshotCoordinatorOptions<T>) {
    this.fetch = options.fetch;
    this.reconcileUnknownWrites = options.reconcileUnknownWrites;
    this.onAuthoritativeReplaced = options.onAuthoritativeReplaced;
    this.onFullReconciled = options.onFullReconciled;
    this.onFillsMerged = options.onFillsMerged;
    this.onFailure = options.onFailure;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.isStopping = options.isStopping ?? (() => false);
    this.mergeKey = options.mergeKey ?? ((order) => String((order as { orderId?: unknown }).orderId ?? ""));
  }

  get state(): SnapshotState {
    return this.snapshotState();
  }

  get authoritative(): readonly T[] {
    return this.authoritativeOrders;
  }

  get fullSnapshotReconciled(): boolean {
    return this.fullSnapshotReconciledValue;
  }

  get fullReconciliationInProgress(): boolean {
    return this.fullReconciliationInProgressValue;
  }

  get lastFullSnapshotAt(): number {
    return this.lastFullSnapshotAtValue;
  }

  /**
   * A caller may use this as the final-write freshness predicate.  Readiness
   * is deliberately false while a full poll or unknown-write reconciliation is
   * in progress, even if the previous snapshot is still within its age limit.
   */
  isFresh(maxAgeMs: number, now = this.clock.now()): boolean {
    return this.fullSnapshotReconciledValue
      && !this.fullReconciliationInProgressValue
      && this.lastFullSnapshotAtValue > 0
      && now - this.lastFullSnapshotAtValue <= maxAgeMs;
  }

  async pollFull(priority: 0 | 1 | 2 | 3 = 0): Promise<boolean> {
    if (this.fullPollInFlight || this.isStopping()) return false;
    this.fullPollInFlight = true;
    this.fullReconciliationInProgressValue = true;
    this.fullSnapshotReconciledValue = false;
    this.fillsDuringFull = new Map();
    try {
      const incoming = [...await this.fetch("full", priority)];
      // The authoritative view changes before reconciliation.  A matching
      // order therefore cannot accidentally be matched against a stale list.
      this.authoritativeOrders = incoming;
      this.generationValue += 1;
      await this.onAuthoritativeReplaced?.(incoming, this.snapshotState());
      await this.reconcileUnknownWrites(incoming);
      if (this.fillsDuringFull.size > 0) {
        const merged = new Map(incoming.map((order) => [this.mergeKey(order), order]));
        for (const order of this.fillsDuringFull.values()) merged.set(this.mergeKey(order), order);
        this.authoritativeOrders = [...merged.values()];
      }
      this.fullSnapshotReconciledValue = true;
      this.lastFullSnapshotAtValue = this.clock.now();
      this.fullReconciliationInProgressValue = false;
      const state = this.snapshotState();
      await this.onFullReconciled?.(incoming, state);
      return true;
    } catch (error) {
      this.fullSnapshotReconciledValue = false;
      this.fullReconciliationInProgressValue = false;
      this.onFailure?.("full", error);
      return false;
    } finally {
      this.fullPollInFlight = false;
    }
  }

  async pollFills(priority: 0 | 1 | 2 | 3 = 0): Promise<boolean> {
    if (this.isStopping()) return false;
    try {
      const incoming = [...await this.fetch("fills", priority)];
      const merged = new Map(this.authoritativeOrders.map((order) => [this.mergeKey(order), order]));
      for (const order of incoming) merged.set(this.mergeKey(order), order);
      this.authoritativeOrders = [...merged.values()];
      if (this.fullReconciliationInProgressValue) {
        for (const order of incoming) this.fillsDuringFull.set(this.mergeKey(order), order);
      }
      const state = this.snapshotState();
      await this.onFillsMerged?.(incoming, state);
      return true;
    } catch (error) {
      this.onFailure?.("fills", error);
      return false;
    }
  }

  private snapshotState(): SnapshotState {
    return {
      generation: this.generationValue,
      lastFullSnapshotAt: this.lastFullSnapshotAtValue,
      fullSnapshotReconciled: this.fullSnapshotReconciledValue,
      fullReconciliationInProgress: this.fullReconciliationInProgressValue,
      authoritative: this.authoritativeOrders,
    };
  }
}

export type RuntimeStartupCoordinatorOptions = Readonly<{
  bootstrap: () => Promise<void>;
  fullSnapshot: () => Promise<boolean>;
  onReady?: () => Promise<void> | void;
  onBlocked?: (reason: "bootstrap-failed" | "full-snapshot-failed", error?: unknown) => Promise<void> | void;
  startActivityStream?: () => Promise<void> | void;
  startTimers?: () => Promise<void> | void;
}>;

/**
 * Encodes the side-effect ordering at startup.  Activity streams and timers
 * are started only after the first full snapshot and its reconciliation have
 * completed successfully.
 */
export class RuntimeStartupCoordinator {
  private readonly options: RuntimeStartupCoordinatorOptions;

  constructor(options: RuntimeStartupCoordinatorOptions) {
    this.options = options;
  }

  async start(): Promise<boolean> {
    try {
      await this.options.bootstrap();
    } catch (error) {
      await this.options.onBlocked?.("bootstrap-failed", error);
      return false;
    }
    let ready = false;
    try {
      ready = await this.options.fullSnapshot();
    } catch (error) {
      await this.options.onBlocked?.("full-snapshot-failed", error);
      return false;
    }
    if (!ready) {
      await this.options.onBlocked?.("full-snapshot-failed");
      return false;
    }
    await this.options.onReady?.();
    await this.options.startActivityStream?.();
    await this.options.startTimers?.();
    return true;
  }
}
