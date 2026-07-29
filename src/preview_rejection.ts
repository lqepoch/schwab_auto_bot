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

/**
 * The only Preview validation fields retained in the execution journal.
 * These values are supplied by Schwab, but text is normalized and redacted
 * before it can reach disk or the terminal.
 */
export type PreviewRejectionDetail = Readonly<{
  validationRuleName: string | null;
  message: string | null;
  activityMessage: string | null;
  originalSeverity: string | null;
  overrideName: string | null;
  overrideSeverity: string | null;
}>;

const cooldownByCode: Record<PreviewRejectionCode, number> = {
  INSUFFICIENT_FUNDS: 15_000,
  DUPLICATE_OR_STATE_CONFLICT: 30_000,
  PRICE_OR_QUANTITY: 300_000,
  MARKET_TRANSIENT: 30_000,
  UNKNOWN: 60_000,
};

const MAX_DIAGNOSTIC_TEXT_LENGTH = 240;

function sanitizedPreviewText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\b(bearer|token|authorization)\s*[:=]?\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "$1 [REDACTED]")
    .replace(/\b\d{9,}\b/g, "[REDACTED_NUMBER]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH) : null;
}

function validationItems(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const validation = (value as { orderValidationResult?: unknown }).orderValidationResult;
  if (!validation || typeof validation !== "object") return [];
  const result = validation as { rejects?: unknown; reviews?: unknown };
  const items = [
    ...(Array.isArray(result.rejects) ? result.rejects : []),
    ...(Array.isArray(result.reviews) ? result.reviews : []),
  ];
  return items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

/**
 * Preserves a small, allow-listed subset of Schwab's validation response.
 * Full response bodies are deliberately never persisted.
 */
export function previewRejectionDetails(value: unknown): readonly PreviewRejectionDetail[] {
  return validationItems(value).map((item) => ({
    validationRuleName: sanitizedPreviewText(item.validationRuleName),
    message: sanitizedPreviewText(item.message),
    activityMessage: sanitizedPreviewText(item.activityMessage),
    originalSeverity: sanitizedPreviewText(item.originalSeverity),
    overrideName: sanitizedPreviewText(item.overrideName),
    overrideSeverity: sanitizedPreviewText(item.overrideSeverity),
  }));
}

/** A compact, already-sanitized explanation suitable for a terminal failure. */
export function previewRejectionSummary(details: readonly PreviewRejectionDetail[]): string {
  if (!details.length) return "MISSING_OR_INVALID_PREVIEW_EVIDENCE";
  return details
    .map((detail) => {
      const rule = detail.validationRuleName ?? detail.overrideName ?? "UNKNOWN";
      return detail.message ? `${rule}: ${detail.message}` : rule;
    })
    .join(" | ")
    .slice(0, 500);
}

/**
 * Reduces Schwab Preview details to an operational cooldown category. The
 * separate allow-listed journal details retain the broker's sanitized reason.
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
