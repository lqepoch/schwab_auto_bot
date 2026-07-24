// ACCT_ACTIVITY has no authoritative fill details.  It may emit many messages
// for one broker-side transition, so confirmations must be prompt but bounded.
export const ACTIVITY_REST_DEBOUNCE_MS = 250;
export const ACTIVITY_REST_MIN_INTERVAL_MS = 1_500;

export function nextActivityRestConfirmationAt(now: number, lastStartedAt: number): number {
  return Math.max(now + ACTIVITY_REST_DEBOUNCE_MS, lastStartedAt + ACTIVITY_REST_MIN_INTERVAL_MS);
}
