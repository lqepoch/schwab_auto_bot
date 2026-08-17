import type { RateLimitMetadata } from './responseMetadata.ts';

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
  correlationId?: string | null;
  rateLimit?: RateLimitMetadata;
  cause?: unknown;
}

export const UNKNOWN_OUTCOME_CODE = 'SCHWAB_UNKNOWN_OUTCOME';
export const REAUTH_REQUIRED_CODE = 'SCHWAB_REAUTH_REQUIRED';

export type MutationOperation = 'PLACE_ORDER' | 'REPLACE_ORDER' | 'CANCEL_ORDER';

export interface UnknownOutcomeErrorOptions {
  operation: MutationOperation;
  method: string;
  path: string;
  status?: number;
  requestId?: string;
  correlationId?: string;
  location?: string;
  cause?: unknown;
}

/**
 * The broker may have accepted a mutation even though this client cannot prove
 * the outcome. Callers must reconcile orders before considering another write.
 */
export class UnknownOutcomeError extends Error {
  readonly code = UNKNOWN_OUTCOME_CODE;
  readonly outcome = 'unknown' as const;
  readonly operation: MutationOperation;
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly location?: string;

  constructor(message: string, options: UnknownOutcomeErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'UnknownOutcomeError';
    this.operation = options.operation;
    this.method = options.method;
    this.path = options.path;
    this.status = options.status;
    this.requestId = options.requestId;
    this.correlationId = options.correlationId;
    this.location = options.location;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      outcome: this.outcome,
      message: this.message,
      operation: this.operation,
      method: this.method,
      path: this.path,
      status: this.status,
      requestId: this.requestId,
      correlationId: this.correlationId,
      location: this.location,
    } as const;
  }
}

/** Indicates that interactive OAuth authorization is required. */
export class ReauthRequiredError extends Error {
  readonly code = REAUTH_REQUIRED_CODE;

  constructor(message = 'Schwab OAuth reauthorization is required', options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ReauthRequiredError';
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    } as const;
  }
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
  readonly correlationId?: string | null;
  readonly rateLimit?: RateLimitMetadata;

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
    this.correlationId = options.correlationId;
    this.rateLimit = options.rateLimit;
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
      correlationId: this.correlationId,
      rateLimit: this.rateLimit,
    } as const;
  }
}
