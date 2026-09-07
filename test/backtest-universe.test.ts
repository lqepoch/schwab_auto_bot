import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createBoundedPrefixDiscovery,
  createReadOnlyOssStore,
  type AliOssPrefixClient,
  type OssConfiguration,
} from "../src/backtest/objectStore.ts";
import {
  discoverCurrentUniverse,
  parseCurrentUniverseDiscovery,
  type CurrentUniverseDiscoveryTransport,
  type CurrentUniverseDiscoveryInput,
} from "../src/backtest/universe.ts";
import { digestJson, sha256Hex } from "../src/backtest/fingerprints.ts";
import { materializeCurrentUniverseCatalog } from "../src/backtest/universeActions.ts";
import { parseManifest } from "../src/backtest/manifest.ts";

const execFileAsync = promisify(execFile);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function archiveBytes(symbol: string, year: number, revision: number): Buffer {
  const prefix = `archive/symbol=${symbol}/year=${year}/revision=${revision}`;
  return Buffer.from(JSON.stringify({
    schema_version: "market-data-bars-1m-manifest-v1",
    provider: "alpaca",
    timeframe: "1m",
    adjustment: "raw",
    quality_status: "PASS",
    data_schema_version: "market-data-bars-1m-v2",
    symbol,
    year,
    asof: "2026-09-01",
    manifest_key: `${prefix}/manifest.json`,
    universe_snapshot_id: HASH_A,
    universe_semantics: "current_snapshot",
    survivorship_bias: true,
    bars: {
      key: `${prefix}/bars.parquet`,
      sha256: HASH_B,
      byte_count: 1,
    },
  }));
}

function fixtureTransport(options: {
  readonly symbols?: readonly string[];
  readonly revisions?: Readonly<Record<string, readonly number[]>>;
  readonly alias?: boolean;
  readonly directObject?: boolean;
} = {}): {
  readonly input: CurrentUniverseDiscoveryInput;
  readonly transport: CurrentUniverseDiscoveryTransport;
  readonly listCalls: string[];
} {
  const symbols = options.symbols ?? ["AAPL"];
  const revisions = options.revisions ?? { "AAPL|2016": [1] };
  const manifestUri = "oss://market-data/universe/snapshot-set/manifest.json";
  const snapshotUri = "oss://market-data/universe/snapshot-set/snapshot.json";
  const snapshot = Buffer.from(JSON.stringify({
    id: HASH_A,
    schema_version: "market-data-universe-snapshot-v1",
    universe: "demo-current",
    semantics: "current_constituents",
    snapshot_date: "2026-09-01",
    retrieved_at: "2026-09-01T00:00:00Z",
    sources: [{ kind: "fixture", uri: "file:fixture" }],
    symbols,
    survivorship_bias: true,
  }));
  const manifest = Buffer.from(JSON.stringify({
    schema_version: "market-data-universe-manifest-v1",
    snapshot: {
      id: HASH_A,
      schema_version: "market-data-universe-snapshot-v1",
      universe: "demo-current",
      semantics: "current_constituents",
      snapshot_date: "2026-09-01",
      retrieved_at: "2026-09-01T00:00:00Z",
      sources: [{ kind: "fixture", uri: "file:fixture" }],
      symbols,
      survivorship_bias: true,
    },
    snapshot_object: {
      key: "snapshot-set/snapshot.json",
      sha256: sha256Hex(snapshot),
      byte_count: snapshot.byteLength,
    },
    constituents_object: { key: "snapshot-set/constituents.json", sha256: HASH_B, byte_count: 1 },
    created_at: "2026-09-01T00:00:00Z",
  }));
  const objects = new Map<string, Buffer>([[manifestUri, manifest], [snapshotUri, snapshot]]);
  for (const symbol of symbols) {
    const year = 2016;
    for (const revision of revisions[`${symbol}|${year}`] ?? []) {
      const uri = `oss://market-data/archive/symbol=${symbol}/year=${year}/revision=${revision}/manifest.json`;
      objects.set(uri, archiveBytes(symbol, year, revision));
    }
  }
  const listCalls: string[] = [];
  const transport: CurrentUniverseDiscoveryTransport = {
    head: async () => ({ source: "oss", requestId: "fixture-request" }),
    get: async (uri) => {
      const bytes = objects.get(uri);
      if (!bytes) throw new Error("FIXTURE_OBJECT_NOT_FOUND");
      return bytes;
    },
    listChildren: async (prefixUri) => {
      listCalls.push(prefixUri);
      const match = /symbol=([^/]+)\/year=(\d+)\/$/.exec(prefixUri);
      if (!match) throw new Error("FIXTURE_PREFIX_INVALID");
      const key = `${match[1]}|${match[2]}`;
      const prefix = new URL(prefixUri).pathname.slice(1);
      return {
        prefixes: [
          ...(revisions[key] ?? []).map((revision) => `archive/symbol=${match[1]}/year=${match[2]}/revision=${revision}/`),
          ...(options.alias ? [`${prefix}provider-symbol=ALIAS/`] : []),
        ],
        objects: options.directObject ? [{ name: `${prefix}alias.json`, size: 1 }] : [],
        pages: 1,
        requestId: "fixture-request",
      };
    },
  };
  return {
    input: {
      universeManifestUri: manifestUri,
      archiveRootUri: "oss://market-data/archive",
      startYear: 2016,
      endYear: 2016,
    },
    transport,
    listCalls,
  };
}

test("current universe discovery requires both network and LIST confirmations at the API", async () => {
  const fixture = fixtureTransport();
  await assert.rejects(
    discoverCurrentUniverse(fixture.input, { allowNetwork: true, transport: fixture.transport }),
    /BACKTEST_LIST_DISCOVERY_REQUIRES_ALLOW_LIST_DISCOVERY/,
  );
  await assert.rejects(
    discoverCurrentUniverse(fixture.input, { allowListDiscovery: true, transport: fixture.transport }),
    /BACKTEST_NETWORK_DISABLED/,
  );
  assert.deepEqual(fixture.listCalls, []);
});

test("discovery lists only explicit symbol/year prefixes and freezes a PASS catalog", async () => {
  const fixture = fixtureTransport();
  const result = await discoverCurrentUniverse(fixture.input, {
    allowNetwork: true,
    allowListDiscovery: true,
    transport: fixture.transport,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.catalog?.shards.length, 1);
  assert.deepEqual(fixture.listCalls, ["oss://market-data/archive/symbol=AAPL/year=2016/"]);
  assert.deepEqual(result.archive.queries[0], {
    snapshotSymbol: "AAPL",
    year: 2016,
    prefixUri: "oss://market-data/archive/symbol=AAPL/year=2016/",
    delimiter: "/",
    pages: 1,
    prefixes: ["archive/symbol=AAPL/year=2016/revision=1/"],
    objects: [],
    requestIdPresent: true,
  });
});

test("missing, multiple, and alias archive entries remain UNVERIFIED", async () => {
  for (const [revisions, code] of [
    [{ "AAPL|2016": [] }, "BACKTEST_UNIVERSE_ARCHIVE_REVISION_NOT_FOUND"],
    [{ "AAPL|2016": [1, 2] }, "BACKTEST_UNIVERSE_ARCHIVE_REVISION_AMBIGUOUS"],
  ] as const) {
    const fixture = fixtureTransport({ revisions });
    const result = await discoverCurrentUniverse(fixture.input, {
      allowNetwork: true,
      allowListDiscovery: true,
      transport: fixture.transport,
    });
    assert.equal(result.status, "UNVERIFIED");
    assert.equal(result.archive.unresolved[0].code, code);
    assert.equal(result.catalog, undefined);
  }
  for (const options of [{ alias: true }, { directObject: true }]) {
    const fixture = fixtureTransport(options);
    const result = await discoverCurrentUniverse(fixture.input, {
      allowNetwork: true,
      allowListDiscovery: true,
      transport: fixture.transport,
    });
    assert.equal(result.status, "UNVERIFIED");
    assert.equal(result.archive.unresolved[0].code, "BACKTEST_UNIVERSE_ARCHIVE_ALIAS_OR_UNEXPECTED_OBJECT");
  }
});

test("ali-oss adapter calls listV2 with one exact delimiter prefix and never exposes LIST on the reader", async () => {
  const config: OssConfiguration = {
    endpoint: "https://oss.example.test",
    endpointStyle: "service",
    region: "ap-southeast-1",
    bucket: "market-data",
    accessKeyId: "fixture-key",
    accessKeySecret: "fixture-secret",
  };
  const queries: Record<string, unknown>[] = [];
  const clientFactory = async (): Promise<AliOssPrefixClient> => ({
    head: async () => ({ res: { headers: { "x-oss-request-id": "head" } } }),
    get: async () => ({ content: Buffer.from("fixture") }),
    listV2: async (query) => {
      queries.push(query);
      return {
        prefixes: ["archive/symbol=AAPL/year=2016/revision=1/"],
        objects: [],
        isTruncated: false,
        nextContinuationToken: null,
        res: { headers: { "x-oss-request-id": "list" } },
      };
    },
  });
  const discovery = createBoundedPrefixDiscovery(config, clientFactory, {
    allowNetwork: true,
    allowListDiscovery: true,
  });
  const listed = await discovery.listChildren("oss://market-data/archive/symbol=AAPL/year=2016");
  assert.deepEqual(queries, [{
    prefix: "archive/symbol=AAPL/year=2016/",
    delimiter: "/",
    "max-keys": 1000,
  }]);
  assert.equal(listed.pages, 1);
  const reader = createReadOnlyOssStore(config, clientFactory);
  assert.equal("listV2" in reader, false);
});

test("discover-universe CLI refuses LIST without the second explicit confirmation", async () => {
  const result = await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    "src/backtest/cli.ts",
    "discover-universe",
    "--universe-manifest-uri", "oss://market-data/exact/manifest.json",
    "--archive-root-uri", "oss://market-data/exact/archive",
    "--start-year", "2016",
    "--end-year", "2016",
    "--allow-network",
  ], { cwd: process.cwd(), env: { ...process.env }, maxBuffer: 1024 * 1024 }).catch((error: unknown) => error as { stderr?: string; code?: number });
  assert.match(String((result as { stderr?: string }).stderr), /BACKTEST_LIST_DISCOVERY_REQUIRES_ALLOW_LIST_DISCOVERY/);
});

test("discover-universe CLI refuses network when only LIST confirmation is present", async () => {
  const result = await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    "src/backtest/cli.ts",
    "discover-universe",
    "--universe-manifest-uri", "oss://market-data/exact/manifest.json",
    "--archive-root-uri", "oss://market-data/exact/archive",
    "--start-year", "2016",
    "--end-year", "2016",
    "--allow-list-discovery",
  ], { cwd: process.cwd(), env: { ...process.env }, maxBuffer: 1024 * 1024 }).catch((error: unknown) => error as { stderr?: string; code?: number });
  assert.match(String((result as { stderr?: string }).stderr), /BACKTEST_NETWORK_DISABLED/);
});

async function writeActionReceipt(root: string, until: string): Promise<{ path: string; sha256: string }> {
  const actionsPath = join(root, "actions.json");
  const actions = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    provider: "alpaca",
    coverage: { symbols: ["AAPL"], since: "2016-01-01", until },
    actions: [],
  }));
  await writeFile(actionsPath, actions);
  const receiptPath = join(root, "receipt.json");
  const receipt = {
    artifactVersion: 1,
    kind: "alpaca-corporate-actions-receipt",
    status: "PASS",
    evidenceClass: "REAL_PROVIDER_READ_ONLY",
    readOnly: true,
    brokerWriteAttempted: false,
    actionsPath,
    actionsSha256: sha256Hex(actions),
    receipt: {
      provider: "alpaca",
      accessMethod: "alpaca_cli",
      evidenceClass: "REAL_PROVIDER_READ_ONLY",
      command: "alpaca data corporate-actions",
      commandFingerprint: HASH_A,
      symbols: ["AAPL"],
      since: "2016-01-01",
      until,
      pages: 1,
      status: 0,
      actionCount: 0,
      rawProviderRowCount: 0,
      duplicateCount: 0,
      providerDuplicateIds: [],
      dataFingerprint: digestJson([]),
      retrievedAt: "2026-09-01T00:00:00Z",
    },
    coverage: { symbols: ["AAPL"], since: "2016-01-01", until },
    warnings: [],
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  await writeFile(receiptPath, receiptBytes);
  return { path: receiptPath, sha256: sha256Hex(receiptBytes) };
}

test("materialize requires a PASS discovery and explicit, complete action receipt coverage", async () => {
  const fixture = fixtureTransport();
  const discovery = await discoverCurrentUniverse(fixture.input, {
    allowNetwork: true,
    allowListDiscovery: true,
    transport: fixture.transport,
  });
  const parsed = parseCurrentUniverseDiscovery(discovery);
  const root = await mkdtemp(join(tmpdir(), "backtest-universe-materialize-"));
  try {
    const receipt = await writeActionReceipt(root, "2016-12-31");
    const result = await materializeCurrentUniverseCatalog({
      discovery: parsed,
      discoverySha256: HASH_A,
      actionReceipts: [receipt],
      catalogPath: join(root, "catalog.json"),
      actionsPath: join(root, "actions-bundle.json"),
      manifestPath: join(root, "manifest.json"),
    });
    assert.equal(result.status, "PASS");
    assert.equal(parseManifest(JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))).universe.completeness, "current-constituents");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialize fails closed for incomplete coverage and tampered receipt hashes", async () => {
  const fixture = fixtureTransport();
  const discovery = parseCurrentUniverseDiscovery(await discoverCurrentUniverse(fixture.input, {
    allowNetwork: true,
    allowListDiscovery: true,
    transport: fixture.transport,
  }));
  const root = await mkdtemp(join(tmpdir(), "backtest-universe-materialize-fail-"));
  try {
    const incomplete = await writeActionReceipt(root, "2016-06-30");
    await assert.rejects(
      materializeCurrentUniverseCatalog({
        discovery,
        actionReceipts: [incomplete],
        catalogPath: join(root, "incomplete-catalog.json"),
        actionsPath: join(root, "incomplete-actions.json"),
        manifestPath: join(root, "incomplete-manifest.json"),
      }),
      /BACKTEST_UNIVERSE_ACTION_COVERAGE_INCOMPLETE_AAPL_2016/,
    );
    await assert.rejects(readFile(join(root, "incomplete-catalog.json")), /ENOENT/);
    await assert.rejects(
      materializeCurrentUniverseCatalog({
        discovery,
        actionReceipts: [{ ...incomplete, sha256: "0".repeat(64) }],
        catalogPath: join(root, "tampered-catalog.json"),
        actionsPath: join(root, "tampered-actions.json"),
        manifestPath: join(root, "tampered-manifest.json"),
      }),
      /BACKTEST_UNIVERSE_ACTION_RECEIPT_SHA256_MISMATCH/,
    );
    const countsReceiptPath = join(root, "counts-receipt.json");
    const countsReceipt = JSON.parse(await readFile(incomplete.path, "utf8")) as {
      receipt: { rawProviderRowCount: number; duplicateCount: number };
    };
    countsReceipt.receipt.rawProviderRowCount = 1;
    countsReceipt.receipt.duplicateCount = 1;
    const countsReceiptBytes = Buffer.from(JSON.stringify(countsReceipt));
    await writeFile(countsReceiptPath, countsReceiptBytes);
    await assert.rejects(
      materializeCurrentUniverseCatalog({
        discovery,
        actionReceipts: [{ path: countsReceiptPath, sha256: sha256Hex(countsReceiptBytes) }],
        catalogPath: join(root, "counts-catalog.json"),
        actionsPath: join(root, "counts-actions.json"),
        manifestPath: join(root, "counts-manifest.json"),
      }),
      /BACKTEST_UNIVERSE_ACTION_RECEIPT_COUNTS_MISMATCH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
