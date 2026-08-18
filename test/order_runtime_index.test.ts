import assert from "node:assert/strict";
import test from "node:test";

import { AUTOMATION_WORKING_ORDER_STATUSES } from "../src/automation/execution/orderWritePreflight.ts";
import { RuntimeOrderIndexCache } from "../src/automation/orderRuntimeIndex.ts";
import { orderInfo, type Json } from "../src/automation/policy/order.ts";
import { parseRuntimePolicy } from "../src/automation/policy/runtime.ts";

const policy = parseRuntimePolicy([]);
const working = new Set<string>(AUTOMATION_WORKING_ORDER_STATUSES);
const tradingDate = "2026-08-18";

function spread(
  orderId: string,
  lowerStrike: number,
  options: {
    closing?: boolean;
    price?: number;
    status?: string;
    enteredTime?: string;
    expiration?: string;
  } = {},
): Json {
  const closing = options.closing === true;
  const strike = (value: number) => String(Math.round(value * 1_000)).padStart(8, "0");
  const expiration = options.expiration ?? "260818";
  return {
    orderId,
    status: options.status ?? "WORKING",
    price: options.price ?? (closing ? 0.99 : 0.88),
    quantity: 1,
    filledQuantity: 0,
    enteredTime: options.enteredTime ?? "2026-08-18T14:00:00.000Z",
    orderLegCollection: [
      {
        quantity: 1,
        instruction: closing ? "SELL_TO_CLOSE" : "BUY_TO_OPEN",
        instrument: { symbol: `QQQ  ${expiration}C${strike(lowerStrike)}` },
      },
      {
        quantity: 1,
        instruction: closing ? "BUY_TO_CLOSE" : "SELL_TO_OPEN",
        instrument: { symbol: `QQQ  ${expiration}C${strike(lowerStrike + 1)}` },
      },
    ],
  };
}

test("caches current, active opening, and active closing views until authority revision changes", () => {
  const cache = new RuntimeOrderIndexCache();
  const opening = spread("101", 740, { price: 0.89 });
  const closing = spread("201", 740, { closing: true });
  const source = [opening, closing];

  const first = cache.snapshot(source, 1, policy, tradingDate, working);
  const second = cache.snapshot(source, 1, policy, tradingDate, working);
  assert.equal(second, first);

  const strategy = [...first.activeOpeningOrdersByStrategy.keys()][0];
  assert.ok(strategy);
  assert.deepEqual(cache.currentOrders(source, 1, policy, tradingDate, working), [opening, closing]);
  assert.deepEqual(cache.activeOpeningOrders(source, 1, policy, tradingDate, working, strategy), [opening]);
  assert.deepEqual(cache.activeClosingOrders(source, 1, policy, tradingDate, working, strategy), [closing]);
  assert.deepEqual(cache.allActiveClosingOrders(source, 1, policy, tradingDate, working), [closing]);
  assert.deepEqual(cache.primaryOpeningOrders(source, 1, policy, tradingDate, working), [opening]);

  closing.status = "CANCELED";
  assert.equal(cache.snapshot(source, 1, policy, tradingDate, working), first);
  const refreshed = cache.snapshot(source, 2, policy, tradingDate, working);
  assert.notEqual(refreshed, first);
  assert.deepEqual(cache.currentOrders(source, 2, policy, tradingDate, working), [opening, closing]);
  assert.deepEqual(cache.activeClosingOrders(source, 2, policy, tradingDate, working, strategy), []);
  assert.deepEqual(cache.allActiveClosingOrders(source, 2, policy, tradingDate, working), []);
});

test("sorts active orders deterministically and selects one managed opening per strategy", () => {
  const cache = new RuntimeOrderIndexCache();
  const laterCheap = spread("102", 741, { price: 0.87, enteredTime: "2026-08-18T14:01:00.000Z" });
  const earlierCheap = spread("101", 741, { price: 0.87, enteredTime: "2026-08-18T14:00:00.000Z" });
  const expensive = spread("103", 741, { price: 0.90, enteredTime: "2026-08-18T13:59:00.000Z" });
  const closeLate = spread("202", 741, { closing: true, enteredTime: "2026-08-18T14:02:00.000Z" });
  const closeEarly = spread("201", 741, { closing: true, enteredTime: "2026-08-18T14:01:00.000Z" });
  const source = [laterCheap, expensive, closeLate, earlierCheap, closeEarly];

  const snapshot = cache.snapshot(source, 1, policy, tradingDate, working);
  const strategy = [...snapshot.activeOpeningOrdersByStrategy.keys()][0];
  assert.ok(strategy);
  assert.deepEqual(
    cache.activeOpeningOrders(source, 1, policy, tradingDate, working, strategy).map((order) => order.orderId),
    ["101", "102", "103"],
  );
  assert.deepEqual(
    cache.activeClosingOrders(source, 1, policy, tradingDate, working, strategy).map((order) => order.orderId),
    ["201", "202"],
  );
  assert.deepEqual(
    cache.allActiveClosingOrders(source, 1, policy, tradingDate, working).map((order) => order.orderId),
    ["201", "202"],
  );
  assert.deepEqual(
    cache.primaryOpeningOrders(source, 1, policy, tradingDate, working).map((order) => order.orderId),
    ["101"],
  );
  assert.equal(cache.primaryOpeningOrderIds(source, 1, policy, tradingDate, working).get(strategy), "101");
});

test("current strategy view retains terminal rows but excludes foreign-date and disallowed-underlying rows", () => {
  const cache = new RuntimeOrderIndexCache();
  const valid = spread("101", 742);
  const terminal = spread("102", 742, { status: "CANCELED" });
  const old = spread("103", 742, { expiration: "260817" });
  const otherUnderlying = structuredClone(valid);
  otherUnderlying.orderId = "104";
  for (const leg of otherUnderlying.orderLegCollection) {
    leg.instrument.symbol = String(leg.instrument.symbol).replace("QQQ", "IWM");
  }
  const source = [valid, terminal, old, otherUnderlying];

  const snapshot = cache.snapshot(source, 1, policy, tradingDate, working);
  assert.deepEqual(snapshot.currentStrategyOrders.map((order) => order.orderId), ["101", "102"]);
  const active = [...snapshot.activeOpeningOrdersByStrategy.values()].flat();
  assert.deepEqual(active.map((order) => order.orderId), ["101"]);
  assert.deepEqual(snapshot.activeClosingOrders, []);
  assert.deepEqual(snapshot.primaryActiveOpeningOrders.map((order) => order.orderId), ["101"]);
  assert.equal(snapshot.primaryActiveOpeningOrderIds.size, 1);
});

test("trading date participates in the cache key", () => {
  const cache = new RuntimeOrderIndexCache();
  const source = [spread("101", 743)];
  const first = cache.snapshot(source, 1, policy, tradingDate, working);
  const nextDate = cache.snapshot(source, 1, policy, "2026-08-19", working);
  assert.notEqual(nextDate, first);
  assert.equal(nextDate.currentStrategyOrders.length, 0);
  assert.equal(nextDate.activeOpeningOrdersByStrategy.size, 0);
  assert.equal(nextDate.activeClosingOrders.length, 0);
  assert.equal(nextDate.primaryActiveOpeningOrders.length, 0);
  assert.equal(nextDate.primaryActiveOpeningOrderIds.size, 0);
});

test("an index rebuild resolves metadata exactly once per broker row", () => {
  const source = [
    spread("101", 744),
    spread("102", 745),
    spread("201", 744, { closing: true }),
    spread("301", 744, { status: "FILLED" }),
  ];
  let resolutions = 0;
  const cache = new RuntimeOrderIndexCache((order) => {
    resolutions += 1;
    return orderInfo(order);
  });

  cache.snapshot(source, 1, policy, tradingDate, working);
  assert.equal(resolutions, source.length);
  cache.currentOrders(source, 1, policy, tradingDate, working);
  cache.primaryOpeningOrders(source, 1, policy, tradingDate, working);
  cache.activeOpeningOrders(source, 1, policy, tradingDate, working, "missing");
  cache.allActiveClosingOrders(source, 1, policy, tradingDate, working);
  assert.equal(resolutions, source.length);

  cache.snapshot(source, 2, policy, tradingDate, working);
  assert.equal(resolutions, source.length * 2);
});
