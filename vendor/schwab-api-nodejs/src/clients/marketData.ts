import { HttpClient } from '../utils/httpClient.js';
import { TokenManager } from '../auth/tokenManager.js';
import { AuthorizedApiClient } from '../utils/apiClientBase.js';
import { Logger, createConsoleLogger } from '../utils/logger.js';
import {
  InstrumentDetail,
  InstrumentProjection,
  InstrumentsSearchResponse,
  MarketHoursResponse,
  MoversResponse,
  OptionChainResponse,
  OptionContractType,
  OptionExpirationChainResponse,
  OptionExpMonth,
  OptionRange,
  OptionStrategy,
  PriceHistoryResponse,
  QuoteFieldRoot,
  QuotesResponse,
  SingleQuoteResponse,
  PeriodType,
  FrequencyType,
} from '../types/marketData.js';

/**
 * Market Data REST API 封装，对应 https://api.schwabapi.com/marketdata/v1 下的全部端点。
 */
export class MarketDataApiClient extends AuthorizedApiClient {
  constructor(http: HttpClient, tokens: TokenManager, logger?: Logger) {
    super(http, tokens, logger ?? createConsoleLogger({ scope: 'MarketDataApiClient' }));
  }

  private normalizeList(value?: string | readonly string[]): string | undefined {
    // 处理数组参数，确保最终使用逗号分隔的字符串
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join(',');
    return undefined;
  }

  private normalizeFields(value?: readonly QuoteFieldRoot[] | string): string | undefined {
    if (!value) return undefined;
    if (Array.isArray(value)) {
      return value.join(',');
    }
    if (typeof value === 'string') {
      return value;
    }
    return undefined;
  }

  /**
   * `GET /quotes`：批量获取行情。
   * @param params.symbols 可传单个字符串或字符串数组，推荐使用数组便于维护。
   * @param params.fields 指定返回字段，如 `['quote','fundamental']`。
   * @param params.indicative ETF 需要时传 `true` 以返回 `.IV` 指数值。
   */
  async getQuotes(params: {
    symbols: string | readonly string[];
    fields?: readonly QuoteFieldRoot[] | string;
    indicative?: boolean;
  }): Promise<QuotesResponse> {
    this.logger.info('调用 getQuotes', { params });
    const symbols = this.normalizeList(params.symbols);
    if (!symbols) {
      throw new Error('getQuotes 需要至少一个 symbols 参数');
    }
    const query = this.buildQuery({
      symbols,
      fields: this.normalizeFields(params.fields),
      indicative: params.indicative,
    });
    return this.request<QuotesResponse>('/quotes', { query });
  }

  /**
   * `GET /{symbol}/quotes`：单个标的行情详情。
   * @param symbol 证券代码，支持股票、指数、期权等。
   * @param params.fields 控制返回字段集合。
   */
  async getQuote(
    symbol: string,
    params: { fields?: readonly QuoteFieldRoot[] | string } = {},
  ): Promise<SingleQuoteResponse> {
    this.logger.info('调用 getQuote', { symbol, params });
    if (!symbol?.trim()) throw new Error('getQuote 需要提供 symbol');
    const query = this.buildQuery({ fields: this.normalizeFields(params.fields) });
    return this.request<SingleQuoteResponse>(`/${encodeURIComponent(symbol)}/quotes`, { query });
  }

  /**
   * `GET /chains`：期权链数据。
   * 常用参数：
   * - `contractType` 取值 `CALL`/`PUT`/`ALL`
   * - `strategy` 结合 `strike`、`range` 控制返回行权价。
   */
  async getOptionChains(params: {
    symbol: string;
    contractType?: OptionContractType;
    includeUnderlyingQuote?: boolean;
    /** @deprecated Use `includeUnderlyingQuote`; this alias is translated to the official query key. */
    includeQuotes?: boolean;
    strategy?: OptionStrategy;
    interval?: number;
    strikeCount?: number;
    strike?: number;
    range?: OptionRange;
    fromDate?: string;
    toDate?: string;
    volatility?: number;
    underlyingPrice?: number;
    interestRate?: number;
    daysToExpiration?: number;
    expMonth?: OptionExpMonth;
    optionType?: string;
    entitlement?: string;
  }): Promise<OptionChainResponse> {
    this.logger.info('调用 getOptionChains', { params });
    if (!params.symbol?.trim()) throw new Error('getOptionChains 需要提供 symbol');
    const includeUnderlyingQuote = params.includeUnderlyingQuote ?? params.includeQuotes;
    const query = this.buildQuery({
      symbol: params.symbol,
      contractType: params.contractType,
      includeUnderlyingQuote,
      strategy: params.strategy,
      interval: params.interval,
      strikeCount: params.strikeCount,
      strike: params.strike,
      range: params.range,
      fromDate: params.fromDate,
      toDate: params.toDate,
      volatility: params.volatility,
      underlyingPrice: params.underlyingPrice,
      interestRate: params.interestRate,
      daysToExpiration: params.daysToExpiration,
      expMonth: params.expMonth,
      optionType: params.optionType,
      entitlement: params.entitlement,
    });
    return this.request<OptionChainResponse>('/chains', { query });
  }

  /**
   * `GET /expirationchain`：返回标的全部期权到期日列表。
   */
  async getOptionExpirationChain(params: {
    symbol: string;
    contractType?: OptionContractType;
    expMonth?: OptionExpMonth;
    optionType?: string;
  }): Promise<OptionExpirationChainResponse> {
    this.logger.info('调用 getOptionExpirationChain', { params });
    if (!params.symbol?.trim()) throw new Error('getOptionExpirationChain 需要提供 symbol');
    const query = this.buildQuery({
      symbol: params.symbol,
      contractType: params.contractType,
      expMonth: params.expMonth,
      optionType: params.optionType,
    });
    return this.request<OptionExpirationChainResponse>('/expirationchain', { query });
  }

  /**
   * `GET /pricehistory`：获取历史 OHLCV 数据。
   * 可以通过 `periodType/period` 或 `startDate/endDate` 控制时间范围。
   */
  async getPriceHistory(params: {
    symbol: string;
    periodType?: PeriodType;
    period?: number;
    frequencyType?: FrequencyType;
    frequency?: number;
    startDate?: number;
    endDate?: number;
    needExtendedHoursData?: boolean;
    needPreviousClose?: boolean;
  }): Promise<PriceHistoryResponse> {
    this.logger.info('调用 getPriceHistory', { params });
    if (!params.symbol?.trim()) throw new Error('getPriceHistory 需要提供 symbol');
    const query = this.buildQuery({
      symbol: params.symbol,
      periodType: params.periodType,
      period: params.period,
      frequencyType: params.frequencyType,
      frequency: params.frequency,
      startDate: params.startDate,
      endDate: params.endDate,
      needExtendedHoursData: params.needExtendedHoursData,
      needPreviousClose: params.needPreviousClose,
    });
    return this.request<PriceHistoryResponse>('/pricehistory', { query });
  }

  /**
   * `GET /movers/{symbol}`：拉取涨跌幅榜。
   * @param symbolId 指数或筛选器 ID，如 `$DJI`、`$COMPX`。
   */
  async getMovers(
    symbolId: string,
    params: { sort?: 'VOLUME' | 'TRADES' | 'PERCENT_CHANGE_UP' | 'PERCENT_CHANGE_DOWN'; frequency?: 0 | 1 | 5 | 10 | 30 | 60 } = {},
  ): Promise<MoversResponse> {
    this.logger.info('调用 getMovers', { symbolId, params });
    if (!symbolId?.trim()) throw new Error('getMovers 需要提供 symbolId');
    const query = this.buildQuery({ sort: params.sort, frequency: params.frequency });
    return this.request<MoversResponse>(`/movers/${encodeURIComponent(symbolId)}`, { query });
  }

  /**
   * `GET /markets`：批量查询各市场在指定日期的开闭市时间。
   * @param params.markets 传入市场标识数组，如 `['EQUITY','OPTION']`。
   */
  async getMarkets(params: { markets: readonly string[]; date?: string }): Promise<MarketHoursResponse> {
    this.logger.info('调用 getMarkets', { params });
    if (!params.markets?.length) {
      throw new Error('getMarkets 至少需要传入一个 market');
    }
    const query = this.buildQuery({
      markets: params.markets.join(','),
      date: params.date,
    });
    return this.request<MarketHoursResponse>('/markets', { query });
  }

  /**
   * `GET /markets/{market}`：查询单个市场的开闭市时间。
   */
  async getMarketHours(marketId: string, params: { date?: string } = {}): Promise<MarketHoursResponse> {
    this.logger.info('调用 getMarketHours', { marketId, params });
    if (!marketId?.trim()) throw new Error('getMarketHours 需要提供 marketId');
    const query = this.buildQuery({ date: params.date });
    return this.request<MarketHoursResponse>(`/markets/${encodeURIComponent(marketId)}`, { query });
  }

  /**
   * `GET /instruments`：根据 symbol + projection 检索基础信息或基本面数据。
   */
  async searchInstruments(
    params: { symbol: string | readonly string[]; projection: InstrumentProjection },
  ): Promise<InstrumentsSearchResponse> {
    this.logger.info('调用 searchInstruments', { params });
    const symbol = this.normalizeList(params.symbol);
    if (!symbol) throw new Error('searchInstruments 需要 symbol 参数');
    if (!params.projection) throw new Error('searchInstruments 需要 projection 参数');
    const query = this.buildQuery({ symbol, projection: params.projection });
    return this.request<InstrumentsSearchResponse>('/instruments', { query });
  }

  /**
   * `GET /instruments/{cusip}`：通过 CUSIP 查询单个标的基本信息。
   */
  async getInstrumentByCusip(cusipId: string): Promise<InstrumentDetail> {
    this.logger.info('调用 getInstrumentByCusip', { cusipId });
    if (!cusipId?.trim()) throw new Error('getInstrumentByCusip 需要提供 CUSIP');
    return this.request<InstrumentDetail>(`/instruments/${encodeURIComponent(cusipId)}`);
  }
}
