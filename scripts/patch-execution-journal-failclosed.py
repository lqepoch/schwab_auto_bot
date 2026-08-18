from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()

old_constructor = '''const executionJournal = new ExecutionJournal(root, runId, (error) => {
  host.stderr.write(`${new Date().toISOString()} EXECUTION_JOURNAL_WRITE_FAILED error=${safeRuntimeError(error)}\\n`);
});
'''
new_constructor = '''let executionJournalPersistenceFault: unknown = null;
let executionJournalStopHandler: (() => void) | null = null;
const executionJournal = new ExecutionJournal(root, runId, (error) => {
  executionJournalPersistenceFault ??= error;
  host.stderr.write(`${new Date().toISOString()} EXECUTION_JOURNAL_WRITE_FAILED error=${safeRuntimeError(error)}\\n`);
  executionJournalStopHandler?.();
});
'''
if text.count(old_constructor) != 1:
    raise SystemExit(f"expected one execution journal constructor, found {text.count(old_constructor)}")
text = text.replace(old_constructor, new_constructor)

old_stopping = '''let stopping = false;
let stopReason = "normal";
let controlCheckRunning = false;
'''
new_stopping = '''let stopping = false;
let stopReason = "normal";
executionJournalStopHandler = () => {
  requestStop("execution-journal-persistence-failed");
};
if (executionJournalPersistenceFault !== null) executionJournalStopHandler();
let controlCheckRunning = false;
'''
if text.count(old_stopping) != 1:
    raise SystemExit(f"expected one stopping block, found {text.count(old_stopping)}")
text = text.replace(old_stopping, new_stopping)

old_write_guard = '''function assertBrokerWritesAllowed(key: string, method: "POST" | "PUT" | "DELETE", path: string): void {
  if (!fullSnapshotReconciled) {
'''
new_write_guard = '''function assertBrokerWritesAllowed(key: string, method: "POST" | "PUT" | "DELETE", path: string): void {
  executionJournal.assertHealthy();
  if (!fullSnapshotReconciled) {
'''
if text.count(old_write_guard) != 1:
    raise SystemExit(f"expected one broker write guard, found {text.count(old_write_guard)}")
text = text.replace(old_write_guard, new_write_guard)

old_final_gate = '''    beforeFinalWrite: async () => {
      await ensureWeeklyReauthorization();
      policy.requireExecutionWindow();
    },
'''
new_final_gate = '''    beforeFinalWrite: async () => {
      executionJournal.assertHealthy();
      await ensureWeeklyReauthorization();
      policy.requireExecutionWindow();
      executionJournal.assertHealthy();
    },
'''
if text.count(old_final_gate) != 1:
    raise SystemExit(f"expected one final write gate, found {text.count(old_final_gate)}")
text = text.replace(old_final_gate, new_final_gate)

old_startup = '''if (stopping) {
  await completeStoppedBeforeStartup();
  return;
}
if (!readOnly) await ensureWeeklyReauthorization();
'''
new_startup = '''if (stopping) {
  await completeStoppedBeforeStartup();
  return;
}
executionJournal.record("run.journal-preflight", { readOnly });
await executionJournal.flush();
if (stopping) {
  await completeStoppedBeforeStartup();
  return;
}
if (!readOnly) await ensureWeeklyReauthorization();
'''
if text.count(old_startup) != 1:
    raise SystemExit(f"expected one startup preflight insertion point, found {text.count(old_startup)}")
text = text.replace(old_startup, new_startup)

path.write_text(text)
