import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketDataApiClient } from '../dist/clients/marketData.js';

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

function makeClient(payload) {
  const calls = [];
  const http = {
    async request(path, options) {
      calls.push({ path, options });
      if (path === '/quotes') return payload;
      throw new Error(`Unexpected path: ${path}`);
    },
    async requestWithResponse(path, options) {
      calls.push({ path, options });
      if (path === '/quotes') {
        return {
          body: payload,
          headers: new Headers(),
          status: 200,
          requestId: 'fixture',
          method: 'GET',
          url: `https://fixture.invalid${path}`,
          correlationId: null,
          rateLimit: { headers: {} },
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  };
  const tokens = {
    async requireAccessToken() { return { access_token: 'token', refresh_token: 'refresh' }; },
    async refreshAccessToken() { return { access_token: 'token2', refresh_token: 'refresh' }; },
  };
  return { client: new MarketDataApiClient(http, tokens, logger), calls };
}

function optionItem(symbol, { bid, ask, strike, underlying = 'QQQ', contractType = 'P' }) {
  return {
    assetMainType: 'OPTION',
    symbol,
    realtime: true,
    reference: {
      underlying,
      contractType,
      strikePrice: strike,
      expirationYear: 2026,
      expirationMonth: 8,
      expirationDay: 14,
    },
    quote: {
      bidPrice: bid,
      askPrice: ask,
      bidSize: 10,
      askSize: 12,
      mark: (bid + ask) / 2,
      lastPrice: (bid + ask) / 2,
      quoteTime: Date.now() - 100,
      delta: -0.42,
      gamma: 0.03,
      theta: -0.1,
      vega: 0.05,
      openInterest: 500,
      totalVolume: 100,
      underlyingPrice: 710,
    },
  };
}

test('getOptionQuote returns normalized secondary-market quote and Greeks', async () => {
  const symbol = 'QQQ   260814P00740000';
  const { client, calls } = makeClient({
    [symbol]: optionItem(symbol, { bid: 29.9, ask: 30.1, strike: 740 }),
  });
  const quote = await client.getOptionQuote(symbol);

  assert.equal(quote.symbol, symbol);
  assert.equal(quote.assetMainType, undefined);
  assert.equal(quote.underlying, 'QQQ');
  assert.equal(quote.contractType, 'PUT');
  assert.equal(quote.expiration, '2026-08-14');
  assert.equal(quote.strike, 740);
  assert.equal(quote.bid, 29.9);
  assert.equal(quote.ask, 30.1);
  assert.equal(quote.mid, 30);
  assert.ok(Math.abs(quote.spread - 0.2) < 1e-10);
  assert.equal(quote.delta, -0.42);
  assert.equal(calls[0].path, '/quotes');
  assert.deepEqual(calls[0].options.query, {
    symbols: symbol,
    fields: 'quote,reference',
  });
});

test('getVerticalOptionQuote derives a leg-based synthetic market', async () => {
  const buySymbol = 'QQQ   260814P00740000';
  const sellSymbol = 'QQQ   260814P00739000';
  const { client } = makeClient({
    [buySymbol]: optionItem(buySymbol, { bid: 29.9, ask: 30.1, strike: 740 }),
    [sellSymbol]: optionItem(sellSymbol, { bid: 28.95, ask: 29.05, strike: 739 }),
  });
  const vertical = await client.getVerticalOptionQuote(buySymbol, sellSymbol);

  assert.ok(Math.abs(vertical.derivedBid - 0.85) < 1e-10);
  assert.ok(Math.abs(vertical.derivedAsk - 1.15) < 1e-10);
  assert.ok(Math.abs(vertical.derivedMid - 1.0) < 1e-10);
  assert.ok(Math.abs(vertical.derivedSpread - 0.3) < 1e-10);
  assert.equal(vertical.sameUnderlying, true);
  assert.equal(vertical.sameExpiration, true);
  assert.equal(vertical.sameContractType, true);
});

test('getOptionQuote rejects non-option assets', async () => {
  const { client } = makeClient({
    QQQ: { assetMainType: 'EQUITY', symbol: 'QQQ', quote: { bidPrice: 500, askPrice: 500.01 } },
  });
  await assert.rejects(() => client.getOptionQuote('QQQ'), /不是期权合约/);
});

test('batch option quote lookup resolves padded symbols from one response index', async () => {
  const first = 'QQQ   260814P00740000';
  const second = 'QQQ   260814P00739000';
  const { client, calls } = makeClient({
    opaqueA: optionItem(`${first} `, { bid: 29.9, ask: 30.1, strike: 740 }),
    opaqueB: optionItem(`${second} `, { bid: 28.95, ask: 29.05, strike: 739 }),
  });

  const quotes = await client.getOptionQuotes([first, second]);
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].strike, 740);
  assert.equal(quotes[1].strike, 739);
  assert.equal(calls.length, 1);
});

test('batch option quote source does not perform a full response find per requested symbol', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/clients/marketData.ts', import.meta.url), 'utf8');
  assert.match(source, /const quoteItems = this\.indexQuoteItems\(response\);/);
  assert.doesNotMatch(source, /Object\.values\(response\)\.find/);
});
