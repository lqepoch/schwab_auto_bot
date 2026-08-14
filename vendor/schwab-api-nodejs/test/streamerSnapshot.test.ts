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

test('snapshot cache merges change rows and rejects old or duplicate timestamps', () => {
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
    key: 'QQQ', '2': 1.25,
  }), generation);
  assert.equal(duplicate.results[0]?.reason, 'duplicate');

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
