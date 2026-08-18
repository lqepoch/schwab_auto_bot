from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()


def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one match, found {count}: {old[:140]!r}")
    text = text.replace(old, new, 1)


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
new_store_block = '''function handleRuntimeStateWriteFailure(store: string, error: unknown): void {
  const code = safeRuntimeError(error);
  executionJournal.record("runtime.state-persistence-failed", { store, code });
  stamp(`RUNTIME_STATE_PERSISTENCE_FAILED store=${store} error=${code}`);
  requestStop(`state-persistence-failed:${store}`);
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
replace_once(old_store_block, new_store_block)

old_shutdown = '''await writer.waitIdle();
await explorerStateStore.flush();
await fixedPriceCycleStateStore.flush();
await exitTemplateStateStore.flush();
await writeRuntimeState("stopped", stopReason);
executionJournal.record("run.stopped", { reason: stopReason });
await executionJournal.flush();
'''
new_shutdown = '''await writer.waitIdle();
const stateFlushResults = await Promise.allSettled([
  explorerStateStore.flush(),
  fixedPriceCycleStateStore.flush(),
  exitTemplateStateStore.flush(),
]);
const stateFlushFailure = stateFlushResults.find(
  (result): result is PromiseRejectedResult => result.status === "rejected",
);
if (stateFlushFailure) {
  const code = safeRuntimeError(stateFlushFailure.reason);
  executionJournal.record("runtime.state-flush-failed", { code });
  stamp(`RUNTIME_STATE_FLUSH_FAILED error=${code}`);
}
await writeRuntimeState("stopped", stopReason);
executionJournal.record("run.stopped", { reason: stopReason });
await executionJournal.flush();
if (stateFlushFailure) {
  throw new Error("RUNTIME_STATE_PERSISTENCE_FAILED", { cause: stateFlushFailure.reason });
}
'''
replace_once(old_shutdown, new_shutdown)

path.write_text(text)
