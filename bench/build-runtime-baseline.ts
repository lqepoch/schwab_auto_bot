import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { RuntimeBenchmarkResult } from "./runtime-benchmark.ts";

export type RuntimeBenchmarkBaseline = {
  schemaVersion: 1;
  generatedAt: string;
  sampleCount: number;
  nodeMajor: number;
  seed: number;
  corpusSize: number;
  policy: {
    orderIndexMultiplier: number;
    persistenceMultiplier: number;
    journalMultiplier: number;
    streamerMultiplier: number;
    eventLoopMultiplier: number;
    minimumEventLoopP99Ms: number;
  };
  metrics: Record<GatedMetricName, BaselineMetric>;
};

type GatedMetricName =
  | "orderIndex.wallMs"
  | "atomicPersistence.wallMs"
  | "executionJournal.wallMs"
  | "streamerDecodeDispatch.wallMs"
  | "eventLoop.p99Ms";

type BaselineMetric = {
  median: number;
  p90: number;
  limit: number;
  unit: "ms";
};

const policy = {
  orderIndexMultiplier: 2.0,
  persistenceMultiplier: 2.5,
  journalMultiplier: 2.0,
  streamerMultiplier: 2.0,
  eventLoopMultiplier: 2.5,
  minimumEventLoopP99Ms: 25,
} as const;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percentile(values: readonly number[], p: number): number {
  if (!values.length) throw new Error("BASELINE_EMPTY_VALUES");
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function metric(
  samples: readonly RuntimeBenchmarkResult[],
  name: GatedMetricName,
  selector: (sample: RuntimeBenchmarkResult) => number,
  multiplier: number,
  floor = 0,
): BaselineMetric {
  const values = samples.map(selector);
  const median = percentile(values, 0.5);
  const p90 = percentile(values, 0.9);
  return {
    median: round(median),
    p90: round(p90),
    limit: round(Math.max(floor, p90 * multiplier)),
    unit: "ms",
  };
}

async function main(): Promise<void> {
  const inputs = arg("--inputs");
  const output = arg("--output") ?? "bench/runtime-baseline.json";
  if (!inputs) throw new Error("BASELINE_INPUT_DIRECTORY_REQUIRED");
  const files = (await readdir(inputs))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length < 5) throw new Error(`BASELINE_REQUIRES_AT_LEAST_5_SAMPLES:${files.length}`);
  const samples = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(inputs, name), "utf8")) as RuntimeBenchmarkResult));
  for (const sample of samples) {
    if (sample.schemaVersion !== 1 || sample.seed !== samples[0].seed || sample.corpusSize !== samples[0].corpusSize) {
      throw new Error("BASELINE_SAMPLE_INCOMPATIBLE");
    }
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const baseline: RuntimeBenchmarkBaseline = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sampleCount: samples.length,
    nodeMajor,
    seed: samples[0].seed,
    corpusSize: samples[0].corpusSize,
    policy: { ...policy },
    metrics: {
      "orderIndex.wallMs": metric(samples, "orderIndex.wallMs", (sample) => sample.metrics.orderIndex.wallMs, policy.orderIndexMultiplier),
      "atomicPersistence.wallMs": metric(samples, "atomicPersistence.wallMs", (sample) => sample.metrics.atomicPersistence.wallMs, policy.persistenceMultiplier),
      "executionJournal.wallMs": metric(samples, "executionJournal.wallMs", (sample) => sample.metrics.executionJournal.wallMs, policy.journalMultiplier),
      "streamerDecodeDispatch.wallMs": metric(samples, "streamerDecodeDispatch.wallMs", (sample) => sample.metrics.streamerDecodeDispatch.wallMs, policy.streamerMultiplier),
      "eventLoop.p99Ms": metric(samples, "eventLoop.p99Ms", (sample) => sample.metrics.eventLoop.p99Ms, policy.eventLoopMultiplier, policy.minimumEventLoopP99Ms),
    },
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(baseline)}\n`);
}

await main();
