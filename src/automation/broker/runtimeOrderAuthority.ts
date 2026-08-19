import { brokerOrderId } from "./orderIdentity.ts";
import { OrderLookup } from "./orderLookup.ts";
import { managedOpeningInfo } from "../orderIndex.ts";
import { RuntimeOrderMetadataCache } from "../orderMetadataCache.ts";
import { RuntimeOrderIndexCache } from "../orderRuntimeIndex.ts";
import type { Json, OptionOrderInfo } from "../policy/order.ts";
import type { RuntimePolicy } from "../policy/runtime.ts";

export type RuntimeOrderAuthorityOptions = Readonly<{
  policy: RuntimePolicy;
  tradingDate: () => string;
  workingStatuses: ReadonlySet<string>;
  orderId?: (order: Json) => string;
}>;

/**
 * Single owner for the runtime's broker-order authority and every derived
 * index/cache. Mutations that change locally visible order authority must pass
 * through this class so cache invalidation cannot drift away from the source.
 */
export class RuntimeOrderAuthority {
  private readonly policy: RuntimePolicy;
  private readonly tradingDate: () => string;
  private readonly workingStatuses: ReadonlySet<string>;
  private readonly orderId: (order: Json) => string;
  private readonly byId: OrderLookup<Json>;
  private readonly metadata = new RuntimeOrderMetadataCache();
  private readonly derived: RuntimeOrderIndexCache;
  private source: Json[] = [];
  private authorityRevision = 0;

  constructor(options: RuntimeOrderAuthorityOptions) {
    this.policy = options.policy;
    this.tradingDate = options.tradingDate;
    this.workingStatuses = options.workingStatuses;
    this.orderId = options.orderId ?? brokerOrderId;
    this.byId = new OrderLookup<Json>(this.orderId);
    this.derived = new RuntimeOrderIndexCache((order) => this.metadata.get(order));
  }

  get revision(): number {
    return this.authorityRevision;
  }

  all(): readonly Json[] {
    return this.source;
  }

  info(order: Json): OptionOrderInfo | null {
    return this.metadata.get(order);
  }

  managedOpening(order: Json): OptionOrderInfo | null {
    const meta = this.info(order);
    return managedOpeningInfo(order, this.policy, this.tradingDate(), meta);
  }

  get(orderIdValue: string): Json | undefined {
    return this.byId.get(orderIdValue);
  }

  getWorking(orderIdValue: string): Json | undefined {
    const order = this.get(orderIdValue);
    return order && this.workingStatuses.has(String(order.status)) ? order : undefined;
  }

  replace(next: readonly Json[]): void {
    const snapshot = [...next];
    // OrderLookup validates every canonical broker ID and rejects duplicates
    // before publishing the replacement map. Publish the array only after that
    // validation succeeds so source and lookup change atomically from callers'
    // perspective.
    this.byId.replace(snapshot);
    this.source = snapshot;
    this.authorityRevision += 1;
  }

  addIfAbsent(order: Json): boolean {
    // A REST poll may observe a just-accepted resource before local synthetic
    // publication. Preserve the broker row when that race occurs.
    if (!this.byId.addIfAbsent(order)) return false;
    this.source.push(order);
    this.authorityRevision += 1;
    return true;
  }

  /**
   * Project a known-successful local mutation only while the last visible row
   * is still in the mutable automation contract. A fresher broker-observed
   * terminal/transitional state always wins the race.
   */
  projectWorkingStatus(orderIdValue: string, status: string): boolean {
    const order = this.get(orderIdValue);
    if (!order || !this.workingStatuses.has(String(order.status))) return false;
    if (String(order.status) === status) return false;
    order.status = status;
    this.authorityRevision += 1;
    return true;
  }

  workingAllowedOrders(): readonly Json[] {
    return this.derived.workingAllowedOrders(
      this.source,
      this.authorityRevision,
      this.policy,
      this.tradingDate(),
      this.workingStatuses,
    );
  }

  currentOrders(): readonly Json[] {
    return this.derived.currentOrders(
      this.source,
      this.authorityRevision,
      this.policy,
      this.tradingDate(),
      this.workingStatuses,
    );
  }

  activeOpeningOrders(strategy: string): readonly Json[] {
    return this.derived.activeOpeningOrders(
      this.source,
      this.authorityRevision,
      this.policy,
      this.tradingDate(),
      this.workingStatuses,
      strategy,
    );
  }

  activeClosingOrders(strategy: string): readonly Json[] {
    return this.derived.activeClosingOrders(
      this.source,
      this.authorityRevision,
      this.policy,
      this.tradingDate(),
      this.workingStatuses,
      strategy,
    );
  }

  allActiveClosingOrders(): readonly Json[] {
    return this.derived.allActiveClosingOrders(
      this.source,
      this.authorityRevision,
      this.policy,
      this.tradingDate(),
      this.workingStatuses,
    );
  }

  primaryOpeningOrders(): readonly Json[] {
    return this.derived.primaryOpeningOrders(
      this.source,
      this.authorityRevision,
      this.policy,
      this.tradingDate(),
      this.workingStatuses,
    );
  }

  primaryOpeningOrderIds(): ReadonlyMap<string, string> {
    return this.derived.primaryOpeningOrderIds(
      this.source,
      this.authorityRevision,
      this.policy,
      this.tradingDate(),
      this.workingStatuses,
    );
  }
}
