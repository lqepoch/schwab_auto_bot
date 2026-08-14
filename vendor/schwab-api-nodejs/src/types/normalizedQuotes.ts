export interface NormalizedOptionQuote {
  symbol: string;
  underlying?: string;
  contractType?: 'CALL' | 'PUT';
  expiration?: string;
  strike?: number;
  realtime?: boolean;
  quoteType?: string;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  mark?: number;
  last?: number;
  mid?: number;
  spread?: number;
  spreadPercentOfMid?: number;
  quoteTime?: number;
  tradeTime?: number;
  quoteAgeMs?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  volatility?: number;
  openInterest?: number;
  totalVolume?: number;
  underlyingPrice?: number;
  theoreticalOptionValue?: number;
  timeValue?: number;
  intrinsicValue?: number;
}

/**
 * Synthetic vertical quote derived from the individual-leg NBBO/quote response.
 * This is an analytical reference and is not a native complex-order-book quote.
 */
export interface DerivedVerticalOptionQuote {
  buy: NormalizedOptionQuote;
  sell: NormalizedOptionQuote;
  /** Buy-leg bid minus sell-leg ask. */
  derivedBid?: number;
  /** Buy-leg ask minus sell-leg bid. */
  derivedAsk?: number;
  /** Midpoint between derivedBid and derivedAsk when both are available. */
  derivedMid?: number;
  /** derivedAsk - derivedBid when both are available. */
  derivedSpread?: number;
  /** Maximum age among the two quote timestamps. */
  quoteAgeMs?: number;
  sameUnderlying: boolean;
  sameExpiration: boolean;
  sameContractType: boolean;
}
