import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { HttpClient } from '../dist/utils/httpClient.js';
import { SchwabApiError } from '../dist/utils/errors.js';
import type { RetryConfig } from '../dist/utils/httpClient.js';

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, child() { return this; },
};

function retryConfig(maxRetries = 2): RetryConfig {
  return {
    maxRetries,
    initialDelayMs: 0,
    maxDelayMs: 0,
    jitterRatio: 0,
    jitterStrategy: 'none',
    maxTotalRetryTimeMs: 1_000,
  };
}

test('default retry policy retries idempotent GET but never mutation POST', async () => {
  let getCalls = 0;
  const getClient = new HttpClient({
    baseUrl: 'https://api.schwabapi.com',
    logger,
    retryConfig: retryConfig(),
    fetch: async () => {
      getCalls += 1;
      return new Response(null, { status: 503 });
    },
  });
  await assert.rejects(() => getClient.request('/quotes'), SchwabApiError);
  assert.equal(getCalls, 3);

  let postCalls = 0;
  const postClient = new HttpClient({
    baseUrl: 'https://api.schwabapi.com',
    logger,
    retryConfig: retryConfig(),
    fetch: async () => {
      postCalls += 1;
      return new Response(null, { status: 503 });
    },
  });
  await assert.rejects(() => postClient.request('/orders', { method: 'POST', body: { price: 0.9 } }), SchwabApiError);
  assert.equal(postCalls, 1);
});

test('explicit low-level retry configuration can retry a replayable JSON body', async () => {
  let calls = 0;
  const bodies: string[] = [];
  const client = new HttpClient({
    baseUrl: 'https://api.schwabapi.com', logger,
    fetch: async (_url, init) => {
      calls += 1;
      bodies.push(String(init?.body));
      return calls === 1 ? new Response(null, { status: 503 }) : new Response('{"ok":true}', {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await client.request('/orders', {
    method: 'POST', body: { price: 0.9 }, retryConfig: { ...retryConfig(1), retryableMethods: ['POST'] },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(bodies, ['{"price":0.9}', '{"price":0.9}']);
});

test('non-replayable stream body disables retries even when explicitly configured', async () => {
  let calls = 0;
  const client = new HttpClient({
    baseUrl: 'https://api.schwabapi.com', logger,
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    },
  });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  await assert.rejects(() => client.request('/orders', {
    method: 'POST', body, retryConfig: { ...retryConfig(3), retryableMethods: ['POST'] },
  }), SchwabApiError);
  assert.equal(calls, 1);
});

test('aborted request does not retry and preserves network error metadata', async () => {
  const controller = new AbortController();
  controller.abort(new Error('caller stopped request'));
  let calls = 0;
  const client = new HttpClient({
    baseUrl: 'https://api.schwabapi.com', logger, retryConfig: retryConfig(),
    fetch: async (_url, init) => {
      calls += 1;
      throw init?.signal?.reason ?? new Error('aborted');
    },
  });
  await assert.rejects(() => client.request('/quotes', { signal: controller.signal }), (error: unknown) => {
    return error instanceof SchwabApiError && error.status === 0 && error.isNetworkError === true;
  });
  assert.equal(calls, 1);
});

test('query encoding, headers, schema validation, and response metadata are deterministic', async () => {
  let observedUrl = '';
  let observedHeaders: Headers | undefined;
  const client = new HttpClient({
    baseUrl: 'https://api.schwabapi.com/trader/v1/', logger,
    defaultHeaders: { 'X-Test': 'default', Authorization: 'default-auth' },
    fetch: async (url, init) => {
      observedUrl = String(url);
      observedHeaders = new Headers(init?.headers);
      return new Response('{"value":7}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          Location: '/orders/7',
          'Schwab-Client-CorrelID': 'corr-read-1',
          'x-ratelimit-limit': '120',
          'x-ratelimit-remaining': '119',
          'x-ratelimit-reset': '1786689600',
        },
      });
    },
  });
  const result = await client.requestWithResponse('/quotes', {
    accessToken: 'access-secret',
    headers: { 'x-test': 'override' },
    query: { symbol: 'QQQ   260812P00740000', empty: undefined, enabled: true },
    schema: z.object({ value: z.number() }),
  });
  assert.match(observedUrl, /symbol=QQQ\+\+\+260812P00740000/);
  assert.match(observedUrl, /enabled=true/);
  assert.equal(observedHeaders?.get('x-test'), 'override');
  assert.equal(observedHeaders?.get('authorization'), 'Bearer access-secret');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('location'), '/orders/7');
  assert.match(result.requestId, /^req-\d+-\d+$/);
  assert.equal(result.method, 'GET');
  assert.equal(result.url, 'https://api.schwabapi.com/trader/v1/quotes?symbol=QQQ+++260812P00740000&enabled=true');
  assert.equal(result.correlationId, 'corr-read-1');
  assert.deepEqual(result.rateLimit, {
    headers: {
      'x-ratelimit-limit': '120',
      'x-ratelimit-remaining': '119',
      'x-ratelimit-reset': '1786689600',
    },
    limit: 120,
    remaining: 119,
    reset: 1786689600,
  });
  assert.deepEqual(result.body, { value: 7 });
});

test('204 and empty responses return undefined while preserving metadata', async () => {
  for (const status of [204, 200]) {
    const client = new HttpClient({
      baseUrl: 'https://api.schwabapi.com', logger,
      fetch: async () => new Response(null, { status }),
    });
    const result = await client.requestWithResponse('/orders/7');
    assert.equal(result.body, undefined);
    assert.equal(result.status, status);
  }
});

test('HTTP errors retain safe correlation and rate-limit metadata without sensitive headers', async () => {
  const client = new HttpClient({
    baseUrl: 'https://api.schwabapi.com',
    logger,
    retryConfig: { maxRetries: 0 },
    fetch: async () => new Response('{"message":"limited"}', {
      status: 429,
      headers: {
        'Schwab-Client-CorrelID': 'corr-error-1',
        'retry-after': '7',
        'ratelimit-limit': '10',
        'ratelimit-remaining': '0',
        'set-cookie': 'session=secret',
      },
    }),
  });

  await assert.rejects(() => client.request('/quotes'), (error: unknown) => {
    if (!(error instanceof SchwabApiError)) return false;
    assert.equal(error.correlationId, 'corr-error-1');
    assert.deepEqual(error.rateLimit, {
      headers: {
        'ratelimit-limit': '10',
        'ratelimit-remaining': '0',
        'retry-after': '7',
      },
      limit: 10,
      remaining: 0,
      retryAfterMs: 7_000,
    });
    assert.equal(error.toJSON().headers['set-cookie'], '[REDACTED]');
    assert.equal(error.toJSON().headers['authorization'], undefined);
    return error.status === 429 && error.isRateLimited === true;
  });
});
