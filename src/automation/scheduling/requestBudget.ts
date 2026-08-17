import { fixedPriceRefreshIntervalMs } from "./refreshPacer.ts";
import type { Priority } from "./priorityRuntime.ts";

const REQUEST_WINDOW_MS = 60_000;
const URGENT_CEILING = 110;
const FOLLOWUP_AND_SELL_CEILING = 108;
const REFRESH_RESERVED_CEILING = 105;
const REFRESH_HEADROOM_IDLE_MS = 2_000;
const REFRESH_WAIT_LOG_INTERVAL_MS = 5_000;
const MIN_WAIT_MS = 100;
const MIN_RATE_LIMIT_BACKOFF_SECONDS = 30;
const MAX_RATE_LIMIT_BACKOFF_SECONDS = 300;

export type RequestBudgetOptions = Readonly<{
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRefreshHeadroomWait?: (state: Readonly<{
    usedLast60s: number;
    refreshCeiling: number;
  }>) => void;
  onRateLimited?: (seconds: number) => void;
}>;

/**
 * Local rolling-window guard for Schwab requests.
 *
 * Priority 0 retains the largest emergency headroom, priority 1/2 fail fast
 * when their reserved budget is exhausted, and priority 3 waits for capacity.
 * Broker 429 responses add a bounded global backoff on top of the local window.
 */
export class RequestBudget {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRefreshHeadroomWait?: RequestBudgetOptions["onRefreshHeadroomWait"];
  private readonly onRateLimited?: RequestBudgetOptions["onRateLimited"];
  private attempts: number[] = [];
  private blockedUntil = 0;
  private lastHeadroomLogAt = 0;
  private lastPriorityActivityAt: number;

  constructor(options: RequestBudgetOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onRefreshHeadroomWait = options.onRefreshHeadroomWait;
    this.onRateLimited = options.onRateLimited;
    this.lastPriorityActivityAt = this.now();
  }

  private pruneAttempts(now: number): void {
    let expired = 0;
    while (expired < this.attempts.length && now - this.attempts[expired] >= REQUEST_WINDOW_MS) {
      expired += 1;
    }
    if (expired > 0) this.attempts.splice(0, expired);
  }

  async admit(priority: Priority): Promise<void> {
    for (;;) {
      const now = this.now();
      this.pruneAttempts(now);
      if (now < this.blockedUntil) {
        await this.sleep(Math.min(1_000, this.blockedUntil - now));
        continue;
      }

      const ceiling = priority === 0
        ? URGENT_CEILING
        : priority === 3
          ? (now - this.lastPriorityActivityAt >= REFRESH_HEADROOM_IDLE_MS
            ? URGENT_CEILING
            : REFRESH_RESERVED_CEILING)
          : FOLLOWUP_AND_SELL_CEILING;

      if (this.attempts.length < ceiling) {
        this.attempts.push(now);
        if (priority < 3) this.lastPriorityActivityAt = now;
        return;
      }

      if (priority === 3) {
        if (now - this.lastHeadroomLogAt >= REFRESH_WAIT_LOG_INTERVAL_MS) {
          this.lastHeadroomLogAt = now;
          this.onRefreshHeadroomWait?.({
            usedLast60s: this.attempts.length,
            refreshCeiling: ceiling,
          });
        }
        await this.sleep(Math.max(MIN_WAIT_MS, REQUEST_WINDOW_MS - (now - this.attempts[0])));
        continue;
      }
      if (priority === 2) throw new Error("SELL_QUOTA_EXHAUSTED");
      if (priority === 1) throw new Error("FOLLOWUP_QUOTA_HEADROOM");
      await this.sleep(Math.max(MIN_WAIT_MS, REQUEST_WINDOW_MS - (now - this.attempts[0])));
    }
  }

  fixedPriceRefreshIntervalMs(): number {
    const now = this.now();
    this.pruneAttempts(now);
    return fixedPriceRefreshIntervalMs(this.attempts.length);
  }

  rateLimited(retryAfter: string | null): void {
    const seconds = Math.max(
      MIN_RATE_LIMIT_BACKOFF_SECONDS,
      Math.min(MAX_RATE_LIMIT_BACKOFF_SECONDS, Number(retryAfter) || MIN_RATE_LIMIT_BACKOFF_SECONDS),
    );
    this.blockedUntil = this.now() + seconds * 1_000;
    this.onRateLimited?.(seconds);
  }
}
