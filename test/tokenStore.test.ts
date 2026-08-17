import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TokenStore } from '../dist/auth/tokenStore.js';
import type { PersistedToken } from '../dist/types/auth.js';
import { createNullLogger } from '../dist/utils/logger.js';

const token = (suffix: string): PersistedToken => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expires_in: 1800,
  token_type: 'Bearer',
  obtained_at: 1_700_000_000_000,
  expires_at: 1_700_001_800_000,
});

async function tempStore() {
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'schwab-token-store-')));
  const filePath = path.join(root, 'nested', 'tokens.json');
  const options = {
    filePath,
    logger: createNullLogger(),
    lockRetryDelayMs: 10,
    lockAcquireTimeoutMs: 50,
    staleLockThresholdMs: 100,
  };
  return { root, filePath, options };
}

test('save atomically persists a valid token with restrictive file permissions', async () => {
  const { root, filePath, options } = await tempStore();
  try {
    await new TokenStore(options).save(token('one'));
    const fileMode = (await stat(filePath)).mode & 0o777;
    const directoryMode = (await stat(path.dirname(filePath))).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(directoryMode, 0o700);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), token('one'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a live same-host owner is never reclaimed only because its lock is old', async () => {
  const { root, filePath, options } = await tempStore();
  const lockPath = `${filePath}.lock`;
  try {
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: Date.now() - 10_000,
      ownerId: 'live-owner',
    }), { mode: 0o600 });

    await assert.rejects(
      () => new TokenStore(options).save(token('blocked')),
      /Timed out acquiring token store lock/,
    );
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).ownerId, 'live-owner');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale foreign-host lock is lease-reclaimable without probing a local PID', async () => {
  const { root, filePath, options } = await tempStore();
  const lockPath = `${filePath}.lock`;
  try {
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: 'foreign-host.example',
      createdAt: Date.now() - 10_000,
      ownerId: 'foreign-owner',
    }), { mode: 0o600 });

    await new TokenStore(options).save(token('reclaimed'));
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).access_token, 'access-reclaimed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a lock release does not unlink a replacement owner lock', async () => {
  const { root, filePath, options } = await tempStore();
  const lockPath = `${filePath}.lock`;
  try {
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const store = new TokenStore(options) as any;
    const handle = await store.acquireLock();
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: Date.now(),
      ownerId: 'replacement-owner',
    }), { mode: 0o600 });

    await store.releaseLock(handle);

    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).ownerId, 'replacement-owner');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent saves leave a complete token document and no lock artifact', async () => {
  const { root, filePath, options } = await tempStore();
  try {
    // Concurrent save correctness includes fsync + directory fsync. Shared CI
    // runners can exceed the 50ms timeout used by lock-timeout unit cases even
    // when the implementation is healthy, so this concurrency case gets
    // realistic acquisition headroom while retaining the same 10ms retry loop.
    const concurrentOptions = {
      ...options,
      lockAcquireTimeoutMs: 500,
      staleLockThresholdMs: 1_000,
    };
    const first = new TokenStore(concurrentOptions).save(token('first'));
    const second = new TokenStore(concurrentOptions).save(token('second'));
    await Promise.all([first, second]);

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as PersistedToken;
    assert.match(persisted.access_token, /^access-(first|second)$/);
    assert.equal(await stat(`${filePath}.lock`).then(() => true, () => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('load fails closed when a lock cannot be observed within the timeout', async () => {
  const { root, filePath, options } = await tempStore();
  const lockPath = `${filePath}.lock`;
  try {
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: Date.now(),
      ownerId: 'reader-blocker',
    }), { mode: 0o600 });
    const result = await new TokenStore(options).load();
    assert.equal(result, null);
    assert.equal(await stat(lockPath).then(() => true, () => false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
