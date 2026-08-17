import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMPILED_SOURCE_ROOTS = new Set(["src", "dist"]);

/**
 * Resolve the repository root for a module located anywhere below
 * <repo>/{src|dist}/automation. This remains stable when implementation files
 * move between automation subdirectories and when TypeScript is compiled.
 */
export function repositoryRootFromAutomationModuleUrl(moduleUrl: string): string {
  let cursor = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const parent = dirname(cursor);
    if (
      basename(cursor) === "automation"
      && COMPILED_SOURCE_ROOTS.has(basename(parent))
    ) {
      return dirname(parent);
    }
    if (parent === cursor) throw new Error("AUTOMATION_REPOSITORY_ROOT_NOT_FOUND");
    cursor = parent;
  }
}

export function defaultAutomationAuthStatePath(moduleUrl: string): string {
  return join(repositoryRootFromAutomationModuleUrl(moduleUrl), "state", "schwab-auth.json");
}
