import { HttpClient } from './httpClient.ts';
import type { HttpResponse, RequestOptions } from './httpClient.ts';
import { TokenManager } from '../auth/tokenManager.ts';
import { SchwabApiError } from './errors.ts';
import { Logger, createConsoleLogger } from './logger.ts';

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
    return this.authorizedRequest<T>(path, options, false) as Promise<T>;
  }

  /**
   * Execute an authorized request while preserving response headers/status.
   * This is required for Trader mutations because Schwab returns the created
   * order link in `Location` rather than in the response body.
   */
  protected async requestWithResponse<T>(
    path: string,
    options?: RequestOptions<T>,
  ): Promise<HttpResponse<T>> {
    return this.authorizedRequest<T>(path, options, true) as Promise<HttpResponse<T>>;
  }

  private async authorizedRequest<T>(
    path: string,
    options: RequestOptions<T> | undefined,
    preserveResponse: boolean,
  ): Promise<T | HttpResponse<T>> {
    // 先记录请求的基本信息，方便问题排查
    const opts = options ?? {};
    const method = (opts.method ?? 'GET').toUpperCase();
    this.logger.info('发起已授权的 REST 请求', { path, method });
    const token = await this.tokens.requireAccessToken();
    const send = (accessToken: string): Promise<T | HttpResponse<T>> => {
      const request = { ...opts, accessToken };
      return preserveResponse
        ? this.http.requestWithResponse<T>(path, request)
        : this.http.request<T>(path, request);
    };
    try {
      return await send(token.access_token);
    } catch (error) {
      const safeToRetryAfterRefresh = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
      if (safeToRetryAfterRefresh && error instanceof SchwabApiError && error.status === 401 && token.refresh_token) {
        this.logger.warn('捕获 401 响应，尝试刷新访问令牌后重试', { path });
        const refreshed = await this.tokens.refreshAccessToken(token.refresh_token);
        return await send(refreshed.access_token);
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
