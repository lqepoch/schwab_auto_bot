import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_ORDER_PRICE, orderPolicyViolation } from "../src/order_policy.ts";

const policy = { underlyings: new Set(["QQQ", "SPY"]), entryNotionalMin: 82, entryNotionalMax: 92 };
const today = "2026-07-24";

function vertical(price: string, closing = false, expiration = "260724") {
  return {
    price,
    quantity: 1,
    orderLegCollection: [
      { quantity: 1, instruction: closing ? "SELL_TO_CLOSE" : "BUY_TO_OPEN", instrument: { symbol: `QQQ  ${expiration}C00720000` } },
      { quantity: 1, instruction: closing ? "BUY_TO_CLOSE" : "SELL_TO_OPEN", instrument: { symbol: `QQQ  ${expiration}C00725000` } },
    ],
  };
}

test("0DTE buy orders must stay inside the configured price range", () => {
  assert.equal(orderPolicyViolation(vertical("0.82"), policy, today), null);
  assert.equal(orderPolicyViolation(vertical("0.92"), policy, today), null);
  assert.equal(orderPolicyViolation(vertical("0.81"), policy, today)?.code, "BUY_PRICE_OUT_OF_RANGE");
  assert.equal(orderPolicyViolation(vertical("0.93"), policy, today)?.code, "BUY_PRICE_OUT_OF_RANGE");
  assert.equal(orderPolicyViolation(vertical("0.87"), policy, "2026-07-25")?.code, "ORDER_NOT_0DTE");
});

test("write-time policy rejects a vertical outside its configured strike range", () => {
  const scopedPolicy = {
    ...policy,
    isWithinStrikeRange: (_underlying: string, lowerStrike: number, higherStrike: number) => lowerStrike >= 750 && higherStrike <= 795,
  };
  assert.equal(orderPolicyViolation(vertical("0.87"), scopedPolicy, today)?.code, "STRIKE_OUT_OF_RANGE");
});

test("0DTE sell orders must use the fixed 0.99 credit", () => {
  assert.equal(orderPolicyViolation(vertical(String(EXIT_ORDER_PRICE), true), policy, today), null);
  assert.equal(orderPolicyViolation(vertical("0.98", true), policy, today)?.code, "SELL_PRICE_INVALID");
  assert.equal(orderPolicyViolation(vertical(String(EXIT_ORDER_PRICE), true, "260725"), policy, today)?.code, "ORDER_NOT_0DTE");
});

test("opening vertical orders are restricted to one contract while a closing vertical can cover the full group", () => {
  const order = vertical("0.87");
  order.quantity = 2;
  order.orderLegCollection[0].quantity = 2;
  order.orderLegCollection[1].quantity = 2;
  assert.equal(orderPolicyViolation(order, policy, today)?.code, "ORDER_QUANTITY_INVALID");
  const exit = vertical(String(EXIT_ORDER_PRICE), true);
  exit.quantity = 4;
  exit.orderLegCollection[0].quantity = 4;
  exit.orderLegCollection[1].quantity = 4;
  assert.equal(orderPolicyViolation(exit, policy, today), null);
});
