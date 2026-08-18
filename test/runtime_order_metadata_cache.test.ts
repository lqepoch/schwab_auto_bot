import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

async function runtimeSource(): Promise<string> {
  return readFile(runtimeSourceUrl, "utf8");
}

test("runtime shares one structural metadata cache with derived order indexes", async () => {
  const source = await runtimeSource();
  assert.match(source, /const orderMetadata = new RuntimeOrderMetadataCache\(\);/);
  assert.match(
    source,
    /const runtimeOrderIndex = new RuntimeOrderIndexCache\(\(order\) => orderMetadata\.get\(order\)\);/,
  );
  assert.match(source, /function info\(order: Json\) \{ return orderMetadata\.get\(order\); \}/);
});

test("managed-opening and policy scans reuse already parsed metadata", async () => {
  const source = await runtimeSource();
  assert.match(
    source,
    /function managedOpening\(order: Json\): ReturnType<typeof info> \{[\s\S]*?const meta = info\(order\);[\s\S]*?managedOpeningInfo\(order, policy, newYorkDate\(\), meta\);/,
  );
  assert.match(source, /orderPolicyViolation\(order, policy, today, meta\)/);
  assert.doesNotMatch(source, /function info\(order: Json\) \{ return orderInfo\(order\); \}/);
});
