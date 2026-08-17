import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeBenchmarkResult } from "./runtime-benchmark.ts";
import type { RuntimeBenchmarkBaseline } from "./build-runtime-baseline.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function positiveIntegerArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`BENCHMARK_MIN_SAMPLES_INVALID:${raw}`);
  }
  return value;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function median(values: readonly number[]): number {
  if (!values.length) throw new Error("BENCHMARK_EMPTY_SAMPLE_SET");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function loadCurrentSamples(): Promise<RuntimeBenchmarkResult[]> {
  const currentPath = arg("--current");
  const currentDirectory = arg("--current-dir");
  if (currentPath && currentDirectory) throw new Error("BENCHMARK_CURRENT_INPUT_AMBIGUOUS");
  if (currentPath) {
    return [JSON.parse(await readFile(currentPath, "utf8")) as RuntimeBenchmarkResult];
  }
  if (currentDirectory) {
    const files = (await readdir(currentDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (!files.length) throw new Error("BENCHMARK_CURRENT_DIRECTORY_EMPTY");
    return Promise.all(files.map(async (name) => (
      JSON.parse(await readFile(join(currentDirectory, name), "utf8")) as RuntimeBenchmarkResult
    )));
  }
  throw new Error("BENCHMARK_CURRENT_REQUIRED");
}

function validateSample(
  baseline: RuntimeBenchmarkBaseline,
  current: RuntimeBenchmarkResult,
): void {
  if (baseline.schemaVersion !== 1 || current.schemaVersion !== 1) {
    throw new Error("BENCHMARK_SCHEMA_INCOMPATIBLE");
  }
  if (baseline.nodeMajor !== Number(process.versions.node.split(".")[0])) {
    throw new Error("BENCHMARK_NODE_MAJOR_MISMATCH");
  }
  if (baseline.seed !== current.seed || baseline.corpusSize !== current.corpusSize) {
    throw new Error("BENCHMARK_CORPUS_MISMATCH");
  }
}

async function main(): Promise<void> {
  const baselinePath = arg("--baseline") ?? "bench/runtime-baseline.json";
  const minimumSamples = positiveIntegerArg("--min-samples", 1);
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as RuntimeBenchmarkBaseline;
  const samples = await loadCurrentSamples();
  if (samples.length < minimumSamples) {
    throw new Error(`BENCHMARK_SAMPLE_SET_TOO_SMALL:${samples.length}<${minimumSamples}`);
  }
  for (const sample of samples) validateSample(baseline, sample);

  const values: Record<keyof RuntimeBenchmarkBaseline["metrics"], number[]> = {
    "orderIndex.wallMs": samples.map((sample) => sample.metrics.orderIndex.wallMs),
    "atomicPersistence.wallMs": samples.map((sample) => sample.metrics.atomicPersistence.wallMs),
    "executionJournal.wallMs": samples.map((sample) => sample.metrics.executionJournal.wallMs),
    "streamerDecodeDispatch.wallMs": samples.map((sample) => sample.metrics.streamerDecodeDispatch.wallMs),
    "eventLoop.p99Ms": samples.map((sample) => sample.metrics.eventLoop.p99Ms),
  };

  const gateEventLoop = hasFlag("--gate-event-loop");
  if (gateEventLoop && samples.length < 5) {
    throw new Error(`EVENT_LOOP_GATE_REQUIRES_5_SAMPLES:${samples.length}`);
  }

  let failed = false;
  for (const [name, baselineMetric] of Object.entries(baseline.metrics)) {
    const currentValues = values[name as keyof typeof values];
    const value = median(currentValues);
    const deltaPct = baselineMetric.median > 0
      ? ((value - baselineMetric.median) / baselineMetric.median) * 100
      : 0;
    const eventLoopMetric = name === "eventLoop.p99Ms";
    const gated = !eventLoopMetric || gateEventLoop;
    const withinLimit = value <= baselineMetric.limit;
    const status = gated ? (withinLimit ? "PASS" : "FAIL") : "OBSERVE";
    if (gated && !withinLimit) failed = true;
    process.stdout.write(
      `${status} ${name} sampleCount=${currentValues.length} currentMedian=${round(value)}ms baselineMedian=${round(baselineMetric.median)}ms p90=${round(baselineMetric.p90)}ms limit=${round(baselineMetric.limit)}ms delta=${round(deltaPct)}% values=[${currentValues.map(round).join(",")}]\n`,
    );
  }

  const cpuUser = median(samples.map((sample) => sample.metrics.process.cpuUserMs));
  const cpuSystem = median(samples.map((sample) => sample.metrics.process.cpuSystemMs));
  const rssDelta = median(samples.map((sample) => sample.metrics.process.rssDeltaBytes));
  const heapDelta = median(samples.map((sample) => sample.metrics.process.heapDeltaBytes));
  process.stdout.write(
    `OBSERVE process sampleCount=${samples.length} cpuUserMedianMs=${round(cpuUser)} cpuSystemMedianMs=${round(cpuSystem)} rssDeltaMedianBytes=${round(rssDelta)} heapDeltaMedianBytes=${round(heapDelta)}\n`,
  );
  if (failed) throw new Error("RUNTIME_BENCHMARK_REGRESSION");
}

await main();
