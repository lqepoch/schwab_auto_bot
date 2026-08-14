/**
 * Safe, machine-readable rate-limit information. The raw header map is an
 * allow-list, never a copy of every response header, so credentials and
 * cookies cannot cross the metadata boundary.
 */
export interface RateLimitMetadata {
  readonly headers: Readonly<Record<string, string>>;
  readonly limit?: number;
  readonly remaining?: number;
  readonly reset?: number;
  readonly retryAfterMs?: number;
}

export interface ResponseMetadata {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly correlationId: string | null;
  readonly rateLimit: RateLimitMetadata;
}

const RATE_LIMIT_HEADERS = new Set([
  'retry-after',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-rate-limit-limit',
  'x-rate-limit-remaining',
  'x-rate-limit-reset',
]);

const CORRELATION_HEADERS = [
  'schwab-client-correlid',
  'x-correlation-id',
  'correlation-id',
];

export function createResponseMetadata(
  headers: Headers,
  requestId: string,
  method: string,
  url: string,
  retryAfterMs?: number,
): ResponseMetadata {
  const correlationId = findHeader(headers, CORRELATION_HEADERS);
  const rateLimitHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (RATE_LIMIT_HEADERS.has(normalized)) {
      rateLimitHeaders[normalized] = value;
    }
  });

  const retryAfterSeconds = parseNonNegativeNumber(rateLimitHeaders['retry-after']);
  const limit = parseNonNegativeNumber(
    rateLimitHeaders['ratelimit-limit']
      ?? rateLimitHeaders['x-ratelimit-limit']
      ?? rateLimitHeaders['x-rate-limit-limit'],
  );
  const remaining = parseNonNegativeNumber(
    rateLimitHeaders['ratelimit-remaining']
      ?? rateLimitHeaders['x-ratelimit-remaining']
      ?? rateLimitHeaders['x-rate-limit-remaining'],
  );
  const reset = parseNonNegativeNumber(
    rateLimitHeaders['ratelimit-reset']
      ?? rateLimitHeaders['x-ratelimit-reset']
      ?? rateLimitHeaders['x-rate-limit-reset'],
  );
  const parsedRetryAfterMs = retryAfterMs ?? (retryAfterSeconds === undefined ? undefined : retryAfterSeconds * 1_000);

  return {
    requestId,
    method,
    url,
    correlationId,
    rateLimit: {
      headers: rateLimitHeaders,
      ...(limit === undefined ? {} : { limit }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(reset === undefined ? {} : { reset }),
      ...(parsedRetryAfterMs === undefined ? {} : { retryAfterMs: parsedRetryAfterMs }),
    },
  };
}

function findHeader(headers: Headers, names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

function parseNonNegativeNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
