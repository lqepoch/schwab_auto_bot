export const FIXED_PRICE_MAX_ACTIVE_ORDERS = 1;
export const FIXED_PRICE_STARTUP_FILL_GRACE_MS = 60_000;
export const STALE_ORDER_RECREATE_AGE_MS = 90_000;
export const STALE_ORDER_RECREATE_RETRY_MS = 10_000;

export function mayReplenishFixedPrice(activeOpeningOrderCount: number): boolean {
  return activeOpeningOrderCount < FIXED_PRICE_MAX_ACTIVE_ORDERS;
}

/** Recover only a recent pre-start fill; initial lookback history is not work. */
export function mayRecoverFixedPriceFill(filledAt: number, runtimeStartedAt: number): boolean {
  return filledAt >= runtimeStartedAt - FIXED_PRICE_STARTUP_FILL_GRACE_MS;
}

export function mayRecreateStaleOrder(enteredAt: number, now: number, nextAllowedAt: number): boolean {
  return enteredAt > 0 && now - enteredAt >= STALE_ORDER_RECREATE_AGE_MS && now >= nextAllowedAt;
}

/**
 * Reserves the single refill slot for a strategy before a new Submit's Preview begins.
 * A REST fill can be observed both by activity reconciliation and a full
 * snapshot; only the first observation may create the buy task.
 */
export class FixedPriceReplenishmentGuard {
  private readonly inFlight = new Map<string, string>();
  private readonly deferredUntil = new Map<string, number>();

  reserve(strategy: string, fillId: string, now = Date.now()): boolean {
    if (now < (this.deferredUntil.get(fillId) ?? 0)) return false;
    const existing = this.inFlight.get(strategy);
    if (existing) return false;
    this.inFlight.set(strategy, fillId);
    return true;
  }

  defer(fillId: string, until: number): void {
    this.deferredUntil.set(fillId, until);
  }

  clearDeferred(fillId: string): void {
    this.deferredUntil.delete(fillId);
  }

  release(strategy: string, fillId: string): void {
    if (this.inFlight.get(strategy) === fillId) this.inFlight.delete(strategy);
  }
}
