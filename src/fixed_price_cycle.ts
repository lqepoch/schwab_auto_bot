export const FIXED_PRICE_MAX_ACTIVE_ORDERS = 1;
export const FIXED_PRICE_STARTUP_FILL_GRACE_MS = 60_000;

export function mayReplenishFixedPrice(activeOpeningOrderCount: number): boolean {
  return activeOpeningOrderCount < FIXED_PRICE_MAX_ACTIVE_ORDERS;
}

/** Recover only a recent pre-start fill; initial lookback history is not work. */
export function mayRecoverFixedPriceFill(filledAt: number, runtimeStartedAt: number): boolean {
  return filledAt >= runtimeStartedAt - FIXED_PRICE_STARTUP_FILL_GRACE_MS;
}
