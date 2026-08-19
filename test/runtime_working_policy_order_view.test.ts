import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

async function runtimeSource(): Promise<string> {
  return readFile(runtimeSourceUrl, "utf8");
}

test("working-order policy audit consumes the authority-owned allowed-underlying view", async () => {
  const source = await runtimeSource();
  assert.match(
    source,
    /function workingAllowedUnderlyingOrders\(\): readonly Json\[\][\s\S]*?orderAuthority\.workingAllowedOrders\(\)/,
  );

  const start = source.indexOf("function reportWorkingOrderPolicyViolations");
  const end = source.indexOf("function recordRefreshSpreadSkip", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  assert.match(block, /for \(const order of workingAllowedUnderlyingOrders\(\)\)/);
  assert.match(block, /orderPolicyViolation\(order, policy, today, meta\)/);
  assert.doesNotMatch(block, /for \(const order of orderAuthority\.all\(\)\)/);
  assert.doesNotMatch(block, /currentStrategyOrders\(\)/);
});
