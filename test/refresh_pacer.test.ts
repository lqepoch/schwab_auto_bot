import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_PRICE_REFRESH_INTERVAL_MAX_MS,
  FIXED_PRICE_REFRESH_INTERVAL_MIN_MS,
  effectiveFixedPriceRefreshIntervalMs,
  FixedPriceRefreshPacer,
  fixedPriceRefreshIntervalMs,
} from "../src/refresh_pacer.ts";

test("fixed-price refresh cadence stays within 0.7 to 1.2 seconds and slows under load", () => {
  assert.equal(fixedPriceRefreshIntervalMs(0), FIXED_PRICE_REFRESH_INTERVAL_MIN_MS);
  assert.equal(fixedPriceRefreshIntervalMs(50), FIXED_PRICE_REFRESH_INTERVAL_MIN_MS);
  assert.equal(fixedPriceRefreshIntervalMs(60), 950);
  assert.equal(fixedPriceRefreshIntervalMs(70), FIXED_PRICE_REFRESH_INTERVAL_MAX_MS);
  assert.equal(fixedPriceRefreshIntervalMs(200), FIXED_PRICE_REFRESH_INTERVAL_MAX_MS);
});

test("operator cadence is a lower bound while quota pacing can slow fixed-price refreshes", () => {
  assert.equal(effectiveFixedPriceRefreshIntervalMs(2_000, 700), 2_000);
  assert.equal(effectiveFixedPriceRefreshIntervalMs(2_000, 1_200), 2_000);
  assert.equal(effectiveFixedPriceRefreshIntervalMs(500, 1_200), 1_200);
});

test("serializes refresh starts to the configured lower cadence bound", async () => {
  const pacer = new FixedPriceRefreshPacer();
  const started: number[] = [];
  await Promise.all([1, 2, 3].map(async () => {
    await pacer.admit(20);
    started.push(Date.now());
  }));
  assert.equal(started.length, 3);
  assert.ok(started[1] - started[0] >= 18);
  assert.ok(started[2] - started[1] >= 18);
});
