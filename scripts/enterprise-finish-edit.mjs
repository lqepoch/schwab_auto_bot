import { readFile, writeFile } from 'node:fs/promises';

const path = 'src/automation/runtimeOrchestrator.ts';
let text = await readFile(path, 'utf8');

const importAnchor = 'import { EXIT_ORDER_PRICE, orderInfo, orderPolicyViolation, type Json } from "../order_policy.ts";';
const indexImport = `${importAnchor}\nimport {\n  buildPrimaryActiveOpeningOrderIds,\n  compareOpeningOrders as compareIndexedOpeningOrders,\n  managedOpeningInfo,\n  selectActiveOpeningOrders,\n} from "./orderIndex.ts";`;
if (!text.includes(importAnchor)) throw new Error('ORDER_POLICY_IMPORT_NOT_FOUND');
text = text.replace(importAnchor, indexImport);

const managedOld = `function managedOpening(order: Json): ReturnType<typeof orderInfo> {
  const meta = info(order);
  const today = newYorkDate();
  if (
    !meta?.opening || meta.expiration !== today || !policy.underlyings.has(meta.underlying)
    || !policy.isWithinStrikeRange(meta.underlying, meta.lowerStrike, meta.higherStrike)
    || !isRefreshSpreadEligible(meta)
    || quantity(order) !== 1 || orderPolicyViolation(order, policy, today)
  ) return null;
  return meta;
}`;
const managedNew = `function managedOpening(order: Json): ReturnType<typeof orderInfo> {
  return managedOpeningInfo(order, policy, newYorkDate());
}`;
if (!text.includes(managedOld)) throw new Error('MANAGED_OPENING_BLOCK_NOT_FOUND');
text = text.replace(managedOld, managedNew);

const indexOld = `function compareOpeningOrders(left: Json, right: Json): number {
  return Number(left.price) - Number(right.price)
    || eventTime(left) - eventTime(right)
    || orderId(left).localeCompare(orderId(right));
}

function activeOpeningOrders(groupKey: string): Json[] {
  const today = newYorkDate();
  return orders.filter((order) => {
    const meta = info(order);
    return working.has(String(order.status)) && meta?.opening && meta.key === groupKey
      && meta.expiration === today && policy.underlyings.has(meta.underlying);
  }).sort(compareOpeningOrders);
}

function primaryActiveOpeningOrderIds(): Map<string, string> {
  const primary = new Map<string, Json>();
  for (const order of orders) {
    const meta = managedOpening(order);
    if (!meta || !working.has(String(order.status))) continue;
    const current = primary.get(meta.key);
    if (!current || compareOpeningOrders(order, current) < 0) primary.set(meta.key, order);
  }
  return new Map([...primary].map(([strategy, order]) => [strategy, orderId(order)]));
}`;
const indexNew = `function activeOpeningOrders(groupKey: string): Json[] {
  return selectActiveOpeningOrders(orders, groupKey, newYorkDate(), policy.underlyings, working);
}

function primaryActiveOpeningOrderIds(): Map<string, string> {
  return buildPrimaryActiveOpeningOrderIds(orders, policy, newYorkDate(), working);
}`;
if (!text.includes(indexOld)) throw new Error('OPENING_INDEX_BLOCK_NOT_FOUND');
text = text.replace(indexOld, indexNew);

// Verify the imported comparator remains behaviorally referenced only by the
// pure module tests/benchmarks; runtime wrappers intentionally use indexed APIs.
text = text.replace('  compareOpeningOrders as compareIndexedOpeningOrders,\n', '');

await writeFile(path, text, 'utf8');
