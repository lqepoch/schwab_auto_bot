import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StaleQuoteError,
  evaluateQuoteFreshness,
  requireFreshOptionQuote,
} from 'schwab-owokit/normalized-quotes';

const policy = { staleAfterMs: 2_000, maxFutureSkewMs: 500 };

test('quote freshness prefers quote time over an old trade time', () => {
  const freshness = evaluateQuoteFreshness(
    { quoteTime: 9_500, tradeTime: 1_000, realtime: true },
    policy,
    10_000,
  );
  assert.deepEqual(freshness, {
    isFresh: true,
    reason: 'fresh',
    observedAt: 10_000,
    sourceTime: 9_500,
    ageMs: 500,
  });
});

test('stale, delayed, missing, and implausibly future quotes fail closed', () => {
  assert.equal(evaluateQuoteFreshness({ quoteTime: 7_000 }, policy, 10_000).reason, 'stale-source-time');
  assert.equal(evaluateQuoteFreshness({ quoteTime: 9_900, realtime: false }, policy, 10_000).reason, 'delayed-source');
  assert.equal(evaluateQuoteFreshness({}, policy, 10_000).reason, 'missing-source-time');
  assert.equal(evaluateQuoteFreshness({ quoteTime: 10_600 }, policy, 10_000).reason, 'future-source-time');
});

test('small future clock skew is clamped to zero age', () => {
  const freshness = evaluateQuoteFreshness({ quoteTime: 10_200, realtime: true }, policy, 10_000);
  assert.equal(freshness.isFresh, true);
  assert.equal(freshness.ageMs, 0);
});

test('execution-sensitive quote guard throws a typed freshness error', () => {
  assert.throws(
    () => requireFreshOptionQuote(
      { symbol: 'QQQ   260814P00740000', quoteTime: 5_000, realtime: true },
      policy,
      10_000,
    ),
    (error) => {
      assert.ok(error instanceof StaleQuoteError);
      assert.equal(error.freshness.reason, 'stale-source-time');
      return true;
    },
  );
});

test('freshness policy input is validated', () => {
  assert.throws(
    () => evaluateQuoteFreshness({ quoteTime: 1 }, { staleAfterMs: -1 }, 1),
    /staleAfterMs/,
  );
  assert.throws(
    () => evaluateQuoteFreshness({ quoteTime: 1 }, { staleAfterMs: 1, maxFutureSkewMs: -1 }, 1),
    /maxFutureSkewMs/,
  );
});
