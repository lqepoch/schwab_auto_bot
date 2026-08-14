import assert from 'node:assert/strict';
import test from 'node:test';

import { MarketDataApiClient } from '../dist/clients/marketData.js';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
};

function makeClient() {
  const calls = [];
  const http = {
    async request(path, options) {
      calls.push({ path, options });
      return {};
    },
  };
  const tokens = {
    async requireAccessToken() {
      return { access_token: 'test-token' };
    },
  };
  return {
    client: new MarketDataApiClient(http, tokens, logger),
    calls,
  };
}

function stableOptions(options) {
  assert.equal(typeof options.schema?.parse, 'function');
  const { schema: _schema, ...rest } = options;
  return rest;
}

test('sends the official includeUnderlyingQuote query key', async () => {
  const { client, calls } = makeClient();

  await client.getOptionChains({
    symbol: 'QQQ',
    includeUnderlyingQuote: true,
  });

  assert.deepEqual([{ path: calls[0].path, options: stableOptions(calls[0].options) }], [{
    path: '/chains',
    options: {
      query: {
        symbol: 'QQQ',
        includeUnderlyingQuote: true,
      },
      accessToken: 'test-token',
    },
  }]);
  assert.equal('includeQuotes' in calls[0].options.query, false);
});

test('translates the deprecated includeQuotes alias to the official key', async () => {
  const { client, calls } = makeClient();

  await client.getOptionChains({
    symbol: 'QQQ',
    includeQuotes: true,
  });

  assert.deepEqual(calls[0].options.query, {
    symbol: 'QQQ',
    includeUnderlyingQuote: true,
  });
  assert.equal('includeQuotes' in calls[0].options.query, false);
});

test('prefers the official parameter when both names are supplied', async () => {
  const { client, calls } = makeClient();

  await client.getOptionChains({
    symbol: 'QQQ',
    includeUnderlyingQuote: false,
    includeQuotes: true,
  });

  assert.deepEqual(calls[0].options.query, {
    symbol: 'QQQ',
    includeUnderlyingQuote: false,
  });
});
