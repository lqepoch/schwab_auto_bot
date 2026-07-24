export type Json = Record<string, any>;

export const EXIT_ORDER_PRICE = 0.99;

export type OptionOrderInfo = {
  key: string;
  underlying: string;
  expiration: string;
  lowerStrike: number;
  higherStrike: number;
  opening: boolean;
  closing: boolean;
  legs: Json[];
};

export type OrderPolicy = {
  underlyings: ReadonlySet<string>;
  entryNotionalMin: number;
  entryNotionalMax: number;
};

export type OrderPolicyViolation = {
  code: "ORDER_STRUCTURE_INVALID" | "ORDER_QUANTITY_INVALID" | "UNDERLYING_NOT_ALLOWED" | "ORDER_NOT_0DTE" | "BUY_PRICE_OUT_OF_RANGE" | "SELL_PRICE_INVALID";
  message: string;
};

export function orderInfo(order: Json): OptionOrderInfo | null {
  const legs = order.orderLegCollection;
  if (!Array.isArray(legs) || legs.length !== 2) return null;
  const parsed = legs.map((leg: Json) => parseOcc(String(leg.instrument?.symbol ?? "")));
  if (parsed.some((value: Json | null) => value === null)) return null;
  if (parsed[0].underlying !== parsed[1].underlying || parsed[0].expiration !== parsed[1].expiration) return null;
  const instructions = legs.map((leg: Json) => String(leg.instruction ?? ""));
  const opening = instructions.every((value: string) => value.endsWith("_TO_OPEN"));
  const closing = instructions.every((value: string) => value.endsWith("_TO_CLOSE"));
  if (!opening && !closing) return null;
  const strikes = parsed.map((value: Json) => value.strike).sort((a: number, b: number) => a - b);
  return {
    key: `${parsed[0].underlying}:${parsed[0].expiration}:${parsed[0].right}:${strikes[0]}:${strikes[1]}`,
    underlying: parsed[0].underlying,
    expiration: parsed[0].expiration,
    lowerStrike: strikes[0],
    higherStrike: strikes[1],
    opening,
    closing,
    legs,
  };
}

export function orderPolicyViolation(order: Json, policy: OrderPolicy, tradingDate: string): OrderPolicyViolation | null {
  const meta = orderInfo(order);
  if (!meta) return { code: "ORDER_STRUCTURE_INVALID", message: "订单不是可识别的双腿垂直期权策略" };
  const requestedQuantity = Number(order.quantity);
  const quantitiesMatch = meta.legs.every((leg) => Number(leg.quantity) === requestedQuantity);
  if (
    !Number.isInteger(requestedQuantity) || requestedQuantity < 1 || !quantitiesMatch
    || (meta.opening && requestedQuantity !== 1)
  ) {
    return { code: "ORDER_QUANTITY_INVALID", message: "开仓垂直订单数量必须为 1；平仓订单的两腿数量必须等于组合总数量" };
  }
  if (!policy.underlyings.has(meta.underlying)) {
    return { code: "UNDERLYING_NOT_ALLOWED", message: `标的 ${meta.underlying} 不在允许范围` };
  }
  if (meta.expiration !== tradingDate) {
    return { code: "ORDER_NOT_0DTE", message: `到期日 ${meta.expiration} 不是当前纽约交易日 ${tradingDate}` };
  }
  const price = Number(order.price);
  if (!Number.isFinite(price)) return { code: "ORDER_STRUCTURE_INVALID", message: "订单价格无效" };
  if (meta.opening && (price * 100 < policy.entryNotionalMin || price * 100 > policy.entryNotionalMax)) {
    return {
      code: "BUY_PRICE_OUT_OF_RANGE",
      message: `买单价格 ${price} 不在 ${policy.entryNotionalMin / 100}-${policy.entryNotionalMax / 100} 范围内`,
    };
  }
  if (meta.closing && Math.abs(price - EXIT_ORDER_PRICE) > 1e-9) {
    return { code: "SELL_PRICE_INVALID", message: `卖单价格 ${price} 必须为 ${EXIT_ORDER_PRICE}` };
  }
  return null;
}

function parseOcc(symbol: string): Json | null {
  const match = symbol.trim().match(/^([A-Z.\-]{1,6})\s*(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, underlying, ymd, right, rawStrike] = match;
  return {
    underlying,
    expiration: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    right,
    strike: Number(rawStrike) / 1_000,
  };
}
