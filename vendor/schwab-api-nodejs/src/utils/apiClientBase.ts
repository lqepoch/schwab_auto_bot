import { HttpClient, RequestOptions } from './httpClient.js';
import { TokenManager } from '../auth/tokenManager.js';
import { SchwabApiError } from './errors.js';
import { Logger, createConsoleLogger } from './logger.js';

type QueryValue = string | number | boolean | undefined | null;

/**
 * Base class for REST clients that rely on OAuth access tokens.
 * Provides helpers for authorizing requests and normalizing query strings.
 */
export abstract class AuthorizedApiClient {
  protected constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenManager,
    protected readonly logger: Logger = createConsoleLogger({ scope: 'AuthorizedApiClient' }),
  ) {}

  protected async request<T>(path: string, options?: RequestOptions<T>): Promise<T> {
    // 先记录请求的基本信息，方便问题排查
    const opts = options ?? {};
    this.logger.info('发起已授权的 REST 请求', { path, method: opts.method ?? 'GET' });
    const token = await this.tokens.requireAccessToken();
    try {
      return await this.http.request<T>(path, { ...opts, accessToken: token.access_token });
    } catch (error) {
      if (error instanceof SchwabApiError && error.status === 401 && token.refresh_token) {
        this.logger.warn('捕获 401 响应，尝试刷新访问令牌后重试', { path });
        const refreshed = await this.tokens.refreshAccessToken(token.refresh_token);
        return this.http.request<T>(path, { ...opts, accessToken: refreshed.access_token });
      }
      this.logger.error('REST 请求失败', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  protected buildQuery(
    params?: Record<string, QueryValue | QueryValue[]>,
  ): Record<string, string | number | boolean> | undefined {
    // 将可能为数组的查询条件统一序列化成字符串
    if (!params) return undefined;

    const entries = Object.entries(params).flatMap(([key, value]) => {
      if (value === undefined || value === null) return [];
      if (Array.isArray(value)) {
        const joined = value
          .filter((item): item is string | number | boolean => item !== undefined && item !== null)
          .join(',');
        return joined ? [[key, joined]] : [];
      }
      return [[key, value]];
    });

    if (!entries.length) {
      // 没有有效参数则返回 undefined，避免出现多余的 ?
      return undefined;
    }
    return Object.fromEntries(entries) as Record<string, string | number | boolean>;
  }
}
