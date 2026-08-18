import { brokerOrderId } from "./orderIdentity.ts";

export type ExactBrokerOrder = Record<string, unknown>;

/**
 * Validate the body returned by Schwab's exact GET /orders/{orderId} endpoint.
 * A one-row response with a different broker ID is not authoritative evidence
 * for the requested resource and must fail closed before entering live order
 * authority or unknown-write reconciliation.
 */
export function exactOrderRoot<T extends ExactBrokerOrder>(body: unknown, requestedOrderId: string): T {
  const canonicalRequestedId = brokerOrderId({ orderId: requestedOrderId });
  const values = Array.isArray(body) ? body : [body];
  if (values.length !== 1 || !values[0] || typeof values[0] !== "object" || Array.isArray(values[0])) {
    throw new Error("AUTHORITATIVE_ORDER_RESPONSE_INVALID");
  }

  const root = values[0] as T;
  if (brokerOrderId(root) !== canonicalRequestedId) {
    throw new Error("AUTHORITATIVE_ORDER_RESPONSE_ID_MISMATCH");
  }
  return root;
}
