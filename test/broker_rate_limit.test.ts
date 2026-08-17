import assert from "node:assert/strict";
import test from "node:test";
import {
  appendBrokerRateLimit,
  brokerRateLimitFromHeaders,
} from "../src/automation/broker/rateLimit.ts";

test("reads an actual X-RateLimit response and appends remaining over limit at the end", () => {
  const value = brokerRateLimitFromHeaders(new Headers({
    "X-RateLimit-Limit": "120",
    "X-RateLimit-Remaining": "87",
    "X-RateLimit-Reset": "42",
  }));
  assert.deepEqual(value, { limit: "120", remaining: "87", resetSeconds: "42" });
  assert.equal(
    appendBrokerRateLimit("刷新 SPY 745/746 Put Replace 0.90", value),
    "刷新 SPY 745/746 Put Replace 0.90 限速 87/120",
  );
});

test("supports standard and alternate rate-limit header spellings", () => {
  assert.deepEqual(
    brokerRateLimitFromHeaders({
      "RateLimit-Limit": "100;w=60",
      "RateLimit-Remaining": "21",
    }),
    { limit: "100", remaining: "21", resetSeconds: null },
  );
  assert.deepEqual(
    brokerRateLimitFromHeaders({
      "x-rate-limit-limit": "60",
    }),
    { limit: "60", remaining: null, resetSeconds: null },
  );
});

test("does not display a guessed limit when the broker omits or malforms the limit header", () => {
  assert.equal(brokerRateLimitFromHeaders(new Headers()), null);
  assert.equal(brokerRateLimitFromHeaders({ "x-ratelimit-remaining": "87" }), null);
  assert.equal(brokerRateLimitFromHeaders({ "x-ratelimit-limit": "not-a-number" }), null);
  assert.equal(appendBrokerRateLimit("刷新完成", null), "刷新完成");
});
