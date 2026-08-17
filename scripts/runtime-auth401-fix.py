from pathlib import Path

path = Path('src/automation/runtimeOrchestrator.ts')
text = path.read_text(encoding='utf-8')

old_import = 'import { requireWeeklyReauthorization, SchwabTokenProvider } from "./auth/provider.ts";\n'
new_import = old_import + 'import { UnauthorizedRefreshCoordinator } from "./auth/unauthorizedRefresh.ts";\n'
if old_import not in text:
    raise SystemExit('AUTH_IMPORT_ANCHOR_MISSING')
text = text.replace(old_import, new_import, 1)

old_tokens = '''const tokens = new SchwabTokenProvider(stamp);\nconst budget = new RequestBudget();\n'''
new_tokens = '''const tokens = new SchwabTokenProvider(stamp);\nconst unauthorizedRefresh = new UnauthorizedRefreshCoordinator({\n  refresh: () => tokens.get(true),\n  onFailure: (code) => {\n    executionJournal.record("auth.background-refresh-failed", { source: "broker-401", code });\n    stamp(`AUTH_BACKGROUND_REFRESH_FAILED code=${code}`);\n  },\n});\nconst budget = new RequestBudget();\n'''
if old_tokens not in text:
    raise SystemExit('TOKEN_COORDINATOR_ANCHOR_MISSING')
text = text.replace(old_tokens, new_tokens, 1)

old_401 = '''      if (error.status === 429) budget.rateLimited(error.headers["retry-after"] ?? null);\n      if (error.status === 401) void tokens.get(true);\n      throw Object.assign(new Error(`SCHWAB_HTTP_${error.status}`), {\n'''
new_401 = '''      if (error.status === 429) budget.rateLimited(error.headers["retry-after"] ?? null);\n      if (error.status === 401 && unauthorizedRefresh.schedule()) {\n        executionJournal.record("auth.background-refresh-scheduled", { source: "broker-401" });\n      }\n      throw Object.assign(new Error(`SCHWAB_HTTP_${error.status}`), {\n'''
if old_401 not in text:
    raise SystemExit('BROKER_401_ANCHOR_MISSING')
text = text.replace(old_401, new_401, 1)

if 'void tokens.get(true)' in text:
    raise SystemExit('STALE_UNHANDLED_TOKEN_REFRESH_REMAINS')

path.write_text(text, encoding='utf-8')
