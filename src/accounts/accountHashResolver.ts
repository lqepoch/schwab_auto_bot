import type { AccountNumberHash } from '../types/trader.js';

/** Minimal source contract so the resolver is easy to test and does not own HTTP concerns. */
export interface AccountNumberHashSource {
  getAccountNumbers(): Promise<AccountNumberHash[]>;
}

export interface AccountHashResolverOptions {
  /** How long one successful account-number mapping remains usable. Default: 5 minutes. */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

interface CachedAccountHash {
  hashValue: string;
  expiresAt: number;
}

/**
 * Resolves Schwab plaintext account numbers into the hash values required by Trader endpoints.
 *
 * Properties important to trading runtimes:
 * - bounded TTL prevents permanently retaining a stale account mapping;
 * - concurrent misses share one broker request instead of creating a request burst;
 * - refresh replaces the full cache atomically, so removed accounts disappear together;
 * - error messages redact account numbers to avoid leaking credentials/identifiers into logs.
 */
export class AccountHashResolver {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache = new Map<string, CachedAccountHash>();
  private refreshInFlight?: Promise<void>;

  constructor(
    private readonly source: AccountNumberHashSource,
    options: AccountHashResolverOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('AccountHashResolver ttlMs must be a positive finite number');
    }
  }

  async resolve(accountNumber: string): Promise<string> {
    const normalized = normalizeAccountNumber(accountNumber);
    const cached = this.cache.get(normalized);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return cached.hashValue;
    }

    await this.refresh();
    const refreshed = this.cache.get(normalized);
    if (!refreshed || refreshed.expiresAt <= this.now()) {
      throw new AccountHashNotFoundError(redactAccountNumber(normalized));
    }
    return refreshed.hashValue;
  }

  async resolveMany(accountNumbers: readonly string[]): Promise<Map<string, string>> {
    const normalized = [...new Set(accountNumbers.map(normalizeAccountNumber))];
    if (normalized.length === 0) return new Map();

    const now = this.now();
    const hasMiss = normalized.some((accountNumber) => {
      const cached = this.cache.get(accountNumber);
      return !cached || cached.expiresAt <= now;
    });
    if (hasMiss) await this.refresh();

    const result = new Map<string, string>();
    for (const accountNumber of normalized) {
      const cached = this.cache.get(accountNumber);
      if (!cached || cached.expiresAt <= this.now()) {
        throw new AccountHashNotFoundError(redactAccountNumber(accountNumber));
      }
      result.set(accountNumber, cached.hashValue);
    }
    return result;
  }

  /** Remove one mapping, or every mapping when no account number is supplied. */
  invalidate(accountNumber?: string): void {
    if (accountNumber === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(normalizeAccountNumber(accountNumber));
  }

  /** Force one shared broker refresh and replace the cache with the returned account set. */
  async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = this.loadMappings();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async loadMappings(): Promise<void> {
    const mappings = await this.source.getAccountNumbers();
    const expiresAt = this.now() + this.ttlMs;
    const next = new Map<string, CachedAccountHash>();

    for (const mapping of mappings) {
      const accountNumber = normalizeAccountNumber(mapping.accountNumber);
      const hashValue = normalizeHashValue(mapping.hashValue);
      if (next.has(accountNumber)) {
        throw new Error(`Duplicate Schwab account mapping returned for ${redactAccountNumber(accountNumber)}`);
      }
      next.set(accountNumber, { hashValue, expiresAt });
    }

    this.cache = next;
  }
}

export class AccountHashNotFoundError extends Error {
  constructor(public readonly redactedAccountNumber: string) {
    super(`No Schwab account hash mapping found for ${redactedAccountNumber}`);
    this.name = 'AccountHashNotFoundError';
  }
}

function normalizeAccountNumber(accountNumber: string): string {
  const normalized = accountNumber.trim();
  if (!normalized) throw new Error('Schwab account number must not be empty');
  return normalized;
}

function normalizeHashValue(hashValue: string): string {
  const normalized = hashValue.trim();
  if (!normalized) throw new Error('Schwab account hash value must not be empty');
  return normalized;
}

function redactAccountNumber(accountNumber: string): string {
  if (accountNumber.length <= 4) return '****';
  return `${'*'.repeat(Math.min(accountNumber.length - 4, 8))}${accountNumber.slice(-4)}`;
}
