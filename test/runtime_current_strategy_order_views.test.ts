import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

async function runtimeSource(): Promise<string> {
  return readFile(runtimeSourceUrl, "utf8");
}

function block(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker ${endMarker}`);
  return source.slice(start, end);
}

test("current-date strategy consumers reuse the centralized revision-aware order view", async () => {
  const source = await runtimeSource();
  assert.match(
    source,
    /function currentStrategyOrders\(\): readonly Json\[\][\s\S]*?orderAuthority\.currentOrders\(\)/,
  );

  for (const [start, end] of [
    ["function reportWorkingRefreshSpreadSkips", "async function waitForReplenishmentWriteWindow"],
    ["function reconcileExplorerSnapshot", "function explorerActionKey"],
    ["function detectExplorerFills", "function queueFixedPriceReplenishment"],
    ["function trackInventoryFillDeltas", "function adoptSells"],
    ["async function reconcilePositions", "/**\n * Exit workers"],
    ["function exitTemplates", "function nextExitWorkerDue"],
  ] as const) {
    const value = block(source, start, end);
    assert.match(value, /currentStrategyOrders\(\)/, `${start} must use cached current strategy orders`);
  }
});

test("non-0DTE working-order policy audit uses the broader centralized working view", async () => {
  const source = await runtimeSource();
  const value = block(source, "function reportWorkingOrderPolicyViolations", "function recordRefreshSpreadSkip");
  assert.match(value, /for \(const order of workingAllowedUnderlyingOrders\(\)\)/);
  assert.doesNotMatch(value, /for \(const order of orderAuthority\.all\(\)\)/);
  assert.doesNotMatch(value, /currentStrategyOrders\(\)/);
  assert.match(value, /orderPolicyViolation\(order, policy, today, meta\)/);
});

test("exit-priority and stale-recreate checks use strategy-key active closing views", async () => {
  const source = await runtimeSource();
  assert.match(source, /const stillWorking = activeClosingOrders\(strategy\)\.length > 0;/);
  assert.match(
    source,
    /function hasExitPriority\(groupKey: string\): boolean \{[\s\S]*?return activeClosingOrders\(groupKey\)\.length > 0;[\s\S]*?\}/,
  );
});
