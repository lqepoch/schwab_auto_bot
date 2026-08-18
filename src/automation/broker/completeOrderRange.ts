export type OrderRange = Readonly<{
  fromEnteredTime: string;
  toEnteredTime: string;
}>;

export type CompleteOrderRangeOptions<T> = Readonly<{
  maxResults: number;
  maxPageRequests?: number;
  key: (order: T) => string;
}>;

export type OrderRangePageFetcher<T> = (range: OrderRange) => Promise<readonly T[]>;

const DEFAULT_MAX_PAGE_REQUESTS = 64;

/**
 * Read a Schwab entered-time range completely when the endpoint exposes only a
 * maxResults ceiling. A page at the ceiling is treated as potentially
 * truncated, so the interval is bisected recursively and the child pages are
 * deduplicated by broker order ID. The overlap at the midpoint intentionally
 * favors completeness over request minimization.
 *
 * If an interval can no longer be split at millisecond precision, or the
 * bounded page-request budget is exhausted, the read fails closed instead of
 * publishing partial order authority.
 */
export async function fetchCompleteOrderRange<T>(
  range: OrderRange,
  fetchPage: OrderRangePageFetcher<T>,
  options: CompleteOrderRangeOptions<T>,
): Promise<T[]> {
  const maxResults = options.maxResults;
  const maxPageRequests = options.maxPageRequests ?? DEFAULT_MAX_PAGE_REQUESTS;
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error("ORDER_RANGE_MAX_RESULTS_INVALID");
  }
  if (!Number.isInteger(maxPageRequests) || maxPageRequests <= 0) {
    throw new Error("ORDER_RANGE_MAX_PAGE_REQUESTS_INVALID");
  }

  const from = parseTimestamp(range.fromEnteredTime, "FROM");
  const to = parseTimestamp(range.toEnteredTime, "TO");
  if (from > to) throw new Error("ORDER_RANGE_TIME_ORDER_INVALID");

  let pageRequests = 0;
  const read = async (fromMs: number, toMs: number): Promise<T[]> => {
    pageRequests += 1;
    if (pageRequests > maxPageRequests) {
      throw new Error("ORDER_SNAPSHOT_PARTITION_LIMIT_EXCEEDED");
    }

    const rows = [...await fetchPage({
      fromEnteredTime: new Date(fromMs).toISOString(),
      toEnteredTime: new Date(toMs).toISOString(),
    })];
    if (rows.length > maxResults) {
      throw new Error("ORDER_SNAPSHOT_PAGE_LIMIT_VIOLATED");
    }
    if (rows.length < maxResults) return validateAndDedupe(rows, options.key);

    if (fromMs >= toMs || toMs - fromMs <= 1) {
      throw new Error("ORDER_SNAPSHOT_RANGE_UNSPLITTABLE");
    }

    const midpoint = fromMs + Math.floor((toMs - fromMs) / 2);
    if (midpoint <= fromMs || midpoint >= toMs) {
      throw new Error("ORDER_SNAPSHOT_RANGE_UNSPLITTABLE");
    }
    const left = await read(fromMs, midpoint);
    const right = await read(midpoint, toMs);
    return validateAndDedupe([...left, ...right], options.key);
  };

  return read(from, to);
}

function parseTimestamp(value: string, label: "FROM" | "TO"): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`ORDER_RANGE_${label}_INVALID`);
  return parsed;
}

function validateAndDedupe<T>(rows: readonly T[], key: (order: T) => string): T[] {
  const merged = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (!id) throw new Error("ORDER_SNAPSHOT_ORDER_ID_MISSING");
    // Later child reads are fresher and intentionally win midpoint duplicates.
    merged.set(id, row);
  }
  return [...merged.values()];
}
