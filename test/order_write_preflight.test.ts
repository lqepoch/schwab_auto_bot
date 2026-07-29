import assert from "node:assert/strict";
import test from "node:test";
import {
  EXISTING_ORDER_REPLACE_NO_PREVIEW,
  SUBMIT_PREVIEW_REQUIRED,
  nativeReplaceOrderId,
  orderWritePreflight,
  replacementSourceViolation,
} from "../src/order_write_preflight.ts";

const workingOpening = {
  orderId: "12345",
  status: "WORKING",
  orderType: "NET_DEBIT",
  price: "0.90",
  quantity: 1,
  orderLegCollection: [
    {
      instruction: "BUY_TO_OPEN",
      quantity: 1,
      instrument: { symbol: "SPY   260729P00745000" },
    },
    {
      instruction: "SELL_TO_OPEN",
      quantity: 1,
      instrument: { symbol: "SPY   260729P00746000" },
    },
  ],
};

test("recognizes only the exact native Replace endpoint for the linked account", () => {
  const path = "/trader/v1/accounts/account-hash/orders/12345";
  assert.equal(nativeReplaceOrderId("PUT", path, "account-hash"), "12345");
  assert.equal(nativeReplaceOrderId("POST", path, "account-hash"), null);
  assert.equal(nativeReplaceOrderId("PUT", `${path}/child`, "account-hash"), null);
  assert.equal(nativeReplaceOrderId("PUT", `${path}?preview=true`, "account-hash"), null);
  assert.equal(nativeReplaceOrderId("PUT", path, "different-account"), null);
});

test("requires Preview for Submit and explicitly skips it only for an exact native Replace", () => {
  assert.deepEqual(
    orderWritePreflight("POST", "/trader/v1/accounts/account-hash/orders", "account-hash"),
    { preflight: SUBMIT_PREVIEW_REQUIRED, replaceOrderId: null, violation: null },
  );
  assert.deepEqual(
    orderWritePreflight("PUT", "/trader/v1/accounts/account-hash/orders/12345", "account-hash"),
    { preflight: EXISTING_ORDER_REPLACE_NO_PREVIEW, replaceOrderId: "12345", violation: null },
  );
  assert.deepEqual(
    orderWritePreflight("PUT", "/trader/v1/accounts/account-hash/orders", "account-hash"),
    { preflight: null, replaceOrderId: null, violation: "REPLACE_ENDPOINT_INVALID" },
  );
});

test("allows price and quantity changes for a working Replace that preserves strategy identity", () => {
  const changed = structuredClone(workingOpening);
  changed.price = "0.88";
  changed.quantity = 2;
  changed.orderLegCollection.forEach((leg) => {
    leg.quantity = 2;
  });
  assert.equal(replacementSourceViolation(workingOpening, changed), null);
});

test("blocks Replace without a working source or when strategy identity changes", () => {
  assert.equal(replacementSourceViolation(undefined, workingOpening), "REPLACE_SOURCE_NOT_FOUND");
  assert.equal(
    replacementSourceViolation({ ...workingOpening, status: "FILLED" }, workingOpening),
    "REPLACE_SOURCE_NOT_WORKING",
  );
  const differentStrategy = structuredClone(workingOpening);
  differentStrategy.orderLegCollection[1].instrument.symbol = "SPY   260729P00747000";
  assert.equal(
    replacementSourceViolation(workingOpening, differentStrategy),
    "REPLACE_IDENTITY_CHANGED",
  );
});
