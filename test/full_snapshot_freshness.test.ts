import assert from "node:assert/strict";
import test from "node:test";
import { FULL_SNAPSHOT_MAX_AGE_MS, isFullSnapshotFresh } from "../src/automation/policy/fullSnapshotFreshness.ts";

test("full snapshot is fresh through the five-second boundary", () => {
  const completedAt = 10_000;
  assert.equal(isFullSnapshotFresh(completedAt, completedAt + FULL_SNAPSHOT_MAX_AGE_MS), true);
  assert.equal(isFullSnapshotFresh(completedAt, completedAt + FULL_SNAPSHOT_MAX_AGE_MS + 1), false);
});

test("missing, invalid, or future snapshot timestamps fail closed", () => {
  assert.equal(isFullSnapshotFresh(0, 10_000), false);
  assert.equal(isFullSnapshotFresh(Number.NaN, 10_000), false);
  assert.equal(isFullSnapshotFresh(20_000, 10_000), false);
});

test("freshness accepts an explicit deterministic clock and max age", () => {
  assert.equal(isFullSnapshotFresh(1_000, 1_250, 250), true);
  assert.equal(isFullSnapshotFresh(1_000, 1_251, 250), false);
  assert.equal(isFullSnapshotFresh(1_000, 1_000, -1), false);
});
