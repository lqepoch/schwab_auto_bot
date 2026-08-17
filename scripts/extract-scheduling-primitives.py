from pathlib import Path

path = Path('src/automation/runtimeOrchestrator.ts')
text = path.read_text(encoding='utf-8')

old_priority = 'import { PriorityGate, PriorityWriter, type Priority } from "./scheduling/priorityRuntime.ts";\n'
new_priority = old_priority + 'import { RequestBudget } from "./scheduling/requestBudget.ts";\nimport { ExplorerActionPacer } from "./scheduling/explorerActionPacer.ts";\n'
if old_priority not in text:
    raise SystemExit('PRIORITY_IMPORT_ANCHOR_MISSING')
text = text.replace(old_priority, new_priority, 1)

old_refresh = 'import { effectiveFixedPriceRefreshIntervalMs, FixedPriceRefreshPacer, fixedPriceRefreshIntervalMs } from "./scheduling/refreshPacer.ts";\n'
new_refresh = 'import { effectiveFixedPriceRefreshIntervalMs, FixedPriceRefreshPacer } from "./scheduling/refreshPacer.ts";\n'
if old_refresh not in text:
    raise SystemExit('REFRESH_IMPORT_ANCHOR_MISSING')
text = text.replace(old_refresh, new_refresh, 1)

start = text.index('class ExplorerActionPacer {')
end_marker = '\n\nconst tokens = new SchwabTokenProvider(stamp);'
end = text.index(end_marker, start)
text = text[:start] + 'const tokens = new SchwabTokenProvider(stamp);' + text[end + len(end_marker):]

old_budget = 'const budget = new RequestBudget();\n'
new_budget = '''const budget = new RequestBudget({\n  onRefreshHeadroomWait: ({ usedLast60s, refreshCeiling }) => {\n    stamp(`整体刷新等待滚动配额释放 usedLast60s=${usedLast60s} refreshCeiling=${refreshCeiling}`);\n  },\n  onRateLimited: (seconds) => stamp(`Schwab 429，全局退避 ${seconds}s`),\n});\n'''
if old_budget not in text:
    raise SystemExit('REQUEST_BUDGET_INSTANTIATION_MISSING')
text = text.replace(old_budget, new_budget, 1)

old_pacer = 'const normalExplorerActionPacer = new ExplorerActionPacer();\n'
new_pacer = 'const normalExplorerActionPacer = new ExplorerActionPacer({ cooldownMs: policy.orderCooldownMs });\n'
if old_pacer not in text:
    raise SystemExit('EXPLORER_PACER_INSTANTIATION_MISSING')
text = text.replace(old_pacer, new_pacer, 1)

for stale in [
    'class ExplorerActionPacer {',
    'class RequestBudget {',
    'fixedPriceRefreshIntervalMs } from "./scheduling/refreshPacer.ts"',
    'new ExplorerActionPacer();',
    'new RequestBudget();',
]:
    if stale in text:
        raise SystemExit(f'STALE_SCHEDULER_FRAGMENT:{stale}')

path.write_text(text, encoding='utf-8')
