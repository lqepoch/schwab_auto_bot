from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()


def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, found {count}: {old[:120]!r}")
    text = text.replace(old, new, 1)


replace_once(
    'import { MAX_ACTIVE_ORDERS, PriceExplorer, type ExplorerAction, type ExplorerSnapshot } from "./execution/priceExplorer.ts";\n',
    'import { MAX_ACTIVE_ORDERS, PriceExplorer, type ExplorerAction } from "./execution/priceExplorer.ts";\n',
)
replace_once(
    'import { acquireRuntimeLock } from "./state/runtimeLock.ts";\n',
    'import { acquireRuntimeLock } from "./state/runtimeLock.ts";\n'
    'import { ExitTemplateStateStore, FixedPriceCycleStateStore, PriceExplorerStateStore } from "./state/runtimeStateStores.ts";\n',
)

stamp_block = '''function stamp(message: string): void {
  const value = singaporeLogFormatter.format(new Date());
  const renderedMessage = appendBrokerRateLimit(message, latestBrokerRateLimit);
  host.stderr.write(`${value} ${renderedMessage}\\n`);
  executionJournal.record("console", {
    message: renderedMessage,
    brokerRateLimit: latestBrokerRateLimit,
  });
}
'''
store_block = stamp_block + '''
const explorerStateStore = new PriceExplorerStateStore(explorerStatePath, {
  readOnly,
  onWriteFailure: (error) => stamp(`PRICE_EXPLORER_STATE_SAVE_FAILED error=${safeRuntimeError(error)}`),
});
const fixedPriceCycleStateStore = new FixedPriceCycleStateStore(fixedPriceCycleStatePath, {
  readOnly,
  onWriteFailure: (error) => stamp(`FIXED_PRICE_CYCLE_STATE_SAVE_FAILED error=${safeRuntimeError(error)}`),
});
const exitTemplateStateStore = new ExitTemplateStateStore(exitTemplateStatePath, {
  readOnly,
  onWriteFailure: (error) => stamp(`EXIT_TEMPLATE_STATE_SAVE_FAILED error=${safeRuntimeError(error)}`),
});
'''
replace_once(stamp_block, store_block)

old_state_helpers = '''async function loadExplorer(): Promise<PriceExplorer> {
  try {
    const value = JSON.parse(await readFile(explorerStatePath, "utf8")) as ExplorerSnapshot;
    if (!value || typeof value !== "object" || !value.groups || typeof value.groups !== "object") {
      throw new Error("EXPLORER_STATE_INVALID");
    }
    return new PriceExplorer(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new PriceExplorer();
    throw error;
  }
}

async function loadFixedPriceCycle(): Promise<Set<string>> {
  try {
    const value = JSON.parse(await readFile(fixedPriceCycleStatePath, "utf8")) as unknown;
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new Error("FIXED_PRICE_CYCLE_STATE_INVALID");
    return new Set(value.slice(-1_000));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

function persistExplorer(): void {
  if (readOnly) return;
  const snapshot = explorer.snapshot();
  explorerSavePending = explorerSavePending
    .then(() => atomicWriteJson(explorerStatePath, snapshot))
    .catch((error) => stamp(`PRICE_EXPLORER_STATE_SAVE_FAILED error=${safeRuntimeError(error)}`));
}

function persistFixedPriceCycle(): void {
  if (readOnly) return;
  const snapshot = [...fixedPriceCycleConsumedFills].slice(-1_000);
  fixedPriceCycleSavePending = fixedPriceCycleSavePending
    .then(() => atomicWriteJson(fixedPriceCycleStatePath, snapshot))
    .catch((error) => stamp(`FIXED_PRICE_CYCLE_STATE_SAVE_FAILED error=${safeRuntimeError(error)}`));
}
'''
new_state_helpers = '''function persistExplorer(): void {
  explorerStateStore.save(explorer);
}

function persistFixedPriceCycle(): void {
  fixedPriceCycleStateStore.save(fixedPriceCycleConsumedFills);
}
'''
replace_once(old_state_helpers, new_state_helpers)

replace_once(
    'const explorer = await loadExplorer();\nconst fixedPriceCycleConsumedFills = await loadFixedPriceCycle();\n',
    'const explorer = await explorerStateStore.load();\nconst fixedPriceCycleConsumedFills = await fixedPriceCycleStateStore.load();\n',
)
replace_once(
    'const exitTemplatesByStrategy = await loadExitTemplates();\nconst reportedUnpricedFills = new Set<string>();\nconst reportedHistoricalFixedPriceFills = new Set<string>();\nlet explorerSavePending = Promise.resolve();\nlet fixedPriceCycleSavePending = Promise.resolve();\nlet exitTemplateSavePending = Promise.resolve();\n',
    'const exitTemplatesByStrategy = await exitTemplateStateStore.load();\nconst reportedUnpricedFills = new Set<string>();\nconst reportedHistoricalFixedPriceFills = new Set<string>();\n',
)

old_load_exit = '''async function loadExitTemplates(): Promise<Map<string, Json>> {
  try {
    const value = JSON.parse(await readFile(exitTemplateStatePath, "utf8")) as Record<string, Json>;
    if (!value || typeof value !== "object") throw new Error("EXIT_TEMPLATE_STATE_INVALID");
    return new Map(Object.entries(value).filter(([, template]) => Array.isArray(template?.orderLegCollection)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

'''
replace_once(old_load_exit, '')

old_remember = '''  exitTemplatesByStrategy.set(strategy, structuredClone(order));
  const snapshot = Object.fromEntries(exitTemplatesByStrategy);
  exitTemplateSavePending = exitTemplateSavePending
    .then(() => atomicWriteJson(exitTemplateStatePath, snapshot))
    .catch((error) => stamp(`EXIT_TEMPLATE_STATE_SAVE_FAILED error=${safeRuntimeError(error)}`));
'''
new_remember = '''  exitTemplatesByStrategy.set(strategy, structuredClone(order));
  exitTemplateStateStore.save(exitTemplatesByStrategy);
'''
replace_once(old_remember, new_remember)

replace_once(
    '''await writer.waitIdle();
await explorerSavePending;
await fixedPriceCycleSavePending;
await exitTemplateSavePending;
await writeRuntimeState("stopped", stopReason);
''',
    '''await writer.waitIdle();
await explorerStateStore.flush();
await fixedPriceCycleStateStore.flush();
await exitTemplateStateStore.flush();
await writeRuntimeState("stopped", stopReason);
''',
)

for forbidden in (
    "loadExplorer()",
    "loadFixedPriceCycle()",
    "loadExitTemplates()",
    "explorerSavePending",
    "fixedPriceCycleSavePending",
    "exitTemplateSavePending",
):
    if forbidden in text:
        raise SystemExit(f"stale runtime state implementation remains: {forbidden}")

path.write_text(text)
