import {
  STREAMER_SERVICE_CONTRACTS,
  type StreamerDeliveryMode,
  type StreamerOrderingEvidence,
  type StreamerService,
} from '../types/streamerContracts.js';

export type RestClientName = 'TraderApiClient' | 'MarketDataApiClient';

export interface RestContractManifestEntry {
  client: RestClientName;
  method: string;
  responseMethod?: string;
  httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** Null means the documented mutation has no response body schema by design. */
  runtimeSchema: string | null;
}

/**
 * Local REST parity manifest. It is intentionally maintained next to the
 * wrapper code because the repository does not consume a remote OpenAPI
 * document. Tests verify every named client/schema symbol exists.
 */
export const REST_CONTRACT_MANIFEST = [
  { client: 'TraderApiClient', method: 'getAccountNumbers', responseMethod: 'getAccountNumbersWithResponse', httpMethod: 'GET', path: '/accounts/accountNumbers', runtimeSchema: 'AccountNumberHashesSchema' },
  { client: 'TraderApiClient', method: 'getAccounts', responseMethod: 'getAccountsWithResponse', httpMethod: 'GET', path: '/accounts', runtimeSchema: 'AccountsResponseSchema' },
  { client: 'TraderApiClient', method: 'getAccount', responseMethod: 'getAccountWithResponse', httpMethod: 'GET', path: '/accounts/{accountNumber}', runtimeSchema: 'AccountResponseSchema' },
  { client: 'TraderApiClient', method: 'getOrders', responseMethod: 'getOrdersWithResponse', httpMethod: 'GET', path: '/accounts/{accountNumber}/orders', runtimeSchema: 'OrdersResponseSchema' },
  { client: 'TraderApiClient', method: 'getOrder', responseMethod: 'getOrderWithResponse', httpMethod: 'GET', path: '/accounts/{accountNumber}/orders/{orderId}', runtimeSchema: 'OrderSchema' },
  { client: 'TraderApiClient', method: 'getOrdersAcrossAccounts', responseMethod: 'getOrdersAcrossAccountsWithResponse', httpMethod: 'GET', path: '/orders', runtimeSchema: 'OrdersResponseSchema' },
  { client: 'TraderApiClient', method: 'getTransactions', responseMethod: 'getTransactionsWithResponse', httpMethod: 'GET', path: '/accounts/{accountNumber}/transactions', runtimeSchema: 'TransactionsResponseSchema' },
  { client: 'TraderApiClient', method: 'getTransaction', responseMethod: 'getTransactionWithResponse', httpMethod: 'GET', path: '/accounts/{accountNumber}/transactions/{transactionId}', runtimeSchema: 'TransactionOrArraySchema' },
  { client: 'TraderApiClient', method: 'getUserPreferences', responseMethod: 'getUserPreferencesWithResponse', httpMethod: 'GET', path: '/userPreference', runtimeSchema: 'UserPreferencesResponseSchema' },
  { client: 'TraderApiClient', method: 'previewOrder', httpMethod: 'POST', path: '/accounts/{accountNumber}/previewOrder', runtimeSchema: 'PreviewOrderResponseSchema' },
  { client: 'TraderApiClient', method: 'placeOrder', httpMethod: 'POST', path: '/accounts/{accountNumber}/orders', runtimeSchema: null },
  { client: 'TraderApiClient', method: 'replaceOrder', httpMethod: 'PUT', path: '/accounts/{accountNumber}/orders/{orderId}', runtimeSchema: null },
  { client: 'TraderApiClient', method: 'cancelOrder', httpMethod: 'DELETE', path: '/accounts/{accountNumber}/orders/{orderId}', runtimeSchema: null },
  { client: 'MarketDataApiClient', method: 'getQuotes', responseMethod: 'getQuotesWithResponse', httpMethod: 'GET', path: '/quotes', runtimeSchema: 'QuotesResponseSchema' },
  { client: 'MarketDataApiClient', method: 'getQuote', responseMethod: 'getQuoteWithResponse', httpMethod: 'GET', path: '/{symbol}/quotes', runtimeSchema: 'SingleQuoteResponseSchema' },
  { client: 'MarketDataApiClient', method: 'getOptionChains', responseMethod: 'getOptionChainsWithResponse', httpMethod: 'GET', path: '/chains', runtimeSchema: 'OptionChainResponseSchema' },
  { client: 'MarketDataApiClient', method: 'getOptionExpirationChain', responseMethod: 'getOptionExpirationChainWithResponse', httpMethod: 'GET', path: '/expirationchain', runtimeSchema: 'OptionExpirationChainResponseSchema' },
  { client: 'MarketDataApiClient', method: 'getPriceHistory', responseMethod: 'getPriceHistoryWithResponse', httpMethod: 'GET', path: '/pricehistory', runtimeSchema: 'PriceHistoryResponseSchema' },
  { client: 'MarketDataApiClient', method: 'getMovers', responseMethod: 'getMoversWithResponse', httpMethod: 'GET', path: '/movers/{symbolId}', runtimeSchema: 'MoversResponseSchema' },
  { client: 'MarketDataApiClient', method: 'getMarkets', responseMethod: 'getMarketsWithResponse', httpMethod: 'GET', path: '/markets', runtimeSchema: 'MarketHoursResponseSchema' },
  { client: 'MarketDataApiClient', method: 'getMarketHours', responseMethod: 'getMarketHoursWithResponse', httpMethod: 'GET', path: '/markets/{marketId}', runtimeSchema: 'MarketHoursResponseSchema' },
  { client: 'MarketDataApiClient', method: 'searchInstruments', responseMethod: 'searchInstrumentsWithResponse', httpMethod: 'GET', path: '/instruments', runtimeSchema: 'InstrumentsSearchResponseSchema' },
  { client: 'MarketDataApiClient', method: 'getInstrumentByCusip', responseMethod: 'getInstrumentByCusipWithResponse', httpMethod: 'GET', path: '/instruments/{cusip}', runtimeSchema: 'InstrumentDetailSchema' },
] as const satisfies readonly RestContractManifestEntry[];

export interface StreamerContractManifestEntry {
  service: StreamerService;
  delivery: StreamerDeliveryMode;
  ordering: StreamerOrderingEvidence;
  fieldRange: readonly [number, number];
}

/** Explicit field ranges from the bundled Schwab Data API document. */
export const STREAMER_CONTRACT_MANIFEST = [
  { service: 'LEVELONE_EQUITIES', delivery: 'change', ordering: 'timestamp', fieldRange: [0, 54] },
  { service: 'LEVELONE_OPTIONS', delivery: 'change', ordering: 'timestamp', fieldRange: [0, 55] },
  { service: 'LEVELONE_FUTURES', delivery: 'change', ordering: 'timestamp', fieldRange: [0, 40] },
  { service: 'LEVELONE_FUTURES_OPTIONS', delivery: 'change', ordering: 'timestamp', fieldRange: [0, 31] },
  { service: 'LEVELONE_FOREX', delivery: 'change', ordering: 'timestamp', fieldRange: [0, 29] },
  { service: 'NYSE_BOOK', delivery: 'whole', ordering: 'timestamp', fieldRange: [0, 3] },
  { service: 'NASDAQ_BOOK', delivery: 'whole', ordering: 'timestamp', fieldRange: [0, 3] },
  { service: 'OPTIONS_BOOK', delivery: 'whole', ordering: 'timestamp', fieldRange: [0, 3] },
  { service: 'CHART_EQUITY', delivery: 'all-sequence', ordering: 'sequence', fieldRange: [0, 8] },
  { service: 'CHART_FUTURES', delivery: 'all-sequence', ordering: 'timestamp', fieldRange: [0, 6] },
  { service: 'SCREENER_EQUITY', delivery: 'whole', ordering: 'timestamp', fieldRange: [0, 4] },
  { service: 'SCREENER_OPTION', delivery: 'whole', ordering: 'timestamp', fieldRange: [0, 4] },
  { service: 'ACCT_ACTIVITY', delivery: 'all-sequence', ordering: 'sequence', fieldRange: [0, 3] },
] as const satisfies readonly StreamerContractManifestEntry[];

export const READ_ONLY_GATEWAY_METHODS = [
  'getAccounts',
  'getAccount',
  'getOrders',
  'getOrder',
  'getQuotes',
  'getQuote',
] as const;

export function expectedFieldIds(range: readonly [number, number]): string[] {
  const [first, last] = range;
  return Array.from({ length: last - first + 1 }, (_, index) => String(first + index));
}

export function manifestServiceNames(): readonly string[] {
  return STREAMER_CONTRACT_MANIFEST.map((entry) => entry.service);
}

// Keep the imported contract referenced in this module so a future removal of
// a service cannot leave the manifest looking valid to consumers by accident.
export const MANIFEST_SERVICE_COUNT = Object.keys(STREAMER_SERVICE_CONTRACTS).length;
