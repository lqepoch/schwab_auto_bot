import assert from "node:assert/strict";
import test from "node:test";
import { RefreshRoundLimit } from "../src/refresh_round_limit.ts";

test("unlimited refresh rounds remain startable", () => {
  const limit = new RefreshRoundLimit(null);
  for (let round = 1; round <= 3; round += 1) {
    assert.equal(limit.mayStartRound(), true);
    assert.deepEqual(limit.completeRound(), {
      completedRounds: round,
      maximumRounds: null,
      maximumReached: false,
    });
  }
});

test("bounded refresh rounds stop exactly at the configured maximum", () => {
  const limit = new RefreshRoundLimit(3);
  limit.completeRound();
  limit.completeRound();
  assert.deepEqual(limit.completeRound(), {
    completedRounds: 3,
    maximumRounds: 3,
    maximumReached: true,
  });
  assert.equal(limit.mayStartRound(), false);
  assert.throws(() => limit.completeRound(), /REFRESH_ROUND_LIMIT_EXHAUSTED/);
});
