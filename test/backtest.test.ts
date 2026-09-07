import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { digestJson, sha256Hex, stableJson } from "../src/backtest/fingerprints.ts";
import { isRegularArchiveSession, parseBars, parseBarsAsync } from "../src/backtest/bars.ts";
import { buildArchiveBacktestManifest } from "../src/backtest/archive.ts";
import { readDatasetBars } from "../src/backtest/catalog.ts";
import {
  loadCorporateActions,
  parseCorporateActions,
  validateCorporateActionPolicy,
} from "../src/backtest/corporateActions.ts";
import { fetchAlpacaBars, fetchAlpacaCorporateActions } from "../src/backtest/alpaca.ts";
import { simulateLongOnlyCashEquity } from "../src/backtest/engine.ts";
import { parseManifest } from "../src/backtest/manifest.ts";
import {
  createReadOnlyOssStore,
  readExactObject,
  readOssConfiguration,
} from "../src/backtest/objectStore.ts";
import { runArchiveProviderParity, runAudit, runBacktest, runPreflight } from "../src/backtest/workflow.ts";

const execFileAsync = promisify(execFile);

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

const parquetFixture = Buffer.from(
  "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AAA9QBgIAAAAAAAAIkAREQAZLBUEFQAVAgAVABUQFQIAPCkGGSYABgAAACYAHBUKGTUABhAZGAFjFQwWBhbeARaCAiaUDSa2DBwYCAAAAAAAgD5AGAgAAAAAAAAlQBYAKAgAAAAAAIA+QBgIAAAAAAAAJUAREQAZLBUEFQAVAgAVABUQFQIAPCkGGSYABgAAACYAHBUEGTUABhAZGAF2FQwWBhbeARb6ASaODya4DhwYCCwBAAAAAAAAGAhkAAAAAAAAABYAKAgsAQAAAAAAABgIZAAAAAAAAAAREQAZLBUEFQAVAgAVABUQFQIAPCkGGSYABgAAABbuDRYGJggWqhAAGRwYDEFSUk9XOnNjaGVtYRisBS8vLy8vL2dCQUFBUUFBQUFBQUFLQUF3QUJnQUZBQWdBQ2dBQUFBQUJCQUFNQUFBQUNBQUlBQUFBQkFBSUFBQUFCQUFBQUFrQUFBQ1lBUUFBU0FFQUFCd0JBQUR3QUFBQXdBQUFBSlFBQUFCb0FBQUFQQUFBQUFRQUFBQ2Mvdi8vQUFBQkFoQUFBQUFjQUFBQUJBQUFBQUFBQUFBQkFBQUFkZ0FBQUFnQURBQUlBQWNBQ0FBQUFBQUFBQUZBQUFBQTBQNy8vd0FBQVFNUUFBQUFGQUFBQUFRQUFBQUFBQUFBQVFBQUFHTUFBQUNLLy8vL0FBQUNBUGorLy84QUFBRURFQUFBQUJRQUFBQUVBQUFBQUFBQUFBRUFBQUJzQUFBQXN2Ly8vd0FBQWdBZy8vLy9BQUFCQXhBQUFBQVVBQUFBQkFBQUFBQUFBQUFCQUFBQWFBQUFBTnIvLy84QUFBSUFTUC8vL3dBQUFRTVFBQUFBR0FBQUFBUUFBQUFBQUFBQUFRQUFBRzhBQmdBSUFBWUFCZ0FBQUFBQUFnQjAvLy8vQUFBQkJSQUFBQUFZQUFBQUJBQUFBQUFBQUFBRUFBQUFabVZsWkFBQUFBQmsvLy8vblAvLy93QUFBUVVRQUFBQUdBQUFBQVFBQUFBQUFBQUFCd0FBQUhObGMzTnBiMjRBalAvLy84VC8vLzhBQUFFS0VBQUFBQndBQUFBRUFBQUFBQUFBQUFFQUFBQjBBQUFBQ0FBTUFBWUFDQUFJQUFBQUFBQUJBQVFBQUFBREFBQUFWVlJEQUJBQUZBQUlBQVlBQndBTUFBQUFFQUFRQUFBQUFBQUJCUkFBQUFBY0FBQUFCQUFBQUFBQUFBQUdBQUFBYzNsdFltOXNBQUFFQUFRQUJBQUFBQUFBQUFBPQAYIHBhcnF1ZXQtY3BwLWFycm93IHZlcnNpb24gMjMuMC4xGZwcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAcAAAA8QYAAFBBUjE=",
  "base64",
);

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

test("Parquet archive rows respect declared SIP and regular-session filters", async () => {
  const manifest = parseManifest(baseManifest({
    session: "regular",
    sourceObject: {
      ...baseManifest().sourceObject,
      sha256: sha256Hex(parquetFixture),
      schema: "market-data-bars-1m-v2",
      format: "parquet",
      compression: "none",
      feed: "sip",
    },
  }));
  const result = await parseBarsAsync(parquetFixture, manifest);
  assert.equal(result.bars.length, 1);
  assert.deepEqual(result.bars[0], {
    timestamp: "2016-01-04T14:30:00.000Z",
    epochMs: Date.parse("2016-01-04T14:30:00Z"),
    symbol: "AAPL",
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 100,
  });
});

test("legacy intraday archive session is mapped only to regular", () => {
  assert.equal(isRegularArchiveSession("regular"), true);
  assert.equal(isRegularArchiveSession("intraday"), true);
  assert.equal(isRegularArchiveSession("premarket"), false);
  assert.equal(isRegularArchiveSession("postmarket"), false);
});

test("archive importer derives a legacy storage prefix without making it a runtime selector", () => {
  const archive = Buffer.from(JSON.stringify({
    schema_version: "market-data-bars-1m-manifest-v1",
    provider: "alpaca",
    timeframe: "1m",
    adjustment: "raw",
    quality_status: "PASS",
    data_schema_version: "market-data-bars-1m-v2",
    symbol: "AAPL",
    year: 2016,
    asof: "2026-08-12",
    manifest_key: "market-data-v2/historical-bars/provider=alpaca/timeframe=1m/symbol=AAPL/year=2016/revision=2/manifest.json",
    universe_snapshot_id: "a".repeat(64),
    universe_semantics: "latest_snapshot",
    survivorship_bias: true,
    bars: {
      key: "market-data-v2/historical-bars/provider=alpaca/timeframe=1m/symbol=AAPL/year=2016/revision=2/bars.parquet",
      sha256: "b".repeat(64),
      byte_count: 123,
    },
  }));
  const result = buildArchiveBacktestManifest({
    archiveManifestUri: "oss://market-data/legacy/market-data-v2/historical-bars/provider=alpaca/timeframe=1m/symbol=AAPL/year=2016/revision=2/manifest.json",
    archiveManifestBytes: archive,
    archiveManifestSha256: sha256Hex(archive),
  });
  assert.equal(result.storagePrefix, "legacy/");
  assert.equal(
    result.manifest.sourceObject.uri,
    "oss://market-data/legacy/market-data-v2/historical-bars/provider=alpaca/timeframe=1m/symbol=AAPL/year=2016/revision=2/bars.parquet",
  );
  assert.equal(result.manifest.adjustmentMode, "raw");
  assert.equal(result.manifest.universe.completeness, "proxy");
  assert.equal(result.manifest.archiveProvenance?.survivorshipBias, true);
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

test("OSS configuration accepts existing market-data environment aliases", () => {
  const status = readOssConfiguration({
    MARKET_DATA_S3_ENDPOINT: "https://oss.example.test",
    MARKET_DATA_S3_ENDPOINT_STYLE: "bucket",
    MARKET_DATA_S3_REGION: "ap-southeast-1",
    MARKET_DATA_S3_BUCKET: "market-data",
    ALIBABACLOUD_ACCESS_KEY_ID: "test-key",
    ALIBABACLOUD_SECRET_ACCESS_KEY: "test-secret",
  });
  assert.equal(status.configured, true);
  assert.equal(status.config?.endpoint, "https://oss.example.test");
  assert.equal(status.config?.endpointStyle, "bucket");
  assert.equal(status.config?.bucket, "market-data");
});

test("CLI composes protected backtest env files without colliding with Node's env-file flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "backtest-cli-env-"));
  try {
    const manifestPath = join(root, "manifest.json");
    const endpointEnv = join(root, "endpoint.env");
    const credentialsEnv = join(root, "credentials.env");
    const outputDir = join(root, "artifact");
    const manifest = parseManifest(baseManifest({
      sourceObject: {
        ...baseManifest().sourceObject,
        uri: "oss://market-data/exact/bars.csv",
      },
    }));
    await Promise.all([
      writeFile(manifestPath, JSON.stringify(manifest)),
      writeFile(endpointEnv, [
        "OSS_ENDPOINT=https://market-data.oss.example.test",
        "OSS_ENDPOINT_STYLE=bucket",
        "OSS_REGION=ap-southeast-1",
        "OSS_BUCKET=market-data",
      ].join("\n") + "\n"),
      writeFile(credentialsEnv, [
        "ALIBABACLOUD_ACCESS_KEY_ID=test-key",
        "ALIBABACLOUD_SECRET_ACCESS_KEY=test-secret",
      ].join("\n") + "\n"),
    ]);
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      "OSS_ENDPOINT", "OSS_ENDPOINT_STYLE", "OSS_REGION", "OSS_BUCKET",
      "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET", "ALIBABACLOUD_ACCESS_KEY_ID",
      "ALIBABACLOUD_SECRET_ACCESS_KEY", "MARKET_DATA_S3_ENDPOINT",
      "MARKET_DATA_S3_ENDPOINT_STYLE", "MARKET_DATA_S3_REGION", "MARKET_DATA_S3_BUCKET",
    ]) delete environment[key];
    const result = await execFileAsync(process.execPath, [
      "--experimental-strip-types", "src/backtest/cli.ts", "preflight",
      "--manifest", manifestPath,
      "--backtest-env-file", endpointEnv + "," + credentialsEnv,
      "--output-dir", outputDir,
    ], { cwd: process.cwd(), env: environment, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(String(result.stdout).trim()) as Record<string, unknown>;
    assert.equal(report.status, "PASS");
    assert.deepEqual((report.oss as Record<string, unknown>).missing, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OSS reader uses CNAME mode for an exact bucket endpoint", async () => {
  let clientOptions: { cname: boolean; bucket: string; endpoint?: string } | undefined;
  const store = createReadOnlyOssStore({
    endpoint: "https://market-data.oss.example.test",
    endpointStyle: "bucket",
    region: "ap-southeast-1",
    bucket: "market-data",
    accessKeyId: "test-key",
    accessKeySecret: "test-secret",
  }, async (options) => {
    clientOptions = options;
    return {
      head: async () => ({ res: { headers: { "x-oss-request-id": "request-1" } } }),
      get: async () => ({ content: Buffer.from("fixture") }),
    };
  });

  const result = await store.head("oss://market-data/exact/bars.csv");
  assert.equal(result.requestId, "request-1");
  assert.deepEqual(clientOptions, {
    cname: true,
    bucket: "market-data",
    endpoint: "https://market-data.oss.example.test",
    accessKeyId: "test-key",
    accessKeySecret: "test-secret",
    stsToken: undefined,
    region: "ap-southeast-1",
    authorizationV4: true,
    retryMax: 0,
    timeout: 60_000,
  });
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

test("Alpaca CLI adapter normalizes grouped current action responses and paginates", async () => {
  const calls: string[][] = [];
  let page = 0;
  const result = await fetchAlpacaCorporateActions(
    { symbols: ["aapl"], since: "2016-01-01", until: "2016-12-31" },
    {
      env: { ALPACA_PAPER_API_KEY_ID: "key-fixture", ALPACA_PAPER_API_SECRET_KEY: "secret-fixture" },
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
                forward_splits: [{
                  id: "split1", symbol: "AAPL", ex_date: "2016-06-01",
                  old_rate: 1, new_rate: 2,
                }],
              },
              next_page_token: "page-2",
            }
            : {
              corporate_actions: {
                cash_dividends: [{
                  id: "dividend1", symbol: "AAPL", ex_date: "2016-09-01", rate: 1,
                }, {
                  id: "dividend2", symbol: "AAPL", ex_date: "2016-09-01", rate: 1,
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
  assert.equal(result.actions[1].dividendPerShare, 1);
  assert.equal(result.actions[1].duplicateCount, 1);
  assert.deepEqual(result.actions[1].providerIds, ["dividend1", "dividend2"]);
  assert.equal(result.receipt.duplicateCount, 1);
  assert.deepEqual(result.receipt.providerDuplicateIds, ["dividend2"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(-2), ["--page-token", "page-2"]);
});

test("Alpaca CLI adapter fetches raw SIP minute bars with exact UTC bounds", async () => {
  const calls: string[][] = [];
  const result = await fetchAlpacaBars(
    {
      symbol: "aapl",
      start: "2016-01-04T14:30:00Z",
      end: "2016-01-04T14:31:00Z",
      feed: "sip",
    },
    {
      env: { ALPACA_PAPER_API_KEY_ID: "key-fixture", ALPACA_PAPER_API_SECRET_KEY: "secret-fixture" },
      runner: async (args, env) => {
        calls.push([...args]);
        assert.equal(env.APCA_API_KEY_ID, "key-fixture");
        return {
          stdout: JSON.stringify({
            bars: [
              { t: "2016-01-04T14:30:00Z", o: 10, h: 11, l: 9, c: 10.5, v: 100 },
              { t: "2016-01-04T14:31:00Z", o: 10.5, h: 12, l: 10, c: 11, v: 200 },
            ],
            next_page_token: "",
          }),
          stderr: "",
        };
      },
    },
  );
  assert.equal(result.bars.length, 2);
  assert.equal(result.bars[0].timestamp, "2016-01-04T14:30:00.000Z");
  assert.equal(result.receipt.adjustment, "raw");
  assert.deepEqual(calls[0].slice(0, 12), [
    "data", "bars", "--symbol", "AAPL", "--start", "2016-01-04T14:30:00.000Z",
    "--end", "2016-01-04T14:31:00.000Z", "--timeframe", "1Min", "--feed", "sip",
  ]);
});

test("provider parity compares a declared raw SIP archive with a CLI response", async () => {
  const root = await mkdtemp(join(tmpdir(), "backtest-provider-parity-"));
  try {
    const bars = [
      "timestamp,symbol,open,high,low,close,volume",
      "2016-01-04T14:30:00Z,AAPL,10,11,9,10.5,100",
      "2016-01-04T14:31:00Z,AAPL,10.5,12,10,11,200",
    ].join("\n") + "\n";
    await writeFile(join(root, "bars.csv"), bars);
    const manifest = parseManifest(baseManifest({
      session: "regular",
      sourceObject: {
        ...baseManifest().sourceObject,
        uri: "file:./bars.csv",
        sha256: sha256Hex(Buffer.from(bars)),
        feed: "sip",
      },
      adjustmentMode: "raw",
    }));
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const report = await runArchiveProviderParity(manifestPath, {
      symbol: "AAPL",
      start: "2016-01-04T14:30:00Z",
      end: "2016-01-04T14:31:00Z",
    }, {
      allowNetwork: true,
      env: { ALPACA_PAPER_API_KEY_ID: "key-fixture", ALPACA_PAPER_API_SECRET_KEY: "secret-fixture" },
      runner: async () => ({
        stdout: JSON.stringify({
          bars: [
            { S: "AAPL", t: "2016-01-04T14:30:00Z", o: 10, h: 11, l: 9, c: 10.5, v: 100 },
            { S: "AAPL", t: "2016-01-04T14:31:00Z", o: 10.5, h: 12, l: 10, c: 11, v: 200 },
          ],
          next_page_token: "",
        }),
        stderr: "",
      }),
    });
    assert.equal(report.status, "PASS");
    assert.equal(report.mismatchCount, 0);
    assert.equal(report.evidenceClass, "REAL_PROVIDER_READ_ONLY_PARITY");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("corporate actions fold provider duplicates but retain distinct same-day dividends", () => {
  const first = parseCorporateActions({
    schemaVersion: 1,
    provider: "alpaca",
    actions: [
      { id: "apa-2", symbol: "APA", ex_date: "2021-01-21", type: "dividend", cash: 0.025 },
      { id: "apa-1", symbol: "APA", ex_date: "2021-01-21", type: "dividend", cash: 0.025 },
      { id: "apa-3", symbol: "APA", ex_date: "2021-01-21", type: "dividend", cash: 0.03 },
    ],
  });
  const second = parseCorporateActions({
    schemaVersion: 1,
    provider: "alpaca",
    actions: [
      { id: "apa-3", symbol: "APA", ex_date: "2021-01-21", type: "dividend", cash: 0.03 },
      { id: "apa-1", symbol: "APA", ex_date: "2021-01-21", type: "dividend", cash: 0.025 },
      { id: "apa-2", symbol: "APA", ex_date: "2021-01-21", type: "dividend", cash: 0.025 },
    ],
  });
  assert.deepEqual(first.actions, second.actions);
  assert.equal(first.actions.length, 2);
  assert.deepEqual(first.actions[0]?.providerIds, ["apa-1", "apa-2"]);
  assert.equal(first.actions[0]?.duplicateCount, 1);
  assert.equal(first.actions[1]?.dividendPerShare, 0.03);
  assert.equal(first.actions[1]?.duplicateCount, undefined);
});

test("corporate action parser rejects repeated provider IDs and folds exact no-ID duplicates", () => {
  assert.throws(() => parseCorporateActions({
    schemaVersion: 1,
    provider: "alpaca",
    actions: [
      { id: "same-id", symbol: "APA", ex_date: "2021-01-21", type: "dividend", cash: 0.025 },
      { id: "same-id", symbol: "APA", ex_date: "2021-01-21", type: "dividend", cash: 0.03 },
    ],
  }), /BACKTEST_ACTION_PROVIDER_ID_CONFLICT/);
  assert.throws(() => parseCorporateActions({
    schemaVersion: 1,
    provider: "alpaca",
    actions: [{
      symbol: "APA",
      ex_date: "2021-01-21",
      type: "dividend",
      cash: 0.025,
      providerIds: ["apa-1", "apa-2"],
    }],
  }), /BACKTEST_ACTION_DUPLICATE_COUNT_INCONSISTENT/);
  const parsed = parseCorporateActions({
    schemaVersion: 1,
    provider: "fixture",
    actions: [
      { symbol: "APA", exDate: "2021-01-21", type: "dividend", cash: 0.025, source: "fixture" },
      { symbol: "APA", exDate: "2021-01-21", type: "dividend", cash: 0.025, source: "fixture" },
    ],
  });
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0]?.duplicateCount, 1);
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

test("reference simulation applies distinct same-day dividends in deterministic order", () => {
  const manifest = parseManifest(baseManifest({
    corporateActions: { mode: "local-file", uri: "file:./actions.json", sha256: "1".repeat(64), appliesToBars: false },
  }));
  const actions = parseCorporateActions({
    schemaVersion: 1,
    provider: "fixture",
    actions: [
      { symbol: "AAPL", exDate: "2016-01-05", type: "dividend", cash: 2, source: "fixture" },
      { symbol: "AAPL", exDate: "2016-01-05", type: "dividend", cash: 1, source: "fixture" },
    ],
  }).actions;
  const result = simulateLongOnlyCashEquity(parseBars(Buffer.from(csv), manifest).bars, manifest, actions, {
    symbol: "AAPL",
    initialCash: 100,
  });
  assert.equal(result.finalCash, 130);
});

test("reference simulation preserves value through a 3:2 split with micro-shares", () => {
  const manifest = parseManifest(baseManifest({
    corporateActions: { mode: "local-file", uri: "file:./actions.json", sha256: "1".repeat(64), appliesToBars: false },
  }));
  const splitBars = [
    "timestamp,symbol,open,high,low,close,volume",
    "2016-01-04T14:30:00Z,AAPL,10,10,10,10,100",
    "2016-01-05T14:30:00Z,AAPL,6.666667,6.666667,6.666667,6.666667,100",
  ].join("\n") + "\n";
  const actions = parseCorporateActions({
    schemaVersion: 1,
    provider: "fixture",
    actions: [{ symbol: "AAPL", exDate: "2016-01-05", type: "split", old_rate: 2, new_rate: 3, source: "fixture" }],
  }).actions;
  const result = simulateLongOnlyCashEquity(
    parseBars(Buffer.from(splitBars), manifest).bars,
    manifest,
    actions,
    { symbol: "AAPL", initialCash: 100 },
  );
  assert.equal(result.sharesBought, 10);
  assert.equal(result.trades[1]?.quantity, 15);
  assert.ok(Math.abs(result.finalCash - 100) <= 0.00001);
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
    const actionBlockedManifest = parseManifest(baseManifest({
      sourceObject: {
        ...baseManifest().sourceObject,
        sha256: sha256Hex(Buffer.from(csv)),
      },
      corporateActions: {
        mode: "provider-receipt",
        uri: "oss://missing-bucket/actions-2016.json",
        sha256: "3".repeat(64),
        appliesToBars: false,
        provider: "alpaca",
      },
    }));
    const actionBlockedPath = join(root, "action-blocked.json");
    await writeFile(actionBlockedPath, JSON.stringify(actionBlockedManifest));
    const actionPreflight = await runPreflight(actionBlockedPath, {});
    assert.equal(actionPreflight.status, "BLOCKED");
    assert.equal((actionPreflight.oss as { required: boolean }).required, true);
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
