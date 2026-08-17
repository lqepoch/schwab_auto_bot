export type RefreshPreflight = Readonly<{
  refreshOrders: () => Promise<boolean>;
  refreshPositions: () => Promise<void>;
}>;

/**
 * A refresh round may create or replace opening orders only after both
 * authoritative broker snapshots are current. A failed order snapshot skips
 * the position read and keeps the entire round fail-closed.
 */
export async function refreshAuthoritativeSnapshots(preflight: RefreshPreflight): Promise<boolean> {
  if (!await preflight.refreshOrders()) return false;
  await preflight.refreshPositions();
  return true;
}
