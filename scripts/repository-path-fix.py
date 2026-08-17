from pathlib import Path

provider = Path('src/automation/auth/provider.ts')
text = provider.read_text(encoding='utf-8')
old_imports = '''import { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\n'''
new_imports = 'import { defaultAutomationAuthStatePath } from "../repositoryPaths.ts";\n'
if old_imports not in text:
    raise SystemExit('PROVIDER_PATH_IMPORT_ANCHOR_MISSING')
text = text.replace(old_imports, new_imports, 1)
old_state = '''const root = dirname(dirname(fileURLToPath(import.meta.url)));\nconst statePath = process.env.SCHWAB_BOT_AUTH_FILE || join(root, "state", "schwab-auth.json");\n'''
new_state = '''const statePath = process.env.SCHWAB_BOT_AUTH_FILE || defaultAutomationAuthStatePath(import.meta.url);\n'''
if old_state not in text:
    raise SystemExit('PROVIDER_STATE_PATH_ANCHOR_MISSING')
text = text.replace(old_state, new_state, 1)
provider.write_text(text, encoding='utf-8')

runtime = Path('src/automation/runtimeOrchestrator.ts')
text = runtime.read_text(encoding='utf-8')
old_url_import = 'import { fileURLToPath } from "node:url";\n'
if old_url_import not in text:
    raise SystemExit('RUNTIME_URL_IMPORT_ANCHOR_MISSING')
text = text.replace(old_url_import, '', 1)
old_runtime_import = 'import { bindRuntimeProcessHandlers } from "./runtimeProcess.ts";\n'
new_runtime_import = old_runtime_import + 'import { repositoryRootFromAutomationModuleUrl } from "./repositoryPaths.ts";\n'
if old_runtime_import not in text:
    raise SystemExit('RUNTIME_PATH_IMPORT_ANCHOR_MISSING')
text = text.replace(old_runtime_import, new_runtime_import, 1)
old_root = 'const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));\n'
new_root = 'const root = repositoryRootFromAutomationModuleUrl(import.meta.url);\n'
if old_root not in text:
    raise SystemExit('RUNTIME_ROOT_ANCHOR_MISSING')
text = text.replace(old_root, new_root, 1)
runtime.write_text(text, encoding='utf-8')
