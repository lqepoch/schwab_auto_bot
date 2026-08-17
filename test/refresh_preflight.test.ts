import assert from "node:assert/strict";
import test from "node:test";
import { refreshAuthoritativeSnapshots } from "../src/automation/policy/refreshPreflight.ts";

test("refreshes Schwab orders before positions and only then admits a refresh round", async () => {
  const calls: string[] = [];
  const admitted = await refreshAuthoritativeSnapshots({
    refreshOrders: async () => {
      calls.push("orders");
      return true;
    },
    refreshPositions: async () => {
      calls.push("positions");
    },
  });

  assert.equal(admitted, true);
  assert.deepEqual(calls, ["orders", "positions"]);
});

test("does not read positions or admit candidates after a failed order snapshot", async () => {
  let positionsRead = false;
  const admitted = await refreshAuthoritativeSnapshots({
    refreshOrders: async () => false,
    refreshPositions: async () => {
      positionsRead = true;
    },
  });

  assert.equal(admitted, false);
  assert.equal(positionsRead, false);
});
