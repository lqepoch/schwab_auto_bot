from pathlib import Path

path = Path('src/automation/runtimeOrchestrator.ts')
text = path.read_text(encoding='utf-8')

old_import = 'import { repositoryRootFromAutomationModuleUrl } from "./repositoryPaths.ts";\n'
new_import = old_import + 'import { superviseBackgroundTask } from "./backgroundTask.ts";\n'
if old_import not in text:
    raise SystemExit('BACKGROUND_IMPORT_ANCHOR_MISSING')
text = text.replace(old_import, new_import, 1)

old_activity_timer = '''  activityRestTimer = setTimeout(() => {\n    activityRestTimer = null;\n    void runActivityRestConfirmation();\n  }, Math.max(0, dueAt - Date.now()));\n'''
new_activity_timer = '''  activityRestTimer = setTimeout(() => {\n    activityRestTimer = null;\n    launchRuntimeBackgroundTask("activity-rest-confirmation", runActivityRestConfirmation);\n  }, Math.max(0, dueAt - Date.now()));\n'''
if old_activity_timer not in text:
    raise SystemExit('ACTIVITY_TIMER_ANCHOR_MISSING')
text = text.replace(old_activity_timer, new_activity_timer, 1)

old_activity_body = '''  activityRestRunning = true;\n  const confirmingThrough = lastIncompleteActivityAt;\n  let confirmed = false;\n  const coveredByOtherPoll = lastFillPollAt >= confirmingThrough;\n  if (!stopping && !coveredByOtherPoll) {\n    // Record the attempt before I/O.  Otherwise a transient REST failure can\n    // immediately re-arm every stream message and consume the entire quota.\n    lastActivityRestAt = Date.now();\n    executionJournal.record("activity.rest-confirmation-started", {\n      confirmingThrough: new Date(confirmingThrough).toISOString(),\n      debounceMs: ACTIVITY_REST_DEBOUNCE_MS,\n      minIntervalMs: ACTIVITY_REST_MIN_INTERVAL_MS,\n    });\n    confirmed = await poll(false, 0);\n  }\n  activityRestRunning = false;\n  if ((!confirmed && !coveredByOtherPoll) || lastIncompleteActivityAt > confirmingThrough) {\n    armActivityRestConfirmation();\n  }\n'''
new_activity_body = '''  activityRestRunning = true;\n  const confirmingThrough = lastIncompleteActivityAt;\n  let confirmed = false;\n  const coveredByOtherPoll = lastFillPollAt >= confirmingThrough;\n  try {\n    if (!stopping && !coveredByOtherPoll) {\n      // Record the attempt before I/O.  Otherwise a transient REST failure can\n      // immediately re-arm every stream message and consume the entire quota.\n      lastActivityRestAt = Date.now();\n      executionJournal.record("activity.rest-confirmation-started", {\n        confirmingThrough: new Date(confirmingThrough).toISOString(),\n        debounceMs: ACTIVITY_REST_DEBOUNCE_MS,\n        minIntervalMs: ACTIVITY_REST_MIN_INTERVAL_MS,\n      });\n      confirmed = await poll(false, 0);\n    }\n  } finally {\n    activityRestRunning = false;\n  }\n  if ((!confirmed && !coveredByOtherPoll) || lastIncompleteActivityAt > confirmingThrough) {\n    armActivityRestConfirmation();\n  }\n'''
if old_activity_body not in text:
    raise SystemExit('ACTIVITY_BODY_ANCHOR_MISSING')
text = text.replace(old_activity_body, new_activity_body, 1)

old_start_loop = '''    activityStream.start();\n    if (!readOnly) void explorerRoundLoop();\n'''
new_start_loop = '''    activityStream.start();\n    if (!readOnly) launchRuntimeBackgroundTask("explorer-round-loop", explorerRoundLoop);\n'''
if old_start_loop not in text:
    raise SystemExit('EXPLORER_LOOP_ANCHOR_MISSING')
text = text.replace(old_start_loop, new_start_loop, 1)

old_intervals = '''  runtimeIntervals.push(setInterval(() => {\n    const fallbackDue = Date.now() - lastFillPollAt >= 30_000;\n    if (!activityStream?.ready || fallbackDue) void poll(false);\n  }, 2_000));\n  if (!policy.repeatBuyAtOrderPrice) runtimeIntervals.push(setInterval(() => void explorerTick(), 200));\n  if (policy.repeatBuyAtOrderPrice) runtimeIntervals.push(setInterval(() => {\n    if (fixedPriceRefreshRoundActive) void poll(true, 3);\n  }, 2_000));\n'''
new_intervals = '''  runtimeIntervals.push(setInterval(() => {\n    const fallbackDue = Date.now() - lastFillPollAt >= 30_000;\n    if (!activityStream?.ready || fallbackDue) {\n      launchRuntimeBackgroundTask("fallback-fill-poll", () => poll(false));\n    }\n  }, 2_000));\n  if (!policy.repeatBuyAtOrderPrice) runtimeIntervals.push(setInterval(() => {\n    launchRuntimeBackgroundTask("explorer-tick", explorerTick);\n  }, 200));\n  if (policy.repeatBuyAtOrderPrice) runtimeIntervals.push(setInterval(() => {\n    if (fixedPriceRefreshRoundActive) {\n      launchRuntimeBackgroundTask("fixed-price-full-poll", () => poll(true, 3));\n    }\n  }, 2_000));\n'''
if old_intervals not in text:
    raise SystemExit('INTERVAL_ANCHOR_MISSING')
text = text.replace(old_intervals, new_intervals, 1)

old_request_stop = '''function requestStop(reason: string): boolean {\n  if (stopping) return false;\n  stopReason = reason;\n  stopping = true;\n  return true;\n}\n\nunbindRuntimeProcessHandlers = bindRuntimeProcessHandlers(process, {\n'''
new_request_stop = '''function requestStop(reason: string): boolean {\n  if (stopping) return false;\n  stopReason = reason;\n  stopping = true;\n  return true;\n}\n\nfunction launchRuntimeBackgroundTask(\n  task: string,\n  operation: () => void | Promise<unknown>,\n): void {\n  superviseBackgroundTask(task, operation, (_task, error, code) => {\n    if (!requestStop(`background-task-failed:${task}`)) return;\n    executionJournal.record("runtime.background-task-failed", {\n      task,\n      code,\n      errorName: error instanceof Error ? error.name : typeof error,\n    });\n    stamp(`RUNTIME_BACKGROUND_TASK_FAILED task=${task} code=${code}`);\n  });\n}\n\nunbindRuntimeProcessHandlers = bindRuntimeProcessHandlers(process, {\n'''
if old_request_stop not in text:
    raise SystemExit('REQUEST_STOP_ANCHOR_MISSING')
text = text.replace(old_request_stop, new_request_stop, 1)

for stale in [
    'void runActivityRestConfirmation();',
    'if (!readOnly) void explorerRoundLoop();',
    'if (!activityStream?.ready || fallbackDue) void poll(false);',
    'setInterval(() => void explorerTick()',
    'if (fixedPriceRefreshRoundActive) void poll(true, 3);',
]:
    if stale in text:
        raise SystemExit(f'STALE_BACKGROUND_CALL:{stale}')

path.write_text(text, encoding='utf-8')
