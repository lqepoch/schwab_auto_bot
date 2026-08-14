import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketDataApiClient } from '../dist/clients/marketData.js';

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

function makeClient(result = {}) {
  const calls = [];
  const http = {
    async request(path, options) {
      calls.push({ path, options });
      return result;
    },
    async requestWithResponse(path, options) {
      calls.push({ path, options });
      return {
        body: result,
        headers: new Headers(),
        status: 200,
        requestId: 'fixture',
        method: 'GET',
        url: `https://fixture.invalid${path}`,
        correlationId: null,
        rateLimit: { headers: {} },
      };
    },
  };
  const tokens = { async requireAccessToken() { return { access_token: 'test-token' }; } };
  return { client: new MarketDataApiClient(http, tokens, logger), calls };
}

function assertRuntimeSchema(options) {
  assert.equal(typeof options.schema?.parse, 'function');
  const { schema: _schema, ...stableOptions } = options;
  return stableOptions;
}

test('quotes normalize symbols, fields, and indicative into the documented query', async () => {
  const { client, calls } = makeClient();
  await client.getQuotes({ symbols: ['QQQ', 'QQQ   260812P00740000'], fields: ['quote', 'fundamental'], indicative: true });
  assert.deepEqual({ path: calls[0].path, options: assertRuntimeSchema(calls[0].options) }, {
    path: '/quotes',
    options: {
      query: { symbols: 'QQQ,QQQ   260812P00740000', fields: 'quote,fundamental', indicative: true },
      accessToken: 'test-token',
    },
  });
});

test('single option quote encodes OCC spaces and keeps fields', async () => {
  const { client, calls } = makeClient();
  await client.getQuote('QQQ   260812P00740000', { fields: ['quote'] });
  assert.equal(calls[0].path, '/QQQ%20%20%20260812P00740000/quotes');
  assert.deepEqual(calls[0].options.query, { fields: 'quote' });
});

test('option chain forwards all supported filters and official includeUnderlyingQuote key', async () => {
  const { client, calls } = makeClient();
  await client.getOptionChains({
    symbol: 'QQQ', contractType: 'PUT', includeUnderlyingQuote: true, strategy: 'VERTICAL',
    interval: 1, strikeCount: 10, strike: 400, range: 'OTM', fromDate: '2026-08-12',
    toDate: '2026-08-13', volatility: 0.2, underlyingPrice: 400, interestRate: 0.05,
    daysToExpiration: 0, expMonth: 'AUG', optionType: 'ALL', entitlement: 'NP',
  });
  assert.deepEqual(calls[0].options.query, {
    symbol: 'QQQ', contractType: 'PUT', includeUnderlyingQuote: true, strategy: 'VERTICAL',
    interval: 1, strikeCount: 10, strike: 400, range: 'OTM', fromDate: '2026-08-12',
    toDate: '2026-08-13', volatility: 0.2, underlyingPrice: 400, interestRate: 0.05,
    daysToExpiration: 0, expMonth: 'AUG', optionType: 'ALL', entitlement: 'NP',
  });
});

test('expiration chain, price history, movers, and market hours use documented paths', async () => {
  const { client, calls } = makeClient();
  await client.getOptionExpirationChain({ symbol: 'QQQ', contractType: 'ALL', expMonth: 'AUG', optionType: 'ALL' });
  await client.getPriceHistory({ symbol: 'QQQ', periodType: 'day', period: 1, frequencyType: 'minute', frequency: 5, startDate: 1, endDate: 2, needExtendedHoursData: true, needPreviousClose: true });
  await client.getMovers('$DJI', { sort: 'VOLUME', frequency: 30 });
  await client.getMarkets({ markets: ['EQUITY', 'OPTION'], date: '2026-08-12' });
  await client.getMarketHours('OPTION', { date: '2026-08-12' });
  assert.deepEqual(calls.map(({ path }) => path), [
    '/expirationchain', '/pricehistory', '/movers/%24DJI', '/markets', '/markets/OPTION',
  ]);
  assert.deepEqual(calls[1].options.query, {
    symbol: 'QQQ', periodType: 'day', period: 1, frequencyType: 'minute', frequency: 5,
    startDate: 1, endDate: 2, needExtendedHoursData: true, needPreviousClose: true,
  });
});

test('instrument search and CUSIP lookup encode their path/query contracts', async () => {
  const { client, calls } = makeClient();
  await client.searchInstruments({ symbol: ['QQQ', 'SPY'], projection: 'SYMBOL_SEARCH' });
  await client.getInstrumentByCusip('12 345');
  assert.deepEqual({ path: calls[0].path, options: assertRuntimeSchema(calls[0].options) }, {
    path: '/instruments',
    options: { query: { symbol: 'QQQ,SPY', projection: 'SYMBOL_SEARCH' }, accessToken: 'test-token' },
  });
  assert.equal(calls[1].path, '/instruments/12%20345');
});

test('market data methods reject missing required identifiers before making a request', async () => {
  const { client, calls } = makeClient();
  await assert.rejects(() => client.getQuotes({ symbols: [] }), /symbols/);
  await assert.rejects(() => client.getQuote('   '), /symbol/);
  await assert.rejects(() => client.getOptionChains({ symbol: '' }), /symbol/);
  await assert.rejects(() => client.getOptionExpirationChain({ symbol: '' }), /symbol/);
  await assert.rejects(() => client.getPriceHistory({ symbol: '' }), /symbol/);
  await assert.rejects(() => client.getMovers(''), /symbolId/);
  await assert.rejects(() => client.getMarkets({ markets: [] }), /market/);
  await assert.rejects(() => client.getMarketHours(''), /marketId/);
  await assert.rejects(() => client.searchInstruments({ symbol: [], projection: 'SYMBOL_SEARCH' }), /symbol/);
  await assert.rejects(() => client.searchInstruments({ symbol: 'QQQ', projection: undefined }), /projection/);
  await assert.rejects(() => client.getInstrumentByCusip(''), /CUSIP/);
  assert.equal(calls.length, 0);
});
