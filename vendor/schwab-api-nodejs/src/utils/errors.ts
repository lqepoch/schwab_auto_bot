export interface SchwabApiErrorOptions {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  retryAfterMs?: number;
  isRateLimited?: boolean;
  isAuthError?: boolean;
  isNetworkError?: boolean;
  requestId?: string;
  method?: string;
  attempt?: number;
  cause?: unknown;
}

/**
 * 自定义的 Schwab API 错误类型，保留 HTTP 状态码、请求 URL 以及原始响应正文，便于排查问题。
 */
export class SchwabApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  readonly retryAfterMs?: number;
  readonly isRateLimited?: boolean;
  readonly isAuthError?: boolean;
  readonly isNetworkError?: boolean;
  readonly requestId?: string;
  readonly method?: string;
  readonly attempt?: number;

  constructor(message: string, options: SchwabApiErrorOptions) {
    super(message);
    this.name = 'SchwabApiError';
    this.status = options.status;
    this.statusText = options.statusText;
    this.url = options.url;
    this.headers = options.headers;
    this.body = options.body;
    this.retryAfterMs = options.retryAfterMs;
    this.isRateLimited = options.isRateLimited;
    this.isAuthError = options.isAuthError;
    this.isNetworkError = options.isNetworkError;
    this.requestId = options.requestId;
    this.method = options.method;
    this.attempt = options.attempt;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toJSON() {
    // 返回标准化结构，方便直接序列化到日志中
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      statusText: this.statusText,
      url: this.url,
      headers: this.headers,
      body: this.body,
      retryAfterMs: this.retryAfterMs,
      isRateLimited: this.isRateLimited,
      isAuthError: this.isAuthError,
      isNetworkError: this.isNetworkError,
      requestId: this.requestId,
      method: this.method,
      attempt: this.attempt,
    } as const;
  }
}
