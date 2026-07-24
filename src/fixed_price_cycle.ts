export const FIXED_PRICE_MAX_ACTIVE_ORDERS = 1;

export function mayReplenishFixedPrice(activeOpeningOrderCount: number): boolean {
  return activeOpeningOrderCount < FIXED_PRICE_MAX_ACTIVE_ORDERS;
}
