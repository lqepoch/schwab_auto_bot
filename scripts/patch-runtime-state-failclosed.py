from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()

old_store_block = '''const explorerStateStore = new PriceExplorerStateStore(explorerStatePath, {
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
new_store_block = '''function handleRuntimeStateWriteFailure(state: string, error: unknown): void {
  const detail = safeRuntimeError(error);
  executionJournal.record("runtime.state-persistence-failed", { state, error: detail });
  stamp(`RUNTIME_STATE_PERSISTENCE_FAILED state=${state} error=${detail}`);
  requestStop(`state-persistence-failed:${state}`);
}

const explorerStateStore = new PriceExplorerStateStore(explorerStatePath, {
  readOnly,
  onWriteFailure: (error) => handleRuntimeStateWriteFailure("price-explorer", error),
});
const fixedPriceCycleStateStore = new FixedPriceCycleStateStore(fixedPriceCycleStatePath, {
  readOnly,
  onWriteFailure: (error) => handleRuntimeStateWriteFailure("fixed-price-cycle", error),
});
const exitTemplateStateStore = new ExitTemplateStateStore(exitTemplateStatePath, {
  readOnly,
  onWriteFailure: (error) => handleRuntimeStateWriteFailure("exit-template", error),
});
'''
if text.count(old_store_block) != 1:
    raise SystemExit(f"expected one runtime state store block, found {text.count(old_store_block)}")
text = text.replace(old_store_block, new_store_block)

old_stop_helper = '''async function completeStoppedBeforeStartup(): Promise<void> {
  await writeRuntimeState("stopped", stopReason);
  executionJournal.record("run.stopped", { reason: stopReason, phase: "before-startup" });
  await executionJournal.flush();
}
'''
new_stop_helper = '''async function completeStoppedBeforeStartup(): Promise<void> {
  await writeRuntimeState("stopped", stopReason);
  executionJournal.record("run.stopped", { reason: stopReason, phase: "before-startup" });
  await executionJournal.flush();
}

async function flushRuntimeStateStores(): Promise<void> {
  const stores = [
    ["price-explorer", explorerStateStore.flush()],
    ["fixed-price-cycle", fixedPriceCycleStateStore.flush()],
    ["exit-template", exitTemplateStateStore.flush()],
  ] as const;
  const results = await Promise.allSettled(stores.map(([, pending]) => pending));
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "fulfilled") continue;
    const state = stores[index][0];
    const detail = safeRuntimeError(result.reason);
    executionJournal.record("runtime.state-flush-failed", { state, error: detail });
    stamp(`RUNTIME_STATE_FLUSH_FAILED state=${state} error=${detail}`);
  }
}
'''
if text.count(old_stop_helper) != 1:
    raise SystemExit(f"expected one pre-startup stop helper, found {text.count(old_stop_helper)}")
text = text.replace(old_stop_helper, new_stop_helper)

old_flush = '''await explorerStateStore.flush();
await fixedPriceCycleStateStore.flush();
await exitTemplateStateStore.flush();
'''
new_flush = '''await flushRuntimeStateStores();
'''
if text.count(old_flush) != 1:
    raise SystemExit(f"expected one runtime state flush block, found {text.count(old_flush)}")
text = text.replace(old_flush, new_flush)

path.write_text(text)
