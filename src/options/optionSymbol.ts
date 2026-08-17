export type SchwabOptionContractType = 'CALL' | 'PUT' | 'C' | 'P';

export interface SchwabOptionSymbolInput {
  /** Underlying/root symbol. Schwab option symbology reserves six characters. */
  underlying: string;
  /** Expiration in YYYY-MM-DD, YYMMDD, or Date form. */
  expiration: string | Date;
  contractType: SchwabOptionContractType;
  /** Strike price in dollars. Schwab encodes strike * 1000 into eight digits. */
  strike: number;
}

export interface ParsedSchwabOptionSymbol {
  underlying: string;
  expiration: string;
  contractType: 'CALL' | 'PUT';
  strike: number;
  raw: string;
}

const OPTION_SYMBOL_PATTERN = /^(.{6})(\d{6})([CP])(\d{8})$/;
const MAX_STRIKE = 99_999.999;

/**
 * Format an equity/index option symbol using Schwab's documented 6+6+1+8 layout.
 *
 * Example: `QQQ   260814P00740000`.
 */
export function formatSchwabOptionSymbol(input: SchwabOptionSymbolInput): string {
  const underlying = normalizeUnderlying(input.underlying);
  const expiration = normalizeExpiration(input.expiration);
  const contractType = normalizeContractType(input.contractType);
  const strike = normalizeStrike(input.strike);
  const encodedStrike = Math.round(strike * 1_000).toString().padStart(8, '0');
  return `${underlying.padEnd(6, ' ')}${expiration}${contractType}${encodedStrike}`;
}

/** Parse and validate a Schwab option symbol. */
export function parseSchwabOptionSymbol(symbol: string): ParsedSchwabOptionSymbol {
  if (typeof symbol !== 'string') {
    throw new TypeError('Option symbol must be a string');
  }
  const match = OPTION_SYMBOL_PATTERN.exec(symbol);
  if (!match) {
    throw new Error(`Invalid Schwab option symbol: ${symbol}`);
  }

  const [, paddedUnderlying, compactExpiration, contractCode, strikeDigits] = match;
  const underlying = paddedUnderlying.trimEnd();
  if (!underlying) {
    throw new Error(`Invalid Schwab option symbol underlying: ${symbol}`);
  }
  const expiration = compactExpirationToIso(compactExpiration);
  const strike = Number(strikeDigits) / 1_000;
  normalizeStrike(strike);

  return {
    underlying,
    expiration,
    contractType: contractCode === 'C' ? 'CALL' : 'PUT',
    strike,
    raw: symbol,
  };
}

/** Return true when the value is a strictly valid Schwab option symbol. */
export function isSchwabOptionSymbol(symbol: string): boolean {
  try {
    parseSchwabOptionSymbol(symbol);
    return true;
  } catch {
    return false;
  }
}

function normalizeUnderlying(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Underlying must be a string');
  const underlying = value.trim().toUpperCase();
  if (!underlying) throw new Error('Underlying is required');
  if (underlying.length > 6) {
    throw new Error(`Underlying exceeds Schwab's six-character option root: ${underlying}`);
  }
  if (/\s/.test(underlying)) {
    throw new Error('Underlying cannot contain whitespace');
  }
  return underlying;
}

function normalizeContractType(value: SchwabOptionContractType): 'C' | 'P' {
  const normalized = String(value).toUpperCase();
  if (normalized === 'CALL' || normalized === 'C') return 'C';
  if (normalized === 'PUT' || normalized === 'P') return 'P';
  throw new Error(`Unsupported option contract type: ${String(value)}`);
}

function normalizeStrike(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_STRIKE) {
    throw new Error(`Invalid option strike: ${String(value)}`);
  }
  const encoded = value * 1_000;
  if (Math.abs(encoded - Math.round(encoded)) > 1e-7) {
    throw new Error('Option strike supports at most three decimal places');
  }
  return value;
}

function normalizeExpiration(value: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid option expiration date');
    return `${String(value.getUTCFullYear()).slice(-2)}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}`;
  }

  const text = value.trim();
  if (/^\d{6}$/.test(text)) {
    compactExpirationToIso(text);
    return text;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!iso) throw new Error(`Invalid option expiration: ${value}`);
  const [, year, month, day] = iso;
  validateCalendarDate(Number(year), Number(month), Number(day));
  return `${year.slice(-2)}${month}${day}`;
}

function compactExpirationToIso(value: string): string {
  const year = 2_000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  validateCalendarDate(year, month, day);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function validateCalendarDate(year: number, month: number, day: number): void {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${year}-${month}-${day}`);
  }
}
