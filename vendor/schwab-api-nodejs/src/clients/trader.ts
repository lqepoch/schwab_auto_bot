import { HttpClient } from '../utils/httpClient.js';
import { TokenManager } from '../auth/tokenManager.js';
import { AuthorizedApiClient } from '../utils/apiClientBase.js';
import { Logger, createConsoleLogger } from '../utils/logger.js';
import { SchwabApiError, UnknownOutcomeError, type MutationOperation } from '../utils/errors.js';
import {
  AccountNumberHashesSchema,
  AccountResponseSchema,
  AccountsResponseSchema,
  OrderSchema,
  OrdersResponseSchema,
  PreviewOrderResponseSchema,
  StreamerInfoSchema,
  TransactionOrArraySchema,
  TransactionsResponseSchema,
  UserPreferencesResponseSchema,
} from '../validation/traderSchemas.js';
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
 * Schwab Trader REST API 封装，覆盖账户、订单、交易记录、偏好设置等端点。
 *
 * 只读与 Preview 响应在离开 SDK 前进行 runtime schema validation；schema 使用
 * passthrough 策略保留 Schwab 后续追加字段，同时阻止错误 envelope 进入业务逻辑。
 */
export class TraderApiClient extends AuthorizedApiClient {
  constructor(http: HttpClient, tokens: TokenManager, logger?: Logger) {
    super(http, tokens, logger ?? createConsoleLogger({ scope: 'TraderApiClient' }));
  }

  /** `GET /accounts/accountNumbers`：获取账号明文与 hashValue 映射。 */
  async getAccountNumbers(): Promise<AccountNumberHash[]> {
    this.logger.info('调用 getAccountNumbers');
    return this.request<AccountNumberHash[]>('/accounts/accountNumbers', {
      schema: AccountNumberHashesSchema,
    });
  }

  /** `GET /accounts`：查询关联账户余额与持仓。 */
  async getAccounts(params: AccountsQuery = {}): Promise<AccountResponse[]> {
    this.logger.info('调用 getAccounts', { params });
    const query = this.buildQuery({ fields: params.fields });
    return this.request<AccountResponse[]>('/accounts', {
      query,
      schema: AccountsResponseSchema,
    });
  }

  /** `GET /accounts/{accountNumber}`：查询单个账户详情。 */
  async getAccount(accountNumber: string, params: AccountsQuery = {}): Promise<AccountResponse> {
    this.logger.info('调用 getAccount', { accountNumber, params });
    const query = this.buildQuery({ fields: params.fields });
    return this.request<AccountResponse>(`/accounts/${accountNumber}`, {
      query,
      schema: AccountResponseSchema,
    });
  }

  /** `GET /accounts/{accountNumber}/orders`：获取指定账户的一段时间内订单列表。 */
  async getOrders(accountNumber: string, params: OrdersQuery): Promise<Order[]> {
    this.logger.info('调用 getOrders', { accountNumber, params });
    return this.request<Order[]>(`/accounts/${accountNumber}/orders`, {
      query: this.buildQuery(params),
      schema: OrdersResponseSchema,
    });
  }

  /**
   * `POST /accounts/{accountNumber}/orders`：提交新订单。
   * 写入仍严格保持单次物理尝试；模糊结果交由调用方对账。
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

  /** `GET /accounts/{accountNumber}/orders/{orderId}`：查询订单详情。 */
  async getOrder(accountNumber: string, orderId: number | string): Promise<Order> {
    this.logger.info('调用 getOrder', { accountNumber, orderId });
    return this.request<Order>(`/accounts/${accountNumber}/orders/${orderId}`, {
      schema: OrderSchema,
    });
  }

  /** `PUT /accounts/{accountNumber}/orders/{orderId}`：替换已存在订单。 */
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

  /** `DELETE /accounts/{accountNumber}/orders/{orderId}`：取消订单。 */
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

  /** `GET /orders`：跨账户批量检索订单。 */
  async getOrdersAcrossAccounts(params: OrdersQuery): Promise<Order[]> {
    this.logger.info('调用 getOrdersAcrossAccounts', { params });
    return this.request<Order[]>('/orders', {
      query: this.buildQuery(params),
      schema: OrdersResponseSchema,
    });
  }

  /** `POST /accounts/{accountNumber}/previewOrder`：下单前预估资金占用与校验。 */
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
        schema: PreviewOrderResponseSchema,
      },
      options,
    );
    return this.request<PreviewOrderResponse>(`/accounts/${accountNumber}/previewOrder`, requestOptions);
  }

  /** `GET /accounts/{accountNumber}/transactions`：查询账户交易记录。 */
  async getTransactions(accountNumber: string, params: TransactionsParams): Promise<Transaction[]> {
    this.logger.info('调用 getTransactions', { accountNumber, params });
    return this.request<Transaction[]>(`/accounts/${accountNumber}/transactions`, {
      query: this.buildQuery(params),
      schema: TransactionsResponseSchema,
    });
  }

  /** `GET /accounts/{accountNumber}/transactions/{transactionId}`：读取单笔交易明细。 */
  async getTransaction(accountNumber: string, transactionId: number | string): Promise<Transaction> {
    this.logger.info('调用 getTransaction', { accountNumber, transactionId });
    const data = await this.request<Transaction | Transaction[]>(
      `/accounts/${accountNumber}/transactions/${transactionId}`,
      { schema: TransactionOrArraySchema },
    );
    if (Array.isArray(data)) {
      if (data.length === 0) {
        this.logger.error('getTransaction 返回空数组', { accountNumber, transactionId });
        throw new Error('Transaction not found in response array');
      }
      return data[0];
    }
    return data;
  }

  /** `GET /userPreference`：拉取用户偏好设定与 Streamer 登录参数。 */
  async getUserPreferences(): Promise<UserPreference[] | UserPreference> {
    this.logger.info('调用 getUserPreferences');
    return this.request<UserPreference[] | UserPreference>('/userPreference', {
      schema: UserPreferencesResponseSchema,
    });
  }

  /** 从用户偏好中提取第一个 StreamerInfo。 */
  async getStreamerInfo(): Promise<StreamerInfo> {
    this.logger.info('调用 getStreamerInfo');
    const prefs = await this.getUserPreferences();

    let streamerInfoArray: StreamerInfo[] | undefined;
    if (Array.isArray(prefs)) {
      streamerInfoArray = prefs[0]?.streamerInfo;
    } else {
      streamerInfoArray = (prefs as UserPreference)?.streamerInfo;
    }

    const info = streamerInfoArray?.[0];
    if (!info) {
      this.logger.error('用户偏好中未包含 StreamerInfo', {
        prefsType: Array.isArray(prefs) ? 'array' : 'object',
        hasStreamerInfo: Boolean(streamerInfoArray),
        streamerInfoLength: streamerInfoArray?.length || 0,
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
