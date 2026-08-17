import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PriceHistoryResponseSchema,
  QuotesResponseSchema,
} from '../dist/validation/marketDataSchemas.js';
import {
  AccountNumberHashesSchema,
  AccountResponseSchema,
  OrdersResponseSchema,
  UserPreferencesResponseSchema,
} from '../dist/validation/traderSchemas.js';

test('market-data schemas retain additive Schwab fields while enforcing stable structure', () => {
  const quote = QuotesResponseSchema.parse({
    QQQ: {
      assetMainType: 'EQUITY',
      symbol: 'QQQ',
      quote: { bidPrice: 500, askPrice: 500.01, futureField: 'preserved' },
      futureTopLevel: { ok: true },
    },
  });
  assert.equal(quote.QQQ.symbol, 'QQQ');
  assert.equal(quote.QQQ.quote.futureField, 'preserved');
  assert.deepEqual(quote.QQQ.futureTopLevel, { ok: true });

  assert.throws(() => QuotesResponseSchema.parse({ QQQ: { quote: { bidPrice: 500 } } }));
  assert.throws(() => PriceHistoryResponseSchema.parse({ candles: [{ open: 'bad' }] }));
});

test('trader schemas reject malformed account/order envelopes without stripping additive fields', () => {
  const hashes = AccountNumberHashesSchema.parse([{ accountNumber: '123', hashValue: 'hash', extra: true }]);
  assert.equal(hashes[0].extra, true);
  assert.throws(() => AccountNumberHashesSchema.parse([{ accountNumber: '123' }]));

  const account = AccountResponseSchema.parse({
    securitiesAccount: { accountNumber: '123', futureField: 7 },
  });
  assert.equal(account.securitiesAccount.futureField, 7);
  assert.throws(() => AccountResponseSchema.parse({ securitiesAccount: {} }));

  assert.deepEqual(OrdersResponseSchema.parse([{ orderId: 42, status: 'WORKING', newBrokerField: 'x' }])[0].newBrokerField, 'x');
  assert.throws(() => OrdersResponseSchema.parse([42]));

  assert.deepEqual(UserPreferencesResponseSchema.parse({ streamerInfo: [] }), { streamerInfo: [] });
  assert.throws(() => UserPreferencesResponseSchema.parse('invalid'));
});
