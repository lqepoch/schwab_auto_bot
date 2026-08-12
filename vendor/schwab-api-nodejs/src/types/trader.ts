export type Session =
  | 'NORMAL'
  | 'AM'
  | 'PM'
  | 'SEAMLESS'
  | (string & {});

export type Duration =
  | 'DAY'
  | 'GOOD_TILL_CANCEL'
  | 'FILL_OR_KILL'
  | 'IMMEDIATE_OR_CANCEL'
  | 'END_OF_DAY'
  | 'EXTENDED'
  | 'GOOD_TILL_DATE'
  | 'UNKNOWN'
  | (string & {});

export type OrderType =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP'
  | 'STOP_LIMIT'
  | 'TRAILING_STOP'
  | 'MARKET_ON_CLOSE'
  | 'LIMIT_ON_CLOSE'
  | 'EXERCISE'
  | 'TRAILING_STOP_LIMIT'
  | 'STOP_MARKET'
  | 'MARKET_ON_OPEN'
  | 'QUOTE'
  | 'UNKNOWN'
  | (string & {});

export type ComplexOrderStrategyType =
  | 'NONE'
  | 'COVERED'
  | 'VERTICAL'
  | 'BACK_RATIO'
  | 'CALENDAR'
  | 'DIAGONAL'
  | 'STRADDLE'
  | 'STRANGLE'
  | 'COLLAR_SYNTHETIC'
  | 'BUTTERFLY'
  | 'CONDOR'
  | 'IRON_CONDOR'
  | 'VERTICAL_ROLL'
  | 'COLLAR'
  | 'ROLL'
  | 'DOUBLE_DIAGONAL'
  | 'UNBALANCED_BUTTERFLY'
  | 'UNBALANCED_CONDOR'
  | 'UNBALANCED_IRON_CONDOR'
  | 'UNBALANCED_VERTICAL_ROLL'
  | 'CUSTOM'
  | (string & {});

export type OrderStatus =
  | 'AWAITING_PARENT_ORDER'
  | 'AWAITING_CONDITION'
  | 'AWAITING_STOP_CONDITION'
  | 'AWAITING_MANUAL_REVIEW'
  | 'ACCEPTED'
  | 'AWAITING_UR_OUT'
  | 'PENDING_ACTIVATION'
  | 'QUEUED'
  | 'WORKING'
  | 'REJECTED'
  | 'PENDING_CANCEL'
  | 'CANCELED'
  | 'PENDING_REPLACE'
  | 'REPLACED'
  | 'FILLED'
  | 'EXPIRED'
  | 'NEW'
  | 'AWAITING_RELEASE_TIME'
  | 'PENDING_ACKNOWLEDGEMENT'
  | 'PENDING_RECALL'
  | 'UNKNOWN'
  | (string & {});

export type Instruction =
  | 'BUY'
  | 'SELL'
  | 'BUY_TO_COVER'
  | 'SELL_SHORT'
  | 'BUY_TO_OPEN'
  | 'BUY_TO_CLOSE'
  | 'SELL_TO_OPEN'
  | 'SELL_TO_CLOSE'
  | 'EXCHANGE'
  | 'UNKNOWN'
  | (string & {});

export type PositionEffect =
  | 'OPENING'
  | 'CLOSING'
  | 'AUTOMATIC'
  | 'UNKNOWN'
  | (string & {});

export type AssetType =
  | 'EQUITY'
  | 'OPTION'
  | 'INDEX'
  | 'MUTUAL_FUND'
  | 'CASH_EQUIVALENT'
  | 'FIXED_INCOME'
  | 'CURRENCY'
  | 'FUTURE'
  | 'FUTURE_OPTION'
  | 'UNKNOWN'
  | (string & {});

export type TransactionType =
  | 'TRADE'
  | 'RECEIVE_AND_DELIVER'
  | 'DIVIDEND_OR_INTEREST'
  | 'ACH_RECEIPT'
  | 'ACH_DISBURSEMENT'
  | 'CASH_RECEIPT'
  | 'CASH_DISBURSEMENT'
  | 'ELECTRONIC_FUND'
  | 'WIRE_OUT'
  | 'WIRE_IN'
  | 'JOURNAL'
  | 'MEMORANDUM'
  | 'MARGIN_CALL'
  | 'MONEY_MARKET'
  | 'SMA_ADJUSTMENT'
  | (string & {});

export interface AccountNumberHash {
  accountNumber: string;
  hashValue: string;
}

export interface Instrument {
  assetType?: AssetType;
  cusip?: string;
  symbol?: string;
  description?: string;
  instrumentId?: number;
  netChange?: number;
  type?: string;
}

export interface Position {
  shortQuantity?: number;
  averagePrice?: number;
  currentDayProfitLoss?: number;
  currentDayProfitLossPercentage?: number;
  longQuantity?: number;
  settledLongQuantity?: number;
  settledShortQuantity?: number;
  agedQuantity?: number;
  instrument?: Instrument;
  marketValue?: number;
  maintenanceRequirement?: number;
  averageLongPrice?: number;
  averageShortPrice?: number;
  taxLotAverageLongPrice?: number;
  taxLotAverageShortPrice?: number;
  longOpenProfitLoss?: number;
  shortOpenProfitLoss?: number;
  previousSessionLongQuantity?: number;
  previousSessionShortQuantity?: number;
  currentDayCost?: number;
}

export interface InitialBalances {
  accruedInterest?: number;
  availableFundsNonMarginableTrade?: number;
  bondValue?: number;
  buyingPower?: number;
  cashBalance?: number;
  cashAvailableForTrading?: number;
  cashReceipts?: number;
  dayTradingBuyingPower?: number;
  dayTradingBuyingPowerCall?: number;
  dayTradingEquityCall?: number;
  equity?: number;
  equityPercentage?: number;
  liquidationValue?: number;
  longMarginValue?: number;
  longOptionMarketValue?: number;
  longStockValue?: number;
  maintenanceCall?: number;
  maintenanceRequirement?: number;
  margin?: number;
  marginEquity?: number;
  moneyMarketFund?: number;
  mutualFundValue?: number;
  regTCall?: number;
  shortMarginValue?: number;
  shortOptionMarketValue?: number;
  shortStockValue?: number;
  totalCash?: number;
  isInCall?: number;
  unsettledCash?: number;
  pendingDeposits?: number;
  marginBalance?: number;
  shortBalance?: number;
  accountValue?: number;
}

export interface CurrentBalances extends Partial<InitialBalances> {
  availableFunds?: number;
  buyingPowerNonMarginableTrade?: number;
  regTCall?: number;
  sma?: number;
  stockBuyingPower?: number;
  optionBuyingPower?: number;
}

export interface ProjectedBalances extends Partial<CurrentBalances> {}

export interface SecuritiesAccount {
  type?: string;
  accountNumber: string;
  roundTrips?: number;
  isDayTrader?: boolean;
  isClosingOnlyRestricted?: boolean;
  pfcbFlag?: boolean;
  positions?: Position[];
  initialBalances?: InitialBalances;
  currentBalances?: CurrentBalances;
  projectedBalances?: ProjectedBalances;
}

export interface AccountResponse {
  securitiesAccount: SecuritiesAccount;
}

export interface OrderLeg {
  orderLegType?: string;
  legId?: number;
  instrument?: Instrument;
  instruction?: Instruction;
  positionEffect?: PositionEffect;
  quantity?: number;
  quantityType?: string;
  divCapGains?: string;
  toSymbol?: string;
}

export interface ExecutionLeg {
  legId?: number;
  price?: number;
  quantity?: number;
  mismarkedQuantity?: number;
  instrumentId?: number;
  time?: string;
}

export interface OrderActivity {
  activityType?: 'EXECUTION' | 'ORDER_ACTION' | (string & {});
  executionType?: 'FILL' | 'PARTIAL_FILL' | (string & {});
  quantity?: number;
  orderRemainingQuantity?: number;
  executionLegs?: ExecutionLeg[];
}

export interface Order {
  session?: Session;
  duration?: Duration;
  orderType?: OrderType;
  cancelTime?: string;
  complexOrderStrategyType?: ComplexOrderStrategyType;
  quantity?: number;
  filledQuantity?: number;
  remainingQuantity?: number;
  requestedDestination?: string;
  destinationLinkName?: string;
  releaseTime?: string;
  stopPrice?: number;
  stopPriceLinkBasis?: string;
  stopPriceLinkType?: string;
  stopPriceOffset?: number;
  stopType?: string;
  priceLinkBasis?: string;
  priceLinkType?: string;
  price?: number;
  taxLotMethod?: string;
  orderLegCollection?: OrderLeg[];
  activationPrice?: number;
  specialInstruction?: string;
  orderStrategyType?: string;
  orderId?: number;
  cancelable?: boolean;
  editable?: boolean;
  status?: OrderStatus;
  enteredTime?: string;
  closeTime?: string;
  tag?: string;
  accountNumber?: string | number;
  orderActivityCollection?: OrderActivity[];
  replacingOrderCollection?: string[];
  childOrderStrategies?: Order[];
  statusDescription?: string;
}

export interface TransactionsQuery {
  startDate: string;
  endDate: string;
  symbol?: string;
  types: string;
}

export interface TransactionTransferItem {
  instrument?: Instrument;
  amount?: number;
  cost?: number;
  price?: number;
  feeType?: string;
  positionEffect?: PositionEffect;
}

export interface TransactionUser {
  cdDomainId?: string;
  login?: string;
  type?: string;
  userId?: number;
  systemUserName?: string;
  firstName?: string;
  lastName?: string;
  brokerRepCode?: string;
}

export interface Transaction {
  activityId?: number;
  time?: string;
  user?: TransactionUser;
  description?: string;
  accountNumber?: string;
  type?: TransactionType;
  status?: string;
  subAccount?: string;
  tradeDate?: string;
  settlementDate?: string;
  positionId?: number;
  orderId?: number;
  netAmount?: number;
  activityType?: string;
  transferItems?: TransactionTransferItem[];
}

export interface UserPreferenceAccount {
  accountNumber: string;
  primaryAccount?: boolean;
  type?: string;
  nickName?: string;
  accountColor?: string;
  displayAcctId?: string;
  autoPositionEffect?: boolean;
}

export interface StreamerInfo {
  streamerSocketUrl: string;
  schwabClientCustomerId: string;
  schwabClientCorrelId: string;
  schwabClientChannel: string;
  schwabClientFunctionId: string;
}

export interface OfferInfo {
  level2Permissions?: boolean;
  mktDataPermission?: string;
}

export interface UserPreference {
  accounts?: UserPreferenceAccount[];
  streamerInfo?: StreamerInfo[];
  offers?: OfferInfo[];
}

export interface PreviewOrderResponse {
  orderStrategies?: Order[];
  projectedBalances?: CurrentBalances;
  validations?: unknown;
}

/**
 * Metadata returned by a successful order mutation. Schwab returns an empty
 * body for order creation/replacement and places the new order link in the
 * `Location` response header instead.
 */
export interface MutationResult<T = undefined> {
  status: number;
  headers: Headers;
  body: T | undefined;
  location: string | null;
  orderId: string | null;
  correlationId: string | null;
}

export type OrderMutationResult<T = undefined> = MutationResult<T>;

export interface OrderPreviewRequest {
  orderStrategyType: string;
  session?: Session;
  duration?: Duration;
  orderType?: OrderType;
  cancelTime?: string;
  complexOrderStrategyType?: ComplexOrderStrategyType;
  quantity?: number;
  filledQuantity?: number;
  remainingQuantity?: number;
  requestedDestination?: string;
  price?: number;
  orderLegCollection: OrderLeg[];
  stopPrice?: number;
  stopPriceLinkBasis?: string;
  stopPriceLinkType?: string;
  stopPriceOffset?: number;
  stopType?: string;
  priceLinkBasis?: string;
  priceLinkType?: string;
  taxLotMethod?: string;
  specialInstruction?: string;
  activationPrice?: number;
  orderActivityCollection?: OrderActivity[];
  status?: OrderStatus;
  tag?: string;
}

export interface PlaceOrderRequest extends Order {}

export type ReplaceOrderRequest = Order;

export interface CancelOrderRequest {
  id?: number;
  order?: Order;
}
