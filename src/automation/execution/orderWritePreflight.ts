import { orderInfo, type Json } from "../policy/order.ts";

export const SUBMIT_PREVIEW_REQUIRED = "SUBMIT_PREVIEW_REQUIRED";
export const EXISTING_ORDER_REPLACE_NO_PREVIEW = "EXISTING_ORDER_REPLACE_NO_PREVIEW";

export const AUTOMATION_WORKING_ORDER_STATUSES = [
  "PENDING_ACTIVATION",
  "QUEUED",
  "WORKING",
  "AWAITING_PARENT_ORDER",
] as const;

export type OrderWritePreflight =
  | typeof SUBMIT_PREVIEW_REQUIRED
  | typeof EXISTING_ORDER_REPLACE_NO_PREVIEW;

export type OrderWritePreflightDecision =
  | Readonly<{
    preflight: typeof SUBMIT_PREVIEW_REQUIRED;
    replaceOrderId: null;
    violation: null;
  }>
  | Readonly<{
    preflight: typeof EXISTING_ORDER_REPLACE_NO_PREVIEW;
    replaceOrderId: string;
    violation: null;
  }>
  | Readonly<{
    preflight: null;
    replaceOrderId: null;
    violation: "REPLACE_ENDPOINT_INVALID";
  }>;

const replaceableStatuses: ReadonlySet<string> = new Set(AUTOMATION_WORKING_ORDER_STATUSES);

/**
 * Returns the existing broker order ID only for the exact native Replace
 * endpoint owned by the active linked account.
 */
export function nativeReplaceOrderId(
  method: "POST" | "PUT",
  path: string,
  accountHash: string,
): string | null {
  if (method !== "PUT") return null;
  const prefix = `/trader/v1/accounts/${accountHash}/orders/`;
  if (!path.startsWith(prefix)) return null;
  const orderId = path.slice(prefix.length);
  if (!orderId || orderId.includes("/") || orderId.includes("?") || orderId.includes("#")) return null;
  return orderId;
}

export function orderWritePreflight(
  method: "POST" | "PUT",
  path: string,
  accountHash: string,
): OrderWritePreflightDecision {
  if (method === "POST") {
    return { preflight: SUBMIT_PREVIEW_REQUIRED, replaceOrderId: null, violation: null };
  }
  const replaceOrderId = nativeReplaceOrderId(method, path, accountHash);
  if (!replaceOrderId) {
    return { preflight: null, replaceOrderId: null, violation: "REPLACE_ENDPOINT_INVALID" };
  }
  return { preflight: EXISTING_ORDER_REPLACE_NO_PREVIEW, replaceOrderId, violation: null };
}

/**
 * Replace may change price or quantity, but it must target a currently working
 * broker order and preserve the option strategy and opening/closing direction.
 */
export function replacementSourceViolation(source: Json | undefined, payload: Json): string | null {
  if (!source) return "REPLACE_SOURCE_NOT_FOUND";
  if (!replaceableStatuses.has(String(source.status))) return "REPLACE_SOURCE_NOT_WORKING";
  const sourceInfo = orderInfo(source);
  const payloadInfo = orderInfo(payload);
  if (!sourceInfo || !payloadInfo) return "REPLACE_IDENTITY_INVALID";
  if (
    sourceInfo.key !== payloadInfo.key
    || sourceInfo.opening !== payloadInfo.opening
    || sourceInfo.closing !== payloadInfo.closing
  ) {
    return "REPLACE_IDENTITY_CHANGED";
  }
  return null;
}
