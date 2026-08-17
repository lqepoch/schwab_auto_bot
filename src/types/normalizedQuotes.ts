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

export interface QuoteFreshnessPolicy {
  /** Maximum accepted quote age before the snapshot is considered stale. */
  staleAfterMs: number;
  /** Maximum tolerated source timestamp lead over the local clock. Default: 1000ms. */
  maxFutureSkewMs?: number;
  /** Treat realtime=false as unusable for execution-sensitive reads. Default: true. */
  rejectDelayed?: boolean;
}

export type QuoteFreshnessReason =
  | 'fresh'
  | 'missing-source-time'
  | 'future-source-time'
  | 'stale-source-time'
  | 'delayed-source';

export interface QuoteFreshness {
  isFresh: boolean;
  reason: QuoteFreshnessReason;
  observedAt: number;
  sourceTime?: number;
  ageMs?: number;
}

export interface QuoteTimingInput {
  quoteTime?: number;
  tradeTime?: number;
  realtime?: boolean;
}

/**
 * Evaluate quote age with explicit clock-skew and delayed-feed semantics.
 * The quote timestamp is preferred over trade time because an actively quoted option can have
 * an old last trade while its NBBO remains current.
 */
export function evaluateQuoteFreshness(
  quote: QuoteTimingInput,
  policy: QuoteFreshnessPolicy,
  observedAt = Date.now(),
): QuoteFreshness {
  validateFreshnessPolicy(policy);

  if ((policy.rejectDelayed ?? true) && quote.realtime === false) {
    return { isFresh: false, reason: 'delayed-source', observedAt };
  }

  const sourceTime = finiteTimestamp(quote.quoteTime) ?? finiteTimestamp(quote.tradeTime);
  if (sourceTime === undefined) {
    return { isFresh: false, reason: 'missing-source-time', observedAt };
  }

  const rawAgeMs = observedAt - sourceTime;
  const maxFutureSkewMs = policy.maxFutureSkewMs ?? 1_000;
  if (rawAgeMs < -maxFutureSkewMs) {
    return {
      isFresh: false,
      reason: 'future-source-time',
      observedAt,
      sourceTime,
      ageMs: rawAgeMs,
    };
  }

  const ageMs = Math.max(0, rawAgeMs);
  if (ageMs > policy.staleAfterMs) {
    return {
      isFresh: false,
      reason: 'stale-source-time',
      observedAt,
      sourceTime,
      ageMs,
    };
  }

  return { isFresh: true, reason: 'fresh', observedAt, sourceTime, ageMs };
}

/** Return a quote only when it satisfies the caller's freshness policy. */
export function requireFreshOptionQuote(
  quote: NormalizedOptionQuote,
  policy: QuoteFreshnessPolicy,
  observedAt = Date.now(),
): NormalizedOptionQuote {
  const freshness = evaluateQuoteFreshness(quote, policy, observedAt);
  if (!freshness.isFresh) {
    throw new StaleQuoteError(quote.symbol, freshness);
  }
  return quote;
}

export class StaleQuoteError extends Error {
  constructor(
    public readonly symbol: string,
    public readonly freshness: QuoteFreshness,
  ) {
    super(`Quote rejected by freshness policy: ${freshness.reason}`);
    this.name = 'StaleQuoteError';
  }
}

function validateFreshnessPolicy(policy: QuoteFreshnessPolicy): void {
  if (!Number.isFinite(policy.staleAfterMs) || policy.staleAfterMs < 0) {
    throw new Error('Quote freshness staleAfterMs must be a non-negative finite number');
  }
  const skew = policy.maxFutureSkewMs ?? 1_000;
  if (!Number.isFinite(skew) || skew < 0) {
    throw new Error('Quote freshness maxFutureSkewMs must be a non-negative finite number');
  }
}

function finiteTimestamp(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}
