import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketDataStreamClient } from '../dist/streamer/marketDataClient.js';

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

function makeClient() {
  const calls = [];
  const streamer = {
    async connect() { calls.push({ kind: 'connect' }); },
    async waitForReady() { calls.push({ kind: 'ready' }); },
    disconnect() { calls.push({ kind: 'disconnect' }); },
    async subscribe(options) { calls.push({ kind: 'subscribe', options }); },
    async unsubscribe(options) { calls.push({ kind: 'unsubscribe', options }); },
  };
  const trader = {
    async getStreamerInfo() {
      return {
        streamerSocketUrl: 'wss://example.test',
        schwabClientCustomerId: 'customer',
        schwabClientCorrelId: 'correl',
        schwabClientChannel: 'channel',
        schwabClientFunctionId: 'function',
      };
    },
  };
  const tokens = {
    async requireAccessToken() { return { access_token: 'token' }; },
  };
  return {
    client: new MarketDataStreamClient(streamer, trader, tokens, logger),
    calls,
  };
}

test('high-level option streamer helpers emit ADD and UNSUBS through canonical client methods', async () => {
  const { client, calls } = makeClient();
  await client.connect();
  await client.addLevelOneOptions({
    keys: ['QQQ   260814P00740000', 'QQQ   260814P00739000'],
    fields: '0,1,2,3,4,5',
  });
  await client.unsubscribeLevelOneOptions({ keys: 'QQQ   260814P00739000' });

  const subscribe = calls.find((call) => call.kind === 'subscribe');
  assert.deepEqual(subscribe.options, {
    service: 'LEVELONE_OPTIONS',
    command: 'ADD',
    parameters: {
      keys: 'QQQ   260814P00740000,QQQ   260814P00739000',
      fields: '0,1,2,3,4,5',
    },
  });

  const unsubscribe = calls.find((call) => call.kind === 'unsubscribe');
  assert.deepEqual(unsubscribe.options, {
    service: 'LEVELONE_OPTIONS',
    parameters: { keys: 'QQQ   260814P00739000' },
  });
});

test('unsubscribeAccountActivity supports whole-service unsubscribe', async () => {
  const { client, calls } = makeClient();
  await client.connect();
  await client.unsubscribeAccountActivity();
  const unsubscribe = calls.find((call) => call.kind === 'unsubscribe');
  assert.deepEqual(unsubscribe.options, { service: 'ACCT_ACTIVITY', parameters: undefined });
});
