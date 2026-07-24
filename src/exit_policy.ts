export const EXIT_BUY_FILL_DELAY_MS = 30_000;
export const EXIT_INVENTORY_TRIGGER = 5;
export const EXIT_REFRESH_MS = 8_000;
export const LIQUIDITY_EXIT_REFRESH_MS = 5_000;
export const LIQUIDITY_EXIT_REFRESH_ROUNDS = 2;

export type ExitEligibility = {
  targetUnitSells: number;
  reason: "inventory-threshold" | "matured-individual-fills" | "waiting-for-individual-fills";
  remainingDelayMs: number;
};

/**
 * Every opening vertical fill matures independently. A recent fill therefore
 * never postpones an older fill from becoming eligible to exit.
 */
export function exitEligibility(
  inventory: number,
  maturedIndividualFills: number,
  unattributedInventory: number,
  unattributedObservedAt: number,
  now = Date.now(),
): ExitEligibility {
  if (inventory >= EXIT_INVENTORY_TRIGGER) {
    return { targetUnitSells: inventory, reason: "inventory-threshold", remainingDelayMs: 0 };
  }
  const unknownRemainingDelayMs = unattributedInventory > 0
    ? Math.max(0, EXIT_BUY_FILL_DELAY_MS - Math.max(0, now - unattributedObservedAt))
    : 0;
  const maturedUnknownInventory = unknownRemainingDelayMs === 0 ? unattributedInventory : 0;
  const targetUnitSells = Math.min(inventory, Math.max(0, maturedIndividualFills) + maturedUnknownInventory);
  return {
    targetUnitSells,
    reason: targetUnitSells > 0 ? "matured-individual-fills" : "waiting-for-individual-fills",
    remainingDelayMs: targetUnitSells > 0 ? 0 : unknownRemainingDelayMs,
  };
}
