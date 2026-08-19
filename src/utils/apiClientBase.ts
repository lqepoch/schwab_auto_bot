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
    const opts = options ?? {};
    const method = (opts.method ?? 'GET').toUpperCase();
    const safeToRetryAfterRefresh = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    // Per-request start messages are diagnostic detail. Keep the default info
    // stream focused on state transitions and failures so polling workloads do
    // not pay synchronous console I/O for every authorized transport.
    this.logger.debug('发起已授权的 REST 请求', { path, method });

    // Read requests may reuse TokenManager's short validated memory snapshot.
    // Mutation-like methods force a durable store read so another process's
    // credential rotation cannot be hidden by the read-path optimization.
    const token = await this.tokens.requireAccessToken({ fresh: !safeToRetryAfterRefresh });
    const send = (accessToken: string): Promise<T | HttpResponse<T>> => {
      const request = { ...opts, accessToken };
      return preserveResponse
        ? this.http.requestWithResponse<T>(path, request)
        : this.http.request<T>(path, request);
    };
    try {
      return await send(token.access_token);
    } catch (error) {
      if (safeToRetryAfterRefresh && error instanceof SchwabApiError && error.status === 401) {
        this.logger.warn('捕获 401 响应，重新读取持久化令牌后尝试一次安全重试', { path });
        const latest = await this.tokens.requireAccessToken({ fresh: true });
        if (latest.access_token !== token.access_token) {
          return await send(latest.access_token);
        }
        if (latest.refresh_token) {
          const refreshed = await this.tokens.refreshAccessToken(latest.refresh_token);
          return await send(refreshed.access_token);
        }
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
    if (!params) return undefined;

    const query: Record<string, string | number | boolean> = {};
    let size = 0;
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        const joined = value
          .filter((item): item is string | number | boolean => item !== undefined && item !== null)
          .join(',');
        if (!joined) continue;
        query[key] = joined;
      } else {
        query[key] = value;
      }
      size += 1;
    }
    return size === 0 ? undefined : query;
  }
}