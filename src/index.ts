import { TokenManager, TokenManagerOptions } from './auth/tokenManager.ts';
import { TokenStore, type TokenStoreAdapter } from './auth/tokenStore.ts';
import { HttpClient } from './utils/httpClient.ts';
import { TraderApiClient, AccountsQuery, OrdersQuery, TransactionsParams } from './clients/trader.ts';
import { MarketDataApiClient } from './clients/marketData.ts';
import { SchwabGateway } from './gateway/schwabGateway.ts';
import { StreamerClient, StreamerClientOptions } from './streamer/streamerClient.ts';
import { MarketDataStreamClient } from './streamer/marketDataClient.ts';
import { SchwabAuthConfig } from './types/auth.ts';
import { Logger, LogLevel, createConsoleLogger } from './utils/logger.ts';
import { config as loadEnvConfig } from 'dotenv';
import open from 'open';
import {
  AccountNumberHash,
  AccountResponse,
  Order,
  OrderPreviewRequest,
  PreviewOrderResponse,
  PlaceOrderRequest,
  ReplaceOrderRequest,
  Transaction,
  UserPreference,
  StreamerInfo,
} from './types/trader.ts';
import {
  QuotesResponse,
  QuoteItem,
  SingleQuoteResponse,
  OptionChainResponse,
  OptionExpirationChainResponse,
  PriceHistoryResponse,
  MoversResponse,
  MarketHoursResponse,
  InstrumentsSearchResponse,
} from './types/marketData.ts';

/**
 * SDK 初始化配置。`clientId`、`clientSecret`、`redirectUri` 必须与在 Schwab 开发者门户登记的应用保持一致。
 * `tokenStorePath` 未指定时默认写在当前工作目录的 `.schwab_tokens.json`。
 */
export interface SchwabOwokitConfig extends SchwabAuthConfig {
  /** 自定义交易 REST API 基础地址，默认 https://api.schwabapi.com/trader/v1 */
  traderBaseUrl?: string;
  /** 自定义市场数据 REST API 基础地址，默认 https://api.schwabapi.com/marketdata/v1 */
  marketDataBaseUrl?: string;
}

/**
 * 附加可选项，可用于配置 Streamer 自动重连、日志输出等。
 */
export interface SchwabOwokitOptions {
  /** Streamer 客户端相关的可选参数 */
  streamer?: StreamerClientOptions;
  /** 自定义日志记录器，未提供时使用带时间戳的 ConsoleLogger。 */
  logger?: Logger;
  /** 快速调整默认日志级别，默认输出 `info` 级别。 */
  logLevel?: LogLevel;
  /** 为 HTTP 请求设置统一超时时间（毫秒），默认 15000ms。 */
  httpTimeoutMs?: number;
  /** TokenManager 的额外参数，例如调整安全刷新窗口。 */
  tokenManager?: Omit<TokenManagerOptions, 'logger'>;
  /**
   * 可选的安全令牌存储适配器；省略时继续使用 owner-only 文件 TokenStore。
   * 适配器必须在无法安全读取时返回 null 或抛错，不能返回部分令牌。
   */
  tokenStore?: TokenStoreAdapter;
}

/**
 * 从环境变量自动创建 SDK 的辅助选项。
 */
export interface SchwabEnvironmentOptions extends SchwabOwokitOptions {
  /** 指定 .env 文件路径，默认使用项目根目录下的 `.env`。 */
  envPath?: string;
  /** 是否自动加载 .env 文件，默认 true。 */
  loadEnvFile?: boolean;
  /** 是否忽略缺失的必填环境变量，默认 false。 */
  optional?: boolean;
}

/**
 * SDK 主入口，聚合了 OAuth Token 管理、账户交易 REST Client 以及市场数据流客户端。
 * 典型用法：
 * ```ts
 * const sdk = new SchwabOwokit({ clientId, clientSecret, redirectUri });
 * const quotes = await sdk.marketData.getQuotes({ symbols: ['AAPL', 'QQQ'] });
 * await sdk.connectStreamer();
 * sdk.marketDataStream.subscribeLevelOneEquities({ keys: 'QQQ' });
 * ```
 */
export class SchwabOwokit {
  readonly tokenManager: TokenManager;
  readonly trader: TraderApiClient;
  readonly streamer: StreamerClient;
  readonly marketDataStream: MarketDataStreamClient;
  readonly marketData: MarketDataApiClient;
  /** Read-only account/order/market-data boundary with response metadata. */
  readonly gateway: SchwabGateway;
  private readonly logger: Logger;

  constructor(config: SchwabOwokitConfig, options: SchwabOwokitOptions = {}) {
    if (!config.clientId || !config.clientSecret || !config.redirectUri) {
      throw new Error('Missing Schwab OAuth configuration');
    }

    const baseLogger =
      options.logger ?? createConsoleLogger({ scope: 'SchwabOwokit', level: options.logLevel ?? 'info' });
    this.logger = baseLogger.child('core');
    this.logger.info('开始初始化 SchwabOwokit 实例', {
      traderBaseUrl: config.traderBaseUrl,
      marketDataBaseUrl: config.marketDataBaseUrl,
    });

    this.tokenManager = this.createTokenManager(config, options, baseLogger);

    const { traderClient, marketDataClient } = this.initializeApiClients(
      config,
      options,
      baseLogger,
      this.tokenManager,
    );
    this.trader = traderClient;
    this.marketData = marketDataClient;
    this.gateway = new SchwabGateway(this.trader, this.marketData);

    const { streamer, marketDataStream } = this.initializeStreamer(
      options,
      baseLogger,
      this.trader,
      this.tokenManager,
    );
    this.streamer = streamer;
    this.marketDataStream = marketDataStream;

    this.logger.info('SchwabOwokit 初始化完成');
  }

  /**
   * 根据环境变量快速创建 SDK 实例。
   */
  static fromEnvironment(options: SchwabEnvironmentOptions = {}): SchwabOwokit {
    const { envPath, loadEnvFile = true, optional = false, ...rest } = options;
    const sdkOptions: SchwabOwokitOptions = rest;
    const logger = sdkOptions.logger ?? createConsoleLogger({ scope: 'SchwabOwokit', level: sdkOptions.logLevel ?? 'info' });

    if (loadEnvFile) {
      const envFilePath = envPath ?? '.env';
      const result = loadEnvConfig({ path: envFilePath, quiet: true });
      if (result.error) {
        logger.warn('加载 .env 文件失败，将继续读取现有环境变量', {
          path: envFilePath,
          error: result.error.message,
        });
      } else {
        logger.info('已从 .env 文件加载环境变量', { path: envFilePath });
      }
    }

    const clientId = process.env.SCHWAB_CLIENT_ID?.trim();
    const clientSecret = process.env.SCHWAB_CLIENT_SECRET?.trim();
    const redirectUri = process.env.SCHWAB_REDIRECT_URI?.trim();
    const tokenStorePath = process.env.SCHWAB_TOKEN_PATH?.trim();

    const missing: string[] = [];
    if (!clientId) missing.push('SCHWAB_CLIENT_ID');
    if (!clientSecret) missing.push('SCHWAB_CLIENT_SECRET');
    if (!redirectUri) missing.push('SCHWAB_REDIRECT_URI');

    if (missing.length && !optional) {
      throw new Error(`环境变量缺失：${missing.join(', ')}。请在 .env 或进程环境中配置后再试。`);
    }

    const config: SchwabOwokitConfig = {
      clientId: clientId ?? '',
      clientSecret: clientSecret ?? '',
      redirectUri: redirectUri ?? '',
      tokenStorePath: tokenStorePath && tokenStorePath.length > 0 ? tokenStorePath : undefined,
    };

    return new SchwabOwokit(config, { ...sdkOptions, logger });
  }

  private createTokenManager(
    config: SchwabOwokitConfig,
    options: SchwabOwokitOptions,
    baseLogger: Logger,
  ): TokenManager {
    const tokenStore = options.tokenStore ?? new TokenStore({
      filePath: config.tokenStorePath,
      logger: baseLogger.child('tokenStore'),
    });
    const tokenManagerOptions: TokenManagerOptions = {
      ...(options.tokenManager ?? {}),
      logger: baseLogger.child('tokenManager'),
    };
    return new TokenManager(config, tokenStore, tokenManagerOptions);
  }

  private initializeApiClients(
    config: SchwabOwokitConfig,
    options: SchwabOwokitOptions,
    baseLogger: Logger,
    tokenManager: TokenManager,
  ): { traderClient: TraderApiClient; marketDataClient: MarketDataApiClient } {
    const httpLogger = baseLogger.child('http');
    const timeoutMs = options.httpTimeoutMs ?? 15_000;

    const traderBase = config.traderBaseUrl ?? 'https://api.schwabapi.com/trader/v1';
    const traderHttp = new HttpClient({
      baseUrl: traderBase,
      logger: httpLogger,
      logScope: 'trader',
      timeoutMs,
    });
    const traderClient = new TraderApiClient(traderHttp, tokenManager, baseLogger.child('traderClient'));

    const marketDataBase = config.marketDataBaseUrl ?? 'https://api.schwabapi.com/marketdata/v1';
    const marketDataHttp = new HttpClient({
      baseUrl: marketDataBase,
      logger: httpLogger,
      logScope: 'marketData',
      timeoutMs,
    });
    const marketDataClient = new MarketDataApiClient(
      marketDataHttp,
      tokenManager,
      baseLogger.child('marketDataClient'),
    );

    return { traderClient, marketDataClient };
  }

  private initializeStreamer(
    options: SchwabOwokitOptions,
    baseLogger: Logger,
    traderClient: TraderApiClient,
    tokenManager: TokenManager,
  ): { streamer: StreamerClient; marketDataStream: MarketDataStreamClient } {
    const streamer = new StreamerClient({
      ...(options.streamer ?? {}),
      logger: baseLogger.child('streamer'),
    });
    const marketDataStream = new MarketDataStreamClient(
      streamer,
      traderClient,
      tokenManager,
      baseLogger.child('marketDataStream'),
    );
    return { streamer, marketDataStream };
  }

  /**
   * 获取当前缓存的访问令牌。若本地 token 已过期会自动刷新。
   */
  async getAccessToken(): Promise<string> {
    this.logger.info('开始获取访问令牌');
    const token = await this.tokenManager.requireAccessToken();
    const preview = token.access_token.length > 10 ? `${token.access_token.slice(0, 6)}...${token.access_token.slice(-4)}` : token.access_token;
    this.logger.info('访问令牌获取成功', { preview });
    return token.access_token;
  }

  /**
   * 建立市场数据 Streamer 连接，内部会自动登录并保持可重复调用（幂等）。
   */
  async connectStreamer(): Promise<void> {
    this.logger.info('准备建立市场数据 Streamer 连接');
    await this.marketDataStream.connect();
    this.logger.info('市场数据 Streamer 已连接');
  }

  /**
   * 主动断开市场数据 Streamer 连接。
   */
  disconnectStreamer(): void {
    this.logger.info('准备断开市场数据 Streamer');
    this.marketDataStream.disconnect();
    this.logger.info('市场数据 Streamer 已断开');
  }

  /**
   * 生成 OAuth 授权链接，引导用户在浏览器完成授权并回调 code。
   * - `state` 建议传入调用方生成的随机字符串，用于防止 CSRF。
   * - `scope` 可根据官方文档传入精细的权限定义，默认留空表示基础权限。
   */
  createAuthorizeUrl(params?: { state?: string; scope?: string }): string {
    this.logger.info('生成授权链接', { params });
    return this.tokenManager.createAuthorizeUrl(params);
  }

  /**
   * 生成授权链接并尝试在默认浏览器中打开，以减少手动复制粘贴。
   * 建议在桌面环境中使用，服务器环境可能因缺少 GUI 而失败。
   * @param params.state 用于防范 CSRF 的随机字符串，可选。
   * @param params.scope 自定义授权范围，参考官方文档中的 scope 定义。
   * @returns 实际用于授权的 URL，便于调用方在必要时回显。
   */
  async openAuthorizeUrl(params?: { state?: string; scope?: string }): Promise<string> {
    this.logger.info('准备自动在浏览器中打开授权页面', { params });
    const url = this.createAuthorizeUrl(params);
    try {
      await open(url);
      this.logger.info('授权页面已尝试在默认浏览器中打开');
    } catch (error) {
      this.logger.error('打开默认浏览器失败，请手动复制授权链接', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return url;
  }

  /**
   * 使用一次性授权码换取访问令牌，成功后会写入本地 token 缓存文件。
   * `code` 参数应当填写浏览器回调 URL 中的 `?code=xxx` 值。
   */
  async exchangeCodeForToken(code: string) {
    this.logger.info('调用 exchangeCodeForToken', { hasCode: Boolean(code) });
    return this.tokenManager.exchangeCodeForToken(code);
  }

  /**
   * 主动刷新访问令牌。若本地尚未缓存 token 会抛出错误。
   */
  async refreshAccessToken() {
    this.logger.info('准备手动刷新访问令牌');
    const cached = await this.tokenManager.getValidToken();
    if (!cached) {
      this.logger.error('刷新失败：本地不存在缓存令牌');
      throw new Error('No cached token available for refresh');
    }
    const refreshed = await this.tokenManager.refreshAccessToken(cached.refresh_token);
    this.logger.info('刷新访问令牌成功');
    return refreshed;
  }
}

export type { AccountsQuery, OrdersQuery, TransactionsParams };
export type {
  AccountNumberHash,
  AccountResponse,
  Order,
  OrderPreviewRequest,
  PlaceOrderRequest,
  ReplaceOrderRequest,
  Transaction,
  UserPreference,
  StreamerInfo,
  PreviewOrderResponse,
};
export type {
  QuotesResponse,
  QuoteItem,
  SingleQuoteResponse,
  OptionChainResponse,
  OptionExpirationChainResponse,
  PriceHistoryResponse,
  MoversResponse,
  MarketHoursResponse,
  InstrumentsSearchResponse,
};
export { TokenManager, TokenStore, HttpClient, TraderApiClient, StreamerClient, MarketDataApiClient };
export { SchwabGateway };
export {
  REST_CONTRACT_MANIFEST,
  STREAMER_CONTRACT_MANIFEST,
  READ_ONLY_GATEWAY_METHODS,
  expectedFieldIds,
  manifestServiceNames,
  MANIFEST_SERVICE_COUNT,
} from './contracts/contractManifest.ts';
export type {
  RestClientName,
  RestContractManifestEntry,
  StreamerContractManifestEntry,
} from './contracts/contractManifest.ts';
export type { TokenStoreAdapter, TokenStoreOptions } from './auth/tokenStore.ts';
export type {
  ReadOnlyGatewayMetadata,
  ReadOnlyGatewayResponse,
  SchwabGatewayOptions,
} from './gateway/schwabGateway.ts';
export { MarketDataStreamClient };
export {
  LEVELONE_EQUITIES_SERVICE_FIELDS,
  LEVELONE_OPTIONS_FIELDS,
  LEVELONE_FUTURES_FIELDS,
  LEVELONE_FUTURES_OPTIONS_FIELDS,
  LEVELONE_FOREX_FIELDS,
  BOOK_FIELDS,
  CHART_EQUITY_SERVICE_FIELDS,
  CHART_FUTURES_FIELDS,
  SCREENER_FIELDS,
  ACCT_ACTIVITY_FIELDS,
  STREAMER_SERVICE_CONTRACTS,
  serializeStreamerServiceFields,
  decodeStreamerServicePayload,
  decodeStreamerServiceRow,
} from './types/streamerContracts.ts';
export type {
  StreamerFieldValueType,
  StreamerDeliveryMode,
  StreamerOrderingEvidence,
  StreamerService,
  ServiceFieldId,
  ServiceFieldSelection,
  StreamerServiceRow,
  TypedStreamerDataPayload,
} from './types/streamerContracts.ts';
export type {
  LevelOneOptionsSubscriptionOptions,
  LevelOneFuturesSubscriptionOptions,
  LevelOneFuturesOptionsSubscriptionOptions,
  LevelOneForexSubscriptionOptions,
  BookSubscriptionOptions,
  ChartSubscriptionOptions,
  ChartEquitySubscriptionOptions,
  ChartFuturesSubscriptionOptions,
  ScreenerSubscriptionOptions,
  ScreenerEquitySubscriptionOptions,
  ScreenerOptionSubscriptionOptions,
  AccountActivitySubscriptionOptions,
} from './streamer/marketDataClient.ts';
export {
  StreamerSnapshotCache,
  BoundedAsyncQueue,
  StreamerSnapshotConsumer,
} from './streamer/streamerSnapshot.ts';
export type {
  SnapshotFreshness,
  SnapshotDiscardReason,
  StreamerSnapshotCacheOptions,
  StreamerSnapshotEntry,
  StreamerSnapshotUpdate,
  SnapshotApplyResult,
  SnapshotPayloadResult,
  QueueOverflowPolicy,
  QueuePushResult,
  StreamerSnapshotConsumerOptions,
} from './streamer/streamerSnapshot.ts';
export type { TokenManagerOptions } from './auth/tokenManager.ts';
export type {
  HttpClientConfig,
  HttpResponse,
  HttpMethod,
  RequestOptions,
  RetryConfig,
  RetryEvent,
} from './utils/httpClient.ts';
export type { RateLimitMetadata, ResponseMetadata as HttpResponseMetadata } from './utils/responseMetadata.ts';
export type { StreamerClientOptions } from './streamer/streamerClient.ts';
export {
  StreamerCommandError,
  StreamerCommandTimeoutError,
  StreamerCommandNotSentError,
  StreamerConnectionError,
} from './streamer/streamerErrors.ts';
export {
  SchwabApiError,
  UnknownOutcomeError,
  ReauthRequiredError,
  UNKNOWN_OUTCOME_CODE,
  REAUTH_REQUIRED_CODE,
} from './utils/errors.ts';
export type { MutationRequestOptions, PlaceOrderOptions } from './clients/trader.ts';
export type { MutationResult, OrderMutationResult } from './types/trader.ts';

// 日志和调试工具
export { 
  createConsoleLogger, 
  createNullLogger, 
  ConsoleLogger, 
  DebugLogger,
  createDebugLogger,
  withDuration,
  logExecutionTime
} from './utils/logger.ts';
export type { Logger, LogLevel, ConsoleLoggerOptions } from './utils/logger.ts';

// 调试和分析工具
export {
  StreamDebugger,
  ConnectionMonitor,
  DataVisualizer,
  PerformanceMonitor,
  createDebugLogger as createStreamDebugLogger,
  parseLevelOneEquities,
  parseNasdaqBook,
  parseChartEquity,
  validateStreamData,
  getFieldDefinition,
  FIELD_MAPPINGS,
  LEVELONE_EQUITIES_FIELDS,
  NASDAQ_BOOK_FIELDS,
  CHART_EQUITY_FIELDS,
  BOOK_PRICE_LEVEL_FIELDS,
  MARKET_MAKER_FIELDS
} from './utils/debugUtils.ts';

// Streamer 专用调试工具
export {
  StreamerDebugger,
  createStreamerDebugger,
  createQuickDebugger
} from './utils/streamerDebugger.ts';
export type { StreamerDebugOptions } from './utils/streamerDebugger.ts';
