import { AccountHashResolver, type AccountHashResolverOptions } from '../accounts/accountHashResolver.ts';
import { MarketDataApiClient } from '../clients/marketData.ts';
import { TraderApiClient, type AccountsQuery, type OrdersQuery } from '../clients/trader.ts';
import type { HttpResponse } from '../utils/httpClient.ts';
import type {
  AccountResponse,
  Order,
} from '../types/trader.ts';
import type {
  QuoteFieldRoot,
  QuotesResponse,
  SingleQuoteResponse,
} from '../types/marketData.ts';

/** Metadata retained by every read-only gateway operation. */
export type ReadOnlyGatewayMetadata = Omit<HttpResponse<unknown>, 'body'>;

/** A typed read result whose transport metadata remains available to callers. */
export interface ReadOnlyGatewayResponse<T> {
  data: T;
  metadata: ReadOnlyGatewayMetadata;
}

export interface SchwabGatewayOptions {
  /** Inject a resolver for deterministic tests or an application-owned cache. */
  accountHashResolver?: AccountHashResolver;
  accountHashResolverOptions?: AccountHashResolverOptions;
}

/**
 * Explicit read-only boundary for account, order, and market-data access.
 *
 * Account-specific methods accept plaintext account numbers and resolve the
 * broker-required hash internally. This class intentionally exposes no place,
 * preview, replace, or cancel operation: trading mutations remain on the
 * existing TraderApiClient/coordinator path and retain its safety semantics.
 */
export class SchwabGateway {
  readonly accountHashResolver: AccountHashResolver;

  constructor(
    private readonly trader: TraderApiClient,
    private readonly marketData: MarketDataApiClient,
    options: SchwabGatewayOptions = {},
  ) {
    this.accountHashResolver =
      options.accountHashResolver ?? new AccountHashResolver(trader, options.accountHashResolverOptions);
  }

  async resolveAccountHash(accountNumber: string): Promise<string> {
    return this.accountHashResolver.resolve(accountNumber);
  }

  async refreshAccountHashes(): Promise<void> {
    await this.accountHashResolver.refresh();
  }

  invalidateAccountHash(accountNumber?: string): void {
    this.accountHashResolver.invalidate(accountNumber);
  }

  async getAccounts(params: AccountsQuery = {}): Promise<ReadOnlyGatewayResponse<AccountResponse[]>> {
    return toReadOnlyResponse(await this.trader.getAccountsWithResponse(params));
  }

  async getAccount(
    accountNumber: string,
    params: AccountsQuery = {},
  ): Promise<ReadOnlyGatewayResponse<AccountResponse>> {
    const accountHash = await this.resolveAccountHash(accountNumber);
    return toReadOnlyResponse(await this.trader.getAccountWithResponse(accountHash, params));
  }

  async getOrders(
    accountNumber: string,
    params: OrdersQuery,
  ): Promise<ReadOnlyGatewayResponse<Order[]>> {
    const accountHash = await this.resolveAccountHash(accountNumber);
    return toReadOnlyResponse(await this.trader.getOrdersWithResponse(accountHash, params));
  }

  async getOrder(
    accountNumber: string,
    orderId: number | string,
  ): Promise<ReadOnlyGatewayResponse<Order>> {
    const accountHash = await this.resolveAccountHash(accountNumber);
    return toReadOnlyResponse(await this.trader.getOrderWithResponse(accountHash, orderId));
  }

  async getQuotes(params: {
    symbols: string | readonly string[];
    fields?: readonly QuoteFieldRoot[] | string;
    indicative?: boolean;
  }): Promise<ReadOnlyGatewayResponse<QuotesResponse>> {
    return toReadOnlyResponse(await this.marketData.getQuotesWithResponse(params));
  }

  async getQuote(
    symbol: string,
    params: { fields?: readonly QuoteFieldRoot[] | string } = {},
  ): Promise<ReadOnlyGatewayResponse<SingleQuoteResponse>> {
    return toReadOnlyResponse(await this.marketData.getQuoteWithResponse(symbol, params));
  }
}

function toReadOnlyResponse<T>(response: HttpResponse<T>): ReadOnlyGatewayResponse<T> {
  const { body, ...metadata } = response;
  return { data: body, metadata };
}
