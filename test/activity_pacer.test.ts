import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_REST_DEBOUNCE_MS,
  ACTIVITY_REST_MIN_INTERVAL_MS,
  nextActivityRestConfirmationAt,
} from "../src/activity_pacer.ts";

test("activity confirmation is prompt for a first signal but bounds a stream storm", () => {
  assert.equal(nextActivityRestConfirmationAt(10_000, 0), 10_000 + ACTIVITY_REST_DEBOUNCE_MS);
  assert.equal(
    nextActivityRestConfirmationAt(10_500, 10_000),
    10_000 + ACTIVITY_REST_MIN_INTERVAL_MS,
  );
});
