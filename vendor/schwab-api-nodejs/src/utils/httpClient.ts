import { performance } from 'node:perf_hooks';
import { ZodError, type ZodType } from 'zod';
import { SchwabApiError } from './errors.ts';
import { type Logger, createConsoleLogger, withDuration } from './logger.ts';
import { redactHeaders } from './redact.ts';
import { DEFAULT_USER_AGENT } from './version.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type RetryEventReason = 'network-error' | 'status-code';

export interface RetryEvent {
  /** 请求唯一编号，用于日志关联 */
  requestId: string;
  /** HTTP 方法 */
  method: HttpMethod;
  /** 请求的完整 URL */
  url: string;
  /** 当前已经尝试的次数（从 1 开始） */
  attempt: number;
  /** 下一次尝试的次数（从 1 开始） */
  nextAttempt: number;
  /** 允许的最大重试次数 */
  maxRetries: number;
  /** 剩余可重试次数 */
  remainingRetries: number;
  /** 等待多久后开始下一次重试（毫秒） */
  delayMs: number;
  /** 重试的原因：网络错误或状态码 */
  reason: RetryEventReason;
  /** 当 reason = 'status-code' 时，记录响应状态码 */
  status?: number;
  /** 捕获到的原始错误对象 */
  error?: unknown;
  /** 自第一次发送以来已经过去的毫秒数 */
  elapsedMs: number;
}

export interface RetryConfig {
  /** 最多允许的重试次数 */
  maxRetries?: number;
  /** 哪些状态码被认为可以重试 */
  retryableStatusCodes?: number[];
  /** 哪些方法允许自动重试 */
  retryableMethods?: HttpMethod[];
  /** 初始退避时间 */
  initialDelayMs?: number;
  /** 退避时间上限 */
  maxDelayMs?: number;
  /** 指数退避倍数 */
  backoffMultiplier?: number;
  /** 抖动比例 */
  jitterRatio?: number;
  /** 是否尊重服务器返回的 retry-after 头 */
  respectRetryAfterHeader?: boolean;
  /** 抖动策略 */
  jitterStrategy?: 'none' | 'proportional' | 'full';
  /** 整个重试阶段允许的最长耗时 */
  maxTotalRetryTimeMs?: number;
}

export interface HttpClientConfig {
  /** API 服务端基础地址 */
  baseUrl: string;
  /** 自定义 fetch 实现，便于注入 polyfill 或测试 */
  fetch?: typeof fetch;
  /** 默认会在每个请求上附加的 HTTP 头 */
  defaultHeaders?: Record<string, string>;
  /** 自定义日志实现 */
  logger?: Logger;
  /** 子日志作用域，用于区分多个客户端实例 */
  logScope?: string;
  /** 默认超时时间 */
  timeoutMs?: number;
  /** 全局重试配置 */
  retryConfig?: RetryConfig;
  /** 全局重试事件回调 */
  onRetry?: (event: RetryEvent) => void;
}

export type HttpResponse<T> = {
  body: T;
  headers: Headers;
  status: number;
};

export interface RequestOptions<T = unknown> {
  /** 覆盖默认 HTTP 方法 */
  method?: HttpMethod;
  /** 附加 HTTP 头 */
  headers?: Record<string, string>;
  /** 查询字符串 */
  query?: Record<string, string | number | boolean | undefined>;
  /** 请求体 */
  body?: unknown;
  /** Bearer Token，会自动拼接 Authorization 头 */
  accessToken?: string;
  /** 外部传入的取消信号 */
  signal?: AbortSignal;
  /** 覆盖默认超时时间 */
  timeoutMs?: number;
  /** 响应体验证 schema */
  schema?: ZodType<T>;
  /** 覆盖重试次数 */
  maxRetries?: number;
  /** 覆盖重试配置 */
  retryConfig?: RetryConfig;
  /** 请求级别的重试事件回调 */
  onRetry?: (event: RetryEvent) => void;
  /** Return response metadata for callers that need broker response headers. */
  includeResponseMetadata?: boolean;
}

interface AbortResources {
  signal: AbortSignal;
  cleanup: () => void;
}

interface ResolvedRetryConfig {
  maxRetries: number;
  retryableStatusCodes: number[];
  retryableMethods: HttpMethod[];
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterRatio: number;
  respectRetryAfterHeader: boolean;
  jitterStrategy: 'none' | 'proportional' | 'full';
  maxTotalRetryTimeMs?: number;
}

interface PreparedBody {
  /** 请求体是否可以安全地重复发送 */
  canRetry: boolean;
  /** 根据当前尝试次数返回对应的 BodyInit */
  createBody: (attempt: number) => BodyInit | undefined;
}

/**
 * 基于 fetch 封装的 HTTP 客户端，提供统一的日志记录、重试、超时控制以及响应校验能力。
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly logger: Logger;
  private readonly timeoutMs?: number;
  private readonly retryConfig: ResolvedRetryConfig;
  private readonly retryObserver?: (event: RetryEvent) => void;
  private requestCounter = 0;

  constructor(config: HttpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? fetch;
    this.logger = (config.logger ?? createConsoleLogger({ scope: 'HttpClient' })).child(
      config.logScope ?? 'default',
    );
    this.timeoutMs = config.timeoutMs;

    // 复制一份默认头，避免外部修改影响内部状态
    this.defaultHeaders = { ...(config.defaultHeaders ?? {}) };
    const hasUserAgent = Object.keys(this.defaultHeaders).some((key) => key.toLowerCase() === 'user-agent');
    if (!hasUserAgent) {
      this.defaultHeaders['User-Agent'] = DEFAULT_USER_AGENT;
    }

    this.retryConfig = this.resolveRetryConfig(config.retryConfig);
    this.retryObserver = config.onRetry;
  }

  /**
   * 发送 HTTP 请求。会自动处理重试、超时、日志记录以及响应体验证。
   */
  async request<T>(path: string, options?: RequestOptions<T>): Promise<T> {
    const opts = options ?? {};
    const requestId = `req-${Date.now()}-${++this.requestCounter}`;
    const method = ((opts.method ?? 'GET') as string).toUpperCase() as HttpMethod;
    const url = this.buildUrl(path, opts.query);

    // 合并请求头，调用方覆盖默认值
    const headers = mergeHeaders(this.defaultHeaders, opts.headers);

    // 根据配置自动附加认证信息
    if (opts.accessToken) {
      setHeader(headers, 'Authorization', `Bearer ${opts.accessToken}`);
    }
    // Resolve retry policy without inferring broker idempotency from a client
    // supplied header. Mutating requests must opt into retrying explicitly at
    // this low-level transport; TraderApiClient never does so.
    const mergedRetryConfig = this.mergeRetryConfig(this.retryConfig, opts.retryConfig);
    const requestRetryConfig = mergedRetryConfig;

    const preparedBody = this.prepareBody(opts.body, headers);

    // 合并外部信号与内部超时控制
    const abortResources = this.mergeAbortSignals(requestId, opts.signal, opts.timeoutMs);
    const requestOnRetry = opts.onRetry;

    let maxRetries = Math.max(0, opts.maxRetries ?? requestRetryConfig.maxRetries);
    if (!preparedBody.canRetry) {
      if (maxRetries > 0) {
        this.logger.debug('请求体不可重复发送，禁用重试', { requestId, method });
      }
      maxRetries = 0;
    }

    const overallStart = performance.now();
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const attemptNumber = attempt + 1;
        const startTime = performance.now();
        const bodyInit = preparedBody.createBody(attempt);

        const init: RequestInit = {
          method,
          headers,
          body: bodyInit,
          signal: abortResources?.signal,
        };

        this.logger.debug('HTTP 请求开始', { requestId, method, url, attempt: attemptNumber });

        let response: Response;
        try {
          response = await this.fetchImpl(url, init);
        } catch (error) {
          // 网络异常时尝试重试
          if (
            this.shouldRetryNetworkError(
              attempt,
              maxRetries,
              method,
              abortResources?.signal,
              requestRetryConfig,
            )
          ) {
            const delayMs = this.computeBackoffDelay(attempt, requestRetryConfig);
            if (this.exceedsRetryBudget(overallStart, delayMs, requestRetryConfig)) {
              this.logger.error('HTTP 请求重试预算已耗尽（网络异常）', {
                requestId,
                method,
                url,
                attempt: attemptNumber,
                delayMs,
              });
            } else {
              this.logger.warn('HTTP 请求失败（网络异常），准备重试', {
                requestId,
                method,
                url,
                attempt: attemptNumber,
                delayMs,
                error: error instanceof Error ? error.message : String(error),
              });
              this.emitRetryEvent(requestOnRetry, {
                requestId,
                method,
                url,
                attempt: attemptNumber,
                nextAttempt: attemptNumber + 1,
                maxRetries,
                remainingRetries: Math.max(0, maxRetries - attempt),
                delayMs,
                reason: 'network-error',
                error,
                elapsedMs: performance.now() - overallStart,
              });
              await this.wait(delayMs, abortResources?.signal);
              continue;
            }
          }

          const originalError = error instanceof Error ? error : new Error(String(error));
          const isAbortError = originalError.name === 'AbortError';
          this.logger.error('HTTP 请求失败（网络异常）', {
            requestId,
            method,
            url,
            attempt: attemptNumber,
            error: originalError.message,
            aborted: isAbortError || abortResources?.signal?.aborted || undefined,
          });

          const message = isAbortError
            ? `Schwab API request was aborted: ${originalError.message}`
            : `Schwab API network request failed: ${originalError.message}`;
          throw new SchwabApiError(message, {
            status: 0,
            statusText: isAbortError ? 'ABORTED' : 'NETWORK_ERROR',
            url,
            headers: redactHeaders({ ...headers }),
            isNetworkError: true,
            requestId,
            method,
            attempt: attemptNumber,
            cause: originalError,
          });
        }

        let rawText: string;
        try {
          rawText = await response.text();
        } catch (error) {
          // The broker may have accepted a mutation before the response body
          // stream failed. Preserve the HTTP response context and classify the
          // read failure as network-ambiguous so TraderApiClient can route it
          // to UnknownOutcome reconciliation instead of exposing a raw Error.
          const originalError = error instanceof Error ? error : new Error(String(error));
          const isAbortError = originalError.name === 'AbortError';
          this.logger.error('HTTP 响应正文读取失败', {
            requestId,
            method,
            url,
            status: response.status,
            attempt: attemptNumber,
            error: originalError.message,
          });
          throw new SchwabApiError(
            `Schwab API response body read failed: ${originalError.message}`,
            {
              status: response.status,
              statusText: isAbortError ? 'ABORTED' : 'RESPONSE_BODY_READ_ERROR',
              url,
              headers: redactHeaders(headersToObject(response.headers)),
              isNetworkError: true,
              requestId,
              method,
              attempt: attemptNumber,
              cause: originalError,
            },
          );
        }
        const parsedBody = rawText ? parseResponseBody(rawText) : undefined;

        if (!response.ok) {
          if (
            this.shouldRetryStatus(
              response.status,
              method,
              attempt,
              maxRetries,
              abortResources?.signal,
              requestRetryConfig,
            )
          ) {
            const delayMs = this.getRetryDelay(response, attempt, requestRetryConfig);
            if (this.exceedsRetryBudget(overallStart, delayMs, requestRetryConfig)) {
              this.logger.error('HTTP 请求重试预算已耗尽（状态码）', {
                requestId,
                method,
                url,
                status: response.status,
                attempt: attemptNumber,
                delayMs,
              });
            } else {
              this.logger.warn('HTTP 请求返回可重试状态码，准备重试', {
                requestId,
                method,
                url,
                status: response.status,
                attempt: attemptNumber,
                delayMs,
              });
              this.emitRetryEvent(requestOnRetry, {
                requestId,
                method,
                url,
                attempt: attemptNumber,
                nextAttempt: attemptNumber + 1,
                maxRetries,
                remainingRetries: Math.max(0, maxRetries - attempt),
                delayMs,
                reason: 'status-code',
                status: response.status,
                elapsedMs: performance.now() - overallStart,
              });
              await this.wait(delayMs, abortResources?.signal);
              continue;
            }
          }

          const message = buildErrorMessage(response.status, response.statusText, parsedBody);
          this.logger.error('HTTP 请求返回非 2xx 状态', {
            requestId,
            method,
            url,
            status: response.status,
            statusText: response.statusText,
            attempt: attemptNumber,
            ...withDuration(startTime),
          });
          const retryAfterMs = this.parseRetryAfter(response.headers.get('retry-after')) ?? undefined;
          throw new SchwabApiError(message, {
            status: response.status,
            statusText: response.statusText,
            url,
            headers: redactHeaders(headersToObject(response.headers)),
            body: parsedBody,
            retryAfterMs,
            isRateLimited: response.status === 429,
            isAuthError: response.status === 401,
            requestId,
            method,
            attempt: attemptNumber,
          });
        }

        if (response.status === 204 || !rawText) {
          this.logger.debug('HTTP 请求完成（无内容）', {
            requestId,
            method,
            url,
            status: response.status,
            attempt: attemptNumber,
            ...withDuration(startTime),
          });
          return this.withMetadata(undefined as T, response, opts);
        }

        const contentType = response.headers.get('content-type') ?? '';
        const isJsonResponse = contentType.includes('application/json');
        const result: unknown = parsedBody ?? rawText;

        const logContext = {
          requestId,
          method,
          url,
          status: response.status,
          attempt: attemptNumber,
          ...withDuration(startTime),
        };

        if (isJsonResponse) {
          this.logger.debug('HTTP 请求完成（JSON 响应）', logContext);
        } else if (typeof result !== 'string') {
          this.logger.debug('HTTP 请求完成（尝试解析 JSON 成功）', logContext);
        } else {
          this.logger.debug('HTTP 请求完成（返回文本）', logContext);
        }

        if (opts.schema) {
          try {
            return this.withMetadata(opts.schema.parse(result), response, opts);
          } catch (error) {
            if (error instanceof ZodError) {
              this.logger.error('HTTP 响应验证失败', {
                requestId,
                method,
                url,
                status: response.status,
                attempt: attemptNumber,
                issues: error.issues,
              });
            }
            throw error;
          }
        }

        return this.withMetadata(result as T, response, opts);
      }

      throw new Error('HTTP request exceeded maximum retry attempts');
    } finally {
      abortResources?.cleanup();
    }
  }

  /** Preserve response headers/status for callers needing the broker order ID. */
  async requestWithResponse<T>(path: string, options?: RequestOptions<T>): Promise<HttpResponse<T>> {
    const response = await this.request<T>(path, {
      ...(options ?? {}),
      includeResponseMetadata: true,
    });
    return response as unknown as HttpResponse<T>;
  }

  private withMetadata<T>(body: T, response: Response, options: RequestOptions<unknown>): T {
    if (!options.includeResponseMetadata) return body;
    return { body, headers: new Headers(response.headers), status: response.status } as T;
  }

  /**
   * 构建最终 URL，并附带查询字符串。
   */
  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * 将调用方传入的重试配置与默认配置合并，并确保字段合法。
   */
  private resolveRetryConfig(config?: RetryConfig): ResolvedRetryConfig {
    const defaults: ResolvedRetryConfig = {
      maxRetries: 3,
      retryableStatusCodes: [429, 500, 502, 503, 504],
      retryableMethods: ['GET', 'HEAD', 'OPTIONS'],
      initialDelayMs: 250,
      maxDelayMs: 8_000,
      backoffMultiplier: 2,
      jitterRatio: 0.2,
      respectRetryAfterHeader: true,
      jitterStrategy: 'full',
      maxTotalRetryTimeMs: 10_000,
    };

    if (!config) {
      return {
        ...defaults,
        retryableStatusCodes: [...defaults.retryableStatusCodes],
        retryableMethods: [...defaults.retryableMethods],
      };
    }

    const jitterStrategy =
      config.jitterStrategy ?? (config.jitterRatio !== undefined ? 'proportional' : defaults.jitterStrategy);

    return {
      maxRetries: Math.max(0, config.maxRetries ?? defaults.maxRetries),
      retryableStatusCodes: [...(config.retryableStatusCodes ?? defaults.retryableStatusCodes)],
      retryableMethods: (config.retryableMethods ?? defaults.retryableMethods).map(
        (method) => method.toUpperCase() as HttpMethod,
      ),
      initialDelayMs: Math.max(0, config.initialDelayMs ?? defaults.initialDelayMs),
      maxDelayMs: Math.max(0, config.maxDelayMs ?? defaults.maxDelayMs),
      backoffMultiplier: Math.max(1, config.backoffMultiplier ?? defaults.backoffMultiplier),
      jitterRatio: Math.min(Math.max(0, config.jitterRatio ?? defaults.jitterRatio), 1),
      respectRetryAfterHeader: config.respectRetryAfterHeader ?? defaults.respectRetryAfterHeader,
      jitterStrategy,
      maxTotalRetryTimeMs:
        config.maxTotalRetryTimeMs === undefined
          ? defaults.maxTotalRetryTimeMs
          : Math.max(0, config.maxTotalRetryTimeMs),
    };
  }

  /**
   * 在默认配置的基础上应用请求级别的重试覆盖。
   */
  private mergeRetryConfig(base: ResolvedRetryConfig, override?: RetryConfig): ResolvedRetryConfig {
    if (!override) {
      return {
        ...base,
        retryableStatusCodes: [...base.retryableStatusCodes],
        retryableMethods: [...base.retryableMethods],
      };
    }

    return {
      maxRetries: Math.max(0, override.maxRetries ?? base.maxRetries),
      retryableStatusCodes: [...(override.retryableStatusCodes ?? base.retryableStatusCodes)],
      retryableMethods: (override.retryableMethods ?? base.retryableMethods).map(
        (method) => method.toUpperCase() as HttpMethod,
      ),
      initialDelayMs: Math.max(0, override.initialDelayMs ?? base.initialDelayMs),
      maxDelayMs: Math.max(0, override.maxDelayMs ?? base.maxDelayMs),
      backoffMultiplier: Math.max(1, override.backoffMultiplier ?? base.backoffMultiplier),
      jitterRatio: Math.min(Math.max(0, override.jitterRatio ?? base.jitterRatio), 1),
      respectRetryAfterHeader: override.respectRetryAfterHeader ?? base.respectRetryAfterHeader,
      jitterStrategy: override.jitterStrategy ?? base.jitterStrategy,
      maxTotalRetryTimeMs:
        override.maxTotalRetryTimeMs === undefined
          ? base.maxTotalRetryTimeMs
          : Math.max(0, override.maxTotalRetryTimeMs),
    };
  }

  /**
   * 根据请求体类型生成适合重试的 BodyInit 工厂，同时设置必要的头部。
   */
  private prepareBody(body: unknown, headers: Record<string, string>): PreparedBody {
    if (body === undefined) {
      return {
        canRetry: true,
        createBody: () => undefined,
      };
    }

    if (isBodyInit(body)) {
      if (isReadableStream(body)) {
        // ReadableStream 无法复制，只能发送一次
        return {
          canRetry: false,
          createBody: () => body,
        };
      }

      if (isFormData(body)) {
        const original = body;
        return {
          canRetry: true,
          createBody: (attempt) => (attempt === 0 ? original : cloneFormData(original)),
        };
      }

      if (isBlob(body)) {
        const original = body;
        return {
          canRetry: true,
          createBody: (attempt) => (attempt === 0 ? original : cloneBlob(original)),
        };
      }

      if (body instanceof URLSearchParams) {
        const original = body;
        return {
          canRetry: true,
          createBody: (attempt) => (attempt === 0 ? original : new URLSearchParams(original.toString())),
        };
      }

      if (body instanceof ArrayBuffer) {
        const original = body;
        return {
          canRetry: true,
          createBody: (attempt) => (attempt === 0 ? original : original.slice(0)),
        };
      }

      if (ArrayBuffer.isView(body)) {
        const original = body;
        return {
          canRetry: true,
          createBody: (attempt) =>
            (attempt === 0 ? original : (cloneArrayBufferView(original) as BodyInit)) as BodyInit,
        };
      }

      return {
        canRetry: true,
        createBody: () => body,
      };
    }

    // 非 BodyInit 类型默认视为 JSON
    if (!hasHeader(headers, 'Content-Type')) {
      headers['Content-Type'] = 'application/json';
    }
    const payload = JSON.stringify(body);
    return {
      canRetry: true,
      createBody: () => payload,
    };
  }

  /**
   * 判断网络错误是否可重试。
   */
  private shouldRetryNetworkError(
    attempt: number,
    maxRetries: number,
    method: HttpMethod,
    signal: AbortSignal | undefined,
    retryConfig: ResolvedRetryConfig,
  ): boolean {
    if (signal?.aborted) {
      return false;
    }
    return attempt < maxRetries && retryConfig.retryableMethods.includes(method);
  }

  /**
   * 判断状态码是否允许重试。
   */
  private shouldRetryStatus(
    status: number,
    method: HttpMethod,
    attempt: number,
    maxRetries: number,
    signal: AbortSignal | undefined,
    retryConfig: ResolvedRetryConfig,
  ): boolean {
    if (signal?.aborted) {
      return false;
    }
    return (
      attempt < maxRetries &&
      retryConfig.retryableMethods.includes(method) &&
      retryConfig.retryableStatusCodes.includes(status)
    );
  }

  /**
   * 计算下次重试前的等待时间。
   */
  private getRetryDelay(
    response: Response,
    attempt: number,
    retryConfig: ResolvedRetryConfig,
  ): number {
    if (retryConfig.respectRetryAfterHeader) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfter = this.parseRetryAfter(retryAfterHeader);
      if (retryAfter !== null) {
        return retryAfter;
      }
    }
    return this.computeBackoffDelay(attempt, retryConfig);
  }

  /**
   * 根据指数退避策略计算等待时间，并引入抖动避免雪崩。
   */
  private computeBackoffDelay(attempt: number, retryConfig: ResolvedRetryConfig): number {
    const baseDelay = retryConfig.initialDelayMs * Math.pow(retryConfig.backoffMultiplier, attempt);
    if (baseDelay <= 0) {
      return 0;
    }
    const clampedBase = Math.min(baseDelay, retryConfig.maxDelayMs || baseDelay);
    if (clampedBase <= 0) {
      return 0;
    }

    switch (retryConfig.jitterStrategy) {
      case 'none': {
        return Math.round(clampedBase);
      }
      case 'proportional': {
        const jitter = retryConfig.jitterRatio;
        if (jitter <= 0) {
          return Math.round(clampedBase);
        }
        const min = clampedBase * (1 - jitter);
        const max = clampedBase * (1 + jitter);
        const randomDelay = min + Math.random() * (max - min);
        return Math.max(0, Math.round(randomDelay));
      }
      case 'full':
      default: {
        return Math.max(0, Math.round(Math.random() * clampedBase));
      }
    }
  }

  /**
   * 判断累计耗时是否已经超过允许的重试预算。
   */
  private exceedsRetryBudget(
    overallStart: number,
    nextDelayMs: number,
    retryConfig: ResolvedRetryConfig,
  ): boolean {
    if (retryConfig.maxTotalRetryTimeMs === undefined) {
      return false;
    }
    const elapsed = performance.now() - overallStart;
    return elapsed + nextDelayMs > retryConfig.maxTotalRetryTimeMs;
  }

  /**
   * 解析 Retry-After 头，返回等待毫秒数。
   */
  private parseRetryAfter(headerValue: string | null): number | null {
    if (!headerValue) {
      return null;
    }
    const seconds = Number(headerValue);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }
    const timestamp = Date.parse(headerValue);
    if (!Number.isNaN(timestamp)) {
      const delay = timestamp - Date.now();
      return delay > 0 ? delay : 0;
    }
    return null;
  }

  /**
   * 延迟等待指定毫秒数，同时监听取消信号。
   */
  private async wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (delayMs <= 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, delayMs);

      const onAbort = () => {
        clearTimeout(timeout);
        reject(signal?.reason ?? new Error('请求在等待重试时被取消'));
      };

      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeout);
          reject(signal.reason ?? new Error('请求在等待重试前被取消'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * 合并调用方传入的 AbortSignal 与 HttpClient 自身的超时控制。
   */
  private mergeAbortSignals(
    requestId: string,
    signal?: AbortSignal,
    requestTimeoutMs?: number,
  ): AbortResources | undefined {
    const timeoutMs = requestTimeoutMs ?? this.timeoutMs;
    if (!signal && !timeoutMs) {
      return undefined;
    }

    const controller = new AbortController();
    let timeoutHandle: NodeJS.Timeout | null = null;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }
    };

    const abortListener = () => {
      controller.abort(signal?.reason ?? new Error('请求被外部中断'));
      this.logger.warn('HTTP 请求被外部取消', { requestId });
      cleanup();
    };

    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        return { signal: controller.signal, cleanup };
      }
      signal.addEventListener('abort', abortListener, { once: true });
    }

    if (timeoutMs) {
      timeoutHandle = setTimeout(() => {
        controller.abort(new Error(`请求超时（${timeoutMs}ms）`));
        this.logger.warn('HTTP 请求超时并被自动中断', { requestId, timeoutMs });
        cleanup();
      }, timeoutMs);
    }

    controller.signal.addEventListener('abort', cleanup, { once: true });

    return { signal: controller.signal, cleanup };
  }

  /**
   * 触发重试事件回调，优先通知请求级别回调，再通知客户端级别回调。
   */
  private emitRetryEvent(
    requestLevelObserver: ((event: RetryEvent) => void) | undefined,
    event: RetryEvent,
  ): void {
    this.invokeRetryObserver(requestLevelObserver, event, 'request');
    if (this.retryObserver && this.retryObserver !== requestLevelObserver) {
      this.invokeRetryObserver(this.retryObserver, event, 'client');
    }
  }

  /**
   * 安全执行回调，避免回调内部异常导致主流程失败。
   */
  private invokeRetryObserver(
    observer: ((event: RetryEvent) => void) | undefined,
    event: RetryEvent,
    scope: 'request' | 'client',
  ): void {
    if (!observer) {
      return;
    }
    try {
      observer(event);
    } catch (error) {
      this.logger.error('HTTP 重试回调执行失败', {
        scope,
        requestId: event.requestId,
        method: event.method,
        url: event.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return undefined;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function buildErrorMessage(status: number, statusText: string, body: unknown): string {
  let detail: string | undefined;

  if (body && typeof body === 'object') {
    const maybeErrors = (body as { errors?: Array<{ detail?: string }> }).errors;
    if (Array.isArray(maybeErrors)) {
      detail = maybeErrors.find((item) => typeof item?.detail === 'string')?.detail;
    }

    if (!detail && typeof (body as { message?: string }).message === 'string') {
      detail = (body as { message: string }).message;
    }
  }

  if (!detail && typeof body === 'string') {
    detail = body;
  }

  const base = `Schwab API request failed: ${status} ${statusText}`;
  return detail ? `${base} - ${detail}` : base;
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function mergeHeaders(
  defaults: Record<string, string>,
  overrides?: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = { ...defaults };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    setHeader(result, name, value);
  }
  return result;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const normalized = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalized) delete headers[key];
  }
  headers[name] = value;
}

function isReadableStream(value: unknown): value is ReadableStream {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== 'undefined' && value instanceof FormData;
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function cloneFormData(original: FormData): FormData {
  const cloned = new FormData();
  original.forEach((value, key) => {
    if (typeof value === 'string') {
      cloned.append(key, value);
    } else {
      const maybeFile = value as File | Blob;
      if (typeof (maybeFile as File).name === 'string') {
        cloned.append(key, maybeFile, (maybeFile as File).name);
      } else {
        cloned.append(key, maybeFile);
      }
    }
  });
  return cloned;
}

function cloneBlob(original: Blob): Blob {
  if (typeof original.slice === 'function') {
    return original.slice(0, original.size, original.type);
  }
  return new Blob([original], { type: original.type });
}

function cloneArrayBufferView(value: ArrayBufferView): ArrayBufferView {
  const copy = new Uint8Array(value.byteLength);
  copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return Buffer.from(copy);
  }
  if (value instanceof DataView) {
    return new DataView(copy.buffer);
  }
  const ctor = (value as any)?.constructor;
  if (typeof ctor === 'function' && 'BYTES_PER_ELEMENT' in ctor) {
    try {
      return new ctor(copy.buffer);
    } catch {
      // 忽略构造失败，降级为 Uint8Array
    }
  }
  return copy;
}

function isBodyInit(value: unknown): value is BodyInit {
  if (value === null) return false;
  if (typeof value === 'string') return true;
  if (isReadableStream(value)) return true;
  if (isBlob(value)) return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (isFormData(value)) return true;
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return true;
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  return false;
}
