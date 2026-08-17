import type {
  Duration,
  Instruction,
  Order,
  OrderLeg,
  PlaceOrderRequest,
  Session,
} from '../types/trader.js';
import { parseSchwabOptionSymbol } from '../options/optionSymbol.js';

export type NetOrderType = 'NET_DEBIT' | 'NET_CREDIT' | 'NET_ZERO';
export type EquityInstruction = 'BUY' | 'SELL' | 'BUY_TO_COVER' | 'SELL_SHORT';
export type OptionInstruction = 'BUY_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN' | 'SELL_TO_CLOSE';

interface BaseOrderOptions {
  session?: Session;
  duration?: Duration;
  tag?: string;
}

export interface EquityOrderOptions extends BaseOrderOptions {
  symbol: string;
  quantity: number;
  instruction: EquityInstruction;
  orderType: 'MARKET' | 'LIMIT';
  price?: number;
}

export interface SingleOptionOrderOptions extends BaseOrderOptions {
  symbol: string;
  quantity: number;
  instruction: OptionInstruction;
  orderType: 'MARKET' | 'LIMIT';
  price?: number;
}

export interface VerticalOptionOrderOptions extends BaseOrderOptions {
  buySymbol: string;
  sellSymbol: string;
  quantity: number;
  buyInstruction: Extract<OptionInstruction, 'BUY_TO_OPEN' | 'BUY_TO_CLOSE'>;
  sellInstruction: Extract<OptionInstruction, 'SELL_TO_OPEN' | 'SELL_TO_CLOSE'>;
  orderType: NetOrderType;
  /** Absolute net price in dollars. Omit only for NET_ZERO. */
  price?: number;
}

export interface EquityTrailingStopOptions extends BaseOrderOptions {
  symbol: string;
  quantity: number;
  instruction?: Extract<EquityInstruction, 'SELL' | 'BUY_TO_COVER'>;
  stopPriceLinkBasis?: string;
  stopPriceLinkType?: 'VALUE' | 'PERCENT' | 'TICK';
  stopPriceOffset: number;
}

/** Build and validate a market/limit equity order. */
export function buildEquityOrder(options: EquityOrderOptions): PlaceOrderRequest {
  const symbol = requireSymbol(options.symbol, 'equity');
  const quantity = requirePositiveQuantity(options.quantity);
  const price = priceForSimpleOrder(options.orderType, options.price);
  const order: PlaceOrderRequest = {
    orderStrategyType: 'SINGLE',
    orderType: options.orderType,
    session: options.session ?? 'NORMAL',
    duration: options.duration ?? 'DAY',
    orderLegCollection: [buildLeg(options.instruction, quantity, symbol, 'EQUITY')],
    ...(price === undefined ? {} : { price }),
    ...(options.tag ? { tag: options.tag } : {}),
  };
  return order;
}

/** Build and validate a market/limit single-leg option order. */
export function buildSingleOptionOrder(options: SingleOptionOrderOptions): PlaceOrderRequest {
  const symbol = requireOptionSymbol(options.symbol);
  const quantity = requirePositiveQuantity(options.quantity);
  const price = priceForSimpleOrder(options.orderType, options.price);
  const order: PlaceOrderRequest = {
    orderStrategyType: 'SINGLE',
    complexOrderStrategyType: 'NONE',
    orderType: options.orderType,
    session: options.session ?? 'NORMAL',
    duration: options.duration ?? 'DAY',
    orderLegCollection: [buildLeg(options.instruction, quantity, symbol, 'OPTION')],
    ...(price === undefined ? {} : { price }),
    ...(options.tag ? { tag: options.tag } : {}),
  };
  return order;
}

/**
 * Build a two-leg vertical option order.
 * The two contracts must share underlying, expiration, and put/call type and must use different strikes.
 */
export function buildVerticalOptionOrder(options: VerticalOptionOrderOptions): PlaceOrderRequest {
  const buy = parseSchwabOptionSymbol(requireOptionSymbol(options.buySymbol));
  const sell = parseSchwabOptionSymbol(requireOptionSymbol(options.sellSymbol));
  validateVerticalPair(buy, sell);
  validateOpenClosePair(options.buyInstruction, options.sellInstruction);
  const quantity = requirePositiveQuantity(options.quantity);
  const price = priceForNetOrder(options.orderType, options.price);

  return {
    orderStrategyType: 'SINGLE',
    complexOrderStrategyType: 'VERTICAL',
    orderType: options.orderType,
    session: options.session ?? 'NORMAL',
    duration: options.duration ?? 'DAY',
    orderLegCollection: [
      buildLeg(options.buyInstruction, quantity, buy.raw, 'OPTION'),
      buildLeg(options.sellInstruction, quantity, sell.raw, 'OPTION'),
    ],
    ...(price === undefined ? {} : { price }),
    ...(options.tag ? { tag: options.tag } : {}),
  };
}

/** Build the Schwab documented OCO parent around two child orders. */
export function buildOcoOrder(first: PlaceOrderRequest, second: PlaceOrderRequest): PlaceOrderRequest {
  requireSingleChild(first, 'first OCO child');
  requireSingleChild(second, 'second OCO child');
  return {
    orderStrategyType: 'OCO',
    childOrderStrategies: [cloneOrder(first), cloneOrder(second)],
  };
}

/** Build a first-triggers-second conditional order. */
export function buildTriggerOrder(parent: PlaceOrderRequest, child: PlaceOrderRequest): PlaceOrderRequest {
  requireSingleChild(parent, 'trigger parent');
  return {
    ...cloneOrder(parent),
    orderStrategyType: 'TRIGGER',
    childOrderStrategies: [cloneOrder(child)],
  };
}

/** Build the common entry -> OCO profit/stop bracket structure. */
export function buildTriggerOcoOrder(
  entry: PlaceOrderRequest,
  profitTarget: PlaceOrderRequest,
  protectiveStop: PlaceOrderRequest,
): PlaceOrderRequest {
  return buildTriggerOrder(entry, buildOcoOrder(profitTarget, protectiveStop));
}

/** Build a Schwab equity trailing-stop order using a value/percent/tick offset. */
export function buildEquityTrailingStop(options: EquityTrailingStopOptions): PlaceOrderRequest {
  const symbol = requireSymbol(options.symbol, 'equity');
  const quantity = requirePositiveQuantity(options.quantity);
  if (!Number.isFinite(options.stopPriceOffset) || options.stopPriceOffset <= 0) {
    throw new Error('Trailing-stop offset must be a positive finite number');
  }

  return {
    orderStrategyType: 'SINGLE',
    complexOrderStrategyType: 'NONE',
    orderType: 'TRAILING_STOP',
    session: options.session ?? 'NORMAL',
    duration: options.duration ?? 'DAY',
    stopPriceLinkBasis: options.stopPriceLinkBasis ?? 'BID',
    stopPriceLinkType: options.stopPriceLinkType ?? 'VALUE',
    stopPriceOffset: options.stopPriceOffset,
    orderLegCollection: [
      buildLeg(options.instruction ?? 'SELL', quantity, symbol, 'EQUITY'),
    ],
    ...(options.tag ? { tag: options.tag } : {}),
  };
}

function buildLeg(
  instruction: Instruction,
  quantity: number,
  symbol: string,
  assetType: 'EQUITY' | 'OPTION',
): OrderLeg {
  return {
    instruction,
    quantity,
    instrument: { symbol, assetType },
  };
}

function requireSymbol(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} symbol is required`);
  return value.trim().toUpperCase();
}

function requireOptionSymbol(value: string): string {
  if (typeof value !== 'string' || !value) throw new Error('option symbol is required');
  parseSchwabOptionSymbol(value);
  return value;
}

function requirePositiveQuantity(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Order quantity must be a positive integer: ${String(value)}`);
  }
  return value;
}

function requirePrice(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} requires a non-negative finite price`);
  }
  return value;
}

function priceForSimpleOrder(orderType: 'MARKET' | 'LIMIT', value: number | undefined): number | undefined {
  if (orderType === 'MARKET') {
    if (value !== undefined) throw new Error('Market orders cannot include a limit price');
    return undefined;
  }
  return requirePrice(value, 'Limit order');
}

function priceForNetOrder(orderType: NetOrderType, value: number | undefined): number | undefined {
  if (orderType === 'NET_ZERO') {
    if (value !== undefined && value !== 0) throw new Error('NET_ZERO price must be omitted or zero');
    return value;
  }
  return requirePrice(value, orderType);
}

function validateVerticalPair(
  left: ReturnType<typeof parseSchwabOptionSymbol>,
  right: ReturnType<typeof parseSchwabOptionSymbol>,
): void {
  if (left.underlying !== right.underlying) throw new Error('Vertical legs must share the same underlying');
  if (left.expiration !== right.expiration) throw new Error('Vertical legs must share the same expiration');
  if (left.contractType !== right.contractType) throw new Error('Vertical legs must both be calls or both be puts');
  if (left.strike === right.strike) throw new Error('Vertical legs must use different strikes');
}

function validateOpenClosePair(buy: OptionInstruction, sell: OptionInstruction): void {
  const buyEffect = buy.endsWith('_OPEN') ? 'OPEN' : 'CLOSE';
  const sellEffect = sell.endsWith('_OPEN') ? 'OPEN' : 'CLOSE';
  if (buyEffect !== sellEffect) {
    throw new Error('Vertical legs must both open or both close');
  }
}

function requireSingleChild(order: PlaceOrderRequest, label: string): void {
  if (!order || typeof order !== 'object') throw new Error(`${label} is required`);
  if (order.orderStrategyType && order.orderStrategyType !== 'SINGLE') {
    throw new Error(`${label} must be a SINGLE order`);
  }
  if (!Array.isArray(order.orderLegCollection) || order.orderLegCollection.length === 0) {
    throw new Error(`${label} must contain order legs`);
  }
}

function cloneOrder(order: PlaceOrderRequest): Order {
  return structuredClone(order);
}
