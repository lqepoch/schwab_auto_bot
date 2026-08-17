export const EXIT_IDLE_BUY_FILL_DELAY_MS = 30_000;
export const EXIT_INVENTORY_TRIGGER = 5;
export const EXIT_REFRESH_MS = 8_000;
export const LIQUIDITY_EXIT_DELAY_MS = 0;
export const LIQUIDITY_EXIT_REFRESH_MS = 5_000;
export const LIQUIDITY_EXIT_REFRESH_ROUNDS = 2;

/** A queued sell submit is not authority; the job must revalidate it. */
export function maySubmitExit(activeWorkingSellCount: number, submitInFlight: boolean): boolean {
  return activeWorkingSellCount === 0 && !submitInFlight;
}

/** Schwab rejects a semantic no-op Replace; keep the existing working sell. */
export function exitRefreshNeeded(
  currentPrice: number,
  currentQuantity: number,
  currentRemainingQuantity: number,
  targetPrice: number,
  targetQuantity: number,
): boolean {
  return currentPrice !== targetPrice
    || currentQuantity !== targetQuantity
    || currentRemainingQuantity !== targetQuantity;
}

export type ExitEligibility = {
  targetQuantity: number;
  reason: "inventory-threshold" | "idle-after-buy-fill" | "waiting-for-confirmed-buy-fill" | "waiting-for-idle-window";
  remainingDelayMs: number;
};

/**
 * One vertical is liquidated only after it has been idle since its most recent
 * opening fill.  A new buy resets that group's idle timer; an inventory of
 * five or more is always an immediate full-exit trigger.
 */
export function exitEligibility(
  inventory: number,
  lastOpeningFillAt: number | null,
  now = Date.now(),
): ExitEligibility {
  if (inventory >= EXIT_INVENTORY_TRIGGER) {
    return { targetQuantity: inventory, reason: "inventory-threshold", remainingDelayMs: 0 };
  }
  if (lastOpeningFillAt === null) {
    return { targetQuantity: 0, reason: "waiting-for-confirmed-buy-fill", remainingDelayMs: EXIT_IDLE_BUY_FILL_DELAY_MS };
  }
  const remainingDelayMs = Math.max(0, lastOpeningFillAt + EXIT_IDLE_BUY_FILL_DELAY_MS - now);
  const targetQuantity = remainingDelayMs === 0 ? inventory : 0;
  return {
    targetQuantity,
    reason: targetQuantity > 0 ? "idle-after-buy-fill" : "waiting-for-idle-window",
    remainingDelayMs,
  };
}
