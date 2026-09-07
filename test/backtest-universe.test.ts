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
import { parseSymbolResolutionReceipt } from "../src/backtest/symbolResolution.ts";

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
  readonly providerSymbols?: Readonly<Record<string, string>>;
} = {}): {
  readonly input: CurrentUniverseDiscoveryInput;
  readonly transport: CurrentUniverseDiscoveryTransport;
  readonly listCalls: string[];
  readonly snapshotSha256: string;
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
  for (const sourceSymbol of symbols) {
    const symbol = options.providerSymbols?.[sourceSymbol] ?? sourceSymbol;
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
    snapshotSha256: sha256Hex(snapshot),
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
    sourceSymbol: "AAPL",
    providerSymbol: "AAPL",
    year: 2016,
    prefixUri: "oss://market-data/archive/symbol=AAPL/year=2016/",
    delimiter: "/",
    pages: 1,
    prefixes: ["archive/symbol=AAPL/year=2016/revision=1/"],
    objects: [],
    requestIdPresent: true,
  });
});

function resolutionReceipt(
  snapshotSha256: string,
  mappings: readonly { sourceSymbol: string; providerSymbol: string }[],
  exclusions: readonly { sourceSymbol: string; reason: string; evidence: { uri: string; sha256: string } }[] = [],
  snapshotId = HASH_A,
) {
  return parseSymbolResolutionReceipt({
    schemaVersion: 1,
    kind: "backtest-symbol-resolution-receipt",
    status: "PASS",
    evidenceClass: "LOCAL_HASH_FIXED_SYMBOL_RESOLUTION",
    readOnly: true,
    brokerWriteAttempted: false,
    snapshot: { id: snapshotId, sha256: snapshotSha256 },
    mappings,
    exclusions,
    warnings: [],
  });
}

test("partial symbol-resolution receipt routes provider symbols and leaves omitted sources identity", async () => {
  const fixture = fixtureTransport({
    symbols: ["AAPL", "BFB"],
    providerSymbols: { BFB: "BF.B" },
    revisions: { "AAPL|2016": [1], "BF.B|2016": [1] },
  });
  const receipt = resolutionReceipt(fixture.snapshotSha256, [{ sourceSymbol: "BFB", providerSymbol: "BF.B" }]);
  const result = await discoverCurrentUniverse({
    ...fixture.input,
    symbolResolution: {
      uri: "file:///tmp/frozen-symbol-resolution.json",
      sha256: HASH_B,
      receipt,
    },
  }, {
    allowNetwork: true,
    allowListDiscovery: true,
    transport: fixture.transport,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.symbolResolution?.mappings[0].sourceSymbol, "BFB");
  assert.deepEqual(fixture.listCalls, [
    "oss://market-data/archive/symbol=AAPL/year=2016/",
    "oss://market-data/archive/symbol=BF.B/year=2016/",
  ]);
  const mapped = result.archive.resolved.find((item) => item.sourceSymbol === "BFB");
  assert.equal(mapped?.providerSymbol, "BF.B");
  assert.deepEqual(mapped?.shard.symbols, ["BF.B"]);
  assert.equal(result.archive.resolved.find((item) => item.sourceSymbol === "AAPL")?.providerSymbol, "AAPL");
  assert.equal(parseCurrentUniverseDiscovery(result).status, "PASS");
});

test("without a resolution receipt the source symbol remains the provider probe and stays UNVERIFIED when absent", async () => {
  const fixture = fixtureTransport({ symbols: ["BFB"], revisions: { "BFB|2016": [] } });
  const result = await discoverCurrentUniverse(fixture.input, {
    allowNetwork: true,
    allowListDiscovery: true,
    transport: fixture.transport,
  });
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.symbolResolution, undefined);
  assert.equal(result.archive.unresolved[0].sourceSymbol, "BFB");
  assert.equal(result.archive.unresolved[0].providerSymbol, "BFB");
  assert.deepEqual(fixture.listCalls, ["oss://market-data/archive/symbol=BFB/year=2016/"]);
});

test("resolution receipt rejects wrong snapshot, duplicate targets, unknown sources, and malformed exclusions", async () => {
  const fixture = fixtureTransport({ symbols: ["AAPL", "BFB"], revisions: { "AAPL|2016": [1], "BFB|2016": [1] } });
  const discover = (receipt: ReturnType<typeof resolutionReceipt>) => discoverCurrentUniverse({
    ...fixture.input,
    symbolResolution: { uri: "file:///tmp/frozen-symbol-resolution.json", sha256: HASH_B, receipt },
  }, { allowNetwork: true, allowListDiscovery: true, transport: fixture.transport });
  await assert.rejects(
    discover(resolutionReceipt("c".repeat(64), [{ sourceSymbol: "BFB", providerSymbol: "BRK.B" }])),
    /BACKTEST_SYMBOL_RESOLUTION_SNAPSHOT_BINDING_MISMATCH/,
  );
  assert.throws(
    () => resolutionReceipt(fixture.snapshotSha256, [
      { sourceSymbol: "AAPL", providerSymbol: "BRK.B" },
      { sourceSymbol: "BFB", providerSymbol: "BRK.B" },
    ]),
    /BACKTEST_SYMBOL_RESOLUTION_MAPPING_PROVIDER_DUPLICATE/,
  );
  await assert.rejects(
    discover(resolutionReceipt(fixture.snapshotSha256, [{ sourceSymbol: "MSFT", providerSymbol: "MSFT" }])),
    /BACKTEST_SYMBOL_RESOLUTION_SOURCE_SYMBOL_UNKNOWN/,
  );
  assert.throws(
    () => resolutionReceipt(fixture.snapshotSha256, [], [{
      sourceSymbol: "BFB",
      reason: "not verified",
      evidence: { uri: "file:///tmp/evidence.json", sha256: "not-a-hash" },
    }]),
    /BACKTEST_SYMBOL_RESOLUTION_RECEIPT_SCHEMA_INVALID/,
  );
});

test("explicit exclusion skips archive LIST but remains in the frozen source-universe audit", async () => {
  const fixture = fixtureTransport({
    symbols: ["AAPL", "P5N994"],
    revisions: { "AAPL|2016": [1], "P5N994|2016": [] },
  });
  const result = await discoverCurrentUniverse({
    ...fixture.input,
    symbolResolution: {
      uri: "file:///tmp/frozen-symbol-resolution.json",
      sha256: HASH_B,
      receipt: resolutionReceipt(fixture.snapshotSha256, [], [{
        sourceSymbol: "P5N994",
        reason: "fixture exclusion evidence only",
        evidence: { uri: "file:///tmp/exclusion-evidence.json", sha256: HASH_B },
      }]),
    },
  }, { allowNetwork: true, allowListDiscovery: true, transport: fixture.transport });
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.universe.symbols, ["AAPL", "P5N994"]);
  assert.deepEqual(result.archive.excluded.map((item) => item.sourceSymbol), ["P5N994"]);
  assert.deepEqual(fixture.listCalls, ["oss://market-data/archive/symbol=AAPL/year=2016/"]);
  assert.equal(result.catalog?.shards.some((shard) => shard.sourceSymbol === "P5N994"), false);
  assert.equal(parseCurrentUniverseDiscovery(result).archive.excluded.length, 1);
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

async function writeActionReceipt(
  root: string,
  until: string,
  actionSymbols: readonly string[] = ["AAPL"],
  actionRows: readonly Record<string, unknown>[] = [],
): Promise<{ path: string; sha256: string }> {
  const sortedSymbols = [...actionSymbols].sort();
  const actionsPath = join(root, "actions.json");
  const actions = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    provider: "alpaca",
    coverage: { symbols: sortedSymbols, since: "2016-01-01", until },
    actions: actionRows,
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
      symbols: sortedSymbols,
      since: "2016-01-01",
      until,
      pages: 1,
      status: 0,
      actionCount: actionRows.length,
      rawProviderRowCount: actionRows.length,
      duplicateCount: 0,
      providerDuplicateIds: [],
      dataFingerprint: digestJson(actionRows),
      retrievedAt: "2026-09-01T00:00:00Z",
    },
    coverage: { symbols: sortedSymbols, since: "2016-01-01", until },
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

test("materialize validates action coverage in provider-symbol space and preserves source identity", async () => {
  const fixture = fixtureTransport({
    symbols: ["AAPL", "BFB"],
    providerSymbols: { BFB: "BF.B" },
    revisions: { "AAPL|2016": [1], "BF.B|2016": [1] },
  });
  const discovery = parseCurrentUniverseDiscovery(await discoverCurrentUniverse({
    ...fixture.input,
    symbolResolution: {
      uri: "file:///tmp/frozen-symbol-resolution.json",
      sha256: HASH_B,
      receipt: resolutionReceipt(fixture.snapshotSha256, [{ sourceSymbol: "BFB", providerSymbol: "BF.B" }]),
    },
  }, { allowNetwork: true, allowListDiscovery: true, transport: fixture.transport }));
  const root = await mkdtemp(join(tmpdir(), "backtest-universe-mapped-materialize-"));
  try {
    const receipt = await writeActionReceipt(root, "2016-12-31", ["AAPL", "BF.B"]);
    const result = await materializeCurrentUniverseCatalog({
      discovery,
      actionReceipts: [receipt],
      catalogPath: join(root, "frozen-catalog.json"),
      actionsPath: join(root, "frozen-actions.json"),
      manifestPath: join(root, "frozen-manifest.json"),
    });
    assert.deepEqual(result.actionCoverage.symbols, ["AAPL", "BFB"]);
    assert.deepEqual(result.actionCoverage.providerSymbols, ["AAPL", "BF.B"]);
    const manifest = parseManifest(JSON.parse(await readFile(join(root, "frozen-manifest.json"), "utf8")));
    assert.deepEqual(manifest.universe.symbols, ["AAPL", "BFB"]);
    assert.equal(manifest.universe.symbolResolution?.mappings[0].providerSymbol, "BF.B");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialize rejects mutable current/latest output paths before writing", async () => {
  const fixture = fixtureTransport();
  const discovery = parseCurrentUniverseDiscovery(await discoverCurrentUniverse(fixture.input, {
    allowNetwork: true,
    allowListDiscovery: true,
    transport: fixture.transport,
  }));
  const root = await mkdtemp(join(tmpdir(), "backtest-universe-output-guard-"));
  try {
    const receipt = await writeActionReceipt(root, "2016-12-31");
    await assert.rejects(
      materializeCurrentUniverseCatalog({
        discovery,
        actionReceipts: [receipt],
        catalogPath: join(root, "current", "catalog.json"),
        actionsPath: join(root, "frozen-actions.json"),
        manifestPath: join(root, "frozen-manifest.json"),
      }),
      /BACKTEST_UNIVERSE_MATERIALIZE_CATALOG_URI_NOT_EXACT/,
    );
    await assert.rejects(readFile(join(root, "frozen-actions.json")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materialize CLI defaults produce frozen runnable output names", async () => {
  const fixture = fixtureTransport();
  const discovery = await discoverCurrentUniverse(fixture.input, {
    allowNetwork: true,
    allowListDiscovery: true,
    transport: fixture.transport,
  });
  const root = await mkdtemp(join(tmpdir(), "backtest-universe-cli-materialize-"));
  try {
    const discoveryPath = join(root, "frozen-discovery.json");
    await writeFile(discoveryPath, JSON.stringify(discovery));
    const receipt = await writeActionReceipt(root, "2016-12-31");
    const outputDir = join(root, "output");
    await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      "src/backtest/cli.ts",
      "materialize-universe-catalog",
      "--discovery", discoveryPath,
      "--actions-receipt", receipt.path,
      "--actions-receipt-sha256", receipt.sha256,
      "--output-dir", outputDir,
    ], { cwd: process.cwd(), env: { ...process.env }, maxBuffer: 1024 * 1024 });
    for (const name of ["frozen-universe-catalog.json", "frozen-universe-actions.json", "frozen-universe-manifest.json"]) {
      await readFile(join(outputDir, name));
    }
    const manifest = parseManifest(JSON.parse(await readFile(join(outputDir, "frozen-universe-manifest.json"), "utf8")));
    assert.equal(manifest.sourceObject.kind, "catalog");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
