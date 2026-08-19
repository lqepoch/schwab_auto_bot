import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeOrderAuthority } from "../src/automation/broker/runtimeOrderAuthority.ts";
import { AUTOMATION_WORKING_ORDER_STATUSES } from "../src/automation/execution/orderWritePreflight.ts";
import type { Json } from "../src/automation/policy/order.ts";
import { parseRuntimePolicy } from "../src/automation/policy/runtime.ts";

const workingStatuses = new Set<string>(AUTOMATION_WORKING_ORDER_STATUSES);
const policy = parseRuntimePolicy([]);
let tradingDate = "2026-08-18";

function authority(): RuntimeOrderAuthority {
  return new RuntimeOrderAuthority({
    policy,
    workingStatuses,
    tradingDate: () => tradingDate,
  });
}

function spread(
  orderId: string,
  lowerStrike: number,
  options: {
    closing?: boolean;
    status?: string;
    price?: number;
    expiration?: string;
  } = {},
): Json {
  const closing = options.closing === true;
  const strike = (value: number) => String(Math.round(value * 1_000)).padStart(8, "0");
  return {
    orderId,
    status: options.status ?? "WORKING",
    price: options.price ?? (closing ? 0.99 : 0.88),
    quantity: 1,
    filledQuantity: 0,
    enteredTime: "2026-08-18T14:00:00.000Z",
    orderLegCollection: [
      {
        quantity: 1,
        instruction: closing ? "SELL_TO_CLOSE" : "BUY_TO_OPEN",
        instrument: { symbol: `QQQ  ${options.expiration ?? "260818"}C${strike(lowerStrike)}` },
      },
      {
        quantity: 1,
        instruction: closing ? "BUY_TO_CLOSE" : "SELL_TO_OPEN",
        instrument: { symbol: `QQQ  ${options.expiration ?? "260818"}C${strike(lowerStrike + 1)}` },
      },
    ],
  };
}

test("replace validates duplicate broker IDs before publishing any new authority", () => {
  const state = authority();
  const existing = spread("101", 740);
  state.replace([existing]);
  const revision = state.revision;

  assert.throws(
    () => state.replace([spread("102", 741), spread("102", 742)]),
    /BROKER_ORDER_ID_DUPLICATE/,
  );
  assert.equal(state.revision, revision);
  assert.deepEqual(state.all(), [existing]);
  assert.equal(state.get("101"), existing);
  assert.equal(state.get("102"), undefined);
});

test("authoritative broker observation wins local accepted-order publication race", () => {
  const state = authority();
  const authoritative = spread("101", 740, { status: "PENDING_ACTIVATION" });
  state.replace([authoritative]);
  const revision = state.revision;

  assert.equal(state.addIfAbsent(spread("101", 740)), false);
  assert.equal(state.revision, revision);
  assert.equal(state.get("101"), authoritative);
  assert.equal(state.get("101")?.status, "PENDING_ACTIVATION");

  const local = spread("102", 741);
  assert.equal(state.addIfAbsent(local), true);
  assert.equal(state.revision, revision + 1);
  assert.equal(state.get("102"), local);
});

test("working status projection is the cache-invalidating boundary for local mutation state", () => {
  const state = authority();
  const opening = spread("101", 740);
  const closing = spread("201", 740, { closing: true });
  state.replace([opening, closing]);
  const strategy = state.info(opening)?.key;
  assert.ok(strategy);
  assert.deepEqual(state.activeOpeningOrders(strategy), [opening]);
  assert.deepEqual(state.activeClosingOrders(strategy), [closing]);
  const revision = state.revision;

  assert.equal(state.projectWorkingStatus("101", "REPLACED"), true);
  assert.equal(state.revision, revision + 1);
  assert.equal(opening.status, "REPLACED");
  assert.deepEqual(state.activeOpeningOrders(strategy), []);

  assert.equal(state.projectWorkingStatus("101", "CANCELED"), false);
  assert.equal(state.revision, revision + 1);
  assert.equal(opening.status, "REPLACED");
});

test("broker-observed terminal status prevents a later local projection from overwriting authority", () => {
  const state = authority();
  const order = spread("101", 740, { status: "FILLED" });
  state.replace([order]);
  const revision = state.revision;

  assert.equal(state.projectWorkingStatus("101", "CANCELED"), false);
  assert.equal(order.status, "FILLED");
  assert.equal(state.revision, revision);
});

test("derived views share centralized policy, date and working-status authority", () => {
  tradingDate = "2026-08-18";
  const state = authority();
  const opening = spread("101", 740);
  const duplicate = spread("102", 740, { price: 0.90 });
  const closing = spread("201", 740, { closing: true });
  const prior = spread("301", 740, { expiration: "260817" });
  state.replace([duplicate, closing, opening, prior]);

  const strategy = state.info(opening)?.key;
  assert.ok(strategy);
  assert.deepEqual(state.workingAllowedOrders().map((order) => order.orderId), ["102", "201", "101", "301"]);
  assert.deepEqual(state.currentOrders().map((order) => order.orderId), ["102", "201", "101"]);
  assert.deepEqual(state.activeOpeningOrders(strategy).map((order) => order.orderId), ["101", "102"]);
  assert.deepEqual(state.activeClosingOrders(strategy).map((order) => order.orderId), ["201"]);
  assert.deepEqual(state.allActiveClosingOrders().map((order) => order.orderId), ["201"]);
  assert.deepEqual(state.primaryOpeningOrders().map((order) => order.orderId), ["101"]);
  assert.equal(state.primaryOpeningOrderIds().get(strategy), "101");

  tradingDate = "2026-08-19";
  assert.equal(state.currentOrders().length, 0);
  assert.equal(state.activeOpeningOrders(strategy).length, 0);
  assert.equal(state.primaryOpeningOrders().length, 0);
});

test("metadata cache reparses structural mutations while live status/price remain uncached", () => {
  const state = authority();
  const order = spread("101", 740);
  state.replace([order]);
  const first = state.info(order);
  assert.ok(first);
  assert.equal(first.lowerStrike, 740);

  order.price = 0.89;
  order.status = "PENDING_REPLACE";
  assert.equal(state.info(order), first);

  order.orderLegCollection[0].instrument.symbol = "QQQ  260818C00739000";
  const second = state.info(order);
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(second.lowerStrike, 739);
});

test("strict broker identity fails closed for malformed resources", () => {
  const state = authority();
  assert.throws(
    () => state.replace([{ status: "WORKING", orderId: "synthetic-1" }]),
    /BROKER_ORDER_ID_INVALID/,
  );
  assert.equal(state.revision, 0);
  assert.equal(state.all().length, 0);
});
