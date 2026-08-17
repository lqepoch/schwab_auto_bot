from pathlib import Path
import re

path = Path('src/automation/runtimeOrchestrator.ts')
text = path.read_text(encoding='utf-8')

old_repo_import = 'import { repositoryRootFromAutomationModuleUrl } from "./repositoryPaths.ts";\n'
new_repo_import = 'import { defaultAutomationRuntimeEntryPath, repositoryRootFromAutomationModuleUrl } from "./repositoryPaths.ts";\nimport { resolveAutomationRuntimeHost, type AutomationRuntimeOptions } from "./runtimeHost.ts";\n'
if old_repo_import not in text:
    raise SystemExit('REPOSITORY_PATH_IMPORT_ANCHOR_MISSING')
text = text.replace(old_repo_import, new_repo_import, 1)

old_signature = '''export async function runAutomationRuntime(): Promise<void> {\nconst root = repositoryRootFromAutomationModuleUrl(import.meta.url);\n'''
new_signature = '''export async function runAutomationRuntime(options: AutomationRuntimeOptions = {}): Promise<void> {\nconst host = resolveAutomationRuntimeHost(options, {\n  entryPath: defaultAutomationRuntimeEntryPath(import.meta.url),\n});\nconst root = repositoryRootFromAutomationModuleUrl(import.meta.url);\n'''
if old_signature not in text:
    raise SystemExit('RUNTIME_SIGNATURE_ANCHOR_MISSING')
text = text.replace(old_signature, new_signature, 1)

for old, new in [
    ('process.stderr', 'host.stderr'),
    ('process.argv', 'host.argv'),
    ('process.pid', 'host.pid'),
    ('process.execPath', 'host.execPath'),
    ('process.env', 'host.env'),
    ('bindRuntimeProcessHandlers(process,', 'bindRuntimeProcessHandlers(host.processEvents,'),
]:
    text = text.replace(old, new)

old_entry = 'entryPath: join(root, "src", "main.ts"),\n'
new_entry = 'entryPath: host.entryPath,\n'
if old_entry not in text:
    raise SystemExit('RUNTIME_ENTRY_PATH_ANCHOR_MISSING')
text = text.replace(old_entry, new_entry, 1)

remaining = re.findall(r'process\.(?:argv|env|pid|execPath|stderr|on|once|off)', text)
if remaining:
    raise SystemExit(f'PROCESS_GLOBAL_COUPLING_REMAINS:{remaining}')

path.write_text(text, encoding='utf-8')
