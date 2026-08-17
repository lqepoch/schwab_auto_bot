import { z } from 'zod';
import type {
  InstrumentDetail,
  InstrumentsSearchResponse,
  MarketHoursResponse,
  MoversResponse,
  OptionChainResponse,
  OptionExpirationChainResponse,
  PriceHistoryResponse,
  QuoteItem,
  QuotesResponse,
  SingleQuoteResponse,
} from '../types/marketData.ts';

const finiteNumber = z.number().finite();
const finiteNumberOptional = finiteNumber.optional();
const nonEmptyStringOptional = z.string().min(1).optional();

const QuoteReferenceSchema = z.object({
  cusip: nonEmptyStringOptional,
  description: z.string().optional(),
  exchange: z.string().optional(),
  exchangeName: z.string().optional(),
}).passthrough();

const QuoteDetailSchema = z.object({
  askPrice: finiteNumberOptional,
  askSize: finiteNumberOptional,
  askTime: finiteNumberOptional,
  bidPrice: finiteNumberOptional,
  bidSize: finiteNumberOptional,
  bidTime: finiteNumberOptional,
  lastPrice: finiteNumberOptional,
  lastSize: finiteNumberOptional,
  mark: finiteNumberOptional,
  quoteTime: finiteNumberOptional,
  tradeTime: finiteNumberOptional,
  totalVolume: finiteNumberOptional,
  volatility: finiteNumberOptional,
}).passthrough();

const QuoteLooseSectionSchema = z.object({}).passthrough();

export const QuoteItemSchema: z.ZodType<QuoteItem> = z.object({
  assetMainType: z.string().optional(),
  assetSubType: z.string().optional(),
  symbol: z.string().min(1),
  quoteType: z.string().optional(),
  realtime: z.boolean().optional(),
  ssid: finiteNumberOptional,
  reference: QuoteReferenceSchema.optional(),
  quote: QuoteDetailSchema.optional(),
  regular: QuoteLooseSectionSchema.optional(),
  fundamental: QuoteLooseSectionSchema.optional(),
  extended: QuoteLooseSectionSchema.optional(),
}).passthrough();

export const QuotesResponseSchema: z.ZodType<QuotesResponse> = z.record(
  z.string(),
  QuoteItemSchema,
);

export const SingleQuoteResponseSchema: z.ZodType<SingleQuoteResponse> = z.object({
  symbol: z.string().optional(),
  empty: z.boolean().optional(),
  previousClose: finiteNumberOptional,
  previousCloseDate: finiteNumberOptional,
  candles: z.array(z.object({
    open: finiteNumber,
    high: finiteNumber,
    low: finiteNumber,
    close: finiteNumber,
    volume: finiteNumber,
    datetime: finiteNumber,
  }).passthrough()).optional(),
}).passthrough();

const OptionContractSchema = z.object({
  putCall: z.enum(['PUT', 'CALL']).optional(),
  symbol: z.string().optional(),
  bidPrice: finiteNumberOptional,
  askPrice: finiteNumberOptional,
  markPrice: finiteNumberOptional,
  strikePrice: finiteNumberOptional,
  expirationDate: z.string().optional(),
  multiplier: finiteNumberOptional,
  isNonStandard: z.boolean().optional(),
}).passthrough();

const OptionContractMapSchema = z.record(
  z.string(),
  z.record(z.string(), OptionContractSchema),
);

export const OptionChainResponseSchema: z.ZodType<OptionChainResponse> = z.object({
  symbol: z.string().optional(),
  status: z.string().optional(),
  isDelayed: z.boolean().optional(),
  isIndex: z.boolean().optional(),
  underlyingPrice: finiteNumberOptional,
  callExpDateMap: OptionContractMapSchema.optional(),
  putExpDateMap: OptionContractMapSchema.optional(),
}).passthrough();

export const OptionExpirationChainResponseSchema: z.ZodType<OptionExpirationChainResponse> = z.object({
  symbol: z.string().optional(),
  isDelayed: z.boolean().optional(),
  isIndex: z.boolean().optional(),
  underlyingPrice: finiteNumberOptional,
  expirationList: z.array(z.object({
    expirationDate: z.string().min(1),
    daysToExpiration: finiteNumber,
    expirationType: z.string().optional(),
    standard: z.boolean().optional(),
  }).passthrough()).optional(),
}).passthrough();

export const PriceHistoryResponseSchema: z.ZodType<PriceHistoryResponse> = z.object({
  symbol: z.string().optional(),
  empty: z.boolean().optional(),
  previousClose: finiteNumberOptional,
  previousCloseDate: finiteNumberOptional,
  candles: z.array(z.object({
    open: finiteNumber,
    high: finiteNumber,
    low: finiteNumber,
    close: finiteNumber,
    volume: finiteNumber,
    datetime: finiteNumber,
  })),
}).passthrough();

export const MoversResponseSchema: z.ZodType<MoversResponse> = z.object({
  screeners: z.array(z.object({
    change: finiteNumberOptional,
    description: z.string().optional(),
    direction: z.enum(['up', 'down']).optional(),
    last: finiteNumberOptional,
    symbol: z.string().optional(),
    totalVolume: finiteNumberOptional,
  }).passthrough()),
}).passthrough();

const MarketSessionTimeSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
});

const MarketSessionHoursSchema = z.record(
  z.string(),
  z.array(MarketSessionTimeSchema).optional(),
);

const MarketHoursProductSchema = z.object({
  date: z.string().min(1),
  marketType: z.string().min(1),
  product: z.string().min(1),
  productName: z.string().optional(),
  isOpen: z.boolean(),
  sessionHours: MarketSessionHoursSchema,
}).passthrough();

export const MarketHoursResponseSchema: z.ZodType<MarketHoursResponse> = z.record(
  z.string(),
  z.record(z.string(), MarketHoursProductSchema),
);

const InstrumentSummarySchema = z.object({
  cusip: z.string().optional(),
  symbol: z.string().optional(),
  description: z.string().optional(),
  exchange: z.string().optional(),
  assetType: z.string().optional(),
}).passthrough();

export const InstrumentsSearchResponseSchema: z.ZodType<InstrumentsSearchResponse> = z.object({
  instruments: z.array(InstrumentSummarySchema),
}).passthrough();

export const InstrumentDetailSchema: z.ZodType<InstrumentDetail> = InstrumentSummarySchema;
