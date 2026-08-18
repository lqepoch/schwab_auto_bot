import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSourceUrl = new URL("../src/automation/runtimeOrchestrator.ts", import.meta.url);

test("runtime wires live Replace source validation into BrokerWriteCoordinator", async () => {
  const source = await readFile(runtimeSourceUrl, "utf8");
  const executeStart = source.indexOf("const result = await brokerWriteCoordinator.execute({");
  assert.notEqual(executeStart, -1);
  const executeEnd = source.indexOf("  });", executeStart);
  assert.notEqual(executeEnd, -1);
  const requestBlock = source.slice(executeStart, executeEnd + 5);

  assert.match(requestBlock, /targetOrder:\s*replaceTargetOrderId/);
  assert.match(requestBlock, /validateFinal:\s*replaceTargetOrderId/);
  assert.match(requestBlock, /targetOrder:[\s\S]*getOrder\(replaceTargetOrderId\)/);
  assert.match(requestBlock, /const currentSource = getOrder\(replaceTargetOrderId\)/);
  assert.match(requestBlock, /replacementSourceViolation\(currentSource, payload\)/);
  assert.match(requestBlock, /if \(violation\) throw new Error\(violation\)/);
});
