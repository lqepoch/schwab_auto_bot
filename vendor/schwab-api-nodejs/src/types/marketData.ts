export type QuoteFieldRoot = 'quote' | 'fundamental' | 'extended' | 'reference' | 'regular' | 'all';

export interface QuoteReference {
  cusip?: string;
  description?: string;
  exchange?: string;
  exchangeName?: string;
}

export interface QuoteDetail {
  '52WeekHigh'?: number;
  '52WeekLow'?: number;
  askMICId?: string;
  askPrice?: number;
  askSize?: number;
  askTime?: number;
  bidMICId?: string;
  bidPrice?: number;
  bidSize?: number;
  bidTime?: number;
  closePrice?: number;
  highPrice?: number;
  lastMICId?: string;
  lastPrice?: number;
  lastSize?: number;
  lowPrice?: number;
  mark?: number;
  markChange?: number;
  markPercentChange?: number;
  netChange?: number;
  netPercentChange?: number;
  openPrice?: number;
  quoteTime?: number;
  securityStatus?: string;
  totalVolume?: number;
  tradeTime?: number;
  volatility?: number;
  [key: string]: unknown;
}

export interface QuoteRegularDetail {
  regularMarketLastPrice?: number;
  regularMarketLastSize?: number;
  regularMarketNetChange?: number;
  regularMarketPercentChange?: number;
  regularMarketTradeTime?: number;
  [key: string]: unknown;
}

export interface QuoteFundamentalDetail {
  avg10DaysVolume?: number;
  avg1YearVolume?: number;
  divAmount?: number;
  divFreq?: number;
  divPayAmount?: number;
  divYield?: number;
  eps?: number;
  fundLeverageFactor?: number;
  peRatio?: number;
  [key: string]: unknown;
}

export interface QuoteExtendedDetail {
  extendedPrice?: number;
  extendedChange?: number;
  extendedChangePercent?: number;
  extendedHoursLastPrice?: number;
  extendedHoursChange?: number;
  extendedHoursChangePercent?: number;
  extendedHoursVolume?: number;
  [key: string]: unknown;
}

export interface QuoteItem {
  assetMainType?: string;
  assetSubType?: string;
  symbol: string;
  quoteType?: string;
  realtime?: boolean;
  ssid?: number;
  reference?: QuoteReference;
  quote?: QuoteDetail;
  regular?: QuoteRegularDetail;
  fundamental?: QuoteFundamentalDetail;
  extended?: QuoteExtendedDetail;
  [key: string]: unknown;
}

export type QuotesResponse = Record<string, QuoteItem>;

export interface QuoteSeriesCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number;
  [key: string]: unknown;
}

export interface SingleQuoteResponse extends Partial<QuoteItem> {
  symbol?: string;
  empty?: boolean;
  previousClose?: number;
  previousCloseDate?: number;
  candles?: QuoteSeriesCandle[];
}

export type OptionStrategy =
  | 'SINGLE'
  | 'ANALYTICAL'
  | 'COVERED'
  | 'VERTICAL'
  | 'CALENDAR'
  | 'DIAGONAL'
  | 'STRADDLE'
  | 'STRANGLE'
  | 'BUTTERFLY'
  | 'CONDOR'
  | 'ROLL'
  | 'COLLAR'
  | 'IRON_CONDOR'
  | 'VERTICAL_ROLL'
  | 'BACK_RATIO'
  | (string & {});

export type OptionContractType = 'ALL' | 'CALL' | 'PUT';
export type OptionRange = 'ALL' | 'ITM' | 'OTM' | 'NTM' | 'SAK' | 'SBK';
export type OptionExpMonth =
  | 'JAN'
  | 'FEB'
  | 'MAR'
  | 'APR'
  | 'MAY'
  | 'JUN'
  | 'JUL'
  | 'AUG'
  | 'SEP'
  | 'OCT'
  | 'NOV'
  | 'DEC'
  | 'ALL';

export interface OptionDeliverable {
  symbol?: string;
  assetType?: string;
  deliverableUnits?: string;
  currencyType?: string;
}

export interface OptionContract {
  putCall?: 'PUT' | 'CALL';
  symbol?: string;
  description?: string;
  exchangeName?: string;
  bidPrice?: number;
  askPrice?: number;
  lastPrice?: number;
  markPrice?: number;
  bidSize?: number;
  askSize?: number;
  lastSize?: number;
  highPrice?: number;
  lowPrice?: number;
  openPrice?: number;
  closePrice?: number;
  totalVolume?: number;
  tradeDate?: number;
  quoteTimeInLong?: number;
  tradeTimeInLong?: number;
  netChange?: number;
  volatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  openInterest?: number;
  timeValue?: number;
  theoreticalOptionValue?: number;
  theoreticalVolatility?: number;
  intrinsicValue?: number;
  isMini?: boolean;
  isNonStandard?: boolean;
  isPennyPilot?: boolean;
  optionDeliverablesList?: OptionDeliverable[];
  strikePrice?: number;
  expirationDate?: string;
  expirationType?: string;
  daysToExpiration?: number;
  lastTradingDay?: number;
  multiplier?: number;
  settlementType?: string;
  deliverableNote?: string;
  isIndexOption?: boolean;
  percentChange?: number;
  markChange?: number;
  markPercentChange?: number;
  optionRoot?: string;
  [key: string]: unknown;
}

export type OptionContractMap = Record<string, Record<string, OptionContract>>;

export interface OptionUnderlying {
  ask?: number;
  askSize?: number;
  bid?: number;
  bidSize?: number;
  change?: number;
  close?: number;
  delayed?: boolean;
  description?: string;
  exchangeName?: string;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  highPrice?: number;
  last?: number;
  lowPrice?: number;
  mark?: number;
  markChange?: number;
  markPercentChange?: number;
  openPrice?: number;
  percentChange?: number;
  quoteTime?: number;
  symbol?: string;
  totalVolume?: number;
  tradeTime?: number;
  [key: string]: unknown;
}

export interface OptionChainResponse {
  symbol?: string;
  status?: string;
  underlying?: OptionUnderlying;
  strategy?: OptionStrategy;
  interval?: number;
  isDelayed?: boolean;
  isIndex?: boolean;
  daysToExpiration?: number;
  interestRate?: number;
  underlyingPrice?: number;
  volatility?: number;
  callExpDateMap?: OptionContractMap;
  putExpDateMap?: OptionContractMap;
  [key: string]: unknown;
}

export interface OptionExpiration {
  expirationDate: string;
  daysToExpiration: number;
  expirationType?: string;
  standard?: boolean;
}

export interface OptionExpirationChainResponse {
  symbol?: string;
  isDelayed?: boolean;
  isIndex?: boolean;
  underlyingPrice?: number;
  strategy?: OptionStrategy;
  interval?: number;
  contractType?: OptionContractType;
  range?: OptionRange;
  numberOfContracts?: number;
  expirationList?: OptionExpiration[];
  [key: string]: unknown;
}

export type PeriodType = 'day' | 'month' | 'year' | 'ytd';
export type FrequencyType = 'minute' | 'daily' | 'weekly' | 'monthly';

export interface PriceHistoryCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number;
}

export interface PriceHistoryResponse {
  symbol?: string;
  empty?: boolean;
  previousClose?: number;
  previousCloseDate?: number;
  candles: PriceHistoryCandle[];
  [key: string]: unknown;
}

export interface MoverItem {
  change?: number;
  description?: string;
  direction?: 'up' | 'down';
  last?: number;
  symbol?: string;
  totalVolume?: number;
}

export interface MoversResponse {
  screeners: MoverItem[];
}

export interface MarketSessionTime {
  start: string;
  end: string;
}

export interface MarketSessionHours {
  preMarket?: MarketSessionTime[];
  regularMarket?: MarketSessionTime[];
  postMarket?: MarketSessionTime[];
  [key: string]: MarketSessionTime[] | undefined;
}

export interface MarketHoursProduct {
  date: string;
  marketType: string;
  product: string;
  productName?: string;
  isOpen: boolean;
  sessionHours: MarketSessionHours;
}

export type MarketHoursResponse = Record<string, Record<string, MarketHoursProduct>>;

export interface InstrumentSummary {
  cusip?: string;
  symbol?: string;
  description?: string;
  exchange?: string;
  assetType?: string;
  [key: string]: unknown;
}

export interface InstrumentsSearchResponse {
  instruments: InstrumentSummary[];
}

export type InstrumentProjection =
  | 'symbol-search'
  | 'symbol-regex'
  | 'desc-search'
  | 'desc-regex'
  | 'search'
  | 'fundamental';

export interface InstrumentDetail extends InstrumentSummary {}
