import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { orderInfo, type Json } from "../src/order_policy.ts";
import { parseRuntimePolicy } from "../src/runtime_policy.ts";
import {
  buildPrimaryActiveOpeningOrderIds,
  selectActiveOpeningOrders,
} from "../src/automation/orderIndex.ts";
import { atomicWriteJson } from "../src/utils/atomicJson.ts";
import { ExecutionJournal } from "../src/execution_journal.ts";
import { StreamerMessageSchema } from "../src/types/streamer.ts";

const CORPUS_SIZE = 2_500;
const ORDER_ITERATIONS = 30;
const ATOMIC_WRITES = 50;
const JOURNAL_RECORDS = 2_000;
const STREAM_MESSAGES = 12_000;
const TRADING_DATE = "2026-07-24";
const working = new Set(["PENDING_ACTIVATION", "QUEUED", "WORKING", "PARTIALLY_FILLED", "AWAITING_PARENT_ORDER"]);
const policy = parseRuntimePolicy([]);

export type RuntimeBenchmarkResult = {
  schemaVersion: 1;
  generatedAt: string;
  node: string;
  platform: NodeJS.Platform;
  architecture: string;
  seed: number;
  corpusSize: number;
  metrics: {
    orderIndex: Metric;
    atomicPersistence: Metric;
    executionJournal: Metric;
    streamerDecodeDispatch: Metric;
    eventLoop: {
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
      maxMs: number;
    };
    process: {
      cpuUserMs: number;
      cpuSystemMs: number;
      rssBeforeBytes: number;
      rssAfterBytes: number;
      rssDeltaBytes: number;
      heapBeforeBytes: number;
      heapAfterBytes: number;
      heapDeltaBytes: number;
    };
  };
};

type Metric = {
  operations: number;
  wallMs: number;
  operationsPerSecond: number;
};

function metric(operations: number, startedAt: number): Metric {
  const wallMs = performance.now() - startedAt;
  return {
    operations,
    wallMs: round(wallMs),
    operationsPerSecond: round(operations / Math.max(wallMs / 1_000, 0.000_001)),
  };
}

function vertical(index: number): Json {
  const lower = 720 + (index % 60);
  const upper = lower + 1;
  const strike = (value: number) => String(Math.round(value * 1_000)).padStart(8, "0");
  const price = (0.82 + (index % 11) / 100).toFixed(2);
  return {
    orderId: String(100_000 + index),
    status: index % 20 === 0 ? "CANCELED" : "WORKING",
    price,
    quantity: 1,
    filledQuantity: 0,
    enteredTime: new Date(Date.UTC(2026, 6, 24, 13, 30, 0) + index * 1_000).toISOString(),
    orderLegCollection: [
      { quantity: 1, instruction: "BUY_TO_OPEN", instrument: { symbol: `QQQ  260724C${strike(lower)}` } },
      { quantity: 1, instruction: "SELL_TO_OPEN", instrument: { symbol: `QQQ  260724C${strike(upper)}` } },
    ],
  };
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

async function main(): Promise<void> {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  const cpuBefore = process.cpuUsage();
  const memoryBefore = process.memoryUsage();
  const corpus = Array.from({ length: CORPUS_SIZE }, (_, index) => vertical(index));
  const firstWorking = corpus.find((order) => order.status === "WORKING");
  if (!firstWorking) throw new Error("BENCHMARK_CORPUS_INVALID");
  const groupKey = orderInfo(firstWorking)?.key;
  if (!groupKey) throw new Error("BENCHMARK_STRATEGY_KEY_INVALID");

  for (let warmup = 0; warmup < 5; warmup += 1) {
    buildPrimaryActiveOpeningOrderIds(corpus, policy, TRADING_DATE, working);
    selectActiveOpeningOrders(corpus, groupKey, TRADING_DATE, policy.underlyings, working);
  }
  let startedAt = performance.now();
  for (let iteration = 0; iteration < ORDER_ITERATIONS; iteration += 1) {
    buildPrimaryActiveOpeningOrderIds(corpus, policy, TRADING_DATE, working);
    selectActiveOpeningOrders(corpus, groupKey, TRADING_DATE, policy.underlyings, working);
  }
  const orderIndex = metric(ORDER_ITERATIONS * CORPUS_SIZE * 2, startedAt);

  const root = await mkdtemp(join(tmpdir(), "schwab-runtime-bench-"));
  let atomicPersistence: Metric;
  let executionJournal: Metric;
  try {
    const statePath = join(root, "state", "benchmark.json");
    startedAt = performance.now();
    for (let index = 0; index < ATOMIC_WRITES; index += 1) {
      await atomicWriteJson(statePath, { schemaVersion: 1, index, payload: "x".repeat(1_024) });
    }
    atomicPersistence = metric(ATOMIC_WRITES, startedAt);

    const failures: unknown[] = [];
    const journal = new ExecutionJournal(root, "benchmark-run", (error) => failures.push(error));
    startedAt = performance.now();
    for (let index = 0; index < JOURNAL_RECORDS; index += 1) {
      journal.record("benchmark.event", { index, strategy: `QQQ:${index % 60}`, payload: "y".repeat(96) });
    }
    await journal.flush();
    if (failures.length) throw new Error(`BENCHMARK_JOURNAL_FAILURES:${failures.length}`);
    executionJournal = metric(JOURNAL_RECORDS, startedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const streamEnvelope = {
    data: [{
      service: "LEVELONE_EQUITIES",
      timestamp: 1_775_000_000_000,
      command: "SUBS",
      content: [{ key: "QQQ", "1": 612.34, "2": 612.33, "3": 612.35, "8": 12_345_678 }],
    }],
  };
  let dispatched = 0;
  startedAt = performance.now();
  for (let index = 0; index < STREAM_MESSAGES; index += 1) {
    const parsed = StreamerMessageSchema.parse(streamEnvelope);
    for (const payload of parsed.data ?? []) dispatched += payload.content.length;
  }
  if (dispatched !== STREAM_MESSAGES) throw new Error("BENCHMARK_STREAM_DISPATCH_INVALID");
  const streamerDecodeDispatch = metric(STREAM_MESSAGES, startedAt);

  await new Promise((resolve) => setTimeout(resolve, 25));
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  histogram.disable();

  const result: RuntimeBenchmarkResult = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    seed: 20260817,
    corpusSize: CORPUS_SIZE,
    metrics: {
      orderIndex,
      atomicPersistence,
      executionJournal,
      streamerDecodeDispatch,
      eventLoop: {
        p50Ms: round(histogram.percentile(50) / 1e6),
        p95Ms: round(histogram.percentile(95) / 1e6),
        p99Ms: round(histogram.percentile(99) / 1e6),
        maxMs: round(histogram.max / 1e6),
      },
      process: {
        cpuUserMs: round(cpu.user / 1_000),
        cpuSystemMs: round(cpu.system / 1_000),
        rssBeforeBytes: memoryBefore.rss,
        rssAfterBytes: memoryAfter.rss,
        rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
        heapBeforeBytes: memoryBefore.heapUsed,
        heapAfterBytes: memoryAfter.heapUsed,
        heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      },
    },
  };

  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
