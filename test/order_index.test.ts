import assert from "node:assert/strict";
import test from "node:test";
import { AUTOMATION_WORKING_ORDER_STATUSES } from "../src/automation/execution/orderWritePreflight.ts";
import { orderInfo, type Json } from "../src/automation/policy/order.ts";
import { parseRuntimePolicy } from "../src/automation/policy/runtime.ts";
import {
  buildPrimaryActiveOpeningOrderIds,
  compareOpeningOrders,
  managedOpeningInfo,
  selectActiveOpeningOrders,
} from "../src/automation/orderIndex.ts";

const tradingDate = "2026-07-24";
const policy = parseRuntimePolicy([]);
const working = new Set<string>(AUTOMATION_WORKING_ORDER_STATUSES);

function opening(
  orderId: string,
  price: string,
  lowerStrike = 720,
  status = "WORKING",
  enteredTime = "2026-07-24T14:00:00.000Z",
): Json {
  const upperStrike = lowerStrike + 1;
  const strike = (value: number) => String(Math.round(value * 1_000)).padStart(8, "0");
  return {
    orderId,
    status,
    price,
    quantity: 1,
    enteredTime,
    orderLegCollection: [
      { quantity: 1, instruction: "BUY_TO_OPEN", instrument: { symbol: `QQQ  260724C${strike(lowerStrike)}` } },
      { quantity: 1, instruction: "SELL_TO_OPEN", instrument: { symbol: `QQQ  260724C${strike(upperStrike)}` } },
    ],
  };
}

test("managed opening classification preserves policy, 0DTE, width, quantity, and working-selection inputs", () => {
  const valid = opening("10", "0.87");
  assert.ok(managedOpeningInfo(valid, policy, tradingDate));

  const wrongWidth = opening("11", "0.87");
  wrongWidth.orderLegCollection![1].instrument!.symbol = "QQQ  260724C00725000";
  assert.equal(managedOpeningInfo(wrongWidth, policy, tradingDate), null);

  const wrongQuantity = opening("12", "0.87");
  wrongQuantity.quantity = 2;
  assert.equal(managedOpeningInfo(wrongQuantity, policy, tradingDate), null);

  const outsideRange = opening("13", "0.87", 800);
  assert.equal(managedOpeningInfo(outsideRange, policy, tradingDate), null);
});

test("active opening selection preserves price, event-time, and order-id ordering", () => {
  const first = opening("20", "0.86", 720, "WORKING", "2026-07-24T14:00:02.000Z");
  const second = opening("19", "0.86", 720, "WORKING", "2026-07-24T14:00:01.000Z");
  const cheapest = opening("21", "0.85", 720, "WORKING", "2026-07-24T14:00:03.000Z");
  const inactive = opening("22", "0.82", 720, "CANCELED");
  const key = orderInfo(first)!.key;

  const selected = selectActiveOpeningOrders(
    [first, second, cheapest, inactive],
    key,
    tradingDate,
    policy.underlyings,
    working,
  );
  assert.deepEqual(selected.map((order) => String(order.orderId)), ["21", "19", "20"]);
  assert.ok(compareOpeningOrders(cheapest, first) < 0);
});

test("primary opening index selects exactly one deterministic broker order per strategy", () => {
  const strategyAHigh = opening("31", "0.90", 720);
  const strategyALow = opening("30", "0.84", 720);
  const strategyB = opening("40", "0.88", 721);
  const canceled = opening("29", "0.82", 720, "CANCELED");

  const primary = buildPrimaryActiveOpeningOrderIds(
    [strategyAHigh, strategyALow, strategyB, canceled],
    policy,
    tradingDate,
    working,
  );
  assert.equal(primary.get(orderInfo(strategyALow)!.key), "30");
  assert.equal(primary.get(orderInfo(strategyB)!.key), "40");
  assert.equal(primary.size, 2);
});
