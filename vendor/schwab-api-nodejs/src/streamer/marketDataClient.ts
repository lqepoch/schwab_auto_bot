import { TokenManager } from '../auth/tokenManager.js';
import { TraderApiClient } from '../clients/trader.js';
import { StreamerClient } from './streamerClient.js';
import type { StreamerInfo } from '../types/trader.js';
import type { LevelOneEquityFieldId, LevelOneEquityFieldSelection } from '../types/levelOneFields.js';
import { serializeLevelOneEquityFields } from '../types/levelOneFields.js';
import {
  serializeStreamerServiceFields,
  type ServiceFieldId,
  type ServiceFieldSelection,
  type StreamerService,
} from '../types/streamerContracts.js';
import { Logger, createConsoleLogger } from '../utils/logger.js';

type SubscriptionKeysInput = string | ReadonlyArray<string>;
export type StreamerFieldSelection<TField extends string = string> = string | readonly TField[];

export interface LevelOneSubscriptionOptions<TField extends string = string> {
  /** Schwab symbols, as a comma-delimited string or an array. */
  keys: SubscriptionKeysInput;
  /** Streamer numeric field identifiers. */
  fields?: StreamerFieldSelection<TField>;
}

export type LevelOneEquitiesSubscriptionOptions = LevelOneSubscriptionOptions<LevelOneEquityFieldId> & {
  fields?: LevelOneEquityFieldSelection;
};

export type LevelOneOptionsSubscriptionOptions = LevelOneSubscriptionOptions<ServiceFieldId<'LEVELONE_OPTIONS'>>;
export type LevelOneFuturesSubscriptionOptions = LevelOneSubscriptionOptions<ServiceFieldId<'LEVELONE_FUTURES'>>;
export type LevelOneFuturesOptionsSubscriptionOptions =
  LevelOneSubscriptionOptions<ServiceFieldId<'LEVELONE_FUTURES_OPTIONS'>>;
export type LevelOneForexSubscriptionOptions = LevelOneSubscriptionOptions<ServiceFieldId<'LEVELONE_FOREX'>>;
export type BookSubscriptionOptions<S extends 'NYSE_BOOK' | 'NASDAQ_BOOK' | 'OPTIONS_BOOK'> =
  LevelOneSubscriptionOptions<ServiceFieldId<S>>;

export interface ChartSubscriptionOptions<TField extends string = string> {
  keys: SubscriptionKeysInput;
  frequency?: string;
  period?: string;
  fields?: StreamerFieldSelection<TField>;
}

export interface ScreenerSubscriptionOptions<TField extends string = string> {
  keys?: SubscriptionKeysInput;
  fields?: StreamerFieldSelection<TField>;
}

export interface AccountActivitySubscriptionOptions {
  keys?: SubscriptionKeysInput;
  fields?: ServiceFieldSelection<'ACCT_ACTIVITY'>;
}

export type ChartEquitySubscriptionOptions = ChartSubscriptionOptions<ServiceFieldId<'CHART_EQUITY'>>;
export type ChartFuturesSubscriptionOptions = ChartSubscriptionOptions<ServiceFieldId<'CHART_FUTURES'>>;
export type ScreenerEquitySubscriptionOptions =
  ScreenerSubscriptionOptions<ServiceFieldId<'SCREENER_EQUITY'>>;
export type ScreenerOptionSubscriptionOptions =
  ScreenerSubscriptionOptions<ServiceFieldId<'SCREENER_OPTION'>>;

export interface UnsubscribeKeysOptions {
  keys: SubscriptionKeysInput;
}

/**
 * High-level Schwab Streamer market-data facade.
 *
 * The facade owns request-shape normalization only. Connection lifecycle, command ACKs,
 * canonical subscription state, replay after reconnect, and command serialization remain in
 * StreamerClient so every service shares one transport state machine.
 */
export class MarketDataStreamClient {
  private streamerInfo?: StreamerInfo;
  private sessionReady = false;
  private readonly logger: Logger;

  constructor(
    private readonly streamer: StreamerClient,
    private readonly traderClient: TraderApiClient,
    private readonly tokenManager: TokenManager,
    logger?: Logger,
  ) {
    this.logger = logger ?? createConsoleLogger({ scope: 'MarketDataStreamClient' });
  }

  /** Establish the Streamer session and wait until ADMIN/LOGIN has been acknowledged. */
  async connect(): Promise<void> {
    this.sessionReady = false;
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
      this.sessionReady = true;
    } catch (error) {
      this.sessionReady = false;
      this.logger.error('等待 Streamer 登录就绪超时或失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.logger.info('市场数据 Streamer 登录完成');
  }

  /** Disconnect and discard the cached connection-specific StreamerInfo. */
  disconnect(): void {
    this.logger.info('主动断开市场数据 Streamer');
    this.sessionReady = false;
    this.streamer.disconnect();
    this.streamerInfo = undefined;
  }

  async subscribeLevelOneEquities(options: LevelOneEquitiesSubscriptionOptions): Promise<void> {
    return this.subscribeLevelOne(
      'LEVELONE_EQUITIES',
      { ...options, fields: serializeLevelOneEquityFields(options.fields) },
      'LevelOneEquities',
    );
  }

  async addLevelOneEquities(options: LevelOneEquitiesSubscriptionOptions): Promise<void> {
    return this.subscribeLevelOne(
      'LEVELONE_EQUITIES',
      { ...options, fields: serializeLevelOneEquityFields(options.fields) },
      'LevelOneEquities',
      'ADD',
    );
  }

  async unsubscribeLevelOneEquities(options: UnsubscribeKeysOptions): Promise<void> {
    return this.unsubscribeByKeys('LEVELONE_EQUITIES', options, 'LevelOneEquities');
  }

  async subscribeLevelOneOptions(options: LevelOneOptionsSubscriptionOptions): Promise<void> {
    return this.subscribeLevelOne('LEVELONE_OPTIONS', options, 'LevelOneOptions');
  }

  async addLevelOneOptions(options: LevelOneOptionsSubscriptionOptions): Promise<void> {
    return this.subscribeLevelOne('LEVELONE_OPTIONS', options, 'LevelOneOptions', 'ADD');
  }

  async unsubscribeLevelOneOptions(options: UnsubscribeKeysOptions): Promise<void> {
    return this.unsubscribeByKeys('LEVELONE_OPTIONS', options, 'LevelOneOptions');
  }

  async subscribeLevelOneFutures(options: LevelOneFuturesSubscriptionOptions): Promise<void> {
    return this.subscribeLevelOne('LEVELONE_FUTURES', options, 'LevelOneFutures');
  }

  async addLevelOneFutures(options: LevelOneFuturesSubscriptionOptions): Promise<void> {
    return this.subscribeLevelOne('LEVELONE_FUTURES', options, 'LevelOneFutures', 'ADD');
  }

  async unsubscribeLevelOneFutures(options: UnsubscribeKeysOptions): Promise<void> {
    return this.unsubscribeByKeys('LEVELONE_FUTURES', options, 'LevelOneFutures');
  }

  async subscribeLevelOneFuturesOptions(options: LevelOneFuturesOptionsSubscriptionOptions): Promise<void> {
    return this.subscribeLevelOne('LEVELONE_FUTURES_OPTIONS', options, 'LevelOneFuturesOptions');
  }

  async addLevelOneFuturesOptions(options: LevelOneFuturesOptionsSubscriptionOptions): Promise<void> {
    return this.subscribeLevelOne('LEVELONE_FUTURES_OPTIONS', options, 'LevelOneFuturesOptions', 'ADD');
  }

  async unsubscribeLevelOneFuturesOptions(options: UnsubscribeKeysOptions): Promise<void> {
    return this.unsubscribeByKeys('LEVELONE_FUTURES_OPTIONS', options, 'LevelOneFuturesOptions');
  }

  async subscribeLevelOneForex(options: LevelOneForexSubscriptionOptions): Promise<void> {
    return this.subscribeLevelOne('LEVELONE_FOREX', options, 'LevelOneForex');
  }

  async addLevelOneForex(options: LevelOneForexSubscriptionOptions): Promise<void> {
    return this.subscribeLevelOne('LEVELONE_FOREX', options, 'LevelOneForex', 'ADD');
  }

  async unsubscribeLevelOneForex(options: UnsubscribeKeysOptions): Promise<void> {
    return this.unsubscribeByKeys('LEVELONE_FOREX', options, 'LevelOneForex');
  }

  async subscribeNyseBook(options: BookSubscriptionOptions<'NYSE_BOOK'>): Promise<void> {
    return this.subscribeLevelOne('NYSE_BOOK', options, 'NYSE_BOOK');
  }

  async addNyseBook(options: BookSubscriptionOptions<'NYSE_BOOK'>): Promise<void> {
    return this.subscribeLevelOne('NYSE_BOOK', options, 'NYSE_BOOK', 'ADD');
  }

  async unsubscribeNyseBook(options: UnsubscribeKeysOptions): Promise<void> {
    return this.unsubscribeByKeys('NYSE_BOOK', options, 'NYSE_BOOK');
  }

  async subscribeNasdaqBook(options: BookSubscriptionOptions<'NASDAQ_BOOK'>): Promise<void> {
    return this.subscribeLevelOne('NASDAQ_BOOK', options, 'NASDAQ_BOOK');
  }

  async addNasdaqBook(options: BookSubscriptionOptions<'NASDAQ_BOOK'>): Promise<void> {
    return this.subscribeLevelOne('NASDAQ_BOOK', options, 'NASDAQ_BOOK', 'ADD');
  }

  async unsubscribeNasdaqBook(options: UnsubscribeKeysOptions): Promise<void> {
    return this.unsubscribeByKeys('NASDAQ_BOOK', options, 'NASDAQ_BOOK');
  }

  async subscribeOptionsBook(options: BookSubscriptionOptions<'OPTIONS_BOOK'>): Promise<void> {
    return this.subscribeLevelOne('OPTIONS_BOOK', options, 'OPTIONS_BOOK');
  }

  async addOptionsBook(options: BookSubscriptionOptions<'OPTIONS_BOOK'>): Promise<void> {
    return this.subscribeLevelOne('OPTIONS_BOOK', options, 'OPTIONS_BOOK', 'ADD');
  }

  async unsubscribeOptionsBook(options: UnsubscribeKeysOptions): Promise<void> {
    return this.unsubscribeByKeys('OPTIONS_BOOK', options, 'OPTIONS_BOOK');
  }

  async subscribeChartEquity(options: ChartEquitySubscriptionOptions): Promise<void> {
    return this.subscribeChart('CHART_EQUITY', options, 'CHART_EQUITY');
  }

  async unsubscribeChartEquity(options: UnsubscribeKeysOptions): Promise<void> {
    return this.unsubscribeByKeys('CHART_EQUITY', options, 'CHART_EQUITY');
  }

  async subscribeChartFutures(options: ChartFuturesSubscriptionOptions): Promise<void> {
    return this.subscribeChart('CHART_FUTURES', options, 'CHART_FUTURES');
  }

  async unsubscribeChartFutures(options: UnsubscribeKeysOptions): Promise<void> {
    return this.unsubscribeByKeys('CHART_FUTURES', options, 'CHART_FUTURES');
  }

  async subscribeScreenerEquity(options: ScreenerEquitySubscriptionOptions = {}): Promise<void> {
    this.assertConnected();
    return this.streamer.subscribe({
      service: 'SCREENER_EQUITY',
      parameters: this.parametersForFields('SCREENER_EQUITY', options.keys, options.fields),
    });
  }

  async unsubscribeScreenerEquity(options: ScreenerSubscriptionOptions = {}): Promise<void> {
    return this.unsubscribeOptionalKeys('SCREENER_EQUITY', options.keys);
  }

  async subscribeScreenerOption(options: ScreenerOptionSubscriptionOptions = {}): Promise<void> {
    this.assertConnected();
    return this.streamer.subscribe({
      service: 'SCREENER_OPTION',
      parameters: this.parametersForFields('SCREENER_OPTION', options.keys, options.fields),
    });
  }

  async unsubscribeScreenerOption(options: ScreenerSubscriptionOptions = {}): Promise<void> {
    return this.unsubscribeOptionalKeys('SCREENER_OPTION', options.keys);
  }

  async subscribeAccountActivity(options: AccountActivitySubscriptionOptions = {}): Promise<void> {
    this.assertConnected();
    return this.streamer.subscribe({
      service: 'ACCT_ACTIVITY',
      parameters: this.parametersForFields('ACCT_ACTIVITY', options.keys, options.fields),
    });
  }

  async unsubscribeAccountActivity(options: AccountActivitySubscriptionOptions = {}): Promise<void> {
    return this.unsubscribeOptionalKeys('ACCT_ACTIVITY', options.keys);
  }

  private assertConnected(): void {
    if (!this.streamerInfo || !this.sessionReady) {
      this.logger.error('尚未建立 Streamer 登录，请先调用 connect()');
      throw new Error('请先调用 connect() 完成 Streamer 登录');
    }
  }

  private subscribeLevelOne(
    service: StreamerService | 'LEVELONE_EQUITIES',
    options: LevelOneSubscriptionOptions,
    errorLabel: string,
    command: 'SUBS' | 'ADD' = 'SUBS',
  ): Promise<void> {
    this.assertConnected();
    const keys = this.requireKeys(options.keys, errorLabel);
    const fields = service === 'LEVELONE_EQUITIES'
      ? this.serializeFields(options.fields)
      : serializeStreamerServiceFields(service, options.fields as ServiceFieldSelection<typeof service>);
    this.logger.info('下发 Streamer 订阅命令', { service, command, keys, fields });
    return this.streamer.subscribe({
      service,
      command,
      parameters: {
        keys,
        ...(fields ? { fields } : {}),
      },
    });
  }

  private subscribeChart(
    service: 'CHART_EQUITY' | 'CHART_FUTURES',
    options: ChartSubscriptionOptions,
    errorLabel: string,
  ): Promise<void> {
    this.assertConnected();
    const keys = this.requireKeys(options.keys, errorLabel);
    const fields = serializeStreamerServiceFields(service, options.fields as ServiceFieldSelection<typeof service>);
    return this.streamer.subscribe({
      service,
      parameters: {
        keys,
        ...(options.frequency ? { frequency: options.frequency.trim() } : {}),
        ...(options.period ? { period: options.period.trim() } : {}),
        ...(fields ? { fields } : {}),
      },
    });
  }

  private unsubscribeByKeys(
    service: string,
    options: UnsubscribeKeysOptions,
    errorLabel: string,
  ): Promise<void> {
    this.assertConnected();
    const keys = this.requireKeys(options.keys, errorLabel);
    return this.streamer.unsubscribe({ service, parameters: { keys } });
  }

  private unsubscribeOptionalKeys(service: string, keys?: SubscriptionKeysInput): Promise<void> {
    this.assertConnected();
    return this.streamer.unsubscribe({
      service,
      parameters: this.parametersForOptionalKeys(keys),
    });
  }

  private parametersForOptionalKeys(keys?: SubscriptionKeysInput): { keys: string } | undefined {
    const sanitized = this.sanitizeKeys(keys);
    return sanitized ? { keys: sanitized } : undefined;
  }

  private parametersForFields<S extends StreamerService>(
    service: S,
    keys?: SubscriptionKeysInput,
    fields?: ServiceFieldSelection<S>,
  ): Record<string, string> | undefined {
    const sanitizedKeys = this.sanitizeKeys(keys);
    const serializedFields = serializeStreamerServiceFields(service, fields);
    if (!sanitizedKeys && !serializedFields) return undefined;
    return {
      ...(sanitizedKeys ? { keys: sanitizedKeys } : {}),
      ...(serializedFields ? { fields: serializedFields } : {}),
    };
  }

  private requireKeys(keys: SubscriptionKeysInput | undefined, label: string): string {
    const sanitized = this.sanitizeKeys(keys);
    if (!sanitized) {
      throw new Error(`订阅 ${label} 需要至少提供一个代码`);
    }
    return sanitized;
  }

  private sanitizeKeys(keys: SubscriptionKeysInput | undefined): string | undefined {
    if (keys === undefined) return undefined;
    const raw = typeof keys === 'string' ? [keys] : [...keys];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of raw) {
      for (const token of value.split(',')) {
        const key = token.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(key);
      }
    }
    return result.length > 0 ? result.join(',') : undefined;
  }

  private serializeFields(fields: StreamerFieldSelection | undefined): string | undefined {
    if (fields === undefined) return undefined;
    const raw = typeof fields === 'string' ? fields.split(',') : [...fields];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of raw) {
      const field = String(value).trim();
      if (!field || seen.has(field)) continue;
      if (!/^[0-9]+$/.test(field)) {
        throw new Error(`Streamer field id must be numeric: ${field}`);
      }
      seen.add(field);
      result.push(field);
    }
    if (result.length === 0) {
      throw new Error('Streamer fields must contain at least one numeric field id');
    }
    return result.join(',');
  }
}
