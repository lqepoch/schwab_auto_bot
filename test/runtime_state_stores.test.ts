import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PriceExplorer } from "../src/automation/execution/priceExplorer.ts";
import {
  ExitTemplateStateStore,
  FixedPriceCycleStateStore,
  PriceExplorerStateStore,
} from "../src/automation/state/runtimeStateStores.ts";
import type { Json } from "../src/automation/policy/order.ts";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "schwab-runtime-state-"));
}

const noopFailure = () => undefined;

test("price explorer persistence snapshots state when the save is queued", async () => {
  const root = await tempRoot();
  const statePath = path.join(root, "explorer.json");
  try {
    const store = new PriceExplorerStateStore(statePath, { readOnly: false, onWriteFailure: noopFailure });
    const explorer = new PriceExplorer();
    explorer.registerWorkingOrder("QQQ:2026-08-18:C:600:601", "first", 90, 1);
    store.save(explorer);
    explorer.registerWorkingOrder("QQQ:2026-08-18:C:600:601", "second", 91, 2);
    await store.flush();

    const persisted = await new PriceExplorerStateStore(statePath, {
      readOnly: false,
      onWriteFailure: noopFailure,
    }).load();
    assert.deepEqual(persisted.activeLogicalOrders("QQQ:2026-08-18:C:600:601").map((order) => order.brokerOrderId), ["first"]);

    store.save(explorer);
    await store.flush();
    const latest = await new PriceExplorerStateStore(statePath, {
      readOnly: false,
      onWriteFailure: noopFailure,
    }).load();
    assert.deepEqual(latest.activeLogicalOrders("QQQ:2026-08-18:C:600:601").map((order) => order.brokerOrderId), ["first", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixed-price cycle persistence caps history and read-only mode leaves disk untouched", async () => {
  const root = await tempRoot();
  const statePath = path.join(root, "fixed.json");
  try {
    const store = new FixedPriceCycleStateStore(statePath, { readOnly: false, onWriteFailure: noopFailure });
    store.save(new Set(Array.from({ length: 1_005 }, (_, index) => `fill-${index}`)));
    await store.flush();

    const loaded = await store.load();
    assert.equal(loaded.size, 1_000);
    assert.equal(loaded.has("fill-0"), false);
    assert.equal(loaded.has("fill-4"), false);
    assert.equal(loaded.has("fill-5"), true);
    assert.equal(loaded.has("fill-1004"), true);

    const before = await readFile(statePath, "utf8");
    const readOnly = new FixedPriceCycleStateStore(statePath, { readOnly: true, onWriteFailure: noopFailure });
    readOnly.save(new Set(["replacement"]));
    await readOnly.flush();
    assert.equal(await readFile(statePath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exit-template persistence filters invalid input and deep-snapshots nested order data", async () => {
  const root = await tempRoot();
  const statePath = path.join(root, "exits.json");
  try {
    await writeFile(statePath, JSON.stringify({
      valid: { orderId: "1", orderLegCollection: [{ instruction: "BUY_TO_OPEN" }] },
      invalid: { orderId: "2" },
    }), "utf8");
    const store = new ExitTemplateStateStore(statePath, { readOnly: false, onWriteFailure: noopFailure });
    const loaded = await store.load();
    assert.deepEqual([...loaded.keys()], ["valid"]);

    const template: Json = {
      orderId: "3",
      orderLegCollection: [{ instruction: "BUY_TO_OPEN", instrument: { symbol: "QQQ_TEST" } }],
    };
    const templates = new Map<string, Json>([["strategy", template]]);
    store.save(templates);
    template.orderLegCollection[0].instruction = "SELL_TO_CLOSE";
    template.orderLegCollection[0].instrument.symbol = "MUTATED";
    await store.flush();

    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.strategy.orderLegCollection[0].instruction, "BUY_TO_OPEN");
    assert.equal(persisted.strategy.orderLegCollection[0].instrument.symbol, "QQQ_TEST");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
