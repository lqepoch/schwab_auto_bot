export type BrokerOrderIdentity = Readonly<Record<string, unknown>>;

/**
 * Return a canonical broker order ID and fail closed on malformed identity.
 *
 * Schwab order resources are keyed by positive integral order IDs. Runtime
 * authority must never coerce a missing value through String(undefined),
 * because that turns a malformed broker row into the shared key "undefined"
 * and can collapse unrelated rows in order maps and reconciliation indexes.
 */
export function brokerOrderId(order: BrokerOrderIdentity): string {
  const value = order.orderId;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("BROKER_ORDER_ID_INVALID");
    }
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) throw new Error("BROKER_ORDER_ID_INVALID");
    const canonical = trimmed.replace(/^0+(?=\d)/, "");
    if (canonical === "0") throw new Error("BROKER_ORDER_ID_INVALID");
    return canonical;
  }
  throw new Error("BROKER_ORDER_ID_INVALID");
}
