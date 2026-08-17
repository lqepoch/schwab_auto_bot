import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  defaultAutomationAuthStatePath,
  repositoryRootFromAutomationModuleUrl,
} from "../src/automation/repositoryPaths.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fileUrl(...segments: string[]): string {
  return pathToFileURL(join(repoRoot, ...segments)).href;
}

test("automation repository root survives source nesting and dist compilation", () => {
  for (const moduleUrl of [
    fileUrl("src", "automation", "runtimeOrchestrator.ts"),
    fileUrl("src", "automation", "auth", "provider.ts"),
    fileUrl("src", "automation", "state", "unknownWriteReconciliation.ts"),
    fileUrl("dist", "automation", "runtimeOrchestrator.js"),
    fileUrl("dist", "automation", "auth", "provider.js"),
  ]) {
    assert.equal(repositoryRootFromAutomationModuleUrl(moduleUrl), repoRoot);
  }
});

test("default automation auth state remains in repository state directory", () => {
  assert.equal(
    defaultAutomationAuthStatePath(fileUrl("src", "automation", "auth", "provider.ts")),
    join(repoRoot, "state", "schwab-auth.json"),
  );
  assert.equal(
    defaultAutomationAuthStatePath(fileUrl("dist", "automation", "auth", "provider.js")),
    join(repoRoot, "state", "schwab-auth.json"),
  );
});

test("repository path resolution fails closed outside src or dist automation roots", () => {
  const unrelated = pathToFileURL(join(repoRoot, "other", "automation", "provider.ts")).href;
  assert.throws(
    () => repositoryRootFromAutomationModuleUrl(unrelated),
    /AUTOMATION_REPOSITORY_ROOT_NOT_FOUND/,
  );
});
