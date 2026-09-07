import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestJson, sha256Hex, stableJson } from "../src/backtest/fingerprints.ts";
import { parseBars } from "../src/backtest/bars.ts";
import { readDatasetBars } from "../src/backtest/catalog.ts";
import {
  loadCorporateActions,
  parseCorporateActions,
  validateCorporateActionPolicy,
} from "../src/backtest/corporateActions.ts";
import { fetchAlpacaCorporateActions } from "../src/backtest/alpaca.ts";
import { simulateLongOnlyCashEquity } from "../src/backtest/engine.ts";
import { parseManifest } from "../src/backtest/manifest.ts";
import { readExactObject } from "../src/backtest/objectStore.ts";
import { runAudit, runBacktest, runPreflight } from "../src/backtest/workflow.ts";

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    datasetId: "fixture-2016",
    feed: "alpaca",
    timeframe: "1m",
    session: "regular",
    adjustmentMode: "raw",
    startDate: "2016-01-04",
    endDate: "2016-01-05",
    sourceObject: {
      kind: "object",
      uri: "file:./bars.csv",
      sha256: "0".repeat(64),
      schema: "canonical-minute-bars-v1",
      format: "csv",
      compression: "none",
    },
    universe: {
      id: "fixture-proxy",
      source: "test fixture only; not an index constituent snapshot",
      fingerprint: digestJson(["AAPL"]),
      completeness: "proxy",
      symbols: ["AAPL"],
    },
    corporateActions: {
      mode: "none",
      appliesToBars: false,
    },
    ...overrides,
  };
}

const csv = [
  "timestamp,symbol,open,high,low,close,volume",
  "2016-01-04T14:30:00Z,AAPL,10,10,10,10,100",
  "2016-01-04T14:31:00Z,AAPL,10,20,10,20,100",
  "2016-01-05T14:30:00Z,AAPL,10,10,10,10,100",
].join("\n") + "\n";

test("stable JSON uses deterministic code-unit key ordering", () => {
  assert.equal(stableJson({ z: 1, A: 2, a: 3 }), '{"A":2,"a":3,"z":1}');
  assert.equal(stableJson({ nested: { b: 1, a: 2 } }), '{"nested":{"a":2,"b":1}}');
});

test("manifest rejects mutable source selectors and unknown adjustment", () => {
  assert.throws(() => parseManifest(baseManifest({
    sourceObject: { ...baseManifest().sourceObject, uri: "oss://bucket/latest/bars.csv" },
  })), /BACKTEST_MANIFEST_INVALID/);
  assert.throws(() => parseManifest(baseManifest({
    sourceObject: { ...baseManifest().sourceObject, uri: "oss://bucket/bars-*.csv" },
  })), /BACKTEST_MANIFEST_INVALID/);
  const manifest = parseManifest(baseManifest({ adjustmentMode: "unknown" }));
  assert.equal(manifest.adjustmentMode, "unknown");
});

test("CSV bars are normalized, sorted, range checked, and fingerprinted", () => {
  const manifest = parseManifest(baseManifest({
    sourceObject: { ...baseManifest().sourceObject, format: "csv", sha256: sha256Hex(Buffer.from(csv)) },
  }));
  const result = parseBars(Buffer.from(csv), manifest);
  assert.equal(result.bars.length, 3);
  assert.equal(result.bars[0].timestamp, "2016-01-04T14:30:00.000Z");
  assert.equal(result.bars[2].close, 10);
  assert.match(result.dataFingerprint, /^[a-f0-9]{64}$/);
});

test("exact local object hashing fails closed and network is opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "backtest-object-"));
  try {
    const path = join(root, "bars.csv");
    await writeFile(path, csv);
    const manifestPath = join(root, "manifest.json");
    const manifest = parseManifest(baseManifest({
      sourceObject: {
        ...baseManifest().sourceObject,
        uri: "file:./bars.csv",
        sha256: sha256Hex(Buffer.from(csv)),
      },
    }));
    await writeFile(manifestPath, JSON.stringify(manifest));
    const exact = await readExactObject(manifestPath, manifest.sourceObject);
    assert.equal(exact.sha256, manifest.sourceObject.sha256);
    await assert.rejects(
      readExactObject(manifestPath, { ...manifest.sourceObject, uri: "oss://bucket/exact.csv" }, { allowNetwork: false }),
      /BACKTEST_NETWORK_DISABLED/,
    );
    await assert.rejects(
      readExactObject(manifestPath, { ...manifest.sourceObject, sha256: "f".repeat(64) }),
      /BACKTEST_SOURCE_SHA256_MISMATCH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog manifests enumerate exact immutable shards without LIST", async () => {
  const root = await mkdtemp(join(tmpdir(), "backtest-catalog-"));
  try {
    const shardOne = [
      "timestamp,symbol,open,high,low,close,volume",
      "2016-01-04T14:30:00Z,AAPL,10,10,10,10,100",
    ].join("\n") + "\n";
    const shardTwo = [
      "timestamp,symbol,open,high,low,close,volume",
      "2016-01-05T14:30:00Z,AAPL,10,10,10,10,100",
    ].join("\n") + "\n";
    await writeFile(join(root, "one.csv"), shardOne);
    await writeFile(join(root, "two.csv"), shardTwo);
    const catalog = {
      schemaVersion: 1,
      datasetId: "fixture-2016",
      feed: "alpaca",
      timeframe: "1m",
      shards: [
        {
          uri: "file:./one.csv", sha256: sha256Hex(Buffer.from(shardOne)),
          schema: "canonical-minute-bars-v1", format: "csv", compression: "none",
          startDate: "2016-01-04", endDate: "2016-01-04", symbols: ["AAPL"],
        },
        {
          uri: "file:./two.csv", sha256: sha256Hex(Buffer.from(shardTwo)),
          schema: "canonical-minute-bars-v1", format: "csv", compression: "none",
          startDate: "2016-01-05", endDate: "2016-01-05", symbols: ["AAPL"],
        },
        {
          uri: "file:./not-read.csv", sha256: sha256Hex(Buffer.from("never read")),
          schema: "canonical-minute-bars-v1", format: "csv", compression: "none",
          startDate: "2016-01-04", endDate: "2016-01-05", symbols: ["MSFT"],
        },
      ],
    };
    const catalogBytes = Buffer.from(JSON.stringify(catalog));
    await writeFile(join(root, "catalog.json"), catalogBytes);
    const manifest = parseManifest(baseManifest({
      sourceObject: {
        kind: "catalog", uri: "file:./catalog.json", sha256: sha256Hex(catalogBytes),
        schema: "minute-bars-catalog-v1", format: "json", compression: "none",
      },
      universe: {
        id: "fixture-proxy",
        source: "test fixture only; not an index constituent snapshot",
        fingerprint: digestJson(["AAPL", "MSFT"]),
        completeness: "proxy",
        symbols: ["AAPL", "MSFT"],
      },
    }));
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = await readDatasetBars(manifestPath, manifest, { requiredSymbols: ["AAPL"] });
    assert.equal(result.bars.length, 2);
    assert.deepEqual(result.sourceObjects, ["file:./catalog.json", "file:./one.csv", "file:./two.csv"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Alpaca CLI adapter normalizes official action types and paginates", async () => {
  const calls: string[][] = [];
  let page = 0;
  const result = await fetchAlpacaCorporateActions(
    { symbols: ["aapl"], since: "2016-01-01", until: "2016-12-31" },
    {
      env: { ALPACA_MARKET_DATA_API_KEY: "key-fixture", ALPACA_MARKET_DATA_SECRET_KEY: "secret-fixture" },
      runner: async (args, env) => {
        calls.push([...args]);
        assert.equal(env.APCA_API_KEY_ID, "key-fixture");
        assert.equal(env.APCA_API_SECRET_KEY, "secret-fixture");
        page += 1;
        return {
          stderr: "",
          stdout: JSON.stringify(page === 1
            ? {
              corporate_actions: {
                forward_split: [{
                  id: "split1", symbol: "AAPL", ca_type: "forward_split", ex_date: "2016-06-01",
                  old_rate: 1, new_rate: 2,
                }],
              },
              next_page_token: "page-2",
            }
            : {
              corporate_actions: {
                cash_dividend: [{
                  id: "dividend1", symbol: "AAPL", ca_type: "cash_dividend", ex_date: "2016-09-01", cash: 1,
                }],
              },
            }),
        };
      },
    },
  );
  assert.equal(result.receipt.accessMethod, "alpaca_cli");
  assert.equal(result.receipt.pages, 2);
  assert.deepEqual(result.actions.map((action) => action.type), ["split", "dividend"]);
  assert.equal(result.actions[0].splitFactor, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(-2), ["--page-token", "page-2"]);
});

test("corporate action policy prevents double adjustment", () => {
  const actions = parseCorporateActions({
    schemaVersion: 1,
    provider: "fixture",
    actions: [{ symbol: "AAPL", exDate: "2016-01-05", type: "dividend", cash: 1, source: "fixture" }],
  });
  const raw = parseManifest(baseManifest({
    corporateActions: { mode: "local-file", uri: "file:./actions.json", sha256: "1".repeat(64), appliesToBars: false },
  }));
  assert.deepEqual(validateCorporateActionPolicy(raw, actions.actions), []);
  const adjusted = parseManifest(baseManifest({
    adjustmentMode: "split-adjusted",
    corporateActions: { mode: "local-file", uri: "file:./actions.json", sha256: "1".repeat(64), appliesToBars: false },
  }));
  assert.throws(() => validateCorporateActionPolicy(adjusted, actions.actions), /CANNOT_APPLY_ACTIONS_AGAIN/);
});

test("corporate action OSS URI uses the exact-object network gate", async () => {
  const manifest = parseManifest(baseManifest({
    corporateActions: {
      mode: "provider-receipt",
      uri: "oss://bucket/actions-2016.json",
      sha256: "2".repeat(64),
      appliesToBars: false,
      provider: "alpaca",
    },
  }));
  const manifestPath = "/tmp/backtest-manifest.json";
  await assert.rejects(
    loadCorporateActions(manifestPath, manifest),
    /BACKTEST_NETWORK_DISABLED/,
  );
});

test("reference simulation applies raw dividend once and adjusted bars never twice", () => {
  const rawManifest = parseManifest(baseManifest({
    corporateActions: { mode: "local-file", uri: "file:./actions.json", sha256: "1".repeat(64), appliesToBars: false },
  }));
  const actions = parseCorporateActions({
    schemaVersion: 1,
    provider: "fixture",
    actions: [{ symbol: "AAPL", exDate: "2016-01-05", type: "dividend", cash: 1, source: "fixture" }],
  }).actions;
  const bars = parseBars(Buffer.from(csv), rawManifest).bars;
  const rawResult = simulateLongOnlyCashEquity(bars, rawManifest, actions, { symbol: "AAPL", initialCash: 100 });
  assert.equal(rawResult.finalCash, 110);
  const adjustedManifest = parseManifest(baseManifest({
    adjustmentMode: "total-return-adjusted",
    corporateActions: { mode: "local-file", uri: "file:./actions.json", sha256: "1".repeat(64), appliesToBars: true },
  }));
  const adjustedResult = simulateLongOnlyCashEquity(bars, adjustedManifest, actions, { symbol: "AAPL", initialCash: 100 });
  assert.equal(adjustedResult.finalCash, 100);
});

test("workflow artifacts distinguish local, blocked, and reproducible runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "backtest-workflow-"));
  try {
    const path = join(root, "bars.csv");
    await writeFile(path, csv);
    const manifest = parseManifest(baseManifest({
      sourceObject: {
        ...baseManifest().sourceObject,
        sha256: sha256Hex(Buffer.from(csv)),
      },
    }));
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const preflight = await runPreflight(manifestPath, {});
    assert.equal(preflight.status, "PASS");
    const audit = await runAudit(manifestPath, {});
    assert.equal(audit.status, "UNVERIFIED");
    await assert.rejects(
      runBacktest(manifestPath, { initialCash: 100 }),
      /BACKTEST_RAW_BARS_CORPORATE_ACTION_EVIDENCE_REQUIRED/,
    );
    const actions = JSON.stringify({
      schemaVersion: 1,
      provider: "fixture",
      actions: [{ symbol: "AAPL", exDate: "2016-01-05", type: "dividend", cash: 1, source: "fixture" }],
    });
    const actionsPath = join(root, "actions.json");
    await writeFile(actionsPath, actions);
    const actionManifest = parseManifest(baseManifest({
      sourceObject: {
        ...baseManifest().sourceObject,
        sha256: sha256Hex(Buffer.from(csv)),
      },
      corporateActions: {
        mode: "local-file",
        uri: "file:./actions.json",
        sha256: sha256Hex(Buffer.from(actions)),
        appliesToBars: false,
      },
    }));
    const actionManifestPath = join(root, "action-manifest.json");
    await writeFile(actionManifestPath, JSON.stringify(actionManifest));
    const runOne = await runBacktest(actionManifestPath, { initialCash: 100 });
    const runTwo = await runBacktest(actionManifestPath, { initialCash: 100 });
    assert.equal(runOne.status, "PASS");
    assert.equal(runOne.runId, runTwo.runId);
    assert.equal((runOne.simulation as { finalCash: number }).finalCash, 110);
    const blockedManifest = parseManifest(baseManifest({
      sourceObject: {
        kind: "object", uri: "oss://missing-bucket/exact.csv", sha256: "0".repeat(64),
        schema: "canonical-minute-bars-v1", format: "csv", compression: "none",
      },
    }));
    const blockedPath = join(root, "blocked.json");
    await writeFile(blockedPath, JSON.stringify(blockedManifest));
    const blocked = await runAudit(blockedPath, {});
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(blocked.networkAccessAttempted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source adapter exposes only read operations", async () => {
  const source = await readFile(new URL("../src/backtest/objectStore.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.(list|put|post|delete)\s*\(/);
  assert.match(source, /\.head\(/);
  assert.match(source, /\.get\(/);
});
