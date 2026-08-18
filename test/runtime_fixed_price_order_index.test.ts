import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

async function runtimeSource(): Promise<string> {
  return readFile(runtimeSourceUrl, "utf8");
}

test("fixed-price round selection uses the revision-aware primary-order cache", async () => {
  const source = await runtimeSource();
  assert.match(
    source,
    /function primaryActiveOpeningOrders\(\): readonly Json\[\][\s\S]*?runtimeOrderIndex\.primaryOpeningOrders\(/,
  );
  assert.match(source, /const candidates = shuffled\(primaryActiveOpeningOrders\(\)\);/);
  assert.doesNotMatch(source, /const candidates = shuffled\(orders\.filter\(/);
});

test("full-order reconciliation queues only cached primary managed openings", async () => {
  const source = await runtimeSource();
  assert.match(
    source,
    /if \(policy\.repeatBuyAtOrderPrice && fixedPriceRefreshRoundActive\) \{[\s\S]*?for \(const order of primaryActiveOpeningOrders\(\)\) \{[\s\S]*?queueFixedPriceRefresh\(order, "full-order-reconciliation", primaryOpeningIds\);[\s\S]*?\}/,
  );
  assert.doesNotMatch(
    source,
    /if \(policy\.repeatBuyAtOrderPrice && fixedPriceRefreshRoundActive\) \{[\s\S]*?for \(const order of orders\) queueFixedPriceRefresh\(order, "full-order-reconciliation"/,
  );
});
