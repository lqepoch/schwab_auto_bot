import { HttpClient } from '../utils/httpClient.js';
import { TokenManager } from '../auth/tokenManager.js';
import { AuthorizedApiClient } from '../utils/apiClientBase.js';
import { Logger, createConsoleLogger } from '../utils/logger.js';
import { parseSchwabOptionSymbol } from '../options/optionSymbol.js';
import type { DerivedVerticalOptionQuote, NormalizedOptionQuote } from '../types/normalizedQuotes.js';
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
  QuoteItem,
  QuotesResponse,
  SingleQuoteResponse,
  PeriodType,
  FrequencyType,
} from '../types/marketData.js';
import {
  InstrumentDetailSchema,
  InstrumentsSearchResponseSchema,
  MarketHoursResponseSchema,
  MoversResponseSchema,
  OptionChainResponseSchema,
  OptionExpirationChainResponseSchema,
  PriceHistoryResponseSchema,
  QuotesResponseSchema,
  SingleQuoteResponseSchema,
} from '../validation/marketDataSchemas.js';

/**
 * Market Data REST API 封装，对应 https://api.schwabapi.com/marketdata/v1 下的全部端点。
 *
 * 所有 REST 响应都会在传出 SDK 前执行宽容式 runtime schema validation：
 * 保留 Schwab 新增的未知字段，同时阻止错误的顶层结构、无效数值类型和缺失的稳定必需字段进入业务层。
 */
export class MarketDataApiClient extends AuthorizedApiClient {
  constructor(http: HttpClient, tokens: TokenManager, logger?: Logger) {
    super(http, tokens, logger ?? createConsoleLogger({ scope: 'MarketDataApiClient' }));
  }

  private normalizeList(value?: string | readonly string[]): string | undefined {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join(',');
    return undefined;
  }

  private normalizeFields(value?: readonly QuoteFieldRoot[] | string): string | undefined {
    if (!value) return undefined;
    if (Array.isArray(value)) return value.join(',');
    if (typeof value === 'string') return value;
    return undefined;
  }

  /** `GET /quotes`：批量获取行情。 */
  async getQuotes(params: {
    symbols: string | readonly string[];
    fields?: readonly QuoteFieldRoot[] | string;
    indicative?: boolean;
  }): Promise<QuotesResponse> {
    this.logger.info('调用 getQuotes', { params });
    const symbols = this.normalizeList(params.symbols);
    if (!symbols) throw new Error('getQuotes 需要至少一个 symbols 参数');
    const query = this.buildQuery({
      symbols,
      fields: this.normalizeFields(params.fields),
      indicative: params.indicative,
    });
    return this.request<QuotesResponse>('/quotes', { query, schema: QuotesResponseSchema });
  }

  /**
   * 获取单个期权合约的标准化二级市场行情。
   * 使用 `/quotes` 获取 OPTION bid/ask/mark/Greeks，并补充 mid/spread/quoteAgeMs。
   */
  async getOptionQuote(
    symbol: string,
    params: { fields?: readonly QuoteFieldRoot[] | string } = {},
  ): Promise<NormalizedOptionQuote> {
    const quotes = await this.getOptionQuotes([symbol], params);
    return quotes[0];
  }

  /** 批量获取并标准化期权合约行情。 */
  async getOptionQuotes(
    symbols: readonly string[],
    params: { fields?: readonly QuoteFieldRoot[] | string } = {},
  ): Promise<NormalizedOptionQuote[]> {
    const normalizedSymbols = symbols
      .map((symbol) => symbol.trimEnd())
      .filter((symbol) => symbol.length > 0);
    if (normalizedSymbols.length === 0) throw new Error('getOptionQuotes 需要至少一个期权 symbol');
    if (new Set(normalizedSymbols).size !== normalizedSymbols.length) {
      throw new Error('getOptionQuotes 不接受重复 symbol');
    }

    const response = await this.getQuotes({
      symbols: normalizedSymbols,
      fields: params.fields ?? ['quote', 'reference'],
    });
    const observedAt = Date.now();
    return normalizedSymbols.map((symbol) => {
      const item = this.findQuoteItem(response, symbol);
      if (!item) throw new Error(`Schwab 未返回期权行情: ${symbol}`);
      if (item.assetMainType !== 'OPTION') {
        throw new Error(`请求的 symbol 不是期权合约: ${symbol} assetMainType=${String(item.assetMainType)}`);
      }
      return this.normalizeOptionQuote(item, observedAt);
    });
  }

  /**
   * 基于两条独立期权腿的 NBBO 推导垂直价差参考市场。
   * derivedBid = buyLeg.bid - sellLeg.ask
   * derivedAsk = buyLeg.ask - sellLeg.bid
   * 该结果属于 leg-derived synthetic market，不代表交易所原生 complex-order-book 报价。
   */
  async getVerticalOptionQuote(
    buySymbol: string,
    sellSymbol: string,
  ): Promise<DerivedVerticalOptionQuote> {
    const [buy, sell] = await this.getOptionQuotes([buySymbol, sellSymbol]);
    const derivedBid = subtractIfPresent(buy.bid, sell.ask);
    const derivedAsk = subtractIfPresent(buy.ask, sell.bid);
    const derivedMid = midpointIfPresent(derivedBid, derivedAsk);
    const derivedSpread = subtractIfPresent(derivedAsk, derivedBid);
    const quoteAgeMs = maxIfPresent(buy.quoteAgeMs, sell.quoteAgeMs);

    return {
      buy,
      sell,
      derivedBid,
      derivedAsk,
      derivedMid,
      derivedSpread,
      quoteAgeMs,
      sameUnderlying: buy.underlying !== undefined && buy.underlying === sell.underlying,
      sameExpiration: buy.expiration !== undefined && buy.expiration === sell.expiration,
      sameContractType: buy.contractType !== undefined && buy.contractType === sell.contractType,
    };
  }

  /**
   * `GET /{symbol}/quotes`：单个标的行情详情。
   * Schwab 文档中的该端点示例结构与 `/quotes` NBBO 结构存在差异；标准化期权行情使用 `getOptionQuote()`。
   */
  async getQuote(
    symbol: string,
    params: { fields?: readonly QuoteFieldRoot[] | string } = {},
  ): Promise<SingleQuoteResponse> {
    this.logger.info('调用 getQuote', { symbol, params });
    if (!symbol?.trim()) throw new Error('getQuote 需要提供 symbol');
    const query = this.buildQuery({ fields: this.normalizeFields(params.fields) });
    return this.request<SingleQuoteResponse>(`/${encodeURIComponent(symbol)}/quotes`, {
      query,
      schema: SingleQuoteResponseSchema,
    });
  }

  /** `GET /chains`：期权链数据。 */
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
    return this.request<OptionChainResponse>('/chains', { query, schema: OptionChainResponseSchema });
  }

  /** `GET /expirationchain`：返回标的全部期权到期日列表。 */
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
    return this.request<OptionExpirationChainResponse>('/expirationchain', {
      query,
      schema: OptionExpirationChainResponseSchema,
    });
  }

  /** `GET /pricehistory`：获取历史 OHLCV 数据。 */
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
    return this.request<PriceHistoryResponse>('/pricehistory', { query, schema: PriceHistoryResponseSchema });
  }

  /** `GET /movers/{symbol}`：拉取涨跌幅榜。 */
  async getMovers(
    symbolId: string,
    params: { sort?: 'VOLUME' | 'TRADES' | 'PERCENT_CHANGE_UP' | 'PERCENT_CHANGE_DOWN'; frequency?: 0 | 1 | 5 | 10 | 30 | 60 } = {},
  ): Promise<MoversResponse> {
    this.logger.info('调用 getMovers', { symbolId, params });
    if (!symbolId?.trim()) throw new Error('getMovers 需要提供 symbolId');
    const query = this.buildQuery({ sort: params.sort, frequency: params.frequency });
    return this.request<MoversResponse>(`/movers/${encodeURIComponent(symbolId)}`, {
      query,
      schema: MoversResponseSchema,
    });
  }

  /** `GET /markets`：批量查询市场开闭市时间。 */
  async getMarkets(params: { markets: readonly string[]; date?: string }): Promise<MarketHoursResponse> {
    this.logger.info('调用 getMarkets', { params });
    if (!params.markets?.length) throw new Error('getMarkets 至少需要传入一个 market');
    const query = this.buildQuery({ markets: params.markets.join(','), date: params.date });
    return this.request<MarketHoursResponse>('/markets', { query, schema: MarketHoursResponseSchema });
  }

  /** `GET /markets/{market}`：查询单个市场开闭市时间。 */
  async getMarketHours(marketId: string, params: { date?: string } = {}): Promise<MarketHoursResponse> {
    this.logger.info('调用 getMarketHours', { marketId, params });
    if (!marketId?.trim()) throw new Error('getMarketHours 需要提供 marketId');
    const query = this.buildQuery({ date: params.date });
    return this.request<MarketHoursResponse>(`/markets/${encodeURIComponent(marketId)}`, {
      query,
      schema: MarketHoursResponseSchema,
    });
  }

  /** `GET /instruments`：根据 symbol + projection 检索基础信息或基本面数据。 */
  async searchInstruments(
    params: { symbol: string | readonly string[]; projection: InstrumentProjection },
  ): Promise<InstrumentsSearchResponse> {
    this.logger.info('调用 searchInstruments', { params });
    const symbol = this.normalizeList(params.symbol);
    if (!symbol) throw new Error('searchInstruments 需要 symbol 参数');
    if (!params.projection) throw new Error('searchInstruments 需要 projection 参数');
    const query = this.buildQuery({ symbol, projection: params.projection });
    return this.request<InstrumentsSearchResponse>('/instruments', {
      query,
      schema: InstrumentsSearchResponseSchema,
    });
  }

  /** `GET /instruments/{cusip}`：通过 CUSIP 查询单个标的基本信息。 */
  async getInstrumentByCusip(cusipId: string): Promise<InstrumentDetail> {
    this.logger.info('调用 getInstrumentByCusip', { cusipId });
    if (!cusipId?.trim()) throw new Error('getInstrumentByCusip 需要提供 CUSIP');
    return this.request<InstrumentDetail>(`/instruments/${encodeURIComponent(cusipId)}`, {
      schema: InstrumentDetailSchema,
    });
  }

  private findQuoteItem(response: QuotesResponse, symbol: string): QuoteItem | undefined {
    return response[symbol]
      ?? Object.values(response).find((item) => item.symbol === symbol || item.symbol?.trimEnd() === symbol.trimEnd());
  }

  private normalizeOptionQuote(item: QuoteItem, observedAt: number): NormalizedOptionQuote {
    const quote = (item.quote ?? {}) as Record<string, unknown>;
    const reference = (item.reference ?? {}) as Record<string, unknown>;
    let parsed: ReturnType<typeof parseSchwabOptionSymbol> | undefined;
    try {
      parsed = parseSchwabOptionSymbol(item.symbol);
    } catch {
      // Adjusted/non-standard contracts may not fit the standard 21-character layout.
    }

    const bid = finiteNumber(quote.bidPrice);
    const ask = finiteNumber(quote.askPrice);
    const mid = midpointIfPresent(bid, ask);
    const spread = subtractIfPresent(ask, bid);
    const quoteTime = positiveTimestamp(quote.quoteTime);
    const contractType = normalizeQuoteContractType(reference.contractType, parsed?.contractType);
    const expiration = expirationFromReference(reference) ?? parsed?.expiration;
    const strike = finiteNumber(reference.strikePrice) ?? parsed?.strike;
    const underlying = stringValue(reference.underlying) ?? parsed?.underlying;

    return {
      symbol: item.symbol,
      underlying,
      contractType,
      expiration,
      strike,
      realtime: item.realtime,
      quoteType: item.quoteType,
      bid,
      ask,
      bidSize: finiteNumber(quote.bidSize),
      askSize: finiteNumber(quote.askSize),
      mark: finiteNumber(quote.mark),
      last: finiteNumber(quote.lastPrice),
      mid,
      spread,
      spreadPercentOfMid: spread !== undefined && mid !== undefined && mid !== 0
        ? (spread / Math.abs(mid)) * 100
        : undefined,
      quoteTime,
      tradeTime: positiveTimestamp(quote.tradeTime),
      quoteAgeMs: quoteTime === undefined ? undefined : Math.max(0, observedAt - quoteTime),
      delta: finiteNumber(quote.delta),
      gamma: finiteNumber(quote.gamma),
      theta: finiteNumber(quote.theta),
      vega: finiteNumber(quote.vega),
      rho: finiteNumber(quote.rho),
      volatility: finiteNumber(quote.volatility),
      openInterest: finiteNumber(quote.openInterest),
      totalVolume: finiteNumber(quote.totalVolume),
      underlyingPrice: finiteNumber(quote.underlyingPrice),
      theoreticalOptionValue: finiteNumber(quote.theoreticalOptionValue),
      timeValue: finiteNumber(quote.timeValue),
      intrinsicValue: finiteNumber(quote.moneyIntrinsicValue),
    };
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function positiveTimestamp(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  return numeric !== undefined && numeric > 0 ? numeric : undefined;
}

function subtractIfPresent(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined || right === undefined ? undefined : left - right;
}

function midpointIfPresent(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined || right === undefined ? undefined : (left + right) / 2;
}

function maxIfPresent(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function normalizeQuoteContractType(
  value: unknown,
  fallback: 'CALL' | 'PUT' | undefined,
): 'CALL' | 'PUT' | undefined {
  if (value === 'C' || value === 'CALL') return 'CALL';
  if (value === 'P' || value === 'PUT') return 'PUT';
  return fallback;
}

function expirationFromReference(reference: Record<string, unknown>): string | undefined {
  const year = finiteNumber(reference.expirationYear);
  const month = finiteNumber(reference.expirationMonth);
  const day = finiteNumber(reference.expirationDay);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
