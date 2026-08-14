import assert from 'node:assert/strict';
import test from 'node:test';
import { SchwabGateway } from '../dist/gateway/schwabGateway.js';

function metadata(path, method = 'GET') {
  return {
    requestId: `fixture-${path}`,
    method,
    url: `https://fixture.invalid${path}`,
    status: 200,
    headers: new Headers({
      'x-fixture-correlation': 'corr-1',
      'x-ratelimit-remaining': '17',
    }),
    correlationId: 'corr-1',
    rateLimit: {
      headers: { 'x-ratelimit-remaining': '17' },
      remaining: 17,
    },
  };
}

function response(body, path) {
  return { body, ...metadata(path) };
}

test('read-only gateway resolves account numbers and preserves typed response metadata', async () => {
  const calls = [];
  const trader = {
    async getAccountNumbers() {
      calls.push(['accountNumbers']);
      return [{ accountNumber: '12345678', hashValue: 'hash/with%value' }];
    },
    async getAccountsWithResponse() {
      calls.push(['accounts']);
      return response([{ securitiesAccount: { accountNumber: '12345678' } }], '/accounts');
    },
    async getAccountWithResponse(hash, params) {
      calls.push(['account', hash, params]);
      return response({ securitiesAccount: { accountNumber: '12345678' } }, `/accounts/${hash}`);
    },
    async getOrdersWithResponse(hash, params) {
      calls.push(['orders', hash, params]);
      return response([], `/accounts/${hash}/orders`);
    },
    async getOrderWithResponse(hash, orderId) {
      calls.push(['order', hash, orderId]);
      return response({ orderId: Number(orderId) }, `/accounts/${hash}/orders/${orderId}`);
    },
  };
  const marketData = {
    async getQuotesWithResponse(params) {
      calls.push(['quotes', params]);
      return response({ AAPL: { symbol: 'AAPL' } }, '/quotes');
    },
    async getQuoteWithResponse(symbol, params) {
      calls.push(['quote', symbol, params]);
      return response({ symbol }, `/${symbol}/quotes`);
    },
  };

  const gateway = new SchwabGateway(trader, marketData);
  const account = await gateway.getAccount('12345678', { fields: 'positions' });
  assert.equal(account.data.securitiesAccount.accountNumber, '12345678');
  assert.equal(account.metadata.requestId, 'fixture-/accounts/hash/with%value');
  assert.equal(account.metadata.headers.get('x-fixture-correlation'), 'corr-1');
  assert.equal(account.metadata.rateLimit.remaining, 17);

  await gateway.getOrders('12345678', { fromEnteredTime: 'a', toEnteredTime: 'b' });
  await gateway.getOrder('12345678', 42);
  await gateway.getQuotes({ symbols: ['AAPL'] });
  await gateway.getQuote('AAPL');
  assert.deepEqual(calls, [
    ['accountNumbers'],
    ['account', 'hash/with%value', { fields: 'positions' }],
    ['orders', 'hash/with%value', { fromEnteredTime: 'a', toEnteredTime: 'b' }],
    ['order', 'hash/with%value', 42],
    ['quotes', { symbols: ['AAPL'] }],
    ['quote', 'AAPL', {}],
  ]);
  assert.equal(typeof gateway.placeOrder, 'undefined');
  assert.equal(typeof gateway.replaceOrder, 'undefined');
  assert.equal(typeof gateway.cancelOrder, 'undefined');
});

test('gateway account resolution fails closed for an unknown account', async () => {
  const gateway = new SchwabGateway(
    { async getAccountNumbers() { return []; } },
    {},
  );
  await assert.rejects(
    () => gateway.getAccount('1234567890'),
    (error) => error?.name === 'AccountHashNotFoundError' && !error.message.includes('1234567890'),
  );
});
