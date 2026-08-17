from pathlib import Path
import json
import os
import re
import shutil

MAPPING = {
    'src/activity_pacer.ts': 'src/automation/scheduling/activityPacer.ts',
    'src/activity_stream.ts': 'src/automation/stream/activityStream.ts',
    'src/auth.ts': 'src/automation/auth/provider.ts',
    'src/auth_cli.ts': 'src/automation/auth/cli.ts',
    'src/weekly_reauthorization.ts': 'src/automation/auth/weeklyReauthorization.ts',
    'src/broker_rate_limit.ts': 'src/automation/broker/rateLimit.ts',
    'src/broker_write_coordinator.ts': 'src/automation/broker/writeCoordinator.ts',
    'src/schwab_client.ts': 'src/automation/broker/schwabClient.ts',
    'src/order_snapshot_coordinator.ts': 'src/automation/broker/orderSnapshotCoordinator.ts',
    'src/business_log.ts': 'src/automation/observability/businessLog.ts',
    'src/execution_journal.ts': 'src/automation/observability/executionJournal.ts',
    'src/entry_price_policy.ts': 'src/automation/policy/entryPrice.ts',
    'src/exit_policy.ts': 'src/automation/policy/exit.ts',
    'src/order_policy.ts': 'src/automation/policy/order.ts',
    'src/refresh_order_policy.ts': 'src/automation/policy/refreshOrder.ts',
    'src/runtime_policy.ts': 'src/automation/policy/runtime.ts',
    'src/full_snapshot_freshness.ts': 'src/automation/policy/fullSnapshotFreshness.ts',
    'src/refresh_preflight.ts': 'src/automation/policy/refreshPreflight.ts',
    'src/order_write_preflight.ts': 'src/automation/execution/orderWritePreflight.ts',
    'src/preview_rejection.ts': 'src/automation/execution/previewRejection.ts',
    'src/fill_price.ts': 'src/automation/execution/fillPrice.ts',
    'src/price_explorer.ts': 'src/automation/execution/priceExplorer.ts',
    'src/fixed_price_cycle.ts': 'src/automation/execution/fixedPriceCycle.ts',
    'src/fixed_price_round_guard.ts': 'src/automation/execution/fixedPriceRoundGuard.ts',
    'src/priority_runtime.ts': 'src/automation/scheduling/priorityRuntime.ts',
    'src/refresh_pacer.ts': 'src/automation/scheduling/refreshPacer.ts',
    'src/refresh_round_limit.ts': 'src/automation/scheduling/refreshRoundLimit.ts',
    'src/runtime_lock.ts': 'src/automation/state/runtimeLock.ts',
    'src/unknown_write_reconciliation.ts': 'src/automation/state/unknownWriteReconciliation.ts',
}

RELATIVE_SPEC = re.compile(r"(?P<q>['\"])(?P<spec>\.\.?/[^'\"\r\n]+?\.(?:ts|js|mjs))(?P=q)")
TEXT_SUFFIXES = {'.ts', '.mjs', '.js', '.json', '.md', '.yml', '.yaml', '.ps1'}
ROOT = Path.cwd()


def rewrite_text_files() -> None:
    files = [
        path for path in ROOT.rglob('*')
        if path.is_file()
        and '.git' not in path.parts
        and 'node_modules' not in path.parts
        and 'dist' not in path.parts
        and '.github' not in path.parts
    ]
    for path in files:
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        old_file = path.relative_to(ROOT).as_posix()
        new_file = MAPPING.get(old_file, old_file)
        try:
            text = path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            continue

        if path.suffix.lower() in {'.ts', '.mjs', '.js'}:
            def replace_spec(match: re.Match[str]) -> str:
                spec = match.group('spec')
                old_target = os.path.normpath(os.path.join(os.path.dirname(old_file), spec)).replace('\\', '/')
                new_target = MAPPING.get(old_target, old_target)
                if new_file == old_file and new_target == old_target:
                    return match.group(0)
                rel = os.path.relpath(new_target, os.path.dirname(new_file) or '.').replace('\\', '/')
                if not rel.startswith('.'):
                    rel = './' + rel
                quote = match.group('q')
                return f"{quote}{rel}{quote}"
            text = RELATIVE_SPEC.sub(replace_spec, text)

        for old, new in MAPPING.items():
            text = text.replace(old, new)
        path.write_text(text, encoding='utf-8')


def move_sources() -> None:
    for old, new in MAPPING.items():
        old_path = ROOT / old
        new_path = ROOT / new
        if not old_path.exists():
            raise RuntimeError(f'MISSING_SOURCE:{old}')
        if new_path.exists():
            raise RuntimeError(f'TARGET_ALREADY_EXISTS:{new}')
        new_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(old_path), str(new_path))


def update_tsconfig() -> None:
    path = ROOT / 'tsconfig.automation.json'
    config = json.loads(path.read_text(encoding='utf-8'))
    config['include'] = ['src/main.ts', 'src/automation/**/*.ts']
    config['exclude'] = ['src/index.ts', 'src/public.ts', 'dist', 'node_modules']
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def add_contract_tests() -> None:
    public_exports = ROOT / 'test/publicExports.test.mjs'
    text = public_exports.read_text(encoding='utf-8')
    anchor = "import { REST_CONTRACT_MANIFEST as subpathRestManifest } from 'schwab-owokit/contract-manifest';\n"
    automation_import = "import {\n  BrokerWriteCoordinator as AutomationBrokerWriteCoordinator,\n  ExecutionJournal as AutomationExecutionJournal,\n  PriceExplorer as AutomationPriceExplorer,\n  SchwabRestClient as AutomationSchwabRestClient,\n  UnknownWriteReconciliation as AutomationUnknownWriteReconciliation,\n  parseRuntimePolicy as automationParseRuntimePolicy,\n  runSchwabAutomationCli,\n} from 'schwab-owokit/automation';\n"
    if automation_import not in text:
        if anchor not in text:
            raise RuntimeError('PUBLIC_EXPORT_TEST_ANCHOR_MISSING')
        text = text.replace(anchor, anchor + automation_import)
    test_block = "\ntest('automation subpath exposes the stable guarded execution boundary without import side effects', () => {\n  assert.equal(typeof runSchwabAutomationCli, 'function');\n  assert.equal(typeof AutomationSchwabRestClient, 'function');\n  assert.equal(typeof AutomationBrokerWriteCoordinator, 'function');\n  assert.equal(typeof AutomationExecutionJournal, 'function');\n  assert.equal(typeof AutomationPriceExplorer, 'function');\n  assert.equal(typeof AutomationUnknownWriteReconciliation, 'function');\n  assert.equal(typeof automationParseRuntimePolicy, 'function');\n});\n"
    if test_block not in text:
        text += test_block
    public_exports.write_text(text, encoding='utf-8')

    layout_test = ROOT / 'test/automation_layout.test.ts'
    layout_test.write_text('''import assert from "node:assert/strict";\nimport { readdir } from "node:fs/promises";\nimport test from "node:test";\n\ntest("repository root source keeps SDK boundary and executable only", async () => {\n  const entries = await readdir(new URL("../src/", import.meta.url), { withFileTypes: true });\n  const rootTypeScriptFiles = entries\n    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))\n    .map((entry) => entry.name)\n    .sort();\n  assert.deepEqual(rootTypeScriptFiles, ["index.ts", "main.ts", "public.ts"]);\n});\n''', encoding='utf-8')


def update_architecture_doc() -> None:
    path = ROOT / 'docs/AUTOMATION_RUNTIME_ARCHITECTURE.md'
    text = path.read_text(encoding='utf-8')
    marker = '## Automation source layout\n'
    section = '''## Automation source layout\n\nAll automation implementation now lives below `src/automation/`; root `src/` contains only the SDK public entrypoints and the stable executable `main.ts`. The module is grouped by responsibility:\n\n- `auth/`: automation OAuth provider and weekly reauthorization adapter.\n- `broker/`: Schwab REST adapter, authoritative snapshot coordination, rate-limit metadata and serialized broker writes.\n- `execution/`: fill pricing, fixed-price cycles, Preview/write preflight, rejection handling and price exploration.\n- `observability/`: business log formatting and durable execution journal.\n- `policy/`: runtime, entry/exit, refresh and freshness rules.\n- `scheduling/`: activity/refresh pacing, priority queues and round limits.\n- `state/`: runtime lock and unknown-write reconciliation.\n- `stream/`: account-activity Streamer adapter.\n\n`test/automation_layout.test.ts` enforces this boundary so automation files cannot drift back into the SDK root.\n\n'''
    if marker not in text:
        path.write_text(section + text, encoding='utf-8')


def main() -> None:
    if not (ROOT / 'src/auth.ts').exists():
        print('automation layout already normalized')
        return
    rewrite_text_files()
    move_sources()
    update_tsconfig()
    add_contract_tests()
    update_architecture_doc()


if __name__ == '__main__':
    main()
