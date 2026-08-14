import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketDataStreamClient } from '../dist/streamer/marketDataClient.js';
import {
  LEVELONE_EQUITIES_FIELDS,
  serializeLevelOneEquityFields,
} from '../dist/types/levelOneFields.js';
import {
  STREAMER_SERVICE_CONTRACTS,
  decodeStreamerServicePayload,
  serializeStreamerServiceFields,
} from '../dist/types/streamerContracts.js';

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

function makeClient() {
  const calls = [];
  const streamer = {
    status: 'disconnected',
    async connect() {
      this.status = 'connected';
      calls.push({ kind: 'connect' });
    },
    async waitForReady() { calls.push({ kind: 'ready' }); },
    disconnect() {
      this.status = 'disconnected';
      calls.push({ kind: 'disconnect' });
    },
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
    streamer,
  };
}

test('canonical LEVELONE_EQUITIES contract keeps bid/ask/last/mark on the verified wire ids', () => {
  assert.equal(LEVELONE_EQUITIES_FIELDS['1'].name, 'Bid Price');
  assert.equal(LEVELONE_EQUITIES_FIELDS['2'].name, 'Ask Price');
  assert.equal(LEVELONE_EQUITIES_FIELDS['3'].name, 'Last Price');
  assert.equal(LEVELONE_EQUITIES_FIELDS['45'].name, 'Mark');
  assert.equal(LEVELONE_EQUITIES_FIELDS['51'].name, 'Delayed');
  assert.equal(LEVELONE_EQUITIES_FIELDS['52'].name, 'Realtime Entitled');
});

test('equity field serialization validates, de-duplicates, and preserves caller order', () => {
  assert.equal(serializeLevelOneEquityFields(['1', '2', '3', '45', '3']), '1,2,3,45');
  assert.equal(serializeLevelOneEquityFields(' 1,2,3,45 '), '1,2,3,45');
  assert.throws(
    () => serializeLevelOneEquityFields('1,999'),
    /Unsupported LEVELONE_EQUITIES field id: 999/,
  );
});

test('service-specific field maps cover documented services and fail closed before send', () => {
  for (const service of Object.keys(STREAMER_SERVICE_CONTRACTS)) {
    assert.equal(serializeStreamerServiceFields(service, ['0']), '0');
    assert.throws(
      () => serializeStreamerServiceFields(service, '999'),
      new RegExp(`${service}.*999`),
    );
  }
  assert.equal(serializeStreamerServiceFields('LEVELONE_OPTIONS', ['2', '3', '2']), '2,3');
});

test('typed service decoder validates documented numeric fields and preserves additive rows', () => {
  const decoded = decodeStreamerServicePayload('LEVELONE_OPTIONS', {
    service: 'LEVELONE_OPTIONS',
    timestamp: 1_700_000_000_000,
    command: 'SUBS',
    content: [{ key: 'QQQ   260814P00740000', '0': 'QQQ', '2': 1.25, additiveField: 'kept' }],
    additiveEnvelopeField: true,
  });
  assert.equal(decoded.content[0]['2'], 1.25);
  assert.equal(decoded.content[0].additiveField, 'kept');
  assert.equal(decoded.additiveEnvelopeField, true);
  assert.throws(
    () => decodeStreamerServicePayload('LEVELONE_OPTIONS', {
      service: 'LEVELONE_OPTIONS', timestamp: 1, command: 'SUBS', content: [{ '2': '1.25' }],
    }),
    /expected number/,
  );
});

test('high-level equity streamer helper serializes typed field arrays', async () => {
  const { client, calls } = makeClient();
  await client.connect();
  await client.subscribeLevelOneEquities({
    keys: ['QQQ', 'SPY', 'QQQ'],
    fields: ['1', '2', '3', '45'],
  });

  const subscribe = calls.find((call) => call.kind === 'subscribe');
  assert.deepEqual(subscribe.options, {
    service: 'LEVELONE_EQUITIES',
    command: 'SUBS',
    parameters: {
      keys: 'QQQ,SPY',
      fields: '1,2,3,45',
    },
  });
});

test('high-level option streamer helpers emit ADD and UNSUBS through canonical client methods', async () => {
  const { client, calls } = makeClient();
  await client.connect();
  await client.addLevelOneOptions({
    keys: ['QQQ   260814P00740000', 'QQQ   260814P00739000'],
    fields: ['0', '1', '2', '3', '4', '5'],
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

test('high-level non-equity services serialize their own fields and reject unknown ids before send', async () => {
  const { client, calls } = makeClient();
  await client.connect();
  await client.subscribeChartEquity({ keys: 'QQQ', fields: ['0', '1', '7'] });
  await client.subscribeScreenerEquity({ keys: 'INDEX_ALL_VOLUME_0', fields: ['0', '1', '4'] });
  await client.subscribeAccountActivity({ keys: 'Account Activity', fields: ['0', '1', '3'] });
  assert.deepEqual(calls.filter((call) => call.kind === 'subscribe').map((call) => call.options.parameters), [
    { keys: 'QQQ', fields: '0,1,7' },
    { keys: 'INDEX_ALL_VOLUME_0', fields: '0,1,4' },
    { keys: 'Account Activity', fields: '0,1,3' },
  ]);

  await assert.rejects(
    () => client.subscribeLevelOneForex({ keys: 'EUR/USD', fields: '0,999' }),
    /LEVELONE_FOREX.*999/,
  );
  assert.equal(calls.filter((call) => call.kind === 'subscribe').length, 3);
});

test('VIEW wrappers cover documented market services and exclude ACCT_ACTIVITY', async () => {
  const { client, calls } = makeClient();
  await client.connect();
  await client.viewLevelOneOptions({ keys: 'QQQ   260814P00740000', fields: ['0', '2'] });
  await client.viewOptionsBook({ keys: 'QQQ   260814P00740000', fields: ['0', '1', '2', '3'] });
  await client.viewChartEquity({ keys: 'QQQ', fields: ['0', '7'] });
  await client.viewScreenerEquity({ keys: 'INDEX_ALL_VOLUME_0', fields: ['0', '4'] });

  const viewCalls = calls.filter((call) => call.kind === 'subscribe');
  assert.deepEqual(viewCalls.map((call) => ({ service: call.options.service, command: call.options.command })), [
    { service: 'LEVELONE_OPTIONS', command: 'VIEW' },
    { service: 'OPTIONS_BOOK', command: 'VIEW' },
    { service: 'CHART_EQUITY', command: 'VIEW' },
    { service: 'SCREENER_EQUITY', command: 'VIEW' },
  ]);
  assert.equal(typeof client.viewAccountActivity, 'undefined');
});

test('book helpers support incremental ADD without falling back to raw streamer.send', async () => {
  const { client, calls } = makeClient();
  await client.connect();
  await client.addOptionsBook({ keys: 'QQQ   260814P00740000', fields: ['0', '1', '2', '3'] });
  const subscribe = calls.find((call) => call.kind === 'subscribe');
  assert.deepEqual(subscribe.options, {
    service: 'OPTIONS_BOOK',
    command: 'ADD',
    parameters: {
      keys: 'QQQ   260814P00740000',
      fields: '0,1,2,3',
    },
  });
});

test('unsubscribeAccountActivity supports whole-service unsubscribe', async () => {
  const { client, calls } = makeClient();
  await client.connect();
  await client.unsubscribeAccountActivity();
  const unsubscribe = calls.find((call) => call.kind === 'unsubscribe');
  assert.deepEqual(unsubscribe.options, { service: 'ACCT_ACTIVITY', parameters: undefined });
});

test('high-level facade fails closed after disconnect instead of sending into a stale session', async () => {
  const { client, calls } = makeClient();
  await client.connect();
  client.disconnect();
  await assert.rejects(
    () => client.subscribeLevelOneEquities({ keys: 'QQQ', fields: ['1', '2', '3'] }),
    /请先调用 connect\(\) 完成 Streamer 登录/,
  );
  assert.equal(calls.filter((call) => call.kind === 'subscribe').length, 0);
});
