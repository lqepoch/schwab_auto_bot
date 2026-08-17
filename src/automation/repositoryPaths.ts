import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMPILED_SOURCE_ROOTS = new Set(["src", "dist"] as const);
type CompiledSourceRoot = "src" | "dist";

type AutomationLayout = Readonly<{
  repositoryRoot: string;
  sourceRoot: CompiledSourceRoot;
}>;

function automationLayoutFromModuleUrl(moduleUrl: string): AutomationLayout {
  let cursor = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const parent = dirname(cursor);
    const sourceRoot = basename(parent);
    if (
      basename(cursor) === "automation"
      && COMPILED_SOURCE_ROOTS.has(sourceRoot as CompiledSourceRoot)
    ) {
      return {
        repositoryRoot: dirname(parent),
        sourceRoot: sourceRoot as CompiledSourceRoot,
      };
    }
    if (parent === cursor) throw new Error("AUTOMATION_REPOSITORY_ROOT_NOT_FOUND");
    cursor = parent;
  }
}

/**
 * Resolve the repository root for a module located anywhere below
 * <repo>/{src|dist}/automation. This remains stable when implementation files
 * move between automation subdirectories and when TypeScript is compiled.
 */
export function repositoryRootFromAutomationModuleUrl(moduleUrl: string): string {
  return automationLayoutFromModuleUrl(moduleUrl).repositoryRoot;
}

export function defaultAutomationAuthStatePath(moduleUrl: string): string {
  return join(repositoryRootFromAutomationModuleUrl(moduleUrl), "state", "schwab-auth.json");
}

/** Default hot-switch entry corresponding to the runtime's source/dist tree. */
export function defaultAutomationRuntimeEntryPath(moduleUrl: string): string {
  const layout = automationLayoutFromModuleUrl(moduleUrl);
  return join(
    layout.repositoryRoot,
    layout.sourceRoot,
    layout.sourceRoot === "src" ? "main.ts" : "main.js",
  );
}
