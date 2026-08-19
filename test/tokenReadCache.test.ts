import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenManager } from '../dist/auth/tokenManager.js';
import type { TokenStoreAdapter } from '../dist/auth/tokenStore.js';
import type { PersistedToken } from '../dist/types/auth.js';
import { createNullLogger } from '../dist/utils/logger.js';

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://localhost/callback',
};

function persisted(accessToken: string, refreshToken = `${accessToken}-refresh`): PersistedToken {
  const now = Date.now();
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 1_800,
    token_type: 'Bearer',
    obtained_at: now,
    expires_at: now + 1_800_000,
  };
}

test('ordinary token reads reuse one validated durable-store result inside the cache window', async () => {
  let loads = 0;
  const token = persisted('cached-access');
  const adapter: TokenStoreAdapter = {
    load: async () => {
      loads += 1;
      return token;
    },
    save: async () => {},
  };
  const manager = new TokenManager(config, adapter, {
    logger: createNullLogger(),
    tokenReadCacheMs: 10_000,
  });

  assert.equal((await manager.requireAccessToken()).access_token, 'cached-access');
  assert.equal((await manager.requireAccessToken()).access_token, 'cached-access');
  assert.equal((await manager.getValidToken())?.access_token, 'cached-access');
  assert.equal(loads, 1);
});

test('fresh token reads bypass the process-local snapshot and observe durable rotation', async () => {
  let loads = 0;
  let token = persisted('access-one', 'refresh-one');
  const adapter: TokenStoreAdapter = {
    load: async () => {
      loads += 1;
      return token;
    },
    save: async () => {},
  };
  const manager = new TokenManager(config, adapter, {
    logger: createNullLogger(),
    tokenReadCacheMs: 10_000,
  });

  assert.equal((await manager.requireAccessToken()).access_token, 'access-one');
  token = persisted('access-two', 'refresh-two');
  assert.equal((await manager.requireAccessToken()).access_token, 'access-one');
  assert.equal((await manager.requireAccessToken({ fresh: true })).access_token, 'access-two');
  assert.equal((await manager.requireAccessToken()).access_token, 'access-two');
  assert.equal(loads, 2);
});

test('zero token read cache preserves durable read-through behavior', async () => {
  let loads = 0;
  const adapter: TokenStoreAdapter = {
    load: async () => {
      loads += 1;
      return persisted(`access-${loads}`);
    },
    save: async () => {},
  };
  const manager = new TokenManager(config, adapter, {
    logger: createNullLogger(),
    tokenReadCacheMs: 0,
  });

  assert.equal((await manager.requireAccessToken()).access_token, 'access-1');
  assert.equal((await manager.requireAccessToken()).access_token, 'access-2');
  assert.equal(loads, 2);
});

test('successful persistence seeds the validated snapshot only after durable save succeeds', async () => {
  let loads = 0;
  let saves = 0;
  const adapter: TokenStoreAdapter = {
    load: async () => {
      loads += 1;
      return null;
    },
    save: async () => {
      saves += 1;
    },
  };
  const manager = new TokenManager(config, adapter, {
    logger: createNullLogger(),
    tokenReadCacheMs: 10_000,
  });

  await manager.persist({
    access_token: 'persisted-access',
    refresh_token: 'persisted-refresh',
    expires_in: 1_800,
    token_type: 'Bearer',
  });
  assert.equal((await manager.requireAccessToken()).access_token, 'persisted-access');
  assert.equal(saves, 1);
  assert.equal(loads, 0);
});

test('failed persistence never publishes a process-local credential snapshot', async () => {
  let loads = 0;
  const adapter: TokenStoreAdapter = {
    load: async () => {
      loads += 1;
      return null;
    },
    save: async () => {
      throw new Error('durable save failed');
    },
  };
  const manager = new TokenManager(config, adapter, {
    logger: createNullLogger(),
    tokenReadCacheMs: 10_000,
  });

  await assert.rejects(
    () => manager.persist({
      access_token: 'unsafe-access',
      refresh_token: 'unsafe-refresh',
      expires_in: 1_800,
      token_type: 'Bearer',
    }),
    /durable save failed/,
  );
  await assert.rejects(() => manager.requireAccessToken(), /No cached Schwab token found/);
  assert.equal(loads, 1);
});
