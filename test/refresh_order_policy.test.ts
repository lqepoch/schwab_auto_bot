import assert from "node:assert/strict";
import test from "node:test";
import {
  RefreshSpreadSkipTracker,
  REQUIRED_REFRESH_SPREAD_WIDTH,
  isRefreshSpreadEligible,
  refreshSpreadWidth,
} from "../src/refresh_order_policy.ts";

test("only a one-point vertical spread is eligible for order refresh", () => {
  assert.equal(REQUIRED_REFRESH_SPREAD_WIDTH, 1);
  assert.equal(isRefreshSpreadEligible({ lowerStrike: 745, higherStrike: 746 }), true);
  assert.equal(isRefreshSpreadEligible({ lowerStrike: 745, higherStrike: 747 }), false);
  assert.equal(isRefreshSpreadEligible({ lowerStrike: 745, higherStrike: 745.5 }), false);
});

test("normalizes decimal strike widths before comparison and logging", () => {
  assert.equal(refreshSpreadWidth({ lowerStrike: 99.1, higherStrike: 100.1 }), 1);
});

test("reports a skipped non-unit order once without treating it as an error", () => {
  const tracker = new RefreshSpreadSkipTracker();
  const spread = { lowerStrike: 745, higherStrike: 747 };
  assert.equal(tracker.shouldReport("12345", spread), true);
  assert.equal(tracker.shouldReport("12345", spread), false);
  assert.equal(tracker.shouldReport("67890", spread), true);
  assert.equal(tracker.shouldReport("unit", { lowerStrike: 745, higherStrike: 746 }), false);
});
