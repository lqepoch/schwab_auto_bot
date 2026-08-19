import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);
const authoritySourceUrl = new URL("../src/automation/broker/runtimeOrderAuthority.ts", import.meta.url);

async function source(url: URL): Promise<string> {
  return readFile(url, "utf8");
}

test("runtime delegates structural metadata and derived indexes to one order authority", async () => {
  const runtime = await source(runtimeSourceUrl);
  const authority = await source(authoritySourceUrl);

  assert.match(runtime, /const orderAuthority = new RuntimeOrderAuthority\(/);
  assert.match(runtime, /function info\(order: Json\) \{ return orderAuthority\.info\(order\); \}/);
  assert.doesNotMatch(runtime, /const orderMetadata = new RuntimeOrderMetadataCache\(\);/);
  assert.doesNotMatch(runtime, /const runtimeOrderIndex = new RuntimeOrderIndexCache/);

  assert.match(authority, /private readonly metadata = new RuntimeOrderMetadataCache\(\);/);
  assert.match(authority, /this\.derived = new RuntimeOrderIndexCache\(\(order\) => this\.metadata\.get\(order\)\);/);
  assert.match(authority, /info\(order: Json\): OptionOrderInfo \| null \{[\s\S]*?return this\.metadata\.get\(order\);/);
});

test("managed-opening and policy scans reuse authority-owned parsed metadata", async () => {
  const runtime = await source(runtimeSourceUrl);
  const authority = await source(authoritySourceUrl);
  assert.match(
    runtime,
    /function managedOpening\(order: Json\): ReturnType<typeof info> \{[\s\S]*?return orderAuthority\.managedOpening\(order\);[\s\S]*?\}/,
  );
  assert.match(
    authority,
    /managedOpening\(order: Json\): OptionOrderInfo \| null \{[\s\S]*?const meta = this\.info\(order\);[\s\S]*?managedOpeningInfo\(order, this\.policy, this\.tradingDate\(\), meta\);/,
  );
  assert.match(runtime, /orderPolicyViolation\(order, policy, today, meta\)/);
  assert.doesNotMatch(runtime, /function info\(order: Json\) \{ return orderInfo\(order\); \}/);
});
