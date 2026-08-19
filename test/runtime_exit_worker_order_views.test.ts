import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

async function runtimeSource(): Promise<string> {
  return readFile(runtimeSourceUrl, "utf8");
}

test("sell adoption consumes the authority-owned account-wide active closing view", async () => {
  const source = await runtimeSource();
  assert.match(
    source,
    /function allActiveClosingOrders\(\): readonly Json\[\][\s\S]*?orderAuthority\.allActiveClosingOrders\(\)/,
  );
  const start = source.indexOf("function adoptSells");
  const end = source.indexOf("async function positions", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  assert.match(block, /for \(const order of allActiveClosingOrders\(\)\)/);
  assert.doesNotMatch(block, /for \(const order of orderAuthority\.all\(\)\)/);
});

test("exit worker scheduling uses strategy-key authority lookups without full authority scans", async () => {
  const source = await runtimeSource();
  const dueStart = source.indexOf("function nextExitWorkerDue");
  const scheduleStart = source.indexOf("function scheduleExitWorker", dueStart);
  assert.notEqual(dueStart, -1);
  assert.notEqual(scheduleStart, -1);
  const block = source.slice(dueStart, scheduleStart);
  assert.match(block, /const nextSellRefresh = activeClosingOrders\(strategy\)/);
  assert.match(block, /return activeClosingOrders\(strategy\)\.length > 0;/);
  assert.doesNotMatch(block, /orderAuthority\.all\(\)\.filter\(/);
  assert.doesNotMatch(block, /orderAuthority\.all\(\)\.some\(/);
});
