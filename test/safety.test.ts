import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenManager } from '../dist/auth/tokenManager.js';
import { TraderApiClient } from '../dist/clients/trader.js';
import { ReauthRequiredError, UnknownOutcomeError, SchwabApiError } from '../dist/utils/errors.js';
import { HttpClient } from '../dist/utils/httpClient.js';
import type { PersistedToken } from '../dist/types/auth.js';

const token: PersistedToken = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 1_800,
  token_type: 'Bearer',
  obtained_at: Date.now(),
  expires_at: Date.now() + 1_800_000,
};

function fakeTokenManager(overrides: Partial<{
  requireAccessToken: () => Promise<PersistedToken>;
  refreshAccessToken: (refreshToken: string) => Promise<PersistedToken>;
}> = {}) {
  return {
    requireAccessToken: overrides.requireAccessToken ?? (async () => token),
    refreshAccessToken: overrides.refreshAccessToken ?? (async () => token),
  } as ConstructorParameters<typeof TraderApiClient>[1];
}

function traderWithFetch(fetchImpl: typeof fetch, tokenManager = fakeTokenManager()) {
  const http = new HttpClient({
    baseUrl: 'https://api.schwabapi.com/trader/v1',
    fetch: fetchImpl,
    retryConfig: { maxRetries: 3 },
  });
  return new TraderApiClient(http, tokenManager);
}

const order = {
  orderStrategyType: 'SINGLE',
  orderType: 'LIMIT',
  price: 0.9,
  orderLegCollection: [],
};

test('placeOrder sends one request, no client idempotency key, and returns Location metadata', async () => {
  let calls = 0;
  let observedHeaders: Headers | undefined;
  const client = traderWithFetch(async (_url, init) => {
    calls += 1;
    observedHeaders = new Headers(init?.headers);
    return new Response(null, {
      status: 201,
      headers: {
        Location: '/trader/v1/accounts/hash/orders/12345',
        'Schwab-Client-CorrelID': 'corr-1',
      },
    });
  });

  const result = await client.placeOrder('hash', order);

  assert.equal(calls, 1);
  assert.equal(observedHeaders?.get('idempotency-key'), null);
  assert.equal(result.status, 201);
  assert.equal(result.location, '/trader/v1/accounts/hash/orders/12345');
  assert.equal(result.orderId, '12345');
  assert.equal(result.correlationId, 'corr-1');
});

test('5xx mutation failures become UnknownOutcomeError without retry', async () => {
  let calls = 0;
  const client = traderWithFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: 'temporary' }), { status: 503 });
  });

  await assert.rejects(
    () => client.placeOrder('hash', order),
    (error: unknown) => error instanceof UnknownOutcomeError
      && error.code === 'SCHWAB_UNKNOWN_OUTCOME'
      && error.status === 503,
  );
  assert.equal(calls, 1);
});

test('network mutation failures become UnknownOutcomeError without retry', async () => {
  let calls = 0;
  const client = traderWithFetch(async () => {
    calls += 1;
    throw new Error('socket reset');
  });

  await assert.rejects(
    () => client.placeOrder('hash', order),
    (error: unknown) => error instanceof UnknownOutcomeError
      && error.code === 'SCHWAB_UNKNOWN_OUTCOME'
      && error.operation === 'PLACE_ORDER',
  );
  assert.equal(calls, 1);
});

test('a response body read failure after a successful mutation becomes UnknownOutcomeError', async () => {
  let calls = 0;
  const client = traderWithFetch(async () => {
    calls += 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('response socket reset'));
      },
    });
    return new Response(body, {
      status: 201,
      headers: { Location: '/trader/v1/accounts/hash/orders/12345' },
    });
  });

  await assert.rejects(
    () => client.placeOrder('hash', order),
    (error: unknown) => error instanceof UnknownOutcomeError
      && error.code === 'SCHWAB_UNKNOWN_OUTCOME'
      && error.status === 201,
  );
  assert.equal(calls, 1);
});

test('successful placeOrder without a valid Location is still UnknownOutcome', async () => {
  const client = traderWithFetch(async () => new Response(null, { status: 201 }));

  await assert.rejects(
    () => client.placeOrder('hash', order),
    (error: unknown) => error instanceof UnknownOutcomeError
      && error.code === 'SCHWAB_UNKNOWN_OUTCOME'
      && error.status === 201,
  );
});

test('mutation caller overrides cannot re-enable retries or idempotency headers', async () => {
  let calls = 0;
  let observedHeaders: Headers | undefined;
  const client = traderWithFetch(async (_url, init) => {
    calls += 1;
    observedHeaders = new Headers(init?.headers);
    return new Response(null, {
      status: 503,
      headers: { 'Schwab-Client-CorrelID': 'corr-unsafe-option' },
    });
  });

  await assert.rejects(
    () => client.placeOrder('hash', order, {
      maxRetries: 5,
      retryConfig: { maxRetries: 5, retryableMethods: ['POST'] },
      idempotencyKey: 'client-generated-key',
    } as never),
    UnknownOutcomeError,
  );
  assert.equal(calls, 1);
  assert.equal(observedHeaders?.get('idempotency-key'), null);
});

test('explicit mutation rejection remains SchwabApiError and is never retried', async () => {
  let calls = 0;
  const client = traderWithFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: 'invalid order' }), { status: 400 });
  });

  await assert.rejects(
    () => client.replaceOrder('hash', '123', order),
    (error: unknown) => error instanceof SchwabApiError && error.status === 400,
  );
  assert.equal(calls, 1);
});

test('401 mutation responses do not transparently refresh and resend', async () => {
  let refreshes = 0;
  let calls = 0;
  const client = traderWithFetch(async () => {
    calls += 1;
    return new Response(null, { status: 401 });
  }, fakeTokenManager({
    refreshAccessToken: async () => {
      refreshes += 1;
      return token;
    },
  }));

  await assert.rejects(() => client.cancelOrder('hash', '123'), SchwabApiError);
  assert.equal(calls, 1);
  assert.equal(refreshes, 0);
});

test('read 401 responses may refresh once and retry', async () => {
  let calls = 0;
  let refreshes = 0;
  const client = traderWithFetch(async () => {
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 401 })
      : new Response(JSON.stringify([{ accountNumber: '1', hashValue: 'hash' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
  }, fakeTokenManager({
    refreshAccessToken: async () => {
      refreshes += 1;
      return token;
    },
  }));

  const result = await client.getAccountNumbers();
  assert.equal(result[0]?.hashValue, 'hash');
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
});

function fakeStore(cached: PersistedToken) {
  return {
    path: '/tmp/test-schwab-token.json',
    load: async () => cached,
    save: async () => undefined,
  } as unknown as ConstructorParameters<typeof TokenManager>[1];
}

function tokenManagerWithFetch(cached: PersistedToken, fetchImpl: typeof fetch) {
  return new TokenManager(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://127.0.0.1',
    },
    fakeStore(cached),
    { fetch: fetchImpl, safetyWindowMs: 60_000 },
  );
}

test('refresh failure may fallback only while cached access token remains valid', async () => {
  const cached = { ...token, expires_at: Date.now() + 30_000 };
  const manager = tokenManagerWithFetch(cached, async () => {
    throw new Error('oauth unavailable');
  });

  assert.equal((await manager.getValidToken())?.access_token, cached.access_token);
});

test('expired cached access token fails closed when refresh fails', async () => {
  const cached = { ...token, expires_at: Date.now() - 1 };
  const manager = tokenManagerWithFetch(cached, async () => {
    throw new Error('oauth unavailable');
  });

  await assert.rejects(
    () => manager.requireAccessToken(),
    (error: unknown) => error instanceof ReauthRequiredError && error.code === 'SCHWAB_REAUTH_REQUIRED',
  );
});

test('invalid_grant fails closed with a stable reauthorization error and redacted callback', async () => {
  const cached = { ...token, expires_at: Date.now() - 1 };
  let callbackBody: unknown;
  const manager = new TokenManager(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://127.0.0.1',
    },
    fakeStore(cached),
    {
      fetch: async () => new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'refresh_token=super-secret-value',
        refresh_token: 'super-secret-value',
      }), { status: 400 }),
      onInvalidGrant: ({ body }) => {
        callbackBody = body;
      },
    },
  );

  await assert.rejects(() => manager.requireAccessToken(), ReauthRequiredError);
  assert.doesNotMatch(JSON.stringify(callbackBody), /super-secret-value/);
  await assert.rejects(() => manager.requireAccessToken(), ReauthRequiredError);
});

test('OAuth requests use the injected timeout signal', async () => {
  let observedSignal: AbortSignal | undefined;
  const manager = new TokenManager(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://127.0.0.1',
    },
    fakeStore(token),
    {
      timeoutMs: 1,
      fetch: async (_url, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          if (observedSignal?.aborted) {
            reject(observedSignal.reason);
            return;
          }
          observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true });
        });
      },
    },
  );

  await assert.rejects(() => manager.exchangeCodeForToken('authorization-code'));
  assert.equal(observedSignal?.aborted, true);
});
