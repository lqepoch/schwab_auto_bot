import {
  compareOpeningOrders,
  managedOpeningInfo,
  orderEventTime,
  orderIdentifier,
} from "./orderIndex.ts";
import { orderInfo, type Json } from "./policy/order.ts";
import type { RuntimePolicy } from "./policy/runtime.ts";

export type RuntimeOrderIndexSnapshot = Readonly<{
  activeOpeningOrdersByStrategy: ReadonlyMap<string, readonly Json[]>;
  activeClosingOrdersByStrategy: ReadonlyMap<string, readonly Json[]>;
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

    const activeOpeningOrdersByStrategy = new Map<string, Json[]>();
    const activeClosingOrdersByStrategy = new Map<string, Json[]>();
    const primaryActiveOpeningOrders = new Map<string, Json>();

    for (const order of source) {
      if (!workingStatuses.has(String(order.status))) continue;

      const meta = orderInfo(order);
      if (
        meta
        && meta.expiration === tradingDate
        && policy.underlyings.has(meta.underlying)
      ) {
        if (meta.opening) push(activeOpeningOrdersByStrategy, meta.key, order);
        if (meta.closing) push(activeClosingOrdersByStrategy, meta.key, order);
      }

      const managed = managedOpeningInfo(order, policy, tradingDate);
      if (!managed) continue;
      const current = primaryActiveOpeningOrders.get(managed.key);
      if (!current || compareOpeningOrders(order, current) < 0) {
        primaryActiveOpeningOrders.set(managed.key, order);
      }
    }

    for (const values of activeOpeningOrdersByStrategy.values()) {
      values.sort(compareOpeningOrders);
    }
    for (const values of activeClosingOrdersByStrategy.values()) {
      values.sort(compareClosingOrders);
    }

    const primaryActiveOpeningOrderIds = new Map<string, string>();
    for (const [strategy, order] of primaryActiveOpeningOrders) {
      primaryActiveOpeningOrderIds.set(strategy, orderIdentifier(order));
    }

    const snapshot: RuntimeOrderIndexSnapshot = {
      activeOpeningOrdersByStrategy,
      activeClosingOrdersByStrategy,
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
