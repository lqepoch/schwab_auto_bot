import assert from 'node:assert/strict';
import test from 'node:test';
import { TraderApiClient } from '../dist/clients/trader.js';

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

function makeClient(responses = {}) {
  const calls = [];
  const http = {
    async request(path, options) {
      calls.push({ kind: 'request', path, options });
      const response = responses[path];
      return typeof response === 'function' ? response(options) : response ?? [];
    },
    async requestWithResponse(path, options) {
      calls.push({ kind: 'requestWithResponse', path, options });
      const response = responses[path];
      return typeof response === 'function'
        ? response(options)
        : response ?? { body: undefined, headers: new Headers(), status: 200 };
    },
  };
  const tokens = {
    async requireAccessToken() { return { access_token: 'test-token', refresh_token: 'refresh' }; },
    async refreshAccessToken() { return { access_token: 'refreshed-token', refresh_token: 'refresh' }; },
  };
  return { client: new TraderApiClient(http, tokens, logger), calls };
}

test('read-only Trader endpoints preserve paths and query parameters', async () => {
  const { client, calls } = makeClient({
    '/accounts/accountNumbers': [{ accountNumber: '123', hashValue: 'hash' }],
    '/accounts': [],
    '/accounts/hash': {},
    '/accounts/hash/orders': [],
    '/accounts/hash/orders/42': {},
    '/orders': [],
    '/accounts/hash/transactions': [],
    '/accounts/hash/transactions/tx': { activityId: 1 },
    '/userPreference': { streamerInfo: [{ streamerSocketUrl: 'wss://test', schwabClientCustomerId: 'c', schwabClientCorrelId: 'r', schwabClientChannel: 'N9', schwabClientFunctionId: 'func' }] },
  });
  await client.getAccountNumbers();
  await client.getAccounts({ fields: 'positions' });
  await client.getAccount('hash', { fields: 'positions' });
  await client.getOrders('hash', { fromEnteredTime: 'a', toEnteredTime: 'b', maxResults: 10, status: 'WORKING' });
  await client.getOrder('hash', 42);
  await client.getOrdersAcrossAccounts({ fromEnteredTime: 'a', toEnteredTime: 'b' });
  await client.getTransactions('hash', { startDate: 'a', endDate: 'b', types: 'TRADE', symbol: 'QQQ' });
  await client.getTransaction('hash', 'tx');
  await client.getUserPreferences();

  assert.deepEqual(calls.map(({ path }) => path), [
    '/accounts/accountNumbers', '/accounts', '/accounts/hash', '/accounts/hash/orders',
    '/accounts/hash/orders/42', '/orders', '/accounts/hash/transactions',
    '/accounts/hash/transactions/tx', '/userPreference',
  ]);
  assert.deepEqual(calls[3].options.query, { fromEnteredTime: 'a', toEnteredTime: 'b', maxResults: 10, status: 'WORKING' });
  assert.deepEqual(calls[6].options.query, { startDate: 'a', endDate: 'b', types: 'TRADE', symbol: 'QQQ' });
  assert.equal(calls.every(({ options }) => options.accessToken === 'test-token'), true);
});

test('getTransaction accepts a single object or one-element response array', async () => {
  const first = makeClient({ '/accounts/hash/transactions/tx': [{ activityId: 7 }] });
  assert.equal((await first.client.getTransaction('hash', 'tx')).activityId, 7);

  const second = makeClient({ '/accounts/hash/transactions/tx': { activityId: 8 } });
  assert.equal((await second.client.getTransaction('hash', 'tx')).activityId, 8);

  const empty = makeClient({ '/accounts/hash/transactions/tx': [] });
  await assert.rejects(() => empty.client.getTransaction('hash', 'tx'), /Transaction not found/);
});

test('getStreamerInfo supports object and array user preference shapes and validates payload', async () => {
  const objectShape = makeClient({
    '/userPreference': {
      streamerInfo: [{ streamerSocketUrl: 'wss://test', schwabClientCustomerId: 'c', schwabClientCorrelId: 'r', schwabClientChannel: 'N9', schwabClientFunctionId: 'func' }],
    },
  });
  assert.equal((await objectShape.client.getStreamerInfo()).streamerSocketUrl, 'wss://test');

  const arrayShape = makeClient({
    '/userPreference': [{
      streamerInfo: [{ streamerSocketUrl: 'wss://array', schwabClientCustomerId: 'c', schwabClientCorrelId: 'r', schwabClientChannel: 'N9', schwabClientFunctionId: 'func' }],
    }],
  });
  assert.equal((await arrayShape.client.getStreamerInfo()).streamerSocketUrl, 'wss://array');

  const invalid = makeClient({ '/userPreference': {} });
  await assert.rejects(() => invalid.client.getStreamerInfo(), /Streamer info unavailable/);
});

test('mutation methods force zero retries and preserve request body/path', async () => {
  const { client, calls } = makeClient({
    '/accounts/hash/orders': { body: undefined, headers: new Headers({ Location: '/accounts/hash/orders/41' }), status: 201 },
    '/accounts/hash/orders/42': (options) => options.method === 'PUT'
      ? { body: undefined, headers: new Headers({ Location: '/accounts/hash/orders/42' }), status: 201 }
      : { body: undefined, headers: new Headers(), status: 204 },
  });
  const order = { orderStrategyType: 'SINGLE', orderType: 'LIMIT', price: 0.9, orderLegCollection: [] };
  await client.placeOrder('hash', order);
  await client.replaceOrder('hash', 42, order);
  await client.cancelOrder('hash', 42);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].kind, 'requestWithResponse');
  assert.equal(calls[0].options.maxRetries, 0);
  assert.equal(calls[0].options.retryConfig.maxRetries, 0);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[2].options.method, 'DELETE');
  assert.equal(calls[2].options.body, undefined);
});
