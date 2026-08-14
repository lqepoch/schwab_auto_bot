import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  BoundedAsyncQueue,
  StreamerSnapshotCache,
  StreamerSnapshotConsumer,
} from '../dist/streamer/streamerSnapshot.js';

function levelOneOptionsPayload(timestamp: number, row: Record<string, unknown>) {
  return {
    service: 'LEVELONE_OPTIONS',
    timestamp,
    command: 'SUBS',
    content: [row],
  };
}

function levelOneEquitiesPayload(timestamp: number, row: Record<string, unknown>) {
  return {
    service: 'LEVELONE_EQUITIES',
    timestamp,
    command: 'SUBS',
    content: [row],
  };
}

test('snapshot cache merges change rows and drops only exact duplicate timestamps', () => {
  let now = 1_000;
  const cache = new StreamerSnapshotCache({ clock: () => now, staleAfterMs: 10 });
  const generation = cache.beginGeneration();

  const first = cache.applyPayload('LEVELONE_OPTIONS', levelOneOptionsPayload(100, {
    key: 'QQQ', '0': 'QQQ', '2': 1.25,
  }), generation);
  assert.equal(first.updates.length, 1);
  assert.equal(cache.get('LEVELONE_OPTIONS', 'QQQ')?.row['2'], 1.25);

  const stale = cache.applyPayload('LEVELONE_OPTIONS', levelOneOptionsPayload(99, {
    key: 'QQQ', '2': 1.20,
  }), generation);
  assert.equal(stale.results[0]?.reason, 'stale-timestamp');
  assert.equal(cache.get('LEVELONE_OPTIONS', 'QQQ')?.row['2'], 1.25);

  const duplicate = cache.applyPayload('LEVELONE_OPTIONS', levelOneOptionsPayload(100, {
    key: 'QQQ', '0': 'QQQ', '2': 1.25,
  }), generation);
  assert.equal(duplicate.results[0]?.reason, 'duplicate');

  const sameTimestampDifferentField = cache.applyPayload('LEVELONE_OPTIONS', levelOneOptionsPayload(100, {
    key: 'QQQ', '3': 1.26,
  }), generation);
  assert.equal(sameTimestampDifferentField.results[0]?.accepted, true);
  assert.equal(cache.get('LEVELONE_OPTIONS', 'QQQ')?.row['2'], 1.25);
  assert.equal(cache.get('LEVELONE_OPTIONS', 'QQQ')?.row['3'], 1.26);

  now = 1_020;
  const update = cache.applyPayload('LEVELONE_OPTIONS', levelOneOptionsPayload(101, {
    key: 'QQQ', '3': 1.30,
  }), generation);
  assert.equal(update.results[0]?.accepted, true);
  assert.equal(cache.get('LEVELONE_OPTIONS', 'QQQ')?.row['2'], 1.25);
  assert.equal(cache.get('LEVELONE_OPTIONS', 'QQQ')?.row['3'], 1.30);
  now = 1_031;
  assert.equal(cache.get('LEVELONE_OPTIONS', 'QQQ')?.freshness, 'stale');
});

test('generic decoder and snapshot cache include the canonical LEVELONE_EQUITIES contract', () => {
  const cache = new StreamerSnapshotCache();
  const generation = cache.beginGeneration();
  const result = cache.applyPayload('LEVELONE_EQUITIES', levelOneEquitiesPayload(100, {
    key: 'AAPL', '0': 'AAPL', '3': 182.5, '51': false,
  }), generation);
  assert.equal(result.results[0]?.accepted, true);
  assert.equal(cache.get('LEVELONE_EQUITIES', 'AAPL')?.row['3'], 182.5);
});

test('all-sequence services require documented sequence evidence and isolate generations', () => {
  const cache = new StreamerSnapshotCache();
  const firstGeneration = cache.beginGeneration();
  const missingSequence = cache.applyPayload('CHART_EQUITY', {
    service: 'CHART_EQUITY', timestamp: 100, command: 'SUBS',
    content: [{ key: 'QQQ', '0': 'QQQ', '7': 100 }],
  }, firstGeneration);
  assert.equal(missingSequence.results[0]?.reason, 'uncertain-order');

  const first = cache.applyPayload('CHART_EQUITY', {
    service: 'CHART_EQUITY', timestamp: 100, command: 'SUBS',
    content: [{ key: 'QQQ', '0': 'QQQ', '6': 10, '7': 100, '4': 1 }],
  }, firstGeneration);
  assert.equal(first.results[0]?.accepted, true);

  const oldSequence = cache.applyPayload('CHART_EQUITY', {
    service: 'CHART_EQUITY', timestamp: 101, command: 'SUBS',
    content: [{ key: 'QQQ', '6': 9, '7': 101 }],
  }, firstGeneration);
  assert.equal(oldSequence.results[0]?.reason, 'stale-sequence');

  const secondGeneration = cache.beginGeneration();
  const lateOldData = cache.applyPayload('CHART_EQUITY', {
    service: 'CHART_EQUITY', timestamp: 102, command: 'SUBS',
    content: [{ key: 'QQQ', '6': 11, '7': 102 }],
  }, firstGeneration);
  assert.equal(lateOldData.results[0]?.reason, 'inactive-generation');
  assert.equal(cache.get('CHART_EQUITY', 'QQQ'), undefined);

  const fresh = cache.applyPayload('CHART_EQUITY', {
    service: 'CHART_EQUITY', timestamp: 102, command: 'SUBS',
    content: [{ key: 'QQQ', '6': 1, '7': 102 }],
  }, secondGeneration);
  assert.equal(fresh.results[0]?.accepted, true);
});

test('CHART_FUTURES uses documented Chart Time as ordering evidence and rejects missing time', () => {
  const cache = new StreamerSnapshotCache();
  const generation = cache.beginGeneration();
  const missingChartTime = cache.applyPayload('CHART_FUTURES', {
    service: 'CHART_FUTURES', timestamp: 100, command: 'SUBS',
    content: [{ key: '/ESZ5', '0': '/ESZ5', '2': 1 }],
  }, generation);
  assert.equal(missingChartTime.results[0]?.reason, 'uncertain-order');

  const first = cache.applyPayload('CHART_FUTURES', {
    service: 'CHART_FUTURES', timestamp: 100, command: 'SUBS',
    content: [{ key: '/ESZ5', '0': '/ESZ5', '1': 1_000, '2': 1 }],
  }, generation);
  assert.equal(first.results[0]?.accepted, true);

  const old = cache.applyPayload('CHART_FUTURES', {
    service: 'CHART_FUTURES', timestamp: 101, command: 'SUBS',
    content: [{ key: '/ESZ5', '1': 999, '2': 2 }],
  }, generation);
  assert.equal(old.results[0]?.reason, 'stale-timestamp');
  assert.equal(cache.get('CHART_FUTURES', '/ESZ5')?.row['2'], 1);
});

test('ACCT_ACTIVITY requires documented row seq/key fields and keeps sequence generation scoped', () => {
  const cache = new StreamerSnapshotCache();
  const generation = cache.beginGeneration();
  const legacy = cache.applyPayload('ACCT_ACTIVITY', {
    service: 'ACCT_ACTIVITY', timestamp: 100, command: 'SUBS',
    content: [{ '3': { orderId: '42' } }],
  }, generation);
  assert.equal(legacy.results[0]?.reason, 'invalid-payload');

  const first = cache.applyPayload('ACCT_ACTIVITY', {
    service: 'ACCT_ACTIVITY', timestamp: 100, command: 'SUBS',
    content: [{ seq: '7', key: 'Account Activity', '1': '12345678', '2': 'ORDER', '3': '{"orderId":"42"}' }],
  }, generation);
  assert.equal(first.results[0]?.accepted, true);
  assert.equal(first.updates[0]?.entry.sequence, 7);

  const old = cache.applyPayload('ACCT_ACTIVITY', {
    service: 'ACCT_ACTIVITY', timestamp: 101, command: 'SUBS',
    content: [{ seq: 6, key: 'Account Activity', '1': '12345678', '2': 'ORDER', '3': 'old' }],
  }, generation);
  assert.equal(old.results[0]?.reason, 'stale-sequence');

  const nextGeneration = cache.beginGeneration();
  const newGeneration = cache.applyPayload('ACCT_ACTIVITY', {
    service: 'ACCT_ACTIVITY', timestamp: 102, command: 'SUBS',
    content: [{ seq: 1, key: 'Account Activity', '1': '12345678', '2': 'ORDER', '3': 'new' }],
  }, nextGeneration);
  assert.equal(newGeneration.results[0]?.accepted, true);
  assert.equal(cache.get('ACCT_ACTIVITY', 'Account Activity')?.generation, nextGeneration);
});

test('bounded queue exposes drop-oldest and cancellation semantics', async () => {
  const queue = new BoundedAsyncQueue<number>(2, 'drop-oldest');
  assert.deepEqual(queue.push(1), { accepted: true, dropped: 0 });
  assert.deepEqual(queue.push(2), { accepted: true, dropped: 0 });
  assert.deepEqual(queue.push(3), { accepted: true, dropped: 1 });
  assert.equal(queue.dropped, 1);
  assert.deepEqual(await queue.next(), { value: 2, done: false });
  assert.deepEqual(await queue.next(), { value: 3, done: false });
  const pending = queue.next();
  queue.push(4);
  assert.deepEqual(await pending, { value: 4, done: false });
  await queue.return();
  assert.deepEqual(await queue.next(), { value: undefined, done: true });
});

test('consumer isolates socket generations and yields typed updates through async iteration', async () => {
  const source = new EventEmitter();
  const discarded: string[] = [];
  const consumer = new StreamerSnapshotConsumer('LEVELONE_OPTIONS', {
    onDiscard: (result) => { if (result.reason) discarded.push(result.reason); },
  });
  consumer.attach(source);
  source.emit('open');
  source.emit('data', levelOneOptionsPayload(100, { key: 'QQQ', '0': 'QQQ', '2': 1.25 }));

  const iterator = consumer[Symbol.asyncIterator]();
  const update = await iterator.next();
  assert.equal(update.done, false);
  assert.equal(update.value?.entry.row['2'], 1.25);

  source.emit('close', 1006, Buffer.from('reconnect'));
  source.emit('data', levelOneOptionsPayload(101, { key: 'QQQ', '2': 1.30 }));
  assert.equal(discarded.at(-1), 'inactive-generation');
  source.emit('open');
  assert.equal(consumer.getSnapshot('QQQ'), undefined);
  await iterator.return?.();
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});
