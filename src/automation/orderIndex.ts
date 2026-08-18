import { brokerOrderId } from "./broker/orderIdentity.ts";
import {
  orderInfo,
  orderPolicyViolation,
  type Json,
  type OptionOrderInfo,
} from "./policy/order.ts";
import { isRefreshSpreadEligible } from "./policy/refreshOrder.ts";
import type { RuntimePolicy } from "./policy/runtime.ts";

export type ManagedOpeningInfo = OptionOrderInfo;

export function orderIdentifier(order: Json): string {
  return brokerOrderId(order);
}

export function orderEventTime(order: Json): number {
  return Date.parse(String(order.closeTime ?? order.cancelTime ?? order.enteredTime ?? 0));
}

export function compareOpeningOrders(left: Json, right: Json): number {
  return Number(left.price) - Number(right.price)
    || orderEventTime(left) - orderEventTime(right)
    || orderIdentifier(left).localeCompare(orderIdentifier(right));
}

export function managedOpeningInfo(
  order: Json,
  policy: RuntimePolicy,
  tradingDate: string,
  parsedMeta?: OptionOrderInfo | null,
): ManagedOpeningInfo | null {
  const meta = parsedMeta === undefined ? orderInfo(order) : parsedMeta;
  if (
    !meta?.opening
    || meta.expiration !== tradingDate
    || !policy.underlyings.has(meta.underlying)
    || !policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
    || !isRefreshSpreadEligible(meta)
    || Number(order.quantity ?? 0) !== 1
    || orderPolicyViolation(order, policy, tradingDate, meta)
  ) return null;
  return meta;
}

export function selectActiveOpeningOrders(
  source: readonly Json[],
  groupKey: string,
  tradingDate: string,
  underlyings: ReadonlySet<string>,
  workingStatuses: ReadonlySet<string>,
): Json[] {
  return source.filter((order) => {
    const meta = orderInfo(order);
    return workingStatuses.has(String(order.status))
      && meta?.opening === true
      && meta.key === groupKey
      && meta.expiration === tradingDate
      && underlyings.has(meta.underlying);
  }).sort(compareOpeningOrders);
}

export function buildPrimaryActiveOpeningOrderIds(
  source: readonly Json[],
  policy: RuntimePolicy,
  tradingDate: string,
  workingStatuses: ReadonlySet<string>,
): Map<string, string> {
  const primary = new Map<string, Json>();
  for (const order of source) {
    const meta = managedOpeningInfo(order, policy, tradingDate);
    if (!meta || !workingStatuses.has(String(order.status))) continue;
    const current = primary.get(meta.key);
    if (!current || compareOpeningOrders(order, current) < 0) primary.set(meta.key, order);
  }
  return new Map([...primary].map(([strategy, order]) => [strategy, orderIdentifier(order)]));
}
