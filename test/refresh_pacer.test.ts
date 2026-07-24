import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_PRICE_REFRESH_INTERVAL_MAX_MS,
  FIXED_PRICE_REFRESH_INTERVAL_MIN_MS,
  FixedPriceRefreshPacer,
  fixedPriceRefreshIntervalMs,
} from "../src/refresh_pacer.ts";

test("fixed-price refresh cadence stays within 0.7 to 0.85 seconds and slows under load", () => {
  assert.equal(fixedPriceRefreshIntervalMs(0), FIXED_PRICE_REFRESH_INTERVAL_MIN_MS);
  assert.equal(fixedPriceRefreshIntervalMs(60), FIXED_PRICE_REFRESH_INTERVAL_MIN_MS);
  assert.equal(fixedPriceRefreshIntervalMs(78), 775);
  assert.equal(fixedPriceRefreshIntervalMs(96), FIXED_PRICE_REFRESH_INTERVAL_MAX_MS);
  assert.equal(fixedPriceRefreshIntervalMs(200), FIXED_PRICE_REFRESH_INTERVAL_MAX_MS);
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
