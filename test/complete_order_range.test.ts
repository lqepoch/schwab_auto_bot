import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchCompleteOrderRange,
  type OrderRange,
} from "../src/automation/broker/completeOrderRange.ts";

type Order = { orderId: string; version?: string };
const key = (order: Order) => order.orderId;
const BASE = Date.parse("2026-08-18T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

function range(fromMs = 0, toMs = 1_000): OrderRange {
  return { fromEnteredTime: iso(fromMs), toEnteredTime: iso(toMs) };
}

test("unsaturated order range returns in one broker page", async () => {
  const calls: OrderRange[] = [];
  const result = await fetchCompleteOrderRange(range(), async (requested) => {
    calls.push(requested);
    return [{ orderId: "1" }, { orderId: "2" }];
  }, { maxResults: 3, key });

  assert.deepEqual(result, [{ orderId: "1" }, { orderId: "2" }]);
  assert.deepEqual(calls, [range()]);
});

test("page at maxResults is bisected until child ranges are complete", async () => {
  const calls: OrderRange[] = [];
  const result = await fetchCompleteOrderRange(range(0, 1_000), async (requested) => {
    calls.push(requested);
    if (requested.fromEnteredTime === iso(0) && requested.toEnteredTime === iso(1_000)) {
      return [{ orderId: "ignored-a" }, { orderId: "ignored-b" }, { orderId: "ignored-c" }];
    }
    if (requested.fromEnteredTime === iso(0) && requested.toEnteredTime === iso(500)) {
      return [{ orderId: "1" }, { orderId: "mid", version: "left" }];
    }
    if (requested.fromEnteredTime === iso(500) && requested.toEnteredTime === iso(1_000)) {
      return [{ orderId: "mid", version: "right" }, { orderId: "2" }];
    }
    throw new Error(`unexpected range ${JSON.stringify(requested)}`);
  }, { maxResults: 3, key });

  assert.equal(calls.length, 3);
  assert.deepEqual(result, [
    { orderId: "1" },
    { orderId: "mid", version: "right" },
    { orderId: "2" },
  ]);
});

test("nested saturation recursively partitions only the saturated child", async () => {
  const calls: OrderRange[] = [];
  const page = (ids: string[]): Order[] => ids.map((orderId) => ({ orderId }));
  const result = await fetchCompleteOrderRange(range(0, 1_000), async (requested) => {
    calls.push(requested);
    const signature = `${requested.fromEnteredTime}|${requested.toEnteredTime}`;
    const pages = new Map<string, Order[]>([
      [`${iso(0)}|${iso(1_000)}`, page(["p1", "p2"])],
      [`${iso(0)}|${iso(500)}`, page(["l1", "l2"])],
      [`${iso(0)}|${iso(250)}`, page(["a"])],
      [`${iso(250)}|${iso(500)}`, page(["b"])],
      [`${iso(500)}|${iso(1_000)}`, page(["c"])],
    ]);
    const rows = pages.get(signature);
    if (!rows) throw new Error(`unexpected range ${signature}`);
    return rows;
  }, { maxResults: 2, key });

  assert.deepEqual(result.map((order) => order.orderId), ["a", "b", "c"]);
  assert.equal(calls.length, 5);
});

test("saturated millisecond-level range fails closed", async () => {
  await assert.rejects(
    () => fetchCompleteOrderRange(range(0, 1), async () => [
      { orderId: "1" }, { orderId: "2" },
    ], { maxResults: 2, key }),
    /ORDER_SNAPSHOT_RANGE_UNSPLITTABLE/,
  );
});

test("bounded page-request budget prevents runaway recovery fan-out", async () => {
  await assert.rejects(
    () => fetchCompleteOrderRange(range(0, 10_000), async () => [
      { orderId: "1" }, { orderId: "2" },
    ], { maxResults: 2, maxPageRequests: 2, key }),
    /ORDER_SNAPSHOT_PARTITION_LIMIT_EXCEEDED/,
  );
});

test("provider contract violations and missing order IDs fail closed", async () => {
  await assert.rejects(
    () => fetchCompleteOrderRange(range(), async () => [
      { orderId: "1" }, { orderId: "2" }, { orderId: "3" },
    ], { maxResults: 2, key }),
    /ORDER_SNAPSHOT_PAGE_LIMIT_VIOLATED/,
  );
  await assert.rejects(
    () => fetchCompleteOrderRange(range(), async () => [{ orderId: "" }], { maxResults: 2, key }),
    /ORDER_SNAPSHOT_ORDER_ID_MISSING/,
  );
});

test("range and limit validation rejects malformed inputs before broker reads", async () => {
  let calls = 0;
  const fetchPage = async (): Promise<Order[]> => { calls += 1; return []; };
  await assert.rejects(
    () => fetchCompleteOrderRange({ fromEnteredTime: "bad", toEnteredTime: iso(1) }, fetchPage, { maxResults: 2, key }),
    /ORDER_RANGE_FROM_INVALID/,
  );
  await assert.rejects(
    () => fetchCompleteOrderRange({ fromEnteredTime: iso(2), toEnteredTime: iso(1) }, fetchPage, { maxResults: 2, key }),
    /ORDER_RANGE_TIME_ORDER_INVALID/,
  );
  await assert.rejects(
    () => fetchCompleteOrderRange(range(), fetchPage, { maxResults: 0, key }),
    /ORDER_RANGE_MAX_RESULTS_INVALID/,
  );
  await assert.rejects(
    () => fetchCompleteOrderRange(range(), fetchPage, { maxResults: 2, maxPageRequests: 0, key }),
    /ORDER_RANGE_MAX_PAGE_REQUESTS_INVALID/,
  );
  assert.equal(calls, 0);
});
