export const FULL_SNAPSHOT_MAX_AGE_MS = 5_000;

export function isFullSnapshotFresh(
  lastFullOrderPollAt: number,
  now = Date.now(),
  maxAgeMs = FULL_SNAPSHOT_MAX_AGE_MS,
): boolean {
  if (!Number.isFinite(lastFullOrderPollAt) || lastFullOrderPollAt <= 0) return false;
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || now < lastFullOrderPollAt) return false;
  return now - lastFullOrderPollAt <= maxAgeMs;
}
