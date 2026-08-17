import { readFile } from "node:fs/promises";
import type { RuntimeBenchmarkResult } from "./runtime-benchmark.ts";
import type { RuntimeBenchmarkBaseline } from "./build-runtime-baseline.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

async function main(): Promise<void> {
  const baselinePath = arg("--baseline") ?? "bench/runtime-baseline.json";
  const currentPath = arg("--current");
  if (!currentPath) throw new Error("BENCHMARK_CURRENT_REQUIRED");
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as RuntimeBenchmarkBaseline;
  const current = JSON.parse(await readFile(currentPath, "utf8")) as RuntimeBenchmarkResult;
  if (baseline.schemaVersion !== 1 || current.schemaVersion !== 1) throw new Error("BENCHMARK_SCHEMA_INCOMPATIBLE");
  if (baseline.nodeMajor !== Number(process.versions.node.split(".")[0])) throw new Error("BENCHMARK_NODE_MAJOR_MISMATCH");
  if (baseline.seed !== current.seed || baseline.corpusSize !== current.corpusSize) throw new Error("BENCHMARK_CORPUS_MISMATCH");

  const values: Record<keyof RuntimeBenchmarkBaseline["metrics"], number> = {
    "orderIndex.wallMs": current.metrics.orderIndex.wallMs,
    "atomicPersistence.wallMs": current.metrics.atomicPersistence.wallMs,
    "executionJournal.wallMs": current.metrics.executionJournal.wallMs,
    "streamerDecodeDispatch.wallMs": current.metrics.streamerDecodeDispatch.wallMs,
    "eventLoop.p99Ms": current.metrics.eventLoop.p99Ms,
  };
  let failed = false;
  for (const [name, baselineMetric] of Object.entries(baseline.metrics)) {
    const value = values[name as keyof typeof values];
    const deltaPct = baselineMetric.median > 0
      ? ((value - baselineMetric.median) / baselineMetric.median) * 100
      : 0;
    const status = value <= baselineMetric.limit ? "PASS" : "FAIL";
    if (status === "FAIL") failed = true;
    process.stdout.write(
      `${status} ${name} current=${round(value)}ms median=${round(baselineMetric.median)}ms p90=${round(baselineMetric.p90)}ms limit=${round(baselineMetric.limit)}ms delta=${round(deltaPct)}%\n`,
    );
  }
  process.stdout.write(
    `OBSERVE process.cpuUserMs=${current.metrics.process.cpuUserMs} process.cpuSystemMs=${current.metrics.process.cpuSystemMs} rssDeltaBytes=${current.metrics.process.rssDeltaBytes} heapDeltaBytes=${current.metrics.process.heapDeltaBytes}\n`,
  );
  if (failed) throw new Error("RUNTIME_BENCHMARK_REGRESSION");
}

await main();
