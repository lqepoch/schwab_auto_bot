from pathlib import Path

runtime = Path("src/automation/runtimeOrchestrator.ts")
text = runtime.read_text()
old_import = '''import {
  EXISTING_ORDER_REPLACE_NO_PREVIEW,
  orderWritePreflight,
  replacementSourceViolation,
  type OrderWritePreflight,
} from "./execution/orderWritePreflight.ts";
'''
new_import = '''import {
  AUTOMATION_WORKING_ORDER_STATUSES,
  EXISTING_ORDER_REPLACE_NO_PREVIEW,
  orderWritePreflight,
  replacementSourceViolation,
  type OrderWritePreflight,
} from "./execution/orderWritePreflight.ts";
'''
if text.count(old_import) != 1:
    raise SystemExit("runtime preflight import anchor missing")
text = text.replace(old_import, new_import)
old_working = 'const working = new Set(["PENDING_ACTIVATION", "QUEUED", "WORKING", "PARTIALLY_FILLED", "AWAITING_PARENT_ORDER"]);'
new_working = 'const working = new Set<string>(AUTOMATION_WORKING_ORDER_STATUSES);'
if text.count(old_working) != 1:
    raise SystemExit("runtime working-status anchor missing")
text = text.replace(old_working, new_working)
runtime.write_text(text)

bench = Path("bench/runtime-benchmark.ts")
text = bench.read_text()
anchor = 'import { orderInfo, type Json } from "../src/automation/policy/order.ts";\n'
insert = 'import { AUTOMATION_WORKING_ORDER_STATUSES } from "../src/automation/execution/orderWritePreflight.ts";\n' + anchor
if insert not in text:
    if text.count(anchor) != 1:
        raise SystemExit("benchmark import anchor missing")
    text = text.replace(anchor, insert, 1)
old_bench = 'const working = new Set(["PENDING_ACTIVATION", "QUEUED", "WORKING", "PARTIALLY_FILLED", "AWAITING_PARENT_ORDER"]);'
new_bench = 'const working = new Set<string>(AUTOMATION_WORKING_ORDER_STATUSES);'
if text.count(old_bench) != 1:
    raise SystemExit("benchmark working-status anchor missing")
text = text.replace(old_bench, new_bench)
bench.write_text(text)
