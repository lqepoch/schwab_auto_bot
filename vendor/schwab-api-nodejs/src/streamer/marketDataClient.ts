import { TokenManager } from '../auth/tokenManager.js';
import { TraderApiClient } from '../clients/trader.js';
import { StreamerClient } from './streamerClient.js';
import { StreamerInfo } from '../types/trader.js';
import { Logger, createConsoleLogger } from '../utils/logger.js';

type SubscriptionKeysInput = string | ReadonlyArray<string>;

export interface LevelOneSubscriptionOptions {
  /** 订阅的证券代码，使用 Schwab 标准符号，可以是逗号分隔的字符串或字符串数组 */
  keys: SubscriptionKeysInput;
  /** 请求字段列表，参考官方文档中的字段编号，默认拉取全部字段 */
  fields?: string;
}

export interface ChartSubscriptionOptions {
  /** 支持逗号分隔字符串或字符串数组形式的证券代码 */
  keys: SubscriptionKeysInput;
  /** 图表数据的频率，如 1、5、10（分钟）等 */
  frequency?: string;
  /** 数据窗口长度，例如 1、5、10（天） */
  period?: string;
}

export interface ScreenerSubscriptionOptions {
  /** 可选：指定筛选器类型，如 `TOP_GAINERS` 等，实际取值以官方文档为准 */
  keys?: SubscriptionKeysInput;
}

export interface AccountActivitySubscriptionOptions {
  keys?: SubscriptionKeysInput;
}

/**
 * 市场数据订阅客户端，封装了 Schwab Streamer API 中的各类服务订阅请求构造。
 * 在调用任何订阅方法前应确保已经执行 `connect()` 建立 WebSocket 登录。
 */
export class MarketDataStreamClient {
  private streamerInfo?: StreamerInfo;
  private readonly logger: Logger;

  constructor(
    private readonly streamer: StreamerClient,
    private readonly traderClient: TraderApiClient,
    private readonly tokenManager: TokenManager,
    logger?: Logger,
  ) {
    this.logger = logger ?? createConsoleLogger({ scope: 'MarketDataStreamClient' });
  }

  /**
   * 建立 Streamer 登录。会自动读取访问令牌与 StreamerInfo，成功后即可进行订阅。
   */
  async connect(): Promise<void> {
    this.logger.info('开始建立市场数据 Streamer 连接');
    const token = await this.tokenManager.requireAccessToken();
    if (!this.streamerInfo) {
      this.logger.info('首次连接，准备获取 StreamerInfo');
      this.streamerInfo = await this.traderClient.getStreamerInfo();
    }
    await this.streamer.connect(token.access_token, this.streamerInfo, async () => {
      const refreshed = await this.tokenManager.requireAccessToken();
      return refreshed.access_token;
    });
    try {
      await this.streamer.waitForReady({ timeoutMs: 15_000 });
    } catch (error) {
      this.logger.error('等待 Streamer 登录就绪超时或失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.logger.info('市场数据 Streamer 登录完成');
  }

  /**
   * 主动断开 Streamer 连接，可在需要时重新调用 `connect()` 进行登录。
   */
  disconnect(): void {
    this.logger.info('主动断开市场数据 Streamer');
    this.streamer.disconnect();
  }

  /**
   * 订阅 Level 1 股本（股票/ETF）行情。默认按 0-54 字段全量拉取，可通过 fields 定制。
   */
  async subscribeLevelOneEquities(options: LevelOneSubscriptionOptions): Promise<void> {
    this.logger.info('订阅 LevelOneEquities', { options });
    return this.subscribeLevelOne('LEVELONE_EQUITIES', options, 'LevelOneEquities');
  }

  /**
   * 订阅 Level 1 期权行情。
   */
  async subscribeLevelOneOptions(options: LevelOneSubscriptionOptions): Promise<void> {
    this.logger.info('订阅 LevelOneOptions', { options });
    return this.subscribeLevelOne('LEVELONE_OPTIONS', options, 'LevelOneOptions');
  }

  /**
   * 订阅 Level 1 期货行情。
   */
  async subscribeLevelOneFutures(options: LevelOneSubscriptionOptions): Promise<void> {
    this.logger.info('订阅 LevelOneFutures', { options });
    return this.subscribeLevelOne('LEVELONE_FUTURES', options, 'LevelOneFutures');
  }

  /**
   * 订阅 Level 1 期货期权行情。
   */
  async subscribeLevelOneFuturesOptions(options: LevelOneSubscriptionOptions): Promise<void> {
    this.logger.info('订阅 LevelOneFuturesOptions', { options });
    return this.subscribeLevelOne('LEVELONE_FUTURES_OPTIONS', options, 'LevelOneFuturesOptions');
  }

  /**
   * 订阅 Level 1 外汇行情。
   */
  async subscribeLevelOneForex(options: LevelOneSubscriptionOptions): Promise<void> {
    this.logger.info('订阅 LevelOneForex', { options });
    return this.subscribeLevelOne('LEVELONE_FOREX', options, 'LevelOneForex');
  }

  /**
   * 订阅 NYSE Level II 买卖盘。
   */
  async subscribeNyseBook(options: LevelOneSubscriptionOptions): Promise<void> {
    this.logger.info('订阅 NYSE_BOOK', { options });
    return this.subscribeLevelOne('NYSE_BOOK', options, 'NYSE_BOOK');
  }

  /**
   * 订阅 NASDAQ Level II 买卖盘。
   */
  async subscribeNasdaqBook(options: LevelOneSubscriptionOptions): Promise<void> {
    this.logger.info('订阅 NASDAQ_BOOK', { options });
    return this.subscribeLevelOne('NASDAQ_BOOK', options, 'NASDAQ_BOOK');
  }

  /**
   * 订阅期权 Level II 买卖盘。
   */
  async subscribeOptionsBook(options: LevelOneSubscriptionOptions): Promise<void> {
    this.logger.info('订阅 OPTIONS_BOOK', { options });
    return this.subscribeLevelOne('OPTIONS_BOOK', options, 'OPTIONS_BOOK');
  }

  /**
   * 订阅股票分时图（蜡烛图）数据。
   */
  async subscribeChartEquity(options: ChartSubscriptionOptions): Promise<void> {
    this.logger.info('订阅 CHART_EQUITY', { options });
    return this.subscribeChart('CHART_EQUITY', options, 'CHART_EQUITY');
  }

  /**
   * 订阅期货分时图（蜡烛图）数据。
   */
  async subscribeChartFutures(options: ChartSubscriptionOptions): Promise<void> {
    this.logger.info('订阅 CHART_FUTURES', { options });
    return this.subscribeChart('CHART_FUTURES', options, 'CHART_FUTURES');
  }

  /**
   * 订阅股票筛选器（涨跌幅榜等）数据。
   */
  async subscribeScreenerEquity(options: ScreenerSubscriptionOptions = {}): Promise<void> {
    this.logger.info('订阅 SCREENER_EQUITY', { options });
    this.assertConnected();
    return this.streamer.subscribe({
      service: 'SCREENER_EQUITY',
      parameters: {
        keys: this.sanitizeKeys(options.keys),
      },
    });
  }

  /**
   * 订阅期权筛选器数据。
   */
  async subscribeScreenerOption(options: ScreenerSubscriptionOptions = {}): Promise<void> {
    this.logger.info('订阅 SCREENER_OPTION', { options });
    this.assertConnected();
    return this.streamer.subscribe({
      service: 'SCREENER_OPTION',
      parameters: {
        keys: this.sanitizeKeys(options.keys),
      },
    });
  }

  /**
   * 订阅账户活动推送，例如订单成交、资金变动等。
   */
  async subscribeAccountActivity(options: AccountActivitySubscriptionOptions = {}): Promise<void> {
    this.logger.info('订阅 ACCT_ACTIVITY', { options });
    this.assertConnected();
    return this.streamer.subscribe({
      service: 'ACCT_ACTIVITY',
      parameters: {
        keys: this.sanitizeKeys(options.keys),
      },
    });
  }

  /**
   * 确保已经完成 Streamer 登录，未连接时抛出友好错误提示。
   */
  private assertConnected(): void {
    if (!this.streamerInfo) {
      this.logger.error('尚未建立 Streamer 登录，请先调用 connect()');
      throw new Error('请先调用 connect() 完成 Streamer 登录');
    }
  }

  /**
   * 统一构造 LevelOne 订阅命令，避免在各个服务间重复编排逻辑。
   * @param service Streamer 服务名称，例如 `LEVELONE_EQUITIES`。
   * @param options 订阅参数，包含 `keys` 和可选的 `fields`。
   * @param errorLabel 发生错误时用于提示的中文标签。
   */
  private subscribeLevelOne(
    service: string,
    options: LevelOneSubscriptionOptions,
    errorLabel: string,
  ): Promise<void> {
    this.assertConnected();
    const keys = this.requireKeys(options.keys, errorLabel);
    this.logger.info('下发 LevelOne 订阅命令', { service, keys, fields: options.fields });
    return this.streamer.subscribe({
      service,
      parameters: {
        keys,
        fields: options.fields ?? undefined,
      },
    });
  }

  /**
   * 统一构造图表类订阅命令，允许调用方配置频率与窗口。
   * @param service Streamer 服务名称，例如 `CHART_EQUITY`。
   * @param options 订阅参数，包含证券代码及频率设置。
   * @param errorLabel 发生错误时用于提示的中文标签。
   */
  private subscribeChart(service: string, options: ChartSubscriptionOptions, errorLabel: string): Promise<void> {
    this.assertConnected();
    const keys = this.requireKeys(options.keys, errorLabel);
    this.logger.info('下发图表订阅命令', { service, keys, frequency: options.frequency, period: options.period });
    return this.streamer.subscribe({
      service,
      parameters: {
        keys,
        frequency: options.frequency,
        period: options.period,
      },
    });
  }

  /**
   * 校验订阅参数中是否包含至少一个证券代码。
   * @param keys 逗号分隔的证券代码字符串。
   * @param label 当前订阅类型的友好名称，用于报错。
   */
  private requireKeys(keys: SubscriptionKeysInput | undefined, label: string): string {
    const sanitized = this.sanitizeKeys(keys);
    if (!sanitized) {
      this.logger.error('订阅缺少关键代码', { label });
      throw new Error(`订阅 ${label} 需要至少提供一个代码`);
    }
    return sanitized;
  }

  /**
   * 对订阅代码进行去重和裁剪，保证发送给服务器的格式合法。
   * @param keys 原始输入的证券代码列表，可以是逗号分隔字符串或字符串数组。
   */
  private sanitizeKeys(keys: SubscriptionKeysInput | undefined): string | undefined {
    if (keys === undefined) return undefined;
    const seen = new Set<string>();
    const result: string[] = [];

    const appendValue = (value: string) => {
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .forEach((item) => {
          if (!seen.has(item)) {
            seen.add(item);
            result.push(item);
          }
        });
    };

    if (typeof keys === 'string') {
      appendValue(keys);
    } else {
      for (const value of keys) {
        appendValue(value);
      }
    }

    if (result.length === 0) {
      return undefined;
    }

    return result.join(',');
  }
}
