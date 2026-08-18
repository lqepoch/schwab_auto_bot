import assert from "node:assert/strict";
import test from "node:test";

import { AUTOMATION_WORKING_ORDER_STATUSES } from "../src/automation/execution/orderWritePreflight.ts";
import { RuntimeOrderIndexCache } from "../src/automation/orderRuntimeIndex.ts";
import type { Json } from "../src/automation/policy/order.ts";
import { parseRuntimePolicy } from "../src/automation/policy/runtime.ts";

const policy = parseRuntimePolicy([]);
const working = new Set<string>(AUTOMATION_WORKING_ORDER_STATUSES);

function spread(orderId: string, expiration: string, status = "WORKING", underlying = "QQQ"): Json {
  return {
    orderId,
    status,
    price: 0.88,
    quantity: 1,
    orderLegCollection: [
      { quantity: 1, instruction: "BUY_TO_OPEN", instrument: { symbol: `${underlying}  ${expiration}C00740000` } },
      { quantity: 1, instruction: "SELL_TO_OPEN", instrument: { symbol: `${underlying}  ${expiration}C00741000` } },
    ],
  };
}

test("working policy view preserves non-0DTE allowed-underlying rows for policy alerts", () => {
  const cache = new RuntimeOrderIndexCache();
  const current = spread("101", "260818");
  const priorDate = spread("102", "260817");
  const terminal = spread("103", "260818", "CANCELED");
  const disallowed = spread("104", "260818", "WORKING", "IWM");
  const source = [current, priorDate, terminal, disallowed];

  assert.deepEqual(
    cache.workingAllowedOrders(source, 1, policy, "2026-08-18", working).map((order) => order.orderId),
    ["101", "102"],
  );
  assert.deepEqual(
    cache.currentOrders(source, 1, policy, "2026-08-18", working).map((order) => order.orderId),
    ["101", "103"],
  );
});
