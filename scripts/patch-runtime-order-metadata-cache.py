from pathlib import Path

runtime_path = Path("src/automation/runtimeOrchestrator.ts")
text = runtime_path.read_text(encoding="utf-8")

old_policy_import = 'import { EXIT_ORDER_PRICE, orderInfo, orderPolicyViolation, type Json } from "./policy/order.ts";\n'
new_policy_import = 'import { EXIT_ORDER_PRICE, orderPolicyViolation, type Json } from "./policy/order.ts";\n'
if text.count(old_policy_import) != 1:
    raise SystemExit(f"POLICY_IMPORT_ANCHOR_MISMATCH:{text.count(old_policy_import)}")
text = text.replace(old_policy_import, new_policy_import, 1)

old_index_imports = '''import { managedOpeningInfo } from "./orderIndex.ts";
import { RuntimeOrderIndexCache } from "./orderRuntimeIndex.ts";
'''
new_index_imports = '''import { managedOpeningInfo } from "./orderIndex.ts";
import { RuntimeOrderMetadataCache } from "./orderMetadataCache.ts";
import { RuntimeOrderIndexCache } from "./orderRuntimeIndex.ts";
'''
if text.count(old_index_imports) != 1:
    raise SystemExit(f"INDEX_IMPORT_ANCHOR_MISMATCH:{text.count(old_index_imports)}")
text = text.replace(old_index_imports, new_index_imports, 1)

old_state = '''let accountHash = "";
let orders: Json[] = [];
const ordersById = new OrderLookup<Json>((order) => orderId(order));
const runtimeOrderIndex = new RuntimeOrderIndexCache();
let orderAuthorityRevision = 0;
'''
new_state = '''let accountHash = "";
let orders: Json[] = [];
const ordersById = new OrderLookup<Json>((order) => orderId(order));
const orderMetadata = new RuntimeOrderMetadataCache();
const runtimeOrderIndex = new RuntimeOrderIndexCache((order) => orderMetadata.get(order));
let orderAuthorityRevision = 0;
'''
if text.count(old_state) != 1:
    raise SystemExit(f"ORDER_STATE_ANCHOR_MISMATCH:{text.count(old_state)}")
text = text.replace(old_state, new_state, 1)

old_info = 'function info(order: Json) { return orderInfo(order); }\n'
new_info = 'function info(order: Json) { return orderMetadata.get(order); }\n'
if text.count(old_info) != 1:
    raise SystemExit(f"INFO_HELPER_ANCHOR_MISMATCH:{text.count(old_info)}")
text = text.replace(old_info, new_info, 1)

old_managed = '''function managedOpening(order: Json): ReturnType<typeof orderInfo> {
  return managedOpeningInfo(order, policy, newYorkDate());
}
'''
new_managed = '''function managedOpening(order: Json): ReturnType<typeof info> {
  const meta = info(order);
  return managedOpeningInfo(order, policy, newYorkDate(), meta);
}
'''
if text.count(old_managed) != 1:
    raise SystemExit(f"MANAGED_OPENING_ANCHOR_MISMATCH:{text.count(old_managed)}")
text = text.replace(old_managed, new_managed, 1)

old_policy_scan = '''    const meta = info(order);
    if (!meta || !policy.underlyings.has(meta.underlying)) continue;
    const violation = orderPolicyViolation(order, policy, today);
'''
new_policy_scan = '''    const meta = info(order);
    if (!meta || !policy.underlyings.has(meta.underlying)) continue;
    const violation = orderPolicyViolation(order, policy, today, meta);
'''
if text.count(old_policy_scan) != 1:
    raise SystemExit(f"POLICY_SCAN_ANCHOR_MISMATCH:{text.count(old_policy_scan)}")
text = text.replace(old_policy_scan, new_policy_scan, 1)
runtime_path.write_text(text, encoding="utf-8")

bench_path = Path("bench/runtime-benchmark.ts")
bench = bench_path.read_text(encoding="utf-8")
old_bench_import = 'import { RuntimeOrderIndexCache } from "../src/automation/orderRuntimeIndex.ts";\n'
new_bench_import = '''import { RuntimeOrderMetadataCache } from "../src/automation/orderMetadataCache.ts";
import { RuntimeOrderIndexCache } from "../src/automation/orderRuntimeIndex.ts";
'''
if bench.count(old_bench_import) != 1:
    raise SystemExit(f"BENCH_IMPORT_ANCHOR_MISMATCH:{bench.count(old_bench_import)}")
bench = bench.replace(old_bench_import, new_bench_import, 1)
old_cache = '  const orderIndexCache = new RuntimeOrderIndexCache();\n'
new_cache = '''  const orderMetadata = new RuntimeOrderMetadataCache();
  const orderIndexCache = new RuntimeOrderIndexCache((order) => orderMetadata.get(order));
'''
if bench.count(old_cache) != 1:
    raise SystemExit(f"BENCH_CACHE_ANCHOR_MISMATCH:{bench.count(old_cache)}")
bench = bench.replace(old_cache, new_cache, 1)
bench_path.write_text(bench, encoding="utf-8")
