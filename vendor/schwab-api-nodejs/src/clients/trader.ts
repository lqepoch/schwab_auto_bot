import { HttpClient } from '../utils/httpClient.js';
import { TokenManager } from '../auth/tokenManager.js';
import { AuthorizedApiClient } from '../utils/apiClientBase.js';
import { Logger, createConsoleLogger } from '../utils/logger.js';
import { SchwabApiError, UnknownOutcomeError, type MutationOperation } from '../utils/errors.js';
import { StreamerInfoSchema } from '../validation/traderSchemas.js';
import {
  AccountNumberHash,
  AccountResponse,
  CancelOrderRequest,
  Order,
  OrderPreviewRequest,
  PlaceOrderRequest,
  ReplaceOrderRequest,
  StreamerInfo,
  Transaction,
  TransactionsQuery,
  UserPreference,
  PreviewOrderResponse,
  MutationResult,
} from '../types/trader.js';
import type { RequestOptions } from '../utils/httpClient.js';

/**
 * Mutation requests may only override the physical request timeout. Automatic
 * retries are intentionally not configurable because Schwab does not expose a
 * documented idempotency contract for order mutations.
 */
export interface MutationRequestOptions {
  timeoutMs?: number;
}

export interface PlaceOrderOptions extends MutationRequestOptions {}

export interface AccountsQuery {
  fields?: 'positions';
}

export interface OrdersQuery extends Record<string, string | number | boolean | undefined> {
  maxResults?: number;
  fromEnteredTime: string;
  toEnteredTime: string;
  status?: string;
}

export interface TransactionsParams extends TransactionsQuery, Record<string, string | number | boolean | undefined> {}

/**
 * Schwab Trader REST API 封装，覆盖文档列出的账户、订单、交易记录、偏好设置等全部端点。
 */
export class TraderApiClient extends AuthorizedApiClient {
  constructor(http: HttpClient, tokens: TokenManager, logger?: Logger) {
    super(http, tokens, logger ?? createConsoleLogger({ scope: 'TraderApiClient' }));
  }

  /**
   * `GET /accounts/accountNumbers`：获取账号明文与加密值映射。
   * 无需传参，返回数组中包含 `accountNumber` 与 `hashValue` 字段。
   */
  async getAccountNumbers(): Promise<AccountNumberHash[]> {
    // 记录方法调用，便于追踪日志
    this.logger.info('调用 getAccountNumbers');
    return this.request<AccountNumberHash[]>('/accounts/accountNumbers');
  }

  /**
   * `GET /accounts`：查询关联账户余额与持仓。
   * @param params.fields 传入 `'positions'` 展开持仓，否则仅返回概要信息。
   */
  async getAccounts(params: AccountsQuery = {}): Promise<AccountResponse[]> {
    this.logger.info('调用 getAccounts', { params });
    // 构建查询字符串，确保只携带有效参数
    const query = this.buildQuery({ fields: params.fields });
    return this.request<AccountResponse[]>('/accounts', { query });
  }

  /**
   * `GET /accounts/{accountNumber}`：查询单个账户详情。
   * @param accountNumber 使用 `getAccountNumbers` 返回的 `hashValue`。
   * @param params.fields 传入 `'positions'` 展开持仓列表。
   */
  async getAccount(accountNumber: string, params: AccountsQuery = {}): Promise<AccountResponse> {
    this.logger.info('调用 getAccount', { accountNumber, params });
    // 构建查询参数并发起请求
    const query = this.buildQuery({ fields: params.fields });
    return this.request<AccountResponse>(`/accounts/${accountNumber}`, { query });
  }

  /**
   * `GET /accounts/{accountNumber}/orders`：获取指定账户的一段时间内的订单列表。
   * @param accountNumber `hashValue` 格式的账号。
   * @param params `fromEnteredTime`/`toEnteredTime` 使用 ISO8601 或 Schwab 要求的时间格式。
   */
  async getOrders(accountNumber: string, params: OrdersQuery): Promise<Order[]> {
    this.logger.info('调用 getOrders', { accountNumber, params });
    // 打包查询条件后发送请求
    return this.request<Order[]>(`/accounts/${accountNumber}/orders`, {
      query: this.buildQuery(params),
    });
  }

  /**
   * `POST /accounts/{accountNumber}/orders`：提交新订单。
   * @param order 按官方 JSON 结构填写下单信息。
   * @param options 仅支持覆盖单次物理请求的超时时间；写入结果必须由调用方对账。
   */
  async placeOrder(
    accountNumber: string,
    order: PlaceOrderRequest,
    options: PlaceOrderOptions = {},
  ): Promise<MutationResult> {
    this.logger.info('调用 placeOrder', { accountNumber });
    return this.requestMutation('PLACE_ORDER', `/accounts/${accountNumber}/orders`,
      {
        method: 'POST',
        body: order,
      },
      options,
    );
  }

  /**
   * `GET /accounts/{accountNumber}/orders/{orderId}`：查询订单详情。
   * @param orderId 可以是数字或字符串形式的订单标识。
   */
  async getOrder(accountNumber: string, orderId: number | string): Promise<Order> {
    this.logger.info('调用 getOrder', { accountNumber, orderId });
    return this.request<Order>(`/accounts/${accountNumber}/orders/${orderId}`);
  }

  /**
   * `PUT /accounts/{accountNumber}/orders/{orderId}`：替换已存在订单。
   * @param order 需提供完整订单结构，Schwab 会覆盖原订单。
   * @param options 仅支持覆盖单次物理请求的超时时间。
   */
  async replaceOrder(
    accountNumber: string,
    orderId: number | string,
    order: ReplaceOrderRequest,
    options: MutationRequestOptions = {},
  ): Promise<MutationResult> {
    this.logger.info('调用 replaceOrder', { accountNumber, orderId });
    return this.requestMutation('REPLACE_ORDER', `/accounts/${accountNumber}/orders/${orderId}`,
      {
        method: 'PUT',
        body: order,
      },
      options,
    );
  }

  /**
   * `DELETE /accounts/{accountNumber}/orders/{orderId}`：取消订单。
   * @param requestBody 可选，提供原订单信息以满足额外验证。
   * @param options 仅支持覆盖单次物理请求的超时时间。
   */
  async cancelOrder(
    accountNumber: string,
    orderId: number | string,
    requestBody?: CancelOrderRequest,
    options: MutationRequestOptions = {},
  ): Promise<MutationResult> {
    this.logger.info('调用 cancelOrder', { accountNumber, orderId });
    return this.requestMutation('CANCEL_ORDER', `/accounts/${accountNumber}/orders/${orderId}`,
      {
        method: 'DELETE',
        body: requestBody,
      },
      options,
    );
  }

  /**
   * `GET /orders`：跨账户批量检索订单。
   * @param params 需提供起止时间，其他筛选字段见官方文档。
   */
  async getOrdersAcrossAccounts(params: OrdersQuery): Promise<Order[]> {
    this.logger.info('调用 getOrdersAcrossAccounts', { params });
    return this.request<Order[]>('/orders', { query: this.buildQuery(params) });
  }

  /**
   * `POST /accounts/{accountNumber}/previewOrder`：下单前预估资金占用。
   * @param order 与正式下单结构一致，会返回试算结果。
   * @param options 仅支持覆盖单次物理请求的超时时间。
   */
  async previewOrder(
    accountNumber: string,
    order: OrderPreviewRequest,
    options: MutationRequestOptions = {},
  ): Promise<PreviewOrderResponse> {
    this.logger.info('调用 previewOrder', { accountNumber });
    const requestOptions = this.applyMutationOverrides<PreviewOrderResponse>(
      {
        method: 'POST',
        body: order,
      },
      options,
    );
    return this.request<PreviewOrderResponse>(`/accounts/${accountNumber}/previewOrder`, requestOptions);
  }

  /**
   * `GET /accounts/{accountNumber}/transactions`：查询账户交易记录。
   * @param params 可传递 `type`、`symbol`、时间范围等过滤条件。
   */
  async getTransactions(accountNumber: string, params: TransactionsParams): Promise<Transaction[]> {
    this.logger.info('调用 getTransactions', { accountNumber, params });
    return this.request<Transaction[]>(`/accounts/${accountNumber}/transactions`, {
      query: this.buildQuery(params),
    });
  }

  /**
   * `GET /accounts/{accountNumber}/transactions/{transactionId}`：读取单笔交易明细。
   * @param transactionId 使用 `getTransactions` 返回的 `transactionId`。
   */
  async getTransaction(accountNumber: string, transactionId: number | string): Promise<Transaction> {
    this.logger.info('调用 getTransaction', { accountNumber, transactionId });
    const data = await this.request<Transaction | Transaction[]>(
      `/accounts/${accountNumber}/transactions/${transactionId}`,
    );
    // 某些情况返回数组，仅取第一条数据
    if (Array.isArray(data)) {
      if (data.length === 0) {
        this.logger.error('getTransaction 返回空数组', { accountNumber, transactionId });
        throw new Error('Transaction not found in response array');
      }
      return data[0];
    }
    return data;
  }

  /**
   * `GET /userPreference`：拉取用户偏好设定。
   * 包含 Streamer 登录参数与可见账号列表。
   */
  async getUserPreferences(): Promise<UserPreference[] | UserPreference> {
    this.logger.info('调用 getUserPreferences');
    return this.request<UserPreference[] | UserPreference>('/userPreference');
  }

  /**
   * 从用户偏好中提取第一个 StreamerInfo，用于建立 WebSocket 登录。
   */
  async getStreamerInfo(): Promise<StreamerInfo> {
    this.logger.info('调用 getStreamerInfo');
    const prefs = await this.getUserPreferences();
    
    // 处理两种可能的响应格式：数组或单个对象
    let streamerInfoArray: StreamerInfo[] | undefined;
    if (Array.isArray(prefs)) {
      // 如果返回的是数组，取第一个元素的 streamerInfo
      streamerInfoArray = prefs[0]?.streamerInfo;
    } else {
      // 如果返回的是单个对象，直接取 streamerInfo
      streamerInfoArray = (prefs as UserPreference)?.streamerInfo;
    }
    
    const info = streamerInfoArray?.[0];
    if (!info) {
      this.logger.error('用户偏好中未包含 StreamerInfo', { 
        prefsType: Array.isArray(prefs) ? 'array' : 'object',
        hasStreamerInfo: Boolean(streamerInfoArray),
        streamerInfoLength: streamerInfoArray?.length || 0
      });
      throw new Error('Streamer info unavailable in user preferences');
    }
    try {
      return StreamerInfoSchema.parse(info);
    } catch (error) {
      this.logger.error('StreamerInfo 验证失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private applyMutationOverrides<T>(
    base: RequestOptions<T>,
    overrides: MutationRequestOptions,
  ): RequestOptions<T> {
    const requestOptions: RequestOptions<T> = {
      ...base,
      // A mutation is always one physical broker attempt. An ambiguous result
      // is surfaced to reconciliation instead of being sent again.
      maxRetries: 0,
      retryConfig: { maxRetries: 0 },
    };
    if (overrides.timeoutMs !== undefined) {
      requestOptions.timeoutMs = overrides.timeoutMs;
    }
    return requestOptions;
  }

  private async requestMutation(
    operation: MutationOperation,
    path: string,
    base: RequestOptions<undefined>,
    options: MutationRequestOptions,
  ): Promise<MutationResult> {
    const requestOptions = this.applyMutationOverrides(base, options);
    try {
      const response = await this.requestWithResponse<undefined>(path, requestOptions);
      const location = response.headers.get('location')?.trim() || null;
      const orderId = parseOrderIdFromLocation(location);
      const correlationId = response.headers.get('Schwab-Client-CorrelID')?.trim() || null;
      if (operation !== 'CANCEL_ORDER' && (!location || !orderId)) {
        throw new UnknownOutcomeError(
          'Schwab accepted the order mutation without a valid Location header',
          {
            operation,
            method: requestOptions.method ?? 'GET',
            path,
            status: response.status,
            correlationId: correlationId ?? undefined,
            location: location ?? undefined,
          },
        );
      }
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        location,
        orderId,
        correlationId,
      };
    } catch (error) {
      if (error instanceof UnknownOutcomeError) throw error;
      if (error instanceof SchwabApiError && (error.isNetworkError || error.status >= 500 || error.status === 0)) {
        throw new UnknownOutcomeError(
          'The broker mutation outcome is unknown; reconcile orders before retrying',
          {
            operation,
            method: base.method ?? 'GET',
            path,
            status: error.status || undefined,
            requestId: error.requestId,
            correlationId: correlationIdFromHeaders(error.headers),
            location: headerFromHeaders(error.headers, 'location'),
            cause: error,
          },
        );
      }
      // 4xx responses, including 401, are explicit rejections and are never
      // hidden by a transparent retry or converted to UnknownOutcome.
      throw error;
    }
  }
}

function correlationIdFromHeaders(headers: Record<string, string>): string | undefined {
  return headerFromHeaders(headers, 'schwab-client-correlid');
}

function headerFromHeaders(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((headerName) => headerName.toLowerCase() === name);
  return key ? headers[key]?.trim() || undefined : undefined;
}

function parseOrderIdFromLocation(location: string | null): string | null {
  if (!location) return null;
  try {
    const url = new URL(location, 'https://api.schwabapi.com');
    const segments = url.pathname.split('/').filter(Boolean);
    const id = segments.at(-1);
    const parent = segments.at(-2)?.toLowerCase();
    return id && parent === 'orders' && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
