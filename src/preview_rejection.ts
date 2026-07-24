export type PreviewRejectionCode =
  | "INSUFFICIENT_FUNDS"
  | "DUPLICATE_OR_STATE_CONFLICT"
  | "PRICE_OR_QUANTITY"
  | "MARKET_TRANSIENT"
  | "UNKNOWN";

export type PreviewRejection = {
  code: PreviewRejectionCode;
  cooldownMs: number;
};

const cooldownByCode: Record<PreviewRejectionCode, number> = {
  INSUFFICIENT_FUNDS: 15_000,
  DUPLICATE_OR_STATE_CONFLICT: 30_000,
  PRICE_OR_QUANTITY: 300_000,
  MARKET_TRANSIENT: 30_000,
  UNKNOWN: 60_000,
};

/**
 * Reduces Schwab Preview details to an allow-listed operational category.
 * Raw validation strings never leave this function or enter the audit log.
 */
export function classifyPreviewRejection(value: unknown): PreviewRejection {
  const text = JSON.stringify(value ?? {}).toLowerCase();
  const code: PreviewRejectionCode = /insufficient\s+(funds|cash|buying power)|buying power.{0,40}insufficient|cash available.{0,40}insufficient|not enough.{0,40}(funds|cash|buying power)/.test(text)
    ? "INSUFFICIENT_FUNDS"
    : /duplicate|already.{0,40}(working|open|pending)|order.{0,40}(filled|replaced|canceled|cancelled)|cannot.{0,40}(replace|cancel)|invalid.{0,40}status/.test(text)
      ? "DUPLICATE_OR_STATE_CONFLICT"
      : /price|quantity|leg|instruction|complex order|vertical/.test(text)
        ? "PRICE_OR_QUANTITY"
        : /market.{0,40}(closed|halt|unavailable)|session|trading.{0,40}(disabled|unavailable)|throttl|rate limit|temporar/.test(text)
          ? "MARKET_TRANSIENT"
          : "UNKNOWN";
  return { code, cooldownMs: cooldownByCode[code] };
}

export function previewRejectionCooldownFromError(error: unknown, fallbackMs: number): number {
  const match = String(error).match(/cooldownMs=(\d+)/);
  return match ? Number(match[1]) : fallbackMs;
}
