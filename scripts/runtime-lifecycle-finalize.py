from pathlib import Path

path = Path('src/automation/runtimeOrchestrator.ts')
text = path.read_text(encoding='utf-8')

old_lock = '''const runtimeLock = acquireRuntimeLock(runtimeLockPath, runId);\nlet sellOrderAutomationDisabledRecorded = false;\n'''
new_lock = '''const runtimeLock = acquireRuntimeLock(runtimeLockPath, runId);\nlet unbindRuntimeProcessHandlers = () => {};\ntry {\nlet sellOrderAutomationDisabledRecorded = false;\n'''
if old_lock not in text:
    raise SystemExit('LOCK_TRY_ANCHOR_MISSING')
text = text.replace(old_lock, new_lock, 1)

old_refresh_stop = '''  if (stopping) return;\n  stopReason = "max-refresh-rounds";\n  stopping = true;\n  executionJournal.record("run.refresh-round-limit-completed", state);\n'''
new_refresh_stop = '''  if (!requestStop("max-refresh-rounds")) return;\n  executionJournal.record("run.refresh-round-limit-completed", state);\n'''
if old_refresh_stop not in text:
    raise SystemExit('REFRESH_STOP_ANCHOR_MISSING')
text = text.replace(old_refresh_stop, new_refresh_stop, 1)

old_control_stop = '''    stopReason = String(request.command);\n    stopping = true;\n    executionJournal.record("run.control-requested", { command: request.command, requestId: request.requestId });\n'''
new_control_stop = '''    if (!requestStop(String(request.command))) return;\n    executionJournal.record("run.control-requested", { command: request.command, requestId: request.requestId });\n'''
if old_control_stop not in text:
    raise SystemExit('CONTROL_STOP_ANCHOR_MISSING')
text = text.replace(old_control_stop, new_control_stop, 1)

old_bind = '''const unbindRuntimeProcessHandlers = bindRuntimeProcessHandlers(process, {\n'''
new_bind = '''unbindRuntimeProcessHandlers = bindRuntimeProcessHandlers(process, {\n'''
if old_bind not in text:
    raise SystemExit('BIND_ANCHOR_MISSING')
text = text.replace(old_bind, new_bind, 1)

old_tail = '''executionJournal.record("run.stopped", { reason: stopReason });\nawait executionJournal.flush();\nunbindRuntimeProcessHandlers();\nruntimeLock.release();\n\n}\n'''
new_tail = '''executionJournal.record("run.stopped", { reason: stopReason });\nawait executionJournal.flush();\n\n} finally {\n  unbindRuntimeProcessHandlers();\n  runtimeLock.release();\n}\n}\n'''
if old_tail not in text:
    raise SystemExit('FINALIZER_ANCHOR_MISSING')
text = text.replace(old_tail, new_tail, 1)

if text.count('stopping = true;') != 1:
    raise SystemExit(f'UNEXPECTED_DIRECT_STOP_ASSIGNMENTS:{text.count("stopping = true;")}')
if text.count('runtimeLock.release();') != 2:
    raise SystemExit(f'UNEXPECTED_RUNTIME_LOCK_RELEASES:{text.count("runtimeLock.release();")}')

path.write_text(text, encoding='utf-8')
