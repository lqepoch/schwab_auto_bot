import {
  compareOpeningOrders,
  managedOpeningInfo,
  orderEventTime,
  orderIdentifier,
} from "./orderIndex.ts";
import type { OrderInfoResolver } from "./orderMetadataCache.ts";
import { orderInfo, type Json } from "./policy/order.ts";
import type { RuntimePolicy } from "./policy/runtime.ts";

export type RuntimeOrderIndexSnapshot = Readonly<{
  workingAllowedUnderlyingOrders: readonly Json[];
  currentStrategyOrders: readonly Json[];
  activeOpeningOrdersByStrategy: ReadonlyMap<string, readonly Json[]>;
  activeClosingOrdersByStrategy: ReadonlyMap<string, readonly Json[]>;
  activeClosingOrders: readonly Json[];
  primaryActiveOpeningOrders: readonly Json[];
  primaryActiveOpeningOrderIds: ReadonlyMap<string, string>;
}>;

const EMPTY_ORDERS: readonly Json[] = Object.freeze([]);

/**
 * Revision-aware cache for order views that are queried repeatedly between
 * authoritative broker snapshots. Runtime owns the revision counter and must
 * advance it whenever the in-memory order authority changes.
 *
 * The cache keeps the broker-authoritative array as the source of truth. It
 * only materializes derived lookup views; it never mutates broker rows.
 */
export class RuntimeOrderIndexCache {
  private source: readonly Json[] | null = null;
  private revision = Number.NaN;
  private tradingDate = "";
  private policy: RuntimePolicy | null = null;
  private workingStatuses: ReadonlySet<string> | null = null;
  private cached: RuntimeOrderIndexSnapshot | null = null;
  private readonly resolveInfo: OrderInfoResolver;

  constructor(resolveInfo: OrderInfoResolver = orderInfo) {
    this.resolveInfo = resolveInfo;
  }

  snapshot(
    source: readonly Json[],
    revision: number,
    policy: RuntimePolicy,
    tradingDate: string,
    workingStatuses: ReadonlySet<string>,
  ): RuntimeOrderIndexSnapshot {
    if (
      this.cached
      && this.source === source
      && this.revision === revision
      && this.tradingDate === tradingDate
      && this.policy === policy
      && this.workingStatuses === workingStatuses
    ) return this.cached;

    const workingAllowedUnderlyingOrders: Json[] = [];
    const currentStrategyOrders: Json[] = [];
    const activeOpeningOrdersByStrategy = new Map<string, Json[]>();
    const activeClosingOrdersByStrategy = new Map<string, Json[]>();
    const activeClosingOrders: Json[] = [];
    const primaryActiveOpeningOrdersByStrategy = new Map<string, Json>();

    for (const order of source) {
      const meta = this.resolveInfo(order);
      const allowedUnderlying = Boolean(meta && policy.underlyings.has(meta.underlying));
      const isWorking = workingStatuses.has(String(order.status));
      if (isWorking && allowedUnderlying) workingAllowedUnderlyingOrders.push(order);

      const isCurrentStrategyOrder = Boolean(
        allowedUnderlying
        && meta
        && meta.expiration === tradingDate,
      );
      if (isCurrentStrategyOrder) currentStrategyOrders.push(order);
      if (!isWorking) continue;

      if (isCurrentStrategyOrder && meta) {
        if (meta.opening) push(activeOpeningOrdersByStrategy, meta.key, order);
        if (meta.closing) {
          push(activeClosingOrdersByStrategy, meta.key, order);
          activeClosingOrders.push(order);
        }
      }

      const managed = managedOpeningInfo(order, policy, tradingDate, meta);
      if (!managed) continue;
      const current = primaryActiveOpeningOrdersByStrategy.get(managed.key);
      if (!current || compareOpeningOrders(order, current) < 0) {
        primaryActiveOpeningOrdersByStrategy.set(managed.key, order);
      }
    }

    for (const values of activeOpeningOrdersByStrategy.values()) {
      values.sort(compareOpeningOrders);
    }
    for (const values of activeClosingOrdersByStrategy.values()) {
      values.sort(compareClosingOrders);
    }
    activeClosingOrders.sort(compareClosingOrders);

    const primaryActiveOpeningOrderIds = new Map<string, string>();
    for (const [strategy, order] of primaryActiveOpeningOrdersByStrategy) {
      primaryActiveOpeningOrderIds.set(strategy, orderIdentifier(order));
    }

    const snapshot: RuntimeOrderIndexSnapshot = {
      workingAllowedUnderlyingOrders,
      currentStrategyOrders,
      activeOpeningOrdersByStrategy,
      activeClosingOrdersByStrategy,
      activeClosingOrders,
      primaryActiveOpeningOrders: [...primaryActiveOpeningOrdersByStrategy.values()],
      primaryActiveOpeningOrderIds,
    };
    this.source = source;
    this.revision = revision;
    this.tradingDate = tradingDate;
    this.policy = policy;
    this.workingStatuses = workingStatuses;
    this.cached = snapshot;
    return snapshot;
  }

  workingAllowedOrders(
    source: readonly Json[],
    revision: number,
    policy: RuntimePolicy,
    tradingDate: string,
    workingStatuses: ReadonlySet<string>,
  ): readonly Json[] {
    return this.snapshot(source, revision, policy, tradingDate, workingStatuses)
      .workingAllowedUnderlyingOrders;
  }

  currentOrders(
    source: readonly Json[],
    revision: number,
    policy: RuntimePolicy,
    tradingDate: string,
    workingStatuses: ReadonlySet<string>,
  ): readonly Json[] {
    return this.snapshot(source, revision, policy, tradingDate, workingStatuses)
      .currentStrategyOrders;
  }

  activeOpeningOrders(
    source: readonly Json[],
    revision: number,
    policy: RuntimePolicy,
    tradingDate: string,
    workingStatuses: ReadonlySet<string>,
    strategy: string,
  ): readonly Json[] {
    return this.snapshot(source, revision, policy, tradingDate, workingStatuses)
      .activeOpeningOrdersByStrategy.get(strategy) ?? EMPTY_ORDERS;
  }

  activeClosingOrders(
    source: readonly Json[],
    revision: number,
    policy: RuntimePolicy,
    tradingDate: string,
    workingStatuses: ReadonlySet<string>,
    strategy: string,
  ): readonly Json[] {
    return this.snapshot(source, revision, policy, tradingDate, workingStatuses)
      .activeClosingOrdersByStrategy.get(strategy) ?? EMPTY_ORDERS;
  }

  allActiveClosingOrders(
    source: readonly Json[],
    revision: number,
    policy: RuntimePolicy,
    tradingDate: string,
    workingStatuses: ReadonlySet<string>,
  ): readonly Json[] {
    return this.snapshot(source, revision, policy, tradingDate, workingStatuses)
      .activeClosingOrders;
  }

  primaryOpeningOrders(
    source: readonly Json[],
    revision: number,
    policy: RuntimePolicy,
    tradingDate: string,
    workingStatuses: ReadonlySet<string>,
  ): readonly Json[] {
    return this.snapshot(source, revision, policy, tradingDate, workingStatuses)
      .primaryActiveOpeningOrders;
  }

  primaryOpeningOrderIds(
    source: readonly Json[],
    revision: number,
    policy: RuntimePolicy,
    tradingDate: string,
    workingStatuses: ReadonlySet<string>,
  ): ReadonlyMap<string, string> {
    return this.snapshot(source, revision, policy, tradingDate, workingStatuses)
      .primaryActiveOpeningOrderIds;
  }
}

function push(target: Map<string, Json[]>, strategy: string, order: Json): void {
  const current = target.get(strategy);
  if (current) current.push(order);
  else target.set(strategy, [order]);
}

function compareClosingOrders(left: Json, right: Json): number {
  return orderEventTime(left) - orderEventTime(right)
    || orderIdentifier(left).localeCompare(orderIdentifier(right));
}
