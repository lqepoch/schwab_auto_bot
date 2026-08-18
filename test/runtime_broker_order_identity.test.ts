import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

test("runtime delegates authoritative order IDs to the strict broker identity helper", async () => {
  const source = await readFile(runtimeSourceUrl, "utf8");
  assert.match(source, /import \{ brokerOrderId \} from "\.\/broker\/orderIdentity\.ts";/);
  assert.match(source, /function orderId\(order: Json\): string \{ return brokerOrderId\(order\); \}/);
  assert.doesNotMatch(source, /String\(order\.orderId\)/);
  assert.match(source, /key: \(order\) => orderId\(order\)/);
  assert.match(source, /mergeKey: \(order\) => orderId\(order\)/);
});
