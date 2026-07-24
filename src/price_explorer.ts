export const PRICE_MIN_CENTS = 84;
export const PRICE_MAX_CENTS = 90;
export const PRICE_STEP_CENTS = 1;
export const FILL_WINDOW_MS = 10_000;
export const MAX_ACTIVE_ORDERS = 3;

export type ExplorerAction = {
  generation: number;
  dueAt: number;
  logicalId: string;
  kind: "ensure" | "refresh" | "set-price" | "resolve-three";
  priceCents?: number;
  binding?: boolean;
};

type FillEvent = { id: string; at: number };
type LogicalOrder = {
  id: string;
  brokerOrderId: string | null;
  priceCents: number;
  createdAt: number;
  filled: boolean;
};
type Group = {
  width: 1 | 2 | 3;
  generation: number;
  nextLogicalId: number;
  fills: Record<string, FillEvent[]>;
  consumedFillIds: string[];
  logicalOrders: Record<string, LogicalOrder>;
  firstBatch: string[];
  delayed: string | null;
  tasks: ExplorerAction[];
};

export type ExplorerSnapshot = { groups: Record<string, Group> };

export type FillTransition = {
  triggered: boolean;
  generation: number;
  actions: ExplorerAction[];
};

export class PriceExplorer {
  private readonly groups: Record<string, Group>;

  constructor(snapshot: ExplorerSnapshot = { groups: {} }) {
    this.groups = structuredClone(snapshot.groups);
  }

  snapshot(): ExplorerSnapshot {
    return { groups: structuredClone(this.groups) };
  }

  registerWorkingOrder(groupKey: string, brokerOrderId: string, priceCents: number, createdAt: number): string {
    const group = this.group(groupKey);
    const existing = Object.values(group.logicalOrders).find((order) => order.brokerOrderId === brokerOrderId);
    if (existing) {
      existing.priceCents = clampPrice(priceCents);
      existing.filled = false;
      return existing.id;
    }
    const reusable = Object.values(group.logicalOrders)
      .filter((order) => order.brokerOrderId === null && !order.filled && order.priceCents === priceCents)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (reusable) {
      reusable.brokerOrderId = brokerOrderId;
      return reusable.id;
    }
    const id = this.newLogicalOrder(group, priceCents, createdAt);
    group.logicalOrders[id].brokerOrderId = brokerOrderId;
    return id;
  }

  bindBrokerOrder(groupKey: string, logicalId: string, brokerOrderId: string): void {
    const logical = this.requireLogical(this.group(groupKey), logicalId);
    logical.brokerOrderId = brokerOrderId;
    logical.filled = false;
  }

  replaceBrokerOrder(groupKey: string, logicalId: string, brokerOrderId: string, priceCents: number): void {
    const logical = this.requireLogical(this.group(groupKey), logicalId);
    logical.brokerOrderId = brokerOrderId;
    logical.priceCents = clampPrice(priceCents);
    logical.filled = false;
  }

  order(groupKey: string, logicalId: string): Readonly<LogicalOrder> | null {
    return this.group(groupKey).logicalOrders[logicalId] ?? null;
  }

  setPrice(groupKey: string, logicalId: string, priceCents: number): number {
    const logical = this.requireLogical(this.group(groupKey), logicalId);
    logical.priceCents = clampPrice(priceCents);
    return logical.priceCents;
  }

  groupKeys(): string[] {
    return Object.keys(this.groups);
  }

  isCurrentGeneration(groupKey: string, generation: number): boolean {
    return this.group(groupKey).generation === generation;
  }

  hasPendingActions(groupKey: string): boolean {
    const group = this.group(groupKey);
    return group.tasks.some((action) => action.generation === group.generation);
  }

  reconcileWorkingBrokerOrders(groupKey: string, brokerOrderIds: ReadonlySet<string>): void {
    const group = this.group(groupKey);
    for (const logical of Object.values(group.logicalOrders)) {
      if (logical.brokerOrderId !== null && !brokerOrderIds.has(logical.brokerOrderId) && !logical.filled) {
        logical.brokerOrderId = null;
      }
    }
  }

  activeLogicalOrders(groupKey: string): ReadonlyArray<LogicalOrder> {
    return Object.values(this.group(groupKey).logicalOrders)
      .filter((order) => !order.filled && order.brokerOrderId !== null)
      .sort((left, right) => left.priceCents - right.priceCents || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  recordCompleteFill(groupKey: string, brokerOrderId: string, actualPriceCents: number, at: number): FillTransition {
    const group = this.group(groupKey);
    if (group.consumedFillIds.includes(brokerOrderId)) return { triggered: false, generation: group.generation, actions: [] };
    if (!Number.isInteger(actualPriceCents) || actualPriceCents < PRICE_MIN_CENTS || actualPriceCents > PRICE_MAX_CENTS) {
      throw new Error("EXPLORER_FILL_PRICE_OUT_OF_RANGE");
    }
    const logical = Object.values(group.logicalOrders).find((order) => order.brokerOrderId === brokerOrderId);
    if (logical) {
      logical.filled = true;
      logical.brokerOrderId = null;
    }
    group.consumedFillIds.push(brokerOrderId);
    group.consumedFillIds = group.consumedFillIds.slice(-500);

    const price = actualPriceCents;
    const bucket = (group.fills[String(price)] ?? []).filter((event) => at - event.at <= FILL_WINDOW_MS);
    bucket.push({ id: brokerOrderId, at });
    group.fills[String(price)] = bucket;
    if (bucket.length < 2) {
      const logicalId = this.newLogicalOrder(group, price, at);
      return { triggered: false, generation: group.generation, actions: [{
        generation: group.generation, dueAt: at, logicalId, kind: "ensure", priceCents: price,
      }] };
    }

    bucket.splice(0, 2);
    const generation = ++group.generation;
    group.tasks = [];
    group.width = group.width === 1 ? 2 : 3;
    group.firstBatch = [];
    group.delayed = null;
    const lower = clampPrice(price - PRICE_STEP_CENTS);
    if (group.width === 2) {
      const first = this.newLogicalOrder(group, lower, at);
      const second = this.newLogicalOrder(group, lower, at + 2_000);
      group.firstBatch = [first, second];
      this.schedule(group, { generation, dueAt: at, logicalId: first, kind: "ensure", priceCents: lower });
      this.schedule(group, { generation, dueAt: at + 2_000, logicalId: second, kind: "ensure", priceCents: lower });
      this.schedule(group, { generation, dueAt: at + 4_000, logicalId: first, kind: "set-price", priceCents: clampPrice(lower + 1) });
      this.schedule(group, { generation, dueAt: at + 6_000, logicalId: second, kind: "refresh" });
      this.schedule(group, { generation, dueAt: at + 10_000, logicalId: second, kind: "set-price", priceCents: clampPrice(lower + 2) });
    } else {
      const explore = this.newLogicalOrder(group, lower, at);
      const baseline = this.newLogicalOrder(group, price, at + 2_000);
      const delayed = this.newLogicalOrder(group, price, at + 10_000);
      group.firstBatch = [explore, baseline];
      group.delayed = delayed;
      this.schedule(group, { generation, dueAt: at, logicalId: explore, kind: "ensure", priceCents: lower });
      this.schedule(group, { generation, dueAt: at + 2_000, logicalId: baseline, kind: "ensure", priceCents: price });
      this.schedule(group, { generation, dueAt: at + 4_000, logicalId: explore, kind: "refresh" });
      this.schedule(group, { generation, dueAt: at + 4_200, logicalId: baseline, kind: "refresh" });
      this.schedule(group, { generation, dueAt: at + 6_000, logicalId: explore, kind: "resolve-three" });
      this.schedule(group, { generation, dueAt: at + 8_000, logicalId: explore, kind: "refresh" });
      this.schedule(group, { generation, dueAt: at + 8_200, logicalId: baseline, kind: "refresh" });
    }
    return { triggered: true, generation, actions: this.due(groupKey, at) };
  }

  due(groupKey: string, now: number): ExplorerAction[] {
    const group = this.group(groupKey);
    return group.tasks.filter((action) => action.generation === group.generation && action.dueAt <= now)
      .sort((left, right) => left.dueAt - right.dueAt || left.logicalId.localeCompare(right.logicalId));
  }

  acknowledge(groupKey: string, completed: ExplorerAction): void {
    const group = this.group(groupKey);
    group.tasks = group.tasks.filter((action) => !sameAction(action, completed));
  }

  resolveThree(groupKey: string, generation: number, now: number): ExplorerAction[] {
    const group = this.group(groupKey);
    if (generation !== group.generation || group.width !== 3 || group.firstBatch.length !== 2 || !group.delayed) return [];
    group.tasks = group.tasks.filter((action) => !(action.generation === generation && action.kind === "resolve-three" && action.dueAt <= now));
    const [exploreId, baselineId] = group.firstBatch;
    const explore = this.requireLogical(group, exploreId);
    const baseline = this.requireLogical(group, baselineId);
    const delayed = this.requireLogical(group, group.delayed);
    const anyFilled = explore.filled || baseline.filled;
    const baselinePrice = baseline.priceCents;
    if (anyFilled) {
      explore.priceCents = clampPrice(baselinePrice - 1);
      delayed.priceCents = baselinePrice;
    } else {
      explore.priceCents = baselinePrice;
      delayed.priceCents = clampPrice(baselinePrice + 1);
    }
    this.schedule(group, { generation, dueAt: now, logicalId: exploreId, kind: "ensure", priceCents: explore.priceCents });
    this.schedule(group, { generation, dueAt: now, logicalId: baselineId, kind: "ensure", priceCents: baseline.priceCents });
    this.schedule(group, { generation, dueAt: now + 4_000, logicalId: delayed.id, kind: "ensure", priceCents: delayed.priceCents });
    this.schedule(group, { generation, dueAt: now + 6_000, logicalId: delayed.id, kind: "refresh" });
    this.schedule(group, {
      generation,
      dueAt: now + 8_000,
      logicalId: delayed.id,
      kind: "set-price",
      priceCents: clampPrice(delayed.priceCents + 1),
    });
    return this.due(groupKey, now);
  }

  planRoundRecovery(groupKey: string, now: number): ExplorerAction[] {
    const group = this.group(groupKey);
    const actions: ExplorerAction[] = [];
    for (const order of this.activeLogicalOrders(groupKey)) {
      const action: ExplorerAction = {
        generation: group.generation,
        dueAt: now,
        logicalId: order.id,
        kind: "set-price",
        priceCents: clampPrice(order.priceCents + PRICE_STEP_CENTS),
        binding: false,
      };
      actions.push(action);
    }
    return actions;
  }

  private group(groupKey: string): Group {
    const current = this.groups[groupKey];
    if (current) return current;
    const created: Group = {
      width: 1, generation: 0, nextLogicalId: 1, fills: {}, consumedFillIds: [], logicalOrders: {}, firstBatch: [], delayed: null, tasks: [],
    };
    this.groups[groupKey] = created;
    return created;
  }

  private newLogicalOrder(group: Group, priceCents: number, createdAt: number): string {
    const id = `l${group.nextLogicalId++}`;
    group.logicalOrders[id] = { id, brokerOrderId: null, priceCents: clampPrice(priceCents), createdAt, filled: false };
    return id;
  }

  private requireLogical(group: Group, logicalId: string): LogicalOrder {
    const value = group.logicalOrders[logicalId];
    if (!value) throw new Error(`EXPLORER_LOGICAL_ORDER_MISSING_${logicalId}`);
    return value;
  }

  private schedule(group: Group, action: ExplorerAction): void {
    group.tasks.push(action);
  }
}

export function clampPrice(priceCents: number): number {
  return Math.min(PRICE_MAX_CENTS, Math.max(PRICE_MIN_CENTS, Math.round(priceCents)));
}

function sameAction(left: ExplorerAction, right: ExplorerAction): boolean {
  return left.generation === right.generation
    && left.dueAt === right.dueAt
    && left.logicalId === right.logicalId
    && left.kind === right.kind
    && left.priceCents === right.priceCents
    && left.binding === right.binding;
}
