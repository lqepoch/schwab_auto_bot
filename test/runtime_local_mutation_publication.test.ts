import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

async function runtimeSource(): Promise<string> {
  return readFile(runtimeSourceUrl, "utf8");
}

test("local accepted Submit initializes fill state only when its synthetic row wins authority publication", async () => {
  const source = await runtimeSource();
  assert.match(source, /function addOrder\(order: Json\): boolean \{ return orderAuthority\.addIfAbsent\(order\); \}/);
  assert.match(
    source,
    /function applyLocalSubmit[\s\S]*?if \(!addOrder\(localOrder\(payload, id\)\)\) return;[\s\S]*?observedFillQuantities\.set\(id, 0\);/,
  );
  assert.doesNotMatch(source, /ordersById\.addIfAbsent/);
});

test("local Replace projection cannot overwrite broker authority that won the response race", async () => {
  const source = await runtimeSource();
  const start = source.indexOf("function applyLocalReplace");
  const end = source.indexOf("function previewAccepted", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);

  assert.match(block, /if \(!addOrder\(localOrder\(payload, replacementId\)\)\) return;/);
  assert.match(block, /orderAuthority\.projectWorkingStatus\(sourceId, "REPLACED"\);/);
  assert.ok(
    block.indexOf("if (!addOrder(localOrder(payload, replacementId))) return;")
      < block.indexOf("orderAuthority.projectWorkingStatus(sourceId, \"REPLACED\")"),
    "replacement publication must be decided before projecting the source status",
  );
  assert.doesNotMatch(block, /source\.status = "REPLACED"/);
});

test("local Cancel projection preserves a concurrently observed broker state through authority ownership", async () => {
  const source = await runtimeSource();
  assert.match(
    source,
    /orderAuthority\.projectWorkingStatus\(orderIdValue, "CANCELED"\);[\s\S]*?broker\.cancel\.accepted/,
  );
  assert.doesNotMatch(source, /current\.status = "CANCELED"/);
});
