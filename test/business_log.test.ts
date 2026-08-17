import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFixedPriceRebuy,
  formatFixedPriceReplace,
  formatRefreshSpreadSkipped,
} from "../src/automation/observability/businessLog.ts";

const putVertical = {
  key: "SPY:2026-07-29:P:745:746",
  underlying: "SPY",
  lowerStrike: 745,
  higherStrike: 746,
};

test("fixed-price business logs show the option strikes and right", () => {
  assert.equal(formatFixedPriceReplace(putVertical, 0.9), "刷新 SPY 745/746 Put Replace 0.90");
  assert.equal(formatFixedPriceRebuy(putVertical, 0.92), "补买 SPY 745/746 Put 0.92");
  assert.equal(
    formatRefreshSpreadSkipped({ ...putVertical, higherStrike: 747 }, "12345", 2),
    "跳过刷新 SPY 745/747 Put order=12345 差价=2 要求=1",
  );
});
