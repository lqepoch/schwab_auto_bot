from pathlib import Path

path = Path('src/automation/runtimeOrchestrator.ts')
text = path.read_text(encoding='utf-8')

old_host = '''const host = resolveAutomationRuntimeHost(options, {\n  entryPath: defaultAutomationRuntimeEntryPath(import.meta.url),\n});\nconst root = repositoryRootFromAutomationModuleUrl(import.meta.url);\nconst automationAuthOptions: AutomationAuthOptions = { env: host.env };\n'''
new_host = '''const codeRoot = repositoryRootFromAutomationModuleUrl(import.meta.url);\nconst host = resolveAutomationRuntimeHost(options, {\n  entryPath: defaultAutomationRuntimeEntryPath(import.meta.url),\n  workspaceRoot: codeRoot,\n});\nconst root = host.workspaceRoot;\nconst automationAuthOptions: AutomationAuthOptions = {\n  env: host.env,\n  statePath: host.env.SCHWAB_BOT_AUTH_FILE || join(root, "state", "schwab-auth.json"),\n};\n'''
if old_host not in text:
    raise SystemExit('RUNTIME_WORKSPACE_HOST_ANCHOR_MISSING')
text = text.replace(old_host, new_host, 1)

old_lock = 'const runtimeLock = acquireRuntimeLock(runtimeLockPath, runId);\n'
new_lock = 'const runtimeLock = acquireRuntimeLock(runtimeLockPath, runId, host.pid);\n'
if old_lock not in text:
    raise SystemExit('RUNTIME_LOCK_PID_ANCHOR_MISSING')
text = text.replace(old_lock, new_lock, 1)

old_reauth = '''  reauthorizeInteractively: () => runInteractiveLogin({\n    beginLogin: () => beginLogin(automationAuthOptions),\n    login: (callbackUrl, state) => login(callbackUrl, state, automationAuthOptions),\n  }),\n'''
new_reauth = '''  reauthorizeInteractively: host.reauthorizeInteractively ?? (() => runInteractiveLogin({\n    beginLogin: () => beginLogin(automationAuthOptions),\n    login: (callbackUrl, state) => login(callbackUrl, state, automationAuthOptions),\n  })),\n'''
if old_reauth not in text:
    raise SystemExit('RUNTIME_REAUTH_CALLBACK_ANCHOR_MISSING')
text = text.replace(old_reauth, new_reauth, 1)

if 'const root = repositoryRootFromAutomationModuleUrl(import.meta.url);' in text:
    raise SystemExit('STALE_RUNTIME_ROOT_REMAINS')
if 'acquireRuntimeLock(runtimeLockPath, runId);' in text:
    raise SystemExit('STALE_RUNTIME_LOCK_PID_REMAINS')

path.write_text(text, encoding='utf-8')
