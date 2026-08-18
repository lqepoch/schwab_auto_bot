from pathlib import Path

path = Path("src/automation/runtimeOrchestrator.ts")
text = path.read_text()

old_decl = '''let operationalAuditPersistenceFault: { source: string; error: unknown } | null = null;
let operationalAuditStopHandler: ((source: string) => void) | null = null;
function noteOperationalAuditFailure(source: string, error: unknown): void {
  operationalAuditPersistenceFault ??= { source, error };
  host.stderr.write(`${new Date().toISOString()} OPERATIONAL_AUDIT_WRITE_FAILED source=${source} error=${safeRuntimeError(error)}\\n`);
  operationalAuditStopHandler?.(source);
}
'''
new_decl = '''let operationalAuditStopHandler: ((source: string) => void) | null = null;
function noteOperationalAuditFailure(source: string, error: unknown): void {
  host.stderr.write(`${new Date().toISOString()} OPERATIONAL_AUDIT_WRITE_FAILED source=${source} error=${safeRuntimeError(error)}\\n`);
  operationalAuditStopHandler?.(source);
}
'''
if text.count(old_decl) != 1:
    raise SystemExit(f"expected one operational audit declaration block, found {text.count(old_decl)}")
text = text.replace(old_decl, new_decl)

old_start = '''operationalAuditStopHandler = (source) => {
  requestStop(`operational-audit-persistence-failed:${source}`);
};
if (operationalAuditPersistenceFault !== null) {
  operationalAuditStopHandler(operationalAuditPersistenceFault.source);
}
let controlCheckRunning = false;
'''
new_start = '''operationalAuditStopHandler = (source) => {
  requestStop(`operational-audit-persistence-failed:${source}`);
};
let controlCheckRunning = false;
'''
if text.count(old_start) != 1:
    raise SystemExit(f"expected one operational audit stop block, found {text.count(old_start)}")
text = text.replace(old_start, new_start)

path.write_text(text)
