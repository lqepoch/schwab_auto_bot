import { performance } from 'node:perf_hooks';
import {
  AuthorizationCodeParams,
  PersistedToken,
  PersistedTokenSchema,
  SchwabAuthConfig,
  TokenResponse,
  TokenResponseSchema,
} from '../types/auth.js';
import { TokenStore, type TokenStoreAdapter } from './tokenStore.js';
import { Logger, createConsoleLogger, withDuration } from '../utils/logger.js';
import { redactSensitive } from '../utils/redact.js';
import { ReauthRequiredError } from '../utils/errors.js';

const AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';

export interface TokenManagerOptions {
  safetyWindowMs?: number;
  logger?: Logger;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onInvalidGrant?: (details: { description?: string; body: unknown }) => void;
}

/**
 * 负责生成授权链接、换取访问令牌、自动刷新以及本地缓存。
 */
export class TokenManager {
  private readonly config: SchwabAuthConfig;
  private readonly store: TokenStoreAdapter;
  private readonly safetyWindow: number;
  private readonly basicAuthHeader: string;
  private readonly refreshPromises = new Map<string, Promise<PersistedToken>>();
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly invalidGrantObserver?: (details: { description?: string; body: unknown }) => void;
  private reauthRequired = false;

  constructor(config: SchwabAuthConfig, store?: TokenStoreAdapter, options: TokenManagerOptions = {}) {
    this.config = config;

    // 创建基础记录器，确保后续步骤都有统一的输出格式
    const baseLogger = options.logger ?? createConsoleLogger({ scope: 'TokenManager' });
    this.logger = baseLogger.child('core');

    // 若未显式传入 TokenStore，则默认使用基于文件的实现
    this.store =
      store ??
      new TokenStore({
        filePath: config.tokenStorePath,
        logger: baseLogger.child('store'),
      });

    this.safetyWindow = options.safetyWindowMs ?? config.tokenSafetyWindowMs ?? 60_000;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
    this.invalidGrantObserver = options.onInvalidGrant;
    const basicAuth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    this.basicAuthHeader = `Basic ${basicAuth}`;
    this.logger.info('TokenManager 初始化完成', {
      redirectUri: this.config.redirectUri,
      tokenStorePath: this.store.path ?? '[custom token store adapter]',
      safetyWindowMs: this.safetyWindow,
    });
  }

  /**
   * 拼装授权链接，可嵌入自定义 state、scope。
   */
  createAuthorizeUrl(params: AuthorizationCodeParams = {}): string {
    // 输出生成授权链接的参数，方便确认 state/scope
    this.logger.info('生成授权链接', { params });
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('response_type', 'code');
    if (params.state) url.searchParams.set('state', params.state);
    if (params.scope) url.searchParams.set('scope', params.scope);
    return url.toString();
  }

  /**
   * 使用授权码兑换初始访问令牌，并自动写入缓存文件。
   */
  async exchangeCodeForToken(code: string): Promise<PersistedToken> {
    this.logger.info('收到授权码，准备换取访问令牌', { hasCode: Boolean(code) });
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
    });
    return this.requestToken(body, false);
  }

  /**
   * 使用 refresh_token 刷新访问令牌。
   */
  async refreshAccessToken(refreshToken: string): Promise<PersistedToken> {
    if (this.reauthRequired) {
      throw new ReauthRequiredError();
    }
    this.logger.info('准备刷新访问令牌', { hasRefreshToken: Boolean(refreshToken) });
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const refreshKey = this.getRefreshKey(refreshToken);
    const existing = this.refreshPromises.get(refreshKey);
    if (existing) {
      this.logger.debug('复用正在执行的刷新请求');
      return existing;
    }

    const start = performance.now();
    const pending = this.requestToken(body, true)
      .then((token) => {
        if (token.refresh_token !== refreshToken) {
          this.logger.warn('检测到刷新令牌已更新，将放弃旧的 refresh_token');
        }
        return token;
      })
      .finally(() => {
        this.refreshPromises.delete(refreshKey);
        this.logger.info('刷新访问令牌流程结束', withDuration(start));
      });
    this.refreshPromises.set(refreshKey, pending);
    return pending;
  }

  /**
   * 获取仍在有效期内的访问令牌，若即将过期则尝试提前刷新。
   */
  async getValidToken(): Promise<PersistedToken | null> {
    this.logger.info('尝试读取可用访问令牌');
    if (this.reauthRequired) {
      throw new ReauthRequiredError();
    }
    const cached = await this.loadPersistedToken();
    if (!cached) {
      this.logger.warn('未找到本地缓存的令牌');
      return null;
    }
    const remainingMs = cached.expires_at - Date.now();
    if (remainingMs <= this.safetyWindow) {
      try {
        this.logger.warn('令牌即将过期，准备刷新');
        const refreshed = await this.refreshAccessToken(cached.refresh_token);
        return refreshed;
      } catch (error) {
        if (error instanceof ReauthRequiredError) {
          throw error;
        }
        if (cached.expires_at > Date.now()) {
          this.logger.warn('刷新令牌失败，但缓存访问令牌仍在有效期内，暂时继续使用', {
            error: safeErrorMessage(error),
          });
          return cached;
        }
        this.logger.error('刷新令牌失败且缓存访问令牌已过期，要求重新授权', {
          error: safeErrorMessage(error),
        });
        throw new ReauthRequiredError(
          'Schwab access token is expired and refresh failed; interactive reauthorization is required',
          { cause: error },
        );
      }
    }
    this.logger.info('缓存令牌仍在有效期内');
    return cached;
  }

  /**
   * 获取可用令牌；若不存在缓存则抛出异常，提示调用方先完成授权交换。
   */
  async requireAccessToken(): Promise<PersistedToken> {
    const token = await this.getValidToken();
    if (!token) {
      this.logger.error('未找到缓存令牌，需要先执行授权');
      throw new Error('No cached Schwab token found. Call exchangeCodeForToken() first.');
    }
    if (token.expires_at <= Date.now()) {
      throw new ReauthRequiredError(
        'Schwab access token is expired; interactive reauthorization is required',
      );
    }
    this.logger.info('成功获取可用访问令牌');
    return token;
  }

  /**
   * 手动持久化令牌对象，可用于外部自定义换取流程。
   */
  async persist(token: TokenResponse): Promise<PersistedToken> {
    this.logger.info('准备手动持久化令牌');
    const persisted = this.decorateToken(token);
    await this.store.save(persisted);
    this.reauthRequired = false;
    this.logger.info('令牌持久化完成', { expiresAt: persisted.expires_at });
    return persisted;
  }

  /**
   * 与 Schwab OAuth 服务器交互的核心逻辑，封装 POST 请求与错误信息。
   */
  private async requestToken(body: URLSearchParams, isRefresh: boolean): Promise<PersistedToken> {
    const start = performance.now();
    this.logger.info('向 OAuth 服务器请求令牌');
    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: this.basicAuthHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.logger.error('请求 OAuth 服务器失败（网络异常）', {
        error: safeErrorMessage(error),
      });
      throw error;
    }
    if (!response.ok) {
      const text = await response.text();
      const analysis = this.analyzeOAuthError(text);
      this.logger.error('OAuth 服务器返回错误', {
        status: response.status,
        statusText: response.statusText,
        body: analysis.sanitizedBody,
      });
      if (analysis.isInvalidGrant) {
        this.logger.error('检测到 OAuth invalid_grant，当前授权凭据不可用', {
          description: analysis.description,
        });
        this.emitInvalidGrant({ description: analysis.description, body: analysis.sanitizedBody });
        this.reauthRequired = true;
        throw new ReauthRequiredError(
          isRefresh
            ? 'Schwab refresh token is invalid; interactive reauthorization is required'
            : 'Schwab authorization grant is invalid; interactive reauthorization is required',
        );
      }
      throw new Error(`Schwab token request failed: ${response.status} ${response.statusText}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      this.logger.error('解析 OAuth 响应 JSON 失败', {
        error: safeErrorMessage(error),
      });
      throw error;
    }

    let token: TokenResponse;
    try {
      token = TokenResponseSchema.parse(payload);
    } catch (error) {
      this.logger.error('OAuth 响应结构验证失败', {
        error: safeErrorMessage(error),
        payload: redactSensitive(payload),
      });
      throw error;
    }
    this.logger.info('成功从 OAuth 服务器获取令牌', withDuration(start));
    const persisted = this.decorateToken(token);
    await this.store.save(persisted);
    if (!isRefresh) this.reauthRequired = false;
    return persisted;
  }

  /**
   * 为原始响应补充缓存时间与过期时间戳，方便失效判断。
   */
  private decorateToken(token: TokenResponse): PersistedToken {
    const now = Date.now();
    this.logger.debug('计算令牌过期时间', { now, expiresIn: token.expires_in });
    return {
      ...token,
      obtained_at: now,
      expires_at: now + token.expires_in * 1000,
    };
  }

  private getRefreshKey(refreshToken: string): string {
    return `${this.config.clientId}:${refreshToken}`;
  }

  private async loadPersistedToken(): Promise<PersistedToken | null> {
    const raw = await this.store.load();
    if (raw === null) return null;
    const parsed = PersistedTokenSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error('令牌存储适配器返回无效令牌，fail-closed', {
        issues: parsed.error.issues,
      });
      return null;
    }
    return parsed.data;
  }

  private analyzeOAuthError(rawBody: string): {
    sanitizedBody: unknown;
    isInvalidGrant: boolean;
    description?: string;
  } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = undefined;
    }

    const sanitizedBody = redactOAuthText(parsed ?? rawBody);
    let isInvalidGrant = false;
    let description: string | undefined;

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const errorCode = typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : undefined;
      if (errorCode === 'invalid_grant') {
        isInvalidGrant = true;
        const maybeDescription = (parsed as { error_description?: unknown }).error_description;
        if (typeof maybeDescription === 'string') {
          description = redactOAuthText(maybeDescription) as string;
        }
      }
    } else if (rawBody.toLowerCase().includes('invalid_grant')) {
      isInvalidGrant = true;
    }

    return { sanitizedBody, isInvalidGrant, description };
  }

  private emitInvalidGrant(details: { description?: string; body: unknown }): void {
    if (!this.invalidGrantObserver) {
      return;
    }
    try {
      this.invalidGrantObserver(details);
    } catch (error) {
      this.logger.error('invalid_grant 回调执行失败', {
        error: safeErrorMessage(error),
      });
    }
  }
}

/**
 * OAuth error payloads are untrusted. Keep enough context for diagnostics
 * while ensuring token-shaped values in both JSON and plain-text responses do
 * not reach logs or callbacks.
 */
function redactOAuthText(value: unknown): unknown {
  const redacted = redactSensitive(value);
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') {
      return current
        .replace(
          /\b(?:access_token|refresh_token|client_secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
          (match) => `${match.slice(0, match.search(/[:=]/))}[REDACTED]`,
        )
        .slice(0, 512);
    }
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === 'object') {
      return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, visit(item)]));
    }
    return current;
  };
  return visit(redacted);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactOAuthText(message));
}
