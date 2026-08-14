import { z } from 'zod';
import type { Order, PreviewOrderResponse } from '../types/trader.js';

const finiteNumber = z.number().finite();
const finiteNumberOptional = finiteNumber.optional();

export const StreamerInfoSchema = z.object({
  streamerSocketUrl: z.string().url(),
  schwabClientCustomerId: z.string().min(1),
  schwabClientCorrelId: z.string().min(1),
  schwabClientChannel: z.string().min(1),
  schwabClientFunctionId: z.string().min(1),
}).passthrough();

export const AccountNumberHashSchema = z.object({
  accountNumber: z.string().min(1),
  hashValue: z.string().min(1),
}).passthrough();

export const AccountNumberHashesSchema = z.array(AccountNumberHashSchema);

const InstrumentSchema = z.object({
  assetType: z.string().optional(),
  cusip: z.string().optional(),
  symbol: z.string().optional(),
  description: z.string().optional(),
  instrumentId: finiteNumberOptional,
  netChange: finiteNumberOptional,
  type: z.string().optional(),
}).passthrough();

const PositionSchema = z.object({
  shortQuantity: finiteNumberOptional,
  averagePrice: finiteNumberOptional,
  currentDayProfitLoss: finiteNumberOptional,
  currentDayProfitLossPercentage: finiteNumberOptional,
  longQuantity: finiteNumberOptional,
  instrument: InstrumentSchema.optional(),
  marketValue: finiteNumberOptional,
}).passthrough();

const BalanceSchema = z.object({}).passthrough();

export const SecuritiesAccountSchema = z.object({
  accountNumber: z.string().min(1),
  type: z.string().optional(),
  roundTrips: finiteNumberOptional,
  isDayTrader: z.boolean().optional(),
  isClosingOnlyRestricted: z.boolean().optional(),
  pfcbFlag: z.boolean().optional(),
  positions: z.array(PositionSchema).optional(),
  initialBalances: BalanceSchema.optional(),
  currentBalances: BalanceSchema.optional(),
  projectedBalances: BalanceSchema.optional(),
}).passthrough();

export const AccountResponseSchema = z.object({
  securitiesAccount: SecuritiesAccountSchema,
}).passthrough();

export const AccountsResponseSchema = z.array(AccountResponseSchema);

const OrderLegSchema = z.object({
  orderLegType: z.string().optional(),
  legId: finiteNumberOptional,
  instrument: InstrumentSchema.optional(),
  instruction: z.string().optional(),
  positionEffect: z.string().optional(),
  quantity: finiteNumberOptional,
  quantityType: z.string().optional(),
}).passthrough();

const ExecutionLegSchema = z.object({
  legId: finiteNumberOptional,
  price: finiteNumberOptional,
  quantity: finiteNumberOptional,
  mismarkedQuantity: finiteNumberOptional,
  instrumentId: finiteNumberOptional,
  time: z.string().optional(),
}).passthrough();

const OrderActivitySchema = z.object({
  activityType: z.string().optional(),
  executionType: z.string().optional(),
  quantity: finiteNumberOptional,
  orderRemainingQuantity: finiteNumberOptional,
  executionLegs: z.array(ExecutionLegSchema).optional(),
}).passthrough();

/**
 * Schwab order responses are recursive through childOrderStrategies. Keep the
 * runtime object open to additive broker fields while exposing the SDK's Order type.
 */
export const OrderSchema: z.ZodType<Order> = z.lazy(() => z.object({
  session: z.string().optional(),
  duration: z.string().optional(),
  orderType: z.string().optional(),
  complexOrderStrategyType: z.string().optional(),
  quantity: finiteNumberOptional,
  filledQuantity: finiteNumberOptional,
  remainingQuantity: finiteNumberOptional,
  stopPrice: finiteNumberOptional,
  price: finiteNumberOptional,
  orderLegCollection: z.array(OrderLegSchema).optional(),
  orderStrategyType: z.string().optional(),
  orderId: finiteNumberOptional,
  cancelable: z.boolean().optional(),
  editable: z.boolean().optional(),
  status: z.string().optional(),
  enteredTime: z.string().optional(),
  closeTime: z.string().optional(),
  tag: z.string().optional(),
  accountNumber: z.union([z.string(), finiteNumber]).optional(),
  orderActivityCollection: z.array(OrderActivitySchema).optional(),
  childOrderStrategies: z.array(OrderSchema).optional(),
  statusDescription: z.string().optional(),
}).passthrough()) as unknown as z.ZodType<Order>;

export const OrdersResponseSchema: z.ZodType<Order[]> = z.array(OrderSchema);

export const TransactionSchema = z.object({
  activityId: finiteNumberOptional,
  time: z.string().optional(),
  description: z.string().optional(),
  accountNumber: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  tradeDate: z.string().optional(),
  settlementDate: z.string().optional(),
  positionId: finiteNumberOptional,
  orderId: finiteNumberOptional,
  netAmount: finiteNumberOptional,
}).passthrough();

export const TransactionsResponseSchema = z.array(TransactionSchema);
export const TransactionOrArraySchema = z.union([TransactionSchema, TransactionsResponseSchema]);

const UserPreferenceAccountSchema = z.object({
  accountNumber: z.string().min(1),
  primaryAccount: z.boolean().optional(),
  type: z.string().optional(),
  nickName: z.string().optional(),
  accountColor: z.string().optional(),
  displayAcctId: z.string().optional(),
  autoPositionEffect: z.boolean().optional(),
}).passthrough();

const OfferInfoSchema = z.object({
  level2Permissions: z.boolean().optional(),
  mktDataPermission: z.string().optional(),
}).passthrough();

export const UserPreferenceSchema = z.object({
  accounts: z.array(UserPreferenceAccountSchema).optional(),
  streamerInfo: z.array(StreamerInfoSchema).optional(),
  offers: z.array(OfferInfoSchema).optional(),
}).passthrough();

export const UserPreferencesResponseSchema = z.union([
  UserPreferenceSchema,
  z.array(UserPreferenceSchema),
]);

const PreviewOrderResponseBaseSchema = z.object({
  orderStrategies: z.array(OrderSchema).optional(),
  projectedBalances: BalanceSchema.optional(),
  validations: z.unknown().optional(),
}).passthrough();

export const PreviewOrderResponseSchema = PreviewOrderResponseBaseSchema as unknown as z.ZodType<PreviewOrderResponse>;
