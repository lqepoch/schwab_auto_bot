import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizedApiClient } from '../dist/utils/apiClientBase.js';
import { SchwabApiError } from '../dist/utils/errors.js';
import { createNullLogger } from '../dist/utils/logger.js';

type Token = { access_token: string; refresh_token: string };

class ProbeClient extends AuthorizedApiClient {
  constructor(http: unknown, tokens: unknown) {
    super(http as never, tokens as never, createNullLogger());
  }

  call(method: 'GET' | 'POST'): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/probe', { method });
  }
}

test('read requests allow the short validated token cache while mutation requests force a fresh durable read', async () => {
  const tokenReads: Array<{ fresh?: boolean }> = [];
  const tokens = {
    async requireAccessToken(options: { fresh?: boolean } = {}): Promise<Token> {
      tokenReads.push(options);
      return { access_token: 'access', refresh_token: 'refresh' };
    },
    async refreshAccessToken(): Promise<Token> {
      throw new Error('unexpected refresh');
    },
  };
  const http = {
    async request(_path: string, _options: unknown) {
      return { ok: true };
    },
    async requestWithResponse() {
      throw new Error('unexpected metadata request');
    },
  };
  const client = new ProbeClient(http, tokens);

  await client.call('GET');
  await client.call('POST');

  assert.deepEqual(tokenReads, [{ fresh: false }, { fresh: true }]);
});

test('a read-side 401 reloads durable credentials before considering refresh', async () => {
  const tokenReads: Array<{ fresh?: boolean }> = [];
  const usedTokens: string[] = [];
  let refreshCalls = 0;
  const tokens = {
    async requireAccessToken(options: { fresh?: boolean } = {}): Promise<Token> {
      tokenReads.push(options);
      return options.fresh
        ? { access_token: 'rotated-access', refresh_token: 'rotated-refresh' }
        : { access_token: 'cached-access', refresh_token: 'cached-refresh' };
    },
    async refreshAccessToken(): Promise<Token> {
      refreshCalls += 1;
      return { access_token: 'refreshed-access', refresh_token: 'refreshed-refresh' };
    },
  };
  const http = {
    async request(_path: string, options: { accessToken?: string }) {
      usedTokens.push(String(options.accessToken));
      if (usedTokens.length === 1) {
        throw new SchwabApiError('unauthorized', {
          status: 401,
          statusText: 'Unauthorized',
          url: 'https://fixture.invalid/probe',
          headers: {},
        });
      }
      return { ok: true };
    },
    async requestWithResponse() {
      throw new Error('unexpected metadata request');
    },
  };
  const client = new ProbeClient(http, tokens);

  assert.deepEqual(await client.call('GET'), { ok: true });
  assert.deepEqual(tokenReads, [{ fresh: false }, { fresh: true }]);
  assert.deepEqual(usedTokens, ['cached-access', 'rotated-access']);
  assert.equal(refreshCalls, 0);
});

test('a read-side 401 refreshes only after a fresh durable read confirms the same access token', async () => {
  const tokenReads: Array<{ fresh?: boolean }> = [];
  const refreshTokens: string[] = [];
  const usedTokens: string[] = [];
  const tokens = {
    async requireAccessToken(options: { fresh?: boolean } = {}): Promise<Token> {
      tokenReads.push(options);
      return { access_token: 'same-access', refresh_token: 'latest-refresh' };
    },
    async refreshAccessToken(refreshToken: string): Promise<Token> {
      refreshTokens.push(refreshToken);
      return { access_token: 'new-access', refresh_token: 'new-refresh' };
    },
  };
  const http = {
    async request(_path: string, options: { accessToken?: string }) {
      usedTokens.push(String(options.accessToken));
      if (usedTokens.length === 1) {
        throw new SchwabApiError('unauthorized', {
          status: 401,
          statusText: 'Unauthorized',
          url: 'https://fixture.invalid/probe',
          headers: {},
        });
      }
      return { ok: true };
    },
    async requestWithResponse() {
      throw new Error('unexpected metadata request');
    },
  };
  const client = new ProbeClient(http, tokens);

  assert.deepEqual(await client.call('GET'), { ok: true });
  assert.deepEqual(tokenReads, [{ fresh: false }, { fresh: true }]);
  assert.deepEqual(refreshTokens, ['latest-refresh']);
  assert.deepEqual(usedTokens, ['same-access', 'new-access']);
});
