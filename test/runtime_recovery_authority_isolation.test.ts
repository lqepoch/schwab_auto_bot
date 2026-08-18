import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

test("runtime keeps historical unknown-write recovery outside the authoritative fetch path", async () => {
  const source = await readFile(runtimeSourceUrl, "utf8");
  const coordinatorStart = source.indexOf("const orderSnapshotCoordinator = new OrderSnapshotCoordinator<Json>({");
  assert.notEqual(coordinatorStart, -1);
  const fetchStart = source.indexOf("  fetch: async (scope, priority) => {", coordinatorStart);
  const supplementStart = source.indexOf("  reconciliationSupplement: async (authoritative, priority) => {", fetchStart);
  const reconcileStart = source.indexOf("  reconcileUnknownWrites: async (snapshot)", supplementStart);
  assert.notEqual(fetchStart, -1);
  assert.notEqual(supplementStart, -1);
  assert.notEqual(reconcileStart, -1);

  const authoritativeFetchBlock = source.slice(fetchStart, supplementStart);
  const recoveryBlock = source.slice(supplementStart, reconcileStart);
  assert.doesNotMatch(authoritativeFetchBlock, /planUnknownWriteRecovery/);
  assert.match(authoritativeFetchBlock, /fetchOrderRange/);
  assert.match(recoveryBlock, /planUnknownWriteRecovery/);
  assert.match(recoveryBlock, /orders\/\$\{encodeURIComponent\(targetOrderId\)\}/);
  assert.match(recoveryBlock, /recovered\.push/);
  assert.match(source.slice(reconcileStart, reconcileStart + 160), /reconcileUnknownWritesAfterFullSnapshot\(snapshot\)/);
});
