from pathlib import Path

path = Path('src/automation/runtimeOrchestrator.ts')
text = path.read_text(encoding='utf-8')

old_import = 'import { ExecutionJournal } from "./observability/executionJournal.ts";\n'
new_import = old_import + 'import { safeRuntimeError } from "./observability/runtimeError.ts";\n'
if old_import not in text:
    raise SystemExit('RUNTIME_ERROR_IMPORT_ANCHOR_MISSING')
text = text.replace(old_import, new_import, 1)

replacements = {
    'error=${String(error)}': 'error=${safeRuntimeError(error)}',
    'error: String(error)': 'error: safeRuntimeError(error)',
    'reason: String(error)': 'reason: safeRuntimeError(error)',
    'error === undefined ? null : String(error)': 'error === undefined ? null : safeRuntimeError(error)',
}
for old, new in replacements.items():
    text = text.replace(old, new)

# Classification-only String(error) calls are intentionally retained. They are
# local control-flow predicates and never leave the runtime boundary.
for unsafe_fragment in [
    'EXECUTION_JOURNAL_WRITE_FAILED error=${String(error)}',
    'STATE_SAVE_FAILED error=${String(error)}',
    '订单快照失败 full=${scope === "full"} error=${String(error)}',
    'LIQUIDITY_EXIT_POSITION_REFRESH_FAILED strategy=${meta.key} error=${String(error)}',
    'POLICY_ALERT_AUDIT_FAILED error=${String(error)}',
    '刷新前订单或持仓对账失败 error=${String(error)}',
    '独立卖出 worker 失败 strategy=${strategy} error=${String(error)}',
    'RUNTIME_CONTROL_READ_FAILED error=${String(error)}',
]:
    if unsafe_fragment in text:
        raise SystemExit(f'UNSAFE_RUNTIME_DIAGNOSTIC_REMAINS:{unsafe_fragment}')

path.write_text(text, encoding='utf-8')
