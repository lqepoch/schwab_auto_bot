export const FIXED_PRICE_REFRESH_INTERVAL_MIN_MS = 700;
export const FIXED_PRICE_REFRESH_INTERVAL_MAX_MS = 1_200;
export const FIXED_PRICE_REFRESH_SOFT_START_RPM = 50;
export const FIXED_PRICE_REFRESH_SOFT_LIMIT_RPM = 70;

export function fixedPriceRefreshIntervalMs(requestsLastMinute: number): number {
  const requests = Math.max(0, requestsLastMinute);
  const pressure = Math.min(
    1,
    Math.max(0, (requests - FIXED_PRICE_REFRESH_SOFT_START_RPM)
      / (FIXED_PRICE_REFRESH_SOFT_LIMIT_RPM - FIXED_PRICE_REFRESH_SOFT_START_RPM)),
  );
  return Math.round(
    FIXED_PRICE_REFRESH_INTERVAL_MIN_MS
      + (FIXED_PRICE_REFRESH_INTERVAL_MAX_MS - FIXED_PRICE_REFRESH_INTERVAL_MIN_MS) * pressure,
  );
}

export class FixedPriceRefreshPacer {
  private tail = Promise.resolve();
  private lastStartedAt = 0;

  admit(intervalMs: number): Promise<void> {
    const next = this.tail.then(async () => {
      const delay = Math.max(0, intervalMs - (Date.now() - this.lastStartedAt));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      this.lastStartedAt = Date.now();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
