from pathlib import Path

path = Path('src/automation/runtimeOrchestrator.ts')
text = path.read_text(encoding='utf-8')

old_import = 'import { bindRuntimeProcessHandlers } from "./runtimeProcess.ts";\n'
new_import = 'import { bindRuntimeAbortSignal, bindRuntimeProcessHandlers } from "./runtimeProcess.ts";\n'
if old_import not in text:
    raise SystemExit('ABORT_BIND_IMPORT_ANCHOR_MISSING')
text = text.replace(old_import, new_import, 1)

old_cleanup = '''const runtimeLock = acquireRuntimeLock(runtimeLockPath, runId, host.pid);\nlet unbindRuntimeProcessHandlers = () => {};\ntry {\n'''
new_cleanup = '''const runtimeLock = acquireRuntimeLock(runtimeLockPath, runId, host.pid);\nlet unbindRuntimeProcessHandlers = () => {};\nlet unbindRuntimeAbortSignal = () => {};\ntry {\n'''
if old_cleanup not in text:
    raise SystemExit('ABORT_CLEANUP_ANCHOR_MISSING')
text = text.replace(old_cleanup, new_cleanup, 1)

old_request = '''function requestStop(reason: string): boolean {\n  if (stopping) return false;\n  stopReason = reason;\n  stopping = true;\n  return true;\n}\n\nfunction launchRuntimeBackgroundTask(\n'''
new_request = '''function requestStop(reason: string): boolean {\n  if (stopping) return false;\n  stopReason = reason;\n  stopping = true;\n  return true;\n}\n\nasync function completeStoppedBeforeStartup(): Promise<void> {\n  await writeRuntimeState("stopped", stopReason);\n  executionJournal.record("run.stopped", { reason: stopReason, phase: "before-startup" });\n  await executionJournal.flush();\n}\n\nfunction launchRuntimeBackgroundTask(\n'''
if old_request not in text:
    raise SystemExit('ABORT_PRESTART_HELPER_ANCHOR_MISSING')
text = text.replace(old_request, new_request, 1)

old_bind = '''unbindRuntimeProcessHandlers = bindRuntimeProcessHandlers(host.processEvents, {\n  onSignal: (signal) => {\n    if (!requestStop("signal")) return;\n    executionJournal.record("run.signal-received", { signal });\n  },\n  onExit: () => runtimeLock.release(),\n});\n\nif (!readOnly) await ensureWeeklyReauthorization();\nawait writeRuntimeState("running");\nexecutionJournal.record("run.started", {\n'''
new_bind = '''unbindRuntimeProcessHandlers = bindRuntimeProcessHandlers(host.processEvents, {\n  onSignal: (signal) => {\n    if (!requestStop("signal")) return;\n    executionJournal.record("run.signal-received", { signal });\n  },\n  onExit: () => runtimeLock.release(),\n});\nunbindRuntimeAbortSignal = bindRuntimeAbortSignal(host.signal, () => {\n  if (!requestStop("abort-signal")) return;\n  executionJournal.record("run.abort-requested", { source: "AutomationRuntimeOptions.signal" });\n});\n\nif (stopping) {\n  await completeStoppedBeforeStartup();\n  return;\n}\nif (!readOnly) await ensureWeeklyReauthorization();\nif (stopping) {\n  await completeStoppedBeforeStartup();\n  return;\n}\nawait writeRuntimeState("running");\nif (stopping) {\n  await completeStoppedBeforeStartup();\n  return;\n}\nexecutionJournal.record("run.started", {\n'''
if old_bind not in text:
    raise SystemExit('ABORT_RUNTIME_BIND_ANCHOR_MISSING')
text = text.replace(old_bind, new_bind, 1)

text = text.replace('''  startActivityStream: async () => {\n    if (once) return;\n''', '''  startActivityStream: async () => {\n    if (once || stopping) return;\n''', 1)
text = text.replace('if (startupReady && !readOnly) {\n', 'if (startupReady && !readOnly && !stopping) {\n', 1)

old_once = '''if (once || !startupReady) {\n  requestStop(once ? "once-complete" : "startup-blocked");\n} else {\n'''
new_once = '''if (once || !startupReady || stopping) {\n  if (!stopping) requestStop(once ? "once-complete" : "startup-blocked");\n} else {\n'''
if old_once not in text:
    raise SystemExit('ABORT_INTERVAL_GATE_ANCHOR_MISSING')
text = text.replace(old_once, new_once, 1)

old_finally = '''} finally {\n  unbindRuntimeProcessHandlers();\n  runtimeLock.release();\n}\n}\n'''
new_finally = '''} finally {\n  unbindRuntimeAbortSignal();\n  unbindRuntimeProcessHandlers();\n  runtimeLock.release();\n}\n}\n'''
if old_finally not in text:
    raise SystemExit('ABORT_FINALIZER_ANCHOR_MISSING')
text = text.replace(old_finally, new_finally, 1)

for required in [
    'bindRuntimeAbortSignal(host.signal',
    'completeStoppedBeforeStartup()',
    'if (once || stopping) return;',
    'if (startupReady && !readOnly && !stopping)',
    'if (once || !startupReady || stopping)',
    'unbindRuntimeAbortSignal();',
]:
    if required not in text:
        raise SystemExit(f'ABORT_REQUIRED_FRAGMENT_MISSING:{required}')

path.write_text(text, encoding='utf-8')
