import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

async function runtimeSource(): Promise<string> {
  return readFile(runtimeSourceUrl, "utf8");
}

test("runtime delegates broker order authority, lookup, metadata and derived cache to one owner", async () => {
  const source = await runtimeSource();
  assert.match(
    source,
    /const orderAuthority = new RuntimeOrderAuthority\(\{[\s\S]*?policy,[\s\S]*?tradingDate: newYorkDate,[\s\S]*?workingStatuses: working,[\s\S]*?\}\);/,
  );
  assert.doesNotMatch(source, /let orders: Json\[\] = \[\];/);
  assert.doesNotMatch(source, /const ordersById = new OrderLookup/);
  assert.doesNotMatch(source, /const orderMetadata = new RuntimeOrderMetadataCache/);
  assert.doesNotMatch(source, /const runtimeOrderIndex = new RuntimeOrderIndexCache/);
  assert.doesNotMatch(source, /let orderAuthorityRevision = 0;/);
  assert.doesNotMatch(source, /orderAuthorityRevision \+= 1/);
});

test("all local authority mutations use centralized cache-invalidating methods", async () => {
  const source = await runtimeSource();
  assert.match(source, /function replaceOrders\(next: readonly Json\[\]\): void \{ orderAuthority\.replace\(next\); \}/);
  assert.match(source, /function addOrder\(order: Json\): boolean \{ return orderAuthority\.addIfAbsent\(order\); \}/);
  assert.match(source, /orderAuthority\.projectWorkingStatus\(sourceId, "REPLACED"\);/);
  assert.match(source, /orderAuthority\.projectWorkingStatus\(orderIdValue, "CANCELED"\);/);
  assert.doesNotMatch(source, /\.status = "REPLACED";/);
  assert.doesNotMatch(source, /\.status = "CANCELED";/);
});

test("runtime order views route through the centralized authority", async () => {
  const source = await runtimeSource();
  for (const expression of [
    "orderAuthority.workingAllowedOrders()",
    "orderAuthority.currentOrders()",
    "orderAuthority.activeOpeningOrders(groupKey)",
    "orderAuthority.activeClosingOrders(strategy)",
    "orderAuthority.allActiveClosingOrders()",
    "orderAuthority.primaryOpeningOrders()",
    "orderAuthority.primaryOpeningOrderIds()",
  ]) {
    assert.ok(source.includes(expression), `missing centralized order view: ${expression}`);
  }
  assert.doesNotMatch(source, /runtimeOrderIndex\./);
  assert.doesNotMatch(source, /orderMetadata\.get\(/);
});
