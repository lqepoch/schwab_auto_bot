import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountHashNotFoundError,
  AccountHashResolver,
} from '../dist/accounts/accountHashResolver.js';

function sourceFrom(loader) {
  return { getAccountNumbers: loader };
}

test('AccountHashResolver caches mappings until TTL expiry', async () => {
  let now = 1_000;
  let calls = 0;
  const resolver = new AccountHashResolver(
    sourceFrom(async () => {
      calls += 1;
      return [{ accountNumber: '12345678', hashValue: 'hash-a' }];
    }),
    { ttlMs: 500, now: () => now },
  );

  assert.equal(await resolver.resolve('12345678'), 'hash-a');
  assert.equal(await resolver.resolve('12345678'), 'hash-a');
  assert.equal(calls, 1);

  now = 1_501;
  assert.equal(await resolver.resolve('12345678'), 'hash-a');
  assert.equal(calls, 2);
});

test('concurrent cache misses coalesce into one account-number request', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const resolver = new AccountHashResolver(sourceFrom(async () => {
    calls += 1;
    await gate;
    return [
      { accountNumber: '11112222', hashValue: 'hash-1' },
      { accountNumber: '33334444', hashValue: 'hash-2' },
    ];
  }));

  const first = resolver.resolve('11112222');
  const second = resolver.resolve('33334444');
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'hash-1');
  assert.equal(await second, 'hash-2');
});

test('resolveMany refreshes once and returns de-duplicated mappings', async () => {
  let calls = 0;
  const resolver = new AccountHashResolver(sourceFrom(async () => {
    calls += 1;
    return [
      { accountNumber: '11112222', hashValue: 'hash-1' },
      { accountNumber: '33334444', hashValue: 'hash-2' },
    ];
  }));

  const result = await resolver.resolveMany(['11112222', '33334444', '11112222']);
  assert.equal(calls, 1);
  assert.deepEqual([...result.entries()], [
    ['11112222', 'hash-1'],
    ['33334444', 'hash-2'],
  ]);
});

test('invalidate supports targeted and full cache invalidation', async () => {
  let calls = 0;
  const resolver = new AccountHashResolver(sourceFrom(async () => {
    calls += 1;
    return [
      { accountNumber: '11112222', hashValue: `hash-${calls}` },
      { accountNumber: '33334444', hashValue: `other-${calls}` },
    ];
  }));

  assert.equal(await resolver.resolve('11112222'), 'hash-1');
  resolver.invalidate('11112222');
  assert.equal(await resolver.resolve('11112222'), 'hash-2');
  resolver.invalidate();
  assert.equal(await resolver.resolve('33334444'), 'other-3');
});

test('unknown accounts fail with a redacted account identifier', async () => {
  const resolver = new AccountHashResolver(sourceFrom(async () => []));
  await assert.rejects(
    () => resolver.resolve('1234567890'),
    (error) => {
      assert.ok(error instanceof AccountHashNotFoundError);
      assert.match(error.message, /\*+7890/);
      assert.equal(error.message.includes('1234567890'), false);
      return true;
    },
  );
});

test('invalid TTL and duplicate broker mappings fail closed', async () => {
  assert.throws(
    () => new AccountHashResolver(sourceFrom(async () => []), { ttlMs: 0 }),
    /ttlMs must be a positive finite number/,
  );

  const resolver = new AccountHashResolver(sourceFrom(async () => [
    { accountNumber: '12345678', hashValue: 'hash-a' },
    { accountNumber: '12345678', hashValue: 'hash-b' },
  ]));
  await assert.rejects(() => resolver.refresh(), /Duplicate Schwab account mapping/);
});
