export type BrokerRateLimit = Readonly<{
  limit: string;
  remaining: string | null;
  resetSeconds: string | null;
}>;

type HeaderSource = Headers | Readonly<Record<string, string>>;

const headerFamilies = [
  {
    limit: "x-ratelimit-limit",
    remaining: "x-ratelimit-remaining",
    reset: "x-ratelimit-reset",
  },
  {
    limit: "ratelimit-limit",
    remaining: "ratelimit-remaining",
    reset: "ratelimit-reset",
  },
  {
    limit: "x-rate-limit-limit",
    remaining: "x-rate-limit-remaining",
    reset: "x-rate-limit-reset",
  },
] as const;

/**
 * Reads only broker-provided rate-limit headers. Schwab does not guarantee
 * these headers publicly, so missing or malformed values intentionally produce
 * no console suffix instead of falling back to the application's local budget.
 */
export function brokerRateLimitFromHeaders(headers: HeaderSource): BrokerRateLimit | null {
  for (const family of headerFamilies) {
    const limit = numericHeaderValue(readHeader(headers, family.limit));
    if (!limit) continue;
    return {
      limit,
      remaining: numericHeaderValue(readHeader(headers, family.remaining)),
      resetSeconds: numericHeaderValue(readHeader(headers, family.reset)),
    };
  }
  return null;
}

export function appendBrokerRateLimit(message: string, rateLimit: BrokerRateLimit | null): string {
  if (!rateLimit) return message;
  const value = rateLimit.remaining === null
    ? rateLimit.limit
    : `${rateLimit.remaining}/${rateLimit.limit}`;
  return `${message} 限速 ${value}`;
}

function readHeader(headers: HeaderSource, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1] ?? null;
}

function numericHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  const match = value.match(/^\s*(\d{1,12})(?:\s*[,;].*)?\s*$/);
  return match?.[1] ?? null;
}
