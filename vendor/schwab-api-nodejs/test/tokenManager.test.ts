import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenManager } from '../dist/auth/tokenManager.js';
import type { TokenStore } from '../dist/auth/tokenStore.js';
import type { PersistedToken } from '../dist/types/auth.js';
import { ReauthRequiredError } from '../dist/utils/errors.js';

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://localhost/callback?x=1',
};

function cached(overrides: Partial<PersistedToken> = {}): PersistedToken {
  return {
    access_token: 'cached-access',
    refresh_token: 'cached-refresh',
    expires_in: 1800,
    token_type: 'Bearer',
    obtained_at: Date.now(),
    expires_at: Date.now() + 1_800_000,
    ...overrides,
  };
}

type MockStore = {
  path: string;
  saved: PersistedToken[];
  load: () => Promise<PersistedToken | null>;
  save: (value: PersistedToken) => Promise<void>;
};

function store(initial: PersistedToken | null = cached(), overrides: Partial<MockStore> = {}): MockStore & TokenStore {
  const saved: PersistedToken[] = [];
  return {
    path: '/tmp/token-manager-test.json',
    saved,
    load: async () => initial,
    save: async (value: PersistedToken) => { saved.push(value); },
    ...overrides,
  } as unknown as MockStore & TokenStore;
}

function tokenResponse(access = 'new-access', refresh = 'new-refresh') {
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: 1800,
    token_type: 'Bearer',
  };
}

test('authorization URL encodes redirect URI, state, and scope', () => {
  const manager = new TokenManager(config, store());
  const url = new URL(manager.createAuthorizeUrl({ state: 'state with spaces/ü', scope: 'read write' }));
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('state'), 'state with spaces/ü');
  assert.equal(url.searchParams.get('scope'), 'read write');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('authorization-code exchange sends form data and Basic client authentication', async () => {
  let observedUrl = '';
  let observedInit: RequestInit | undefined;
  const savedStore = store(null);
  const manager = new TokenManager(config, savedStore, {
    fetch: async (url, init) => {
      observedUrl = String(url);
      observedInit = init;
      return new Response(JSON.stringify(tokenResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const persisted = await manager.exchangeCodeForToken('code with spaces');
  assert.ok(observedInit);
  const init = observedInit;
  assert.match(observedUrl, /\/v1\/oauth\/token$/);
  assert.equal(init.method, 'POST');
  assert.equal(new Headers(init.headers).get('authorization'), `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
  assert.equal(new Headers(init.headers).get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(init.body as URLSearchParams).get('code'), 'code with spaces');
  assert.equal(new URLSearchParams(init.body as URLSearchParams).get('redirect_uri'), config.redirectUri);
  assert.equal(persisted.access_token, 'new-access');
  assert.equal(savedStore.saved.length, 1);
});

test('refresh requests for one refresh token are single-flight', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const manager = new TokenManager(config, store(), {
    fetch: async () => {
      calls += 1;
      await gate;
      return new Response(JSON.stringify(tokenResponse()), { status: 200 });
    },
  });
  const first = manager.refreshAccessToken('same-refresh');
  const second = manager.refreshAccessToken('same-refresh');
  assert.equal(calls, 1);
  release();
  assert.equal((await first).access_token, 'new-access');
  assert.equal((await second).access_token, 'new-access');
});

test('different refresh tokens do not share a single-flight promise', async () => {
  let calls = 0;
  const manager = new TokenManager(config, store(), {
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(tokenResponse(`access-${calls}`, `refresh-${calls}`)), { status: 200 });
    },
  });
  const [first, second] = await Promise.all([
    manager.refreshAccessToken('refresh-one'),
    manager.refreshAccessToken('refresh-two'),
  ]);
  assert.equal(calls, 2);
  assert.notEqual(first.access_token, second.access_token);
});

test('invalid_grant latches reauthorization and persist clears the latch', async () => {
  let calls = 0;
  const savedStore = store(cached({ expires_at: Date.now() - 1 }));
  savedStore.load = async () => savedStore.saved.at(-1) ?? cached({ expires_at: Date.now() - 1 });
  const manager = new TokenManager(config, savedStore, {
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    },
  });
  await assert.rejects(() => manager.requireAccessToken(), ReauthRequiredError);
  await assert.rejects(() => manager.refreshAccessToken('refresh'), ReauthRequiredError);
  await manager.persist(tokenResponse('authorized-access', 'authorized-refresh'));
  assert.equal((await manager.requireAccessToken()).access_token, 'authorized-access');
  assert.equal(calls, 1);
});

test('invalid_grant observer failure cannot replace the stable reauth error', async () => {
  const manager = new TokenManager(config, store(cached({ expires_at: Date.now() - 1 })), {
    fetch: async () => new Response('invalid_grant: refresh_token=secret-value', { status: 400 }),
    onInvalidGrant: () => { throw new Error('observer failed'); },
  });
  await assert.rejects(
    () => manager.requireAccessToken(),
    (error) => error instanceof ReauthRequiredError && error.code === 'SCHWAB_REAUTH_REQUIRED',
  );
});

test('token schema and token-store failures propagate without returning a partial token', async () => {
  const invalid = new TokenManager(config, store(null), {
    fetch: async () => new Response(JSON.stringify({ access_token: 'only-access' }), { status: 200 }),
  });
  await assert.rejects(() => invalid.exchangeCodeForToken('code'));

  const saveFailure = new TokenManager(config, store(null, {
    save: async () => { throw new Error('disk full'); },
  }), {
    fetch: async () => new Response(JSON.stringify(tokenResponse()), { status: 200 }),
  });
  await assert.rejects(() => saveFailure.exchangeCodeForToken('code'), /disk full/);
});
