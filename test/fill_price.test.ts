import assert from "node:assert/strict";
import test from "node:test";
import { completeNetDebitFill, completeOrderLimitFill } from "../src/fill_price.ts";

function filledVertical() {
  return {
    quantity: 1,
    filledQuantity: 1,
    price: "0.90",
    closeTime: "2026-07-24T14:00:00Z",
    orderLegCollection: [
      { legId: 1, instruction: "BUY_TO_OPEN" },
      { legId: 2, instruction: "SELL_TO_OPEN" },
    ],
    orderActivityCollection: [{ executionLegs: [
      { legId: 1, price: 2.15, quantity: 1, time: "2026-07-24T14:00:01Z" },
      { legId: 2, price: 1.27, quantity: 1, time: "2026-07-24T14:00:02Z" },
    ] }],
  };
}

test("uses Schwab execution legs to derive the actual vertical net debit", () => {
  const fill = completeNetDebitFill(filledVertical());
  assert.deepEqual(fill, { priceCents: 88, filledAt: Date.parse("2026-07-24T14:00:02Z") });
});

test("uses the submitted limit price without reading execution legs in repeat-limit mode", () => {
  const filled = filledVertical();
  filled.orderActivityCollection = [];
  assert.deepEqual(completeOrderLimitFill(filled), {
    priceCents: 90,
    filledAt: Date.parse("2026-07-24T14:00:00Z"),
  });
});

test("fails closed without a complete one-contract execution report", () => {
  const partial = filledVertical();
  partial.filledQuantity = 0;
  assert.equal(completeNetDebitFill(partial), null);
  const missing = filledVertical();
  missing.orderActivityCollection = [];
  assert.equal(completeNetDebitFill(missing), null);
  const fractional = filledVertical();
  fractional.orderActivityCollection[0].executionLegs[0].price = 2.151;
  assert.equal(completeNetDebitFill(fractional), null);
  const nonCentLimit = filledVertical();
  nonCentLimit.price = "0.901";
  assert.equal(completeOrderLimitFill(nonCentLimit), null);
});
