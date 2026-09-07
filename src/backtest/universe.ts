import { posix } from "node:path";
import { z } from "zod";
import { buildArchiveBacktestManifest } from "./archive.ts";
import type { CatalogShard, MinuteBarsCatalog } from "./catalog.ts";
import { compareCodeUnits, digestJson, isSha256, sha256Hex } from "./fingerprints.ts";
import { parseManifest, type BacktestManifest } from "./manifest.ts";
import {
  createBoundedPrefixDiscovery,
  createReadOnlyOssStore,
  parseExactOssUri,
  readOssConfiguration,
  type BoundedPrefixDiscovery,
  type BoundedPrefixObject,
  type ObjectHead,
  type ReadOnlyObjectStore,
} from "./objectStore.ts";
import {
  bindSymbolResolution,
  identitySymbolResolution,
  providerSymbolForSource,
  type SymbolResolutionPlan,
  type SymbolResolutionReceiptInput,
} from "./symbolResolution.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const symbol = z.string().regex(/^[A-Z][A-Z0-9._-]{0,15}$/);

const objectReferenceSchema = z.object({
  key: z.string().min(1),
  sha256: hash,
  byte_count: z.number().int().positive(),
});

const snapshotSchema = z.object({
  id: hash,
  schema_version: z.literal("market-data-universe-snapshot-v1"),
  universe: z.string().min(1),
  semantics: z.string().min(1),
  snapshot_date: dateOnly,
  retrieved_at: z.string().min(1),
  sources: z.array(z.unknown()),
  symbols: z.array(symbol).min(1),
  survivorship_bias: z.boolean(),
});

const universeManifestSchema = z.object({
  schema_version: z.literal("market-data-universe-manifest-v1"),
  snapshot: snapshotSchema,
  snapshot_object: objectReferenceSchema,
  constituents_object: objectReferenceSchema,
  created_at: z.string().min(1),
});

type UniverseSnapshot = z.infer<typeof snapshotSchema>;
type UniverseArchiveManifest = z.infer<typeof universeManifestSchema>;

export interface CurrentUniverseDiscoveryTransport {
  readonly head: (uri: string) => Promise<ObjectHead>;
  readonly get: (uri: string) => Promise<Buffer>;
  readonly listChildren: BoundedPrefixDiscovery["listChildren"];
}

export interface CurrentUniverseDiscoveryInput {
  readonly universeManifestUri: string;
  readonly archiveRootUri: string;
  readonly startYear: number;
  readonly endYear: number;
  readonly feed?: "sip" | "boats";
  readonly session?: "regular" | "extended" | "all";
  readonly concurrency?: number;
  readonly symbolResolution?: SymbolResolutionReceiptInput;
}

export interface CurrentUniverseArchiveQuery {
  readonly snapshotSymbol: string;
  readonly sourceSymbol: string;
  readonly providerSymbol: string;
  readonly year: number;
  readonly prefixUri: string;
  readonly delimiter: "/";
  readonly pages: number;
  readonly prefixes: readonly string[];
  readonly objects: readonly BoundedPrefixObject[];
  readonly requestIdPresent: boolean;
}

export interface CurrentUniverseResolvedShard {
  readonly snapshotSymbol: string;
  readonly sourceSymbol: string;
  readonly providerSymbol: string;
  readonly adjustmentMode: "raw" | "split-adjusted" | "total-return-adjusted";
  readonly year: number;
  readonly revision: number;
  readonly archiveManifest: {
    readonly uri: string;
    readonly sha256: string;
    readonly requestIdPresent: boolean;
  };
  readonly query: CurrentUniverseArchiveQuery;
  readonly shard: CatalogShard;
}

export interface CurrentUniverseUnresolvedShard {
  readonly snapshotSymbol: string;
  readonly sourceSymbol: string;
  readonly providerSymbol: string;
  readonly year: number;
  readonly code: string;
  readonly revisions: readonly number[];
  readonly query: CurrentUniverseArchiveQuery;
}

export interface CurrentUniverseExcludedSymbol {
  readonly sourceSymbol: string;
  readonly reason: string;
  readonly evidence: { readonly uri: string; readonly sha256: string };
  readonly years: { readonly start: number; readonly end: number };
}

export interface CurrentUniverseDiscoveryResult {
  readonly schemaVersion: 1;
  readonly kind: "backtest-current-universe-discovery";
  readonly status: "PASS" | "UNVERIFIED";
  readonly evidenceClass: "OSS_READ_ONLY_UNIVERSE_ADMISSION";
  readonly readOnly: true;
  readonly brokerWriteAttempted: false;
  readonly warnings: readonly string[];
  readonly universe: {
    readonly id: string;
    readonly snapshotId: string;
    readonly snapshotDate: string;
    readonly semantics: string;
    readonly survivorshipBias: boolean;
    readonly symbols: readonly string[];
    readonly fingerprint: string;
    readonly manifest: { readonly uri: string; readonly sha256: string; readonly requestIdPresent: boolean };
    readonly snapshot: { readonly uri: string; readonly sha256: string; readonly requestIdPresent: boolean };
  };
  readonly symbolResolution?: SymbolResolutionPlan;
  readonly archive: {
    readonly rootUri: string;
    readonly startYear: number;
    readonly endYear: number;
    readonly feed: "sip" | "boats";
  readonly session: "regular" | "extended" | "all";
    readonly adjustmentMode: "raw" | "split-adjusted" | "total-return-adjusted" | "unknown";
    readonly expectedShardCount: number;
    readonly excludedShardCount: number;
    readonly resolvedShardCount: number;
    readonly unresolved: readonly CurrentUniverseUnresolvedShard[];
    readonly excluded: readonly CurrentUniverseExcludedSymbol[];
    readonly resolved: readonly CurrentUniverseResolvedShard[];
    readonly queries: readonly CurrentUniverseArchiveQuery[];
  };
  readonly catalog?: MinuteBarsCatalog;
}

export interface CurrentUniverseActionsInput {
  readonly uri: string;
  readonly sha256: string;
  readonly provider: "alpaca" | "yfinance";
}

function safeObjectKey(value: string, code: string): string {
  const key = value.replace(/^\/+/, "").replace(/\/+$/, "");
  if (
    !key
    || key.includes("..")
    || key.includes("//")
    || /[?*]/.test(key)
    || /(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(key)
  ) {
    throw new Error(code);
  }
  return key;
}

function objectUri(bucket: string, key: string): string {
  const trailingSlash = key.endsWith("/");
  const safeKey = safeObjectKey(key, "BACKTEST_UNIVERSE_OBJECT_KEY_INVALID");
  return `oss://${bucket}/${safeKey}${trailingSlash ? "/" : ""}`;
}

function parseJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(code);
  }
}

function parseUniverseManifest(bytes: Buffer): UniverseArchiveManifest {
  const result = universeManifestSchema.safeParse(parseJson(bytes, "BACKTEST_UNIVERSE_MANIFEST_JSON_INVALID"));
  if (!result.success) throw new Error("BACKTEST_UNIVERSE_MANIFEST_SCHEMA_INVALID");
  safeObjectKey(result.data.snapshot_object.key, "BACKTEST_UNIVERSE_SNAPSHOT_KEY_INVALID");
  safeObjectKey(result.data.constituents_object.key, "BACKTEST_UNIVERSE_CONSTITUENTS_KEY_INVALID");
  return result.data;
}

function parseSnapshot(bytes: Buffer): UniverseSnapshot {
  const result = snapshotSchema.safeParse(parseJson(bytes, "BACKTEST_UNIVERSE_SNAPSHOT_JSON_INVALID"));
  if (!result.success) throw new Error("BACKTEST_UNIVERSE_SNAPSHOT_SCHEMA_INVALID");
  return result.data;
}

function sameSymbols(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertYear(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1900 || value > 9999) {
    throw new Error("BACKTEST_UNIVERSE_" + label.toUpperCase() + "_INVALID");
  }
}

function boundedConcurrency(value: number | undefined): number {
  const concurrency = value ?? 8;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("BACKTEST_UNIVERSE_CONCURRENCY_INVALID");
  }
  return concurrency;
}

function actualLogicalObjectKey(actualManifestKey: string, logicalObjectKey: string): string {
  const actualDirectory = posix.dirname(actualManifestKey);
  const logicalDirectory = posix.dirname(logicalObjectKey);
  if (actualDirectory === "." || logicalDirectory === "." || !actualDirectory.endsWith(logicalDirectory)) {
    throw new Error("BACKTEST_UNIVERSE_STORAGE_PREFIX_UNRESOLVED");
  }
  const storagePrefix = actualDirectory.slice(0, actualDirectory.length - logicalDirectory.length);
  return storagePrefix + logicalObjectKey;
}

function rootKey(uri: string, expectedBucket: string): string {
  const parsed = parseExactOssUri(uri);
  if (parsed.bucket !== expectedBucket) throw new Error("BACKTEST_OSS_BUCKET_MISMATCH");
  return safeObjectKey(parsed.key, "BACKTEST_UNIVERSE_ARCHIVE_ROOT_INVALID");
}

function exactRevision(prefix: string, value: string): number | undefined {
  const match = new RegExp(`^${escapeRegExp(prefix)}revision=(\\d+)/$`).exec(value);
  if (!match) return undefined;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codeOf(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const code = error.message.split(":", 1)[0];
  return /^BACKTEST_[A-Z0-9_]+$/.test(code) ? code : fallback;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      result[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return result;
}

function liveTransport(
  env: NodeJS.ProcessEnv | undefined,
  options: { readonly allowNetwork: boolean; readonly allowListDiscovery: boolean },
): CurrentUniverseDiscoveryTransport {
  const configuration = readOssConfiguration(env);
  if (!configuration.configured || !configuration.config) throw new Error("BACKTEST_OSS_CONFIG_MISSING");
  const reader = createReadOnlyOssStore(configuration.config);
  const discovery = createBoundedPrefixDiscovery(configuration.config, undefined, options);
  return {
    head: (uri) => reader.head(uri),
    get: (uri) => reader.get(uri),
    listChildren: (uri) => discovery.listChildren(uri),
  };
}

interface BootstrapUniverse {
  readonly bucket: string;
  readonly manifest: UniverseArchiveManifest;
  readonly snapshot: UniverseSnapshot;
  readonly manifestUri: string;
  readonly manifestSha256: string;
  readonly manifestRequestIdPresent: boolean;
  readonly snapshotUri: string;
  readonly snapshotSha256: string;
  readonly snapshotRequestIdPresent: boolean;
}

async function bootstrapUniverse(
  universeManifestUri: string,
  transport: CurrentUniverseDiscoveryTransport,
): Promise<BootstrapUniverse> {
  const location = parseExactOssUri(universeManifestUri);
  const manifestHead = await transport.head(universeManifestUri);
  const manifestBytes = await transport.get(universeManifestUri);
  const manifest = parseUniverseManifest(manifestBytes);
  const snapshotKey = actualLogicalObjectKey(location.key, manifest.snapshot_object.key);
  const snapshotUri = objectUri(location.bucket, snapshotKey);
  const snapshotHead = await transport.head(snapshotUri);
  const snapshotBytes = await transport.get(snapshotUri);
  if (snapshotBytes.byteLength !== manifest.snapshot_object.byte_count) {
    throw new Error("BACKTEST_UNIVERSE_SNAPSHOT_BYTE_COUNT_MISMATCH");
  }
  const snapshotSha256 = sha256Hex(snapshotBytes);
  if (snapshotSha256 !== manifest.snapshot_object.sha256) {
    throw new Error("BACKTEST_UNIVERSE_SNAPSHOT_SHA256_MISMATCH");
  }
  const snapshot = parseSnapshot(snapshotBytes);
  if (
    snapshot.id !== manifest.snapshot.id
    || snapshot.universe !== manifest.snapshot.universe
    || snapshot.snapshot_date !== manifest.snapshot.snapshot_date
    || snapshot.semantics !== manifest.snapshot.semantics
    || snapshot.survivorship_bias !== manifest.snapshot.survivorship_bias
    || !sameSymbols(snapshot.symbols, manifest.snapshot.symbols)
  ) {
    throw new Error("BACKTEST_UNIVERSE_SNAPSHOT_MANIFEST_MISMATCH");
  }
  return {
    bucket: location.bucket,
    manifest,
    snapshot,
    manifestUri: universeManifestUri,
    manifestSha256: sha256Hex(manifestBytes),
    manifestRequestIdPresent: Boolean(manifestHead.requestId),
    snapshotUri,
    snapshotSha256,
    snapshotRequestIdPresent: Boolean(snapshotHead.requestId),
  };
}

type ArchiveProbe = { readonly sourceSymbol: string; readonly providerSymbol: string; readonly year: number };
type ArchiveProbeResult = CurrentUniverseResolvedShard | CurrentUniverseUnresolvedShard;

function isResolved(result: ArchiveProbeResult): result is CurrentUniverseResolvedShard {
  return "shard" in result;
}

async function resolveArchiveProbe(
  probe: ArchiveProbe,
  input: { bucket: string; archiveRootKey: string; feed: "sip" | "boats"; session: "regular" | "extended" | "all" },
  transport: CurrentUniverseDiscoveryTransport,
): Promise<ArchiveProbeResult> {
  const prefixKey = `${input.archiveRootKey}/symbol=${probe.providerSymbol}/year=${probe.year}/`;
  const prefixUri = objectUri(input.bucket, prefixKey);
  const emptyQuery = (overrides: Partial<CurrentUniverseArchiveQuery> = {}): CurrentUniverseArchiveQuery => ({
    snapshotSymbol: probe.sourceSymbol,
    sourceSymbol: probe.sourceSymbol,
    providerSymbol: probe.providerSymbol,
    year: probe.year,
    prefixUri,
    delimiter: "/",
    pages: 0,
    prefixes: [],
    objects: [],
    requestIdPresent: false,
    ...overrides,
  });
  let listed: {
    readonly prefixes: readonly string[];
    readonly objects: readonly BoundedPrefixObject[];
    readonly pages: number;
    readonly requestId?: string;
  };
  try {
    listed = await transport.listChildren(prefixUri);
  } catch (error) {
    return {
      snapshotSymbol: probe.sourceSymbol,
      sourceSymbol: probe.sourceSymbol,
      providerSymbol: probe.providerSymbol,
      year: probe.year,
      code: codeOf(error, "BACKTEST_UNIVERSE_ARCHIVE_DISCOVERY_FAILED"),
      revisions: [],
      query: emptyQuery(),
    };
  }
  const query: CurrentUniverseArchiveQuery = {
    snapshotSymbol: probe.sourceSymbol,
    sourceSymbol: probe.sourceSymbol,
    providerSymbol: probe.providerSymbol,
    year: probe.year,
    prefixUri,
    delimiter: "/",
    pages: listed.pages,
    prefixes: listed.prefixes,
    objects: listed.objects,
    requestIdPresent: Boolean(listed.requestId),
  };
  const unexpectedPrefixes = listed.prefixes.filter((value) => exactRevision(prefixKey, value) === undefined);
  if (unexpectedPrefixes.length > 0 || listed.objects.length > 0) {
    return {
      snapshotSymbol: probe.sourceSymbol,
      sourceSymbol: probe.sourceSymbol,
      providerSymbol: probe.providerSymbol,
      year: probe.year,
      code: "BACKTEST_UNIVERSE_ARCHIVE_ALIAS_OR_UNEXPECTED_OBJECT",
      revisions: [],
      query,
    };
  }
  const revisions = listed.prefixes
    .map((value) => exactRevision(prefixKey, value))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  if (revisions.length !== 1) {
    return {
      snapshotSymbol: probe.sourceSymbol,
      sourceSymbol: probe.sourceSymbol,
      providerSymbol: probe.providerSymbol,
      year: probe.year,
      code: revisions.length === 0
        ? "BACKTEST_UNIVERSE_ARCHIVE_REVISION_NOT_FOUND"
        : "BACKTEST_UNIVERSE_ARCHIVE_REVISION_AMBIGUOUS",
      revisions,
      query,
    };
  }
  const revision = revisions[0];
  const archiveManifestUri = objectUri(input.bucket, `${prefixKey}revision=${revision}/manifest.json`);
  try {
    const head = await transport.head(archiveManifestUri);
    const bytes = await transport.get(archiveManifestUri);
    const archiveManifestSha256 = sha256Hex(bytes);
    const imported = buildArchiveBacktestManifest({
      archiveManifestUri,
      archiveManifestBytes: bytes,
      archiveManifestSha256,
      feed: input.feed,
      session: input.session,
    });
    if (imported.archive.symbol !== probe.providerSymbol || imported.archive.year !== probe.year) {
      throw new Error("BACKTEST_UNIVERSE_ARCHIVE_IDENTITY_MISMATCH");
    }
    const source = imported.manifest.sourceObject;
    if (source.kind !== "object" || source.schema === "minute-bars-catalog-v1" || source.format === "json") {
      throw new Error("BACKTEST_UNIVERSE_ARCHIVE_SOURCE_INVALID");
    }
    const shard: CatalogShard = {
      uri: source.uri,
      sha256: source.sha256,
      schema: source.schema,
      format: source.format,
      compression: source.compression,
      feed: source.feed,
      startDate: `${probe.year}-01-01`,
      endDate: `${probe.year}-12-31`,
      symbols: [probe.providerSymbol],
      sourceSymbol: probe.sourceSymbol,
      providerSymbol: probe.providerSymbol,
    };
    return {
      snapshotSymbol: probe.sourceSymbol,
      sourceSymbol: probe.sourceSymbol,
      providerSymbol: probe.providerSymbol,
      adjustmentMode: imported.manifest.adjustmentMode as CurrentUniverseResolvedShard["adjustmentMode"],
      year: probe.year,
      revision,
      archiveManifest: {
        uri: archiveManifestUri,
        sha256: archiveManifestSha256,
        requestIdPresent: Boolean(head.requestId),
      },
      query,
      shard,
    };
  } catch (error) {
    return {
      snapshotSymbol: probe.sourceSymbol,
      sourceSymbol: probe.sourceSymbol,
      providerSymbol: probe.providerSymbol,
      year: probe.year,
      code: codeOf(error, "BACKTEST_UNIVERSE_ARCHIVE_MANIFEST_READ_FAILED"),
      revisions,
      query,
    };
  }
}

function datasetId(universe: string, startYear: number, endYear: number, snapshotId: string): string {
  const normalized = universe.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `alpaca-current-${normalized}-${startYear}-${endYear}-${snapshotId.slice(0, 12)}`;
}

export async function discoverCurrentUniverse(
  input: CurrentUniverseDiscoveryInput,
  options: {
    readonly allowNetwork?: boolean;
    readonly allowListDiscovery?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly transport?: CurrentUniverseDiscoveryTransport;
  } = {},
): Promise<CurrentUniverseDiscoveryResult> {
  if (!options.allowNetwork) throw new Error("BACKTEST_NETWORK_DISABLED");
  if (!options.allowListDiscovery) throw new Error("BACKTEST_LIST_DISCOVERY_REQUIRES_ALLOW_LIST_DISCOVERY");
  assertYear(input.startYear, "start_year");
  assertYear(input.endYear, "end_year");
  if (input.endYear < input.startYear) throw new Error("BACKTEST_UNIVERSE_YEAR_RANGE_INVALID");
  const transport = options.transport ?? liveTransport(options.env, {
    allowNetwork: true,
    allowListDiscovery: true,
  });
  const bootstrap = await bootstrapUniverse(input.universeManifestUri, transport);
  const archiveRootKey = rootKey(input.archiveRootUri, bootstrap.bucket);
  const feed = input.feed ?? "sip";
  const session = input.session ?? "regular";
  const symbols = [...new Set(bootstrap.snapshot.symbols)].sort(compareCodeUnits);
  if (symbols.length !== bootstrap.snapshot.symbols.length) throw new Error("BACKTEST_UNIVERSE_SNAPSHOT_SYMBOL_DUPLICATE");
  const identity = identitySymbolResolution(
    { id: bootstrap.snapshot.id, sha256: bootstrap.snapshotSha256 },
    symbols,
  );
  const resolution = input.symbolResolution
    ? bindSymbolResolution(
      input.symbolResolution,
      { id: bootstrap.snapshot.id, sha256: bootstrap.snapshotSha256 },
      symbols,
    )
    : identity;
  const excludedSymbols = new Set(resolution.exclusions.map((item) => item.sourceSymbol));
  const activeSymbols = symbols.filter((sourceSymbol) => !excludedSymbols.has(sourceSymbol));
  const probes = activeSymbols.flatMap((sourceSymbol) =>
    Array.from({ length: input.endYear - input.startYear + 1 }, (_, offset) => ({
      sourceSymbol,
      providerSymbol: providerSymbolForSource(resolution, sourceSymbol),
      year: input.startYear + offset,
    })),
  );
  const probesResult = await mapConcurrent(
    probes,
    boundedConcurrency(input.concurrency),
    (probe) => resolveArchiveProbe(probe, {
      bucket: bootstrap.bucket,
      archiveRootKey,
      feed,
      session,
    }, transport),
  );
  const resolved = probesResult.filter(isResolved).sort((left, right) =>
    compareCodeUnits(left.sourceSymbol, right.sourceSymbol) || left.year - right.year);
  const unresolved = probesResult.filter((result): result is CurrentUniverseUnresolvedShard => !isResolved(result)).sort((left, right) =>
    compareCodeUnits(left.sourceSymbol, right.sourceSymbol) || left.year - right.year);
  const queries = probesResult.map((result) => result.query).sort((left, right) =>
    compareCodeUnits(left.sourceSymbol, right.sourceSymbol) || left.year - right.year);
  const fingerprint = digestJson({
    universeManifestSha256: bootstrap.manifestSha256,
    snapshotSha256: bootstrap.snapshotSha256,
    snapshotId: bootstrap.snapshot.id,
    symbols,
  });
  const adjustmentModes = [...new Set(resolved.map((item) => item.adjustmentMode))];
  const adjustmentMode: CurrentUniverseDiscoveryResult["archive"]["adjustmentMode"] = adjustmentModes.length === 1
    ? adjustmentModes[0]
    : "unknown";
  const warnings = [
    "EXPLICIT_BOUNDED_PREFIX_DISCOVERY_FROZEN_BEFORE_RUNTIME_READS",
    "RUNTIME_CATALOG_READS_EXACT_OBJECTS_ONLY",
  ];
  if (input.symbolResolution) warnings.push("SYMBOL_RESOLUTION_RECEIPT_HASH_BOUND_TO_UNIVERSE_SNAPSHOT");
  if (resolution.exclusions.length > 0) warnings.push("EXPLICIT_SYMBOL_EXCLUSIONS_REMAIN_IN_UNIVERSE_AUDIT_IDENTITY");
  if (bootstrap.snapshot.survivorship_bias) warnings.push("CURRENT_UNIVERSE_HAS_DECLARED_SURVIVORSHIP_BIAS");
  if (unresolved.length > 0) warnings.push("CURRENT_UNIVERSE_CATALOG_NOT_ADMISSIBLE_UNTIL_ALL_SHARDS_RESOLVE");
  if (adjustmentModes.length > 1) warnings.push("CURRENT_UNIVERSE_MIXED_ADJUSTMENT_DECLARATIONS_UNVERIFIED");
  if (unresolved.some((item) => item.code === "BACKTEST_UNIVERSE_ARCHIVE_ALIAS_OR_UNEXPECTED_OBJECT")) {
    warnings.push("CURRENT_UNIVERSE_ARCHIVE_ALIAS_OR_UNEXPECTED_OBJECT_UNVERIFIED");
  }
  const excluded = resolution.exclusions.map((item) => ({
    sourceSymbol: item.sourceSymbol,
    reason: item.reason,
    evidence: item.evidence,
    years: { start: input.startYear, end: input.endYear },
  }));
  const admissible = unresolved.length === 0 && resolved.length > 0 && adjustmentMode !== "unknown";
  if (resolved.length === 0) warnings.push("CURRENT_UNIVERSE_NO_ACTIVE_ARCHIVE_SHARDS");
  const catalog = admissible ? {
    schemaVersion: 1 as const,
    datasetId: datasetId(bootstrap.snapshot.universe, input.startYear, input.endYear, bootstrap.snapshot.id),
    feed: "alpaca" as const,
    timeframe: "1m" as const,
    adjustmentMode,
    shards: resolved.map((result) => result.shard),
  } satisfies MinuteBarsCatalog : undefined;
  return {
    schemaVersion: 1,
    kind: "backtest-current-universe-discovery",
    status: admissible ? "PASS" : "UNVERIFIED",
    evidenceClass: "OSS_READ_ONLY_UNIVERSE_ADMISSION",
    readOnly: true,
    brokerWriteAttempted: false,
    warnings,
    universe: {
      id: bootstrap.snapshot.universe,
      snapshotId: bootstrap.snapshot.id,
      snapshotDate: bootstrap.snapshot.snapshot_date,
      semantics: bootstrap.snapshot.semantics,
      survivorshipBias: bootstrap.snapshot.survivorship_bias,
      symbols,
      fingerprint,
      manifest: {
        uri: bootstrap.manifestUri,
        sha256: bootstrap.manifestSha256,
        requestIdPresent: bootstrap.manifestRequestIdPresent,
      },
      snapshot: {
        uri: bootstrap.snapshotUri,
        sha256: bootstrap.snapshotSha256,
        requestIdPresent: bootstrap.snapshotRequestIdPresent,
      },
    },
    ...(input.symbolResolution ? { symbolResolution: resolution } : {}),
    archive: {
      rootUri: input.archiveRootUri,
      startYear: input.startYear,
      endYear: input.endYear,
      feed,
      session,
      adjustmentMode,
      expectedShardCount: symbols.length * (input.endYear - input.startYear + 1),
      excludedShardCount: excluded.length * (input.endYear - input.startYear + 1),
      resolvedShardCount: resolved.length,
      unresolved,
      excluded,
      resolved,
      queries,
    },
    ...(catalog ? { catalog } : {}),
  };
}

export function buildCurrentUniverseBacktestManifest(
  discovery: CurrentUniverseDiscoveryResult,
  input: {
    readonly catalogUri: string;
    readonly catalogSha256: string;
    readonly corporateActions?: CurrentUniverseActionsInput;
    readonly discoverySha256?: string;
  },
): BacktestManifest {
  if (discovery.status !== "PASS" || !discovery.catalog) {
    throw new Error("BACKTEST_UNIVERSE_CATALOG_DISCOVERY_NOT_ADMISSIBLE");
  }
  if (!isSha256(input.catalogSha256)) throw new Error("BACKTEST_UNIVERSE_CATALOG_SHA256_INVALID");
  if (input.corporateActions && !isSha256(input.corporateActions.sha256)) throw new Error("BACKTEST_UNIVERSE_ACTIONS_SHA256_INVALID");
  if (input.discoverySha256 !== undefined && !isSha256(input.discoverySha256)) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SHA256_INVALID");
  }
  if (!/^(?:file|oss):/i.test(input.catalogUri)) throw new Error("BACKTEST_UNIVERSE_CATALOG_URI_INVALID");
  if (input.corporateActions && !/^(?:file|oss):/i.test(input.corporateActions.uri)) throw new Error("BACKTEST_UNIVERSE_ACTIONS_URI_INVALID");
  return parseManifest({
    schemaVersion: 1,
    datasetId: discovery.catalog.datasetId,
    feed: "alpaca",
    timeframe: "1m",
    session: discovery.archive.session,
    adjustmentMode: discovery.archive.adjustmentMode,
    startDate: `${discovery.archive.startYear}-01-01`,
    endDate: `${discovery.archive.endYear}-12-31`,
    sourceObject: {
      kind: "catalog",
      uri: input.catalogUri,
      sha256: input.catalogSha256,
      schema: "minute-bars-catalog-v1",
      format: "json",
      compression: "none",
    },
    universe: {
      id: `current-${discovery.universe.id}-${discovery.universe.snapshotId.slice(0, 12)}`,
      source: `frozen snapshot ${discovery.universe.snapshot.uri} sha256=${discovery.universe.snapshot.sha256}; discovery-manifest sha256=${discovery.universe.manifest.sha256}`
        + (input.discoverySha256 ? `; frozen-discovery-artifact sha256=${input.discoverySha256}` : ""),
      fingerprint: discovery.universe.fingerprint,
      completeness: "current-constituents",
      symbols: discovery.universe.symbols,
      ...(discovery.symbolResolution ? {
        symbolResolution: {
          receiptUri: discovery.symbolResolution.receiptUri,
          receiptSha256: discovery.symbolResolution.receiptSha256,
          snapshotId: discovery.symbolResolution.snapshotId,
          snapshotSha256: discovery.symbolResolution.snapshotSha256,
          mappings: discovery.symbolResolution.mappings,
          exclusions: discovery.symbolResolution.exclusions,
        },
      } : {}),
    },
    corporateActions: input.corporateActions
      ? {
        mode: "provider-receipt",
        uri: input.corporateActions.uri,
        sha256: input.corporateActions.sha256,
        appliesToBars: discovery.archive.adjustmentMode !== "raw",
        provider: input.corporateActions.provider,
      }
      : { mode: "none", appliesToBars: false },
  });
}

export { parseCurrentUniverseDiscovery } from "./universeValidation.ts";
