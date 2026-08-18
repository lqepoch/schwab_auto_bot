import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const nodeMajor = Number(process.versions.node.split(".")[0]);
const checker = join(process.cwd(), "bench", "check-runtime-benchmark.ts");

function baseline() {
  const metric = (limit: number) => ({ median: 10, p90: 12, limit, unit: "ms" as const });
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-17T00:00:00.000Z",
    sampleCount: 7,
    nodeMajor,
    seed: 20260817,
    corpusSize: 2500,
    policy: {
      orderIndexMultiplier: 2,
      persistenceMultiplier: 2.5,
      journalMultiplier: 2,
      streamerMultiplier: 2,
      eventLoopMultiplier: 2.5,
      minimumEventLoopP99Ms: 25,
    },
    metrics: {
      "orderIndex.wallMs": metric(100),
      "atomicPersistence.wallMs": metric(100),
      "executionJournal.wallMs": metric(100),
      "streamerDecodeDispatch.wallMs": metric(100),
      "eventLoop.p99Ms": metric(30),
    },
  };
}

function sample(overrides: { orderIndex?: number; atomicPersistence?: number; eventLoop?: number } = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-17T00:00:00.000Z",
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    seed: 20260817,
    corpusSize: 2500,
    metrics: {
      orderIndex: { operations: 1, wallMs: overrides.orderIndex ?? 10, operationsPerSecond: 1 },
      atomicPersistence: { operations: 1, wallMs: overrides.atomicPersistence ?? 10, operationsPerSecond: 1 },
      executionJournal: { operations: 1, wallMs: 10, operationsPerSecond: 1 },
      streamerDecodeDispatch: { operations: 1, wallMs: 10, operationsPerSecond: 1 },
      eventLoop: { p50Ms: 5, p95Ms: 8, p99Ms: overrides.eventLoop ?? 10, maxMs: overrides.eventLoop ?? 10 },
      process: {
        cpuUserMs: 10,
        cpuSystemMs: 5,
        rssBeforeBytes: 1,
        rssAfterBytes: 2,
        rssDeltaBytes: 1,
        heapBeforeBytes: 1,
        heapAfterBytes: 2,
        heapDeltaBytes: 1,
      },
    },
  };
}

function run(args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", checker, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

test("PR profile observes shared-runner event-loop and durable persistence latency", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const currentPath = join(root, "current.json");
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    await writeFile(currentPath, JSON.stringify(sample({ eventLoop: 50, atomicPersistence: 500 })), "utf8");
    const result = run(["--baseline", baselinePath, "--current", currentPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OBSERVE eventLoop\.p99Ms/);
    assert.match(result.stdout, /OBSERVE atomicPersistence\.wallMs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PR profile still fails a deterministic hot-path regression", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const currentPath = join(root, "current.json");
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    await writeFile(currentPath, JSON.stringify(sample({ orderIndex: 150 })), "utf8");
    const result = run(["--baseline", baselinePath, "--current", currentPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /FAIL orderIndex\.wallMs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default multi-sample profile keeps filesystem latency as evidence instead of a portable SLO", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const samplesPath = join(root, "samples");
    await mkdir(samplesPath);
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    for (const [index, value] of [250, 500, 900].entries()) {
      await writeFile(join(samplesPath, `${index}.json`), JSON.stringify(sample({ atomicPersistence: value })), "utf8");
    }
    const result = run(["--baseline", baselinePath, "--current-dir", samplesPath, "--min-samples", "3"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OBSERVE atomicPersistence\.wallMs sampleCount=3 currentMedian=500ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("minimum sample contract rejects an accidentally undersized benchmark directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const samplesPath = join(root, "samples");
    await mkdir(samplesPath);
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    for (const index of [0, 1]) {
      await writeFile(join(samplesPath, `${index}.json`), JSON.stringify(sample()), "utf8");
    }
    const result = run(["--baseline", baselinePath, "--current-dir", samplesPath, "--min-samples", "3"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BENCHMARK_SAMPLE_SET_TOO_SMALL:2<3/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event-loop gate requires at least five samples and gates the median p99", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const samplesPath = join(root, "samples");
    await mkdir(samplesPath);
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    for (const [index, value] of [10, 20, 50, 60, 70].entries()) {
      await writeFile(join(samplesPath, `${index}.json`), JSON.stringify(sample({ eventLoop: value })), "utf8");
    }
    const result = run(["--baseline", baselinePath, "--current-dir", samplesPath, "--min-samples", "5", "--gate-event-loop"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /FAIL eventLoop\.p99Ms sampleCount=5 currentMedian=50ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event-loop gate tolerates isolated noisy-neighbor spikes when the five-sample median stays within SLO", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const samplesPath = join(root, "samples");
    await mkdir(samplesPath);
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    for (const [index, value] of [10, 20, 25, 50, 100].entries()) {
      await writeFile(join(samplesPath, `${index}.json`), JSON.stringify(sample({ eventLoop: value })), "utf8");
    }
    const result = run(["--baseline", baselinePath, "--current-dir", samplesPath, "--min-samples", "5", "--gate-event-loop"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS eventLoop\.p99Ms sampleCount=5 currentMedian=25ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic persistence gate requires five samples before enforcing a host-calibrated SLO", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const samplesPath = join(root, "samples");
    await mkdir(samplesPath);
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    for (const index of [0, 1, 2]) {
      await writeFile(join(samplesPath, `${index}.json`), JSON.stringify(sample({ atomicPersistence: 150 })), "utf8");
    }
    const result = run([
      "--baseline", baselinePath,
      "--current-dir", samplesPath,
      "--min-samples", "3",
      "--gate-atomic-persistence",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ATOMIC_PERSISTENCE_GATE_REQUIRES_5_SAMPLES:3/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host-calibrated atomic persistence gate fails a five-sample median above its limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const samplesPath = join(root, "samples");
    await mkdir(samplesPath);
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    for (const [index, value] of [90, 120, 150, 180, 240].entries()) {
      await writeFile(join(samplesPath, `${index}.json`), JSON.stringify(sample({ atomicPersistence: value })), "utf8");
    }
    const result = run([
      "--baseline", baselinePath,
      "--current-dir", samplesPath,
      "--min-samples", "5",
      "--gate-atomic-persistence",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /FAIL atomicPersistence\.wallMs sampleCount=5 currentMedian=150ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
