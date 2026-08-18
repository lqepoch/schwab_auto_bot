from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()

text = text.replace(
    'import { appendFile, mkdir, readFile, unlink } from "node:fs/promises";\nimport { dirname, join } from "node:path";\n',
    'import { readFile, unlink } from "node:fs/promises";\nimport { join } from "node:path";\n',
)
text = text.replace(
    'import { ExecutionJournal } from "./observability/executionJournal.ts";\n',
    'import { ExecutionJournal } from "./observability/executionJournal.ts";\nimport { DurableJsonlWriter } from "./observability/durableJsonl.ts";\n',
)

old_journal = '''const executionJournal = new ExecutionJournal(root, runId, (error) => {
  executionJournalPersistenceFault ??= error;
  host.stderr.write(`${new Date().toISOString()} EXECUTION_JOURNAL_WRITE_FAILED error=${safeRuntimeError(error)}\\n`);
  executionJournalStopHandler?.();
});
'''
new_journal = '''const executionJournal = new ExecutionJournal(root, runId, (error) => {
  executionJournalPersistenceFault ??= error;
  host.stderr.write(`${new Date().toISOString()} EXECUTION_JOURNAL_WRITE_FAILED error=${safeRuntimeError(error)}\\n`);
  executionJournalStopHandler?.();
});
let operationalAuditPersistenceFault: { source: string; error: unknown } | null = null;
let operationalAuditStopHandler: ((source: string) => void) | null = null;
function noteOperationalAuditFailure(source: string, error: unknown): void {
  operationalAuditPersistenceFault ??= { source, error };
  host.stderr.write(`${new Date().toISOString()} OPERATIONAL_AUDIT_WRITE_FAILED source=${source} error=${safeRuntimeError(error)}\\n`);
  operationalAuditStopHandler?.(source);
}
const sendEvidenceAudit = new DurableJsonlWriter(evidencePath, {
  failureCode: "SEND_EVIDENCE_PERSISTENCE_FAILED",
  onFailure: (error) => noteOperationalAuditFailure("send-evidence", error),
});
const policyAlertAudit = new DurableJsonlWriter(policyAlertPath, {
  failureCode: "POLICY_ALERT_PERSISTENCE_FAILED",
  onFailure: (error) => noteOperationalAuditFailure("policy-alert", error),
});
'''
if text.count(old_journal) != 1:
    raise SystemExit(f"expected one journal constructor block, found {text.count(old_journal)}")
text = text.replace(old_journal, new_journal)

old_stop = '''executionJournalStopHandler = () => {
  requestStop("execution-journal-persistence-failed");
};
if (executionJournalPersistenceFault !== null) executionJournalStopHandler();
let controlCheckRunning = false;
'''
new_stop = '''executionJournalStopHandler = () => {
  requestStop("execution-journal-persistence-failed");
};
if (executionJournalPersistenceFault !== null) executionJournalStopHandler();
operationalAuditStopHandler = (source) => {
  requestStop(`operational-audit-persistence-failed:${source}`);
};
if (operationalAuditPersistenceFault !== null) {
  operationalAuditStopHandler(operationalAuditPersistenceFault.source);
}
let controlCheckRunning = false;
'''
if text.count(old_stop) != 1:
    raise SystemExit(f"expected one stop handler block, found {text.count(old_stop)}")
text = text.replace(old_stop, new_stop)

old_guard = '''function assertBrokerWritesAllowed(key: string, method: "POST" | "PUT" | "DELETE", path: string): void {
  executionJournal.assertHealthy();
'''
new_guard = '''function assertOperationalAuditsHealthy(): void {
  executionJournal.assertHealthy();
  sendEvidenceAudit.assertHealthy();
  policyAlertAudit.assertHealthy();
}

function assertBrokerWritesAllowed(key: string, method: "POST" | "PUT" | "DELETE", path: string): void {
  assertOperationalAuditsHealthy();
'''
if text.count(old_guard) != 1:
    raise SystemExit(f"expected one broker guard block, found {text.count(old_guard)}")
text = text.replace(old_guard, new_guard)

old_final = '''    beforeFinalWrite: async () => {
      executionJournal.assertHealthy();
      await ensureWeeklyReauthorization();
      policy.requireExecutionWindow();
      executionJournal.assertHealthy();
    },
'''
new_final = '''    beforeFinalWrite: async () => {
      assertOperationalAuditsHealthy();
      await ensureWeeklyReauthorization();
      policy.requireExecutionWindow();
      assertOperationalAuditsHealthy();
    },
'''
if text.count(old_final) != 1:
    raise SystemExit(f"expected one final write guard, found {text.count(old_final)}")
text = text.replace(old_final, new_final)

old_evidence = '''async function evidence(
  key: string,
  method: string,
  path: string,
  payload: Json,
  preflight: OrderWritePreflight | "NOT_APPLICABLE",
): Promise<void> {
  await mkdir(dirname(evidencePath), { recursive: true });
  await appendFile(evidencePath, `${JSON.stringify({
    at: new Date().toISOString(), key, method, endpoint: path, preflight,
    payloadShape: { orderType: payload.orderType, price: payload.price, quantity: payload.quantity },
  })}\\n`);
}
'''
new_evidence = '''async function evidence(
  key: string,
  method: string,
  path: string,
  payload: Json,
  preflight: OrderWritePreflight | "NOT_APPLICABLE",
): Promise<void> {
  await sendEvidenceAudit.append({
    at: new Date().toISOString(), key, method, endpoint: path, preflight,
    payloadShape: { orderType: payload.orderType, price: payload.price, quantity: payload.quantity },
  });
}
'''
if text.count(old_evidence) != 1:
    raise SystemExit(f"expected one evidence function, found {text.count(old_evidence)}")
text = text.replace(old_evidence, new_evidence)

old_alert = '''  const record = {
    at: new Date().toISOString(), source, orderId: id, code, price: order.price ?? null, message,
  };
  stamp(`POLICY_ALERT code=${code} source=${source} order=${id} price=${String(order.price ?? "unknown")} detail=${message}`);
  void mkdir(dirname(policyAlertPath), { recursive: true })
    .then(() => appendFile(policyAlertPath, `${JSON.stringify(record)}\\n`))
    .catch((error) => stamp(`POLICY_ALERT_AUDIT_FAILED error=${safeRuntimeError(error)}`));
}
'''
new_alert = '''  const record = {
    at: new Date().toISOString(), source, orderId: id, code, price: order.price ?? null, message,
  };
  executionJournal.record("policy.alert", record);
  stamp(`POLICY_ALERT code=${code} source=${source} order=${id} price=${String(order.price ?? "unknown")} detail=${message}`);
  void policyAlertAudit.append(record).catch(() => undefined);
}
'''
if text.count(old_alert) != 1:
    raise SystemExit(f"expected one policy alert block, found {text.count(old_alert)}")
text = text.replace(old_alert, new_alert)

old_flush = '''const stateFlushResults = await Promise.allSettled([
  explorerStateStore.flush(),
  fixedPriceCycleStateStore.flush(),
  exitTemplateStateStore.flush(),
]);
'''
new_flush = '''const auditFlushResults = await Promise.allSettled([
  sendEvidenceAudit.flush(),
  policyAlertAudit.flush(),
]);
const auditFlushFailure = auditFlushResults.find(
  (result): result is PromiseRejectedResult => result.status === "rejected",
);
if (auditFlushFailure) {
  const code = safeRuntimeError(auditFlushFailure.reason);
  executionJournal.record("runtime.operational-audit-flush-failed", { code });
  stamp(`OPERATIONAL_AUDIT_FLUSH_FAILED error=${code}`);
}
const stateFlushResults = await Promise.allSettled([
  explorerStateStore.flush(),
  fixedPriceCycleStateStore.flush(),
  exitTemplateStateStore.flush(),
]);
'''
if text.count(old_flush) != 1:
    raise SystemExit(f"expected one state flush block, found {text.count(old_flush)}")
text = text.replace(old_flush, new_flush)

old_throw = '''await executionJournal.flush();
if (stateFlushFailure) {
  throw new Error("RUNTIME_STATE_PERSISTENCE_FAILED", { cause: stateFlushFailure.reason });
}
'''
new_throw = '''await executionJournal.flush();
if (auditFlushFailure) {
  throw new Error("OPERATIONAL_AUDIT_PERSISTENCE_FAILED", { cause: auditFlushFailure.reason });
}
if (stateFlushFailure) {
  throw new Error("RUNTIME_STATE_PERSISTENCE_FAILED", { cause: stateFlushFailure.reason });
}
'''
if text.count(old_throw) != 1:
    raise SystemExit(f"expected one shutdown failure block, found {text.count(old_throw)}")
text = text.replace(old_throw, new_throw)

path.write_text(text)
