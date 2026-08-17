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

function sample(overrides: { orderIndex?: number; eventLoop?: number } = {}) {
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
      atomicPersistence: { operations: 1, wallMs: 10, operationsPerSecond: 1 },
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

test("PR profile gates stable local metrics while treating one shared-runner event-loop spike as observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const currentPath = join(root, "current.json");
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    await writeFile(currentPath, JSON.stringify(sample({ eventLoop: 50 })), "utf8");
    const result = run(["--baseline", baselinePath, "--current", currentPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OBSERVE eventLoop\.p99Ms/);
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

test("scheduled profile requires at least five samples and gates the median event-loop p99", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const samplesPath = join(root, "samples");
    await mkdir(samplesPath);
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    for (const [index, value] of [10, 20, 50, 60, 70].entries()) {
      await writeFile(join(samplesPath, `${index}.json`), JSON.stringify(sample({ eventLoop: value })), "utf8");
    }
    const result = run(["--baseline", baselinePath, "--current-dir", samplesPath, "--gate-event-loop"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /FAIL eventLoop\.p99Ms sampleCount=5 currentMedian=50ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduled profile tolerates isolated noisy-neighbor spikes when the five-sample median stays within SLO", async () => {
  const root = await mkdtemp(join(tmpdir(), "schwab-bench-gate-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const samplesPath = join(root, "samples");
    await mkdir(samplesPath);
    await writeFile(baselinePath, JSON.stringify(baseline()), "utf8");
    for (const [index, value] of [10, 20, 25, 50, 100].entries()) {
      await writeFile(join(samplesPath, `${index}.json`), JSON.stringify(sample({ eventLoop: value })), "utf8");
    }
    const result = run(["--baseline", baselinePath, "--current-dir", samplesPath, "--gate-event-loop"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS eventLoop\.p99Ms sampleCount=5 currentMedian=25ms/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
