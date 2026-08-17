from pathlib import Path

path = Path('src/automation/runtimeOrchestrator.ts')
text = path.read_text(encoding='utf-8')

old_import = '''import {\n  fingerprintOrder,\n  safePath,\n  UnknownWriteReconciliation,\n  type UnknownWriteFailure,\n} from "./state/unknownWriteReconciliation.ts";\n'''
new_import = old_import + 'import { bindRuntimeProcessHandlers } from "./runtimeProcess.ts";\n'
if old_import not in text:
    raise SystemExit('IMPORT_ANCHOR_MISSING')
text = text.replace(old_import, new_import, 1)

old_lock = '''const runtimeLock = acquireRuntimeLock(runtimeLockPath, runId);\nprocess.once("exit", () => runtimeLock.release());\n'''
new_lock = '''const runtimeLock = acquireRuntimeLock(runtimeLockPath, runId);\n'''
if old_lock not in text:
    raise SystemExit('LOCK_ANCHOR_MISSING')
text = text.replace(old_lock, new_lock, 1)

old_stop = '''function stop(): void {\n  if (stopping) return;\n  stopReason = "signal";\n  stopping = true;\n  executionJournal.record("run.signal-received", { signal: "SIGINT_OR_SIGTERM" });\n}\nprocess.on("SIGINT", stop);\nprocess.on("SIGTERM", stop);\n'''
new_stop = '''function requestStop(reason: string): boolean {\n  if (stopping) return false;\n  stopReason = reason;\n  stopping = true;\n  return true;\n}\n\nconst unbindRuntimeProcessHandlers = bindRuntimeProcessHandlers(process, {\n  onSignal: (signal) => {\n    if (!requestStop("signal")) return;\n    executionJournal.record("run.signal-received", { signal });\n  },\n  onExit: () => runtimeLock.release(),\n});\n'''
if old_stop not in text:
    raise SystemExit('STOP_ANCHOR_MISSING')
text = text.replace(old_stop, new_stop, 1)

old_blocked = '''    stamp(reason === "bootstrap-failed"\n      ? `启动停止：账户 bootstrap 失败 error=${String(error)}`\n      : "启动停止：初始完整订单快照或未知写入只读对账失败，未启动任何交易循环");\n    stop();\n'''
new_blocked = '''    stamp(reason === "bootstrap-failed"\n      ? `启动停止：账户 bootstrap 失败 error=${String(error)}`\n      : "启动停止：初始完整订单快照或未知写入只读对账失败，未启动任何交易循环");\n    requestStop(startupReason);\n'''
if old_blocked not in text:
    raise SystemExit('STARTUP_BLOCK_ANCHOR_MISSING')
text = text.replace(old_blocked, new_blocked, 1)

old_once = '''if (once || !startupReady) {\n  stop();\n} else {\n'''
new_once = '''if (once || !startupReady) {\n  requestStop(once ? "once-complete" : "startup-blocked");\n} else {\n'''
if old_once not in text:
    raise SystemExit('ONCE_ANCHOR_MISSING')
text = text.replace(old_once, new_once, 1)

old_shutdown = '''executionJournal.record("run.stopped", { reason: stopReason });\nawait executionJournal.flush();\nruntimeLock.release();\n\n}\n'''
new_shutdown = '''executionJournal.record("run.stopped", { reason: stopReason });\nawait executionJournal.flush();\nunbindRuntimeProcessHandlers();\nruntimeLock.release();\n\n}\n'''
if old_shutdown not in text:
    raise SystemExit('SHUTDOWN_ANCHOR_MISSING')
text = text.replace(old_shutdown, new_shutdown, 1)

if 'SIGINT_OR_SIGTERM' in text:
    raise SystemExit('STALE_SIGNAL_LABEL_REMAINS')
if 'function stop()' in text:
    raise SystemExit('STALE_STOP_FUNCTION_REMAINS')

path.write_text(text, encoding='utf-8')
