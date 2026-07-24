import type { Json } from "./order_policy.ts";

export type CompleteNetDebitFill = {
  priceCents: number;
  filledAt: number;
};

export function completeNetDebitFill(order: Json): CompleteNetDebitFill | null {
  const orderQuantity = Number(order.quantity ?? 0);
  const filledQuantity = Number(order.filledQuantity ?? 0);
  if (!Number.isFinite(orderQuantity) || orderQuantity !== 1 || filledQuantity !== orderQuantity) return null;
  const legs = Array.isArray(order.orderLegCollection) ? order.orderLegCollection : [];
  if (legs.length !== 2 || legs.some((leg: Json) => !String(leg.instruction).endsWith("_TO_OPEN"))) return null;
  const instructions = new Map<string, string>();
  legs.forEach((leg: Json, index: number) => {
    instructions.set(String(leg.legId ?? index + 1), String(leg.instruction));
  });
  const executionLegs = (Array.isArray(order.orderActivityCollection) ? order.orderActivityCollection : [])
    .flatMap((activity: Json) => Array.isArray(activity.executionLegs) ? activity.executionLegs : []);
  if (executionLegs.length === 0) return null;

  const quantities = new Map<string, number>();
  let netDebit = 0;
  let filledAt = Date.parse(order.closeTime ?? order.enteredTime ?? 0);
  for (const execution of executionLegs) {
    const legId = String(execution.legId ?? execution.orderLegId ?? "");
    const instruction = instructions.get(legId);
    const price = Number(execution.price);
    const quantity = Number(execution.quantity ?? 0);
    const at = Date.parse(execution.time ?? execution.executionTime ?? 0);
    if (!instruction || !Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) return null;
    quantities.set(legId, (quantities.get(legId) ?? 0) + quantity);
    netDebit += (instruction.startsWith("BUY_") ? 1 : -1) * price * quantity;
    if (Number.isFinite(at)) filledAt = Math.max(filledAt, at);
  }
  if (!Number.isFinite(filledAt) || !legs.every((leg: Json, index: number) => quantities.get(String(leg.legId ?? index + 1)) === 1)) {
    return null;
  }
  const rawCents = netDebit * 100;
  const priceCents = Math.round(rawCents);
  if (Math.abs(rawCents - priceCents) > 1e-6) return null;
  return priceCents >= 0 ? { priceCents, filledAt } : null;
}

/**
 * Returns the submitted limit price after Schwab reports a complete one-contract fill.
 * This deliberately does not inspect execution legs: repeat-limit mode is based on the
 * requested order price, not a price-improved or otherwise different execution price.
 */
export function completeOrderLimitFill(order: Json): CompleteNetDebitFill | null {
  const orderQuantity = Number(order.quantity ?? 0);
  const filledQuantity = Number(order.filledQuantity ?? 0);
  const rawPrice = Number(order.price);
  const filledAt = Date.parse(order.closeTime ?? order.enteredTime ?? 0);
  if (
    !Number.isFinite(orderQuantity)
    || orderQuantity !== 1
    || filledQuantity !== orderQuantity
    || !Number.isFinite(rawPrice)
    || !Number.isFinite(filledAt)
  ) return null;
  const priceCents = Math.round(rawPrice * 100);
  return Math.abs(rawPrice * 100 - priceCents) <= 1e-6 ? { priceCents, filledAt } : null;
}
