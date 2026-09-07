import { compareCodeUnits, digestJson, isSha256 } from "./fingerprints.ts";
import { parseExactOssUri } from "./objectStore.ts";
import type { CatalogShard, MinuteBarsCatalog } from "./catalog.ts";
import {
  parseSymbolResolutionManifest,
  providerSymbolForSource,
  type SymbolResolutionManifest,
} from "./symbolResolution.ts";
import type {
  CurrentUniverseArchiveQuery,
  CurrentUniverseDiscoveryResult,
  CurrentUniverseExcludedSymbol,
  CurrentUniverseResolvedShard,
  CurrentUniverseUnresolvedShard,
} from "./universe.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL_RE = /^[A-Z][A-Z0-9._-]{0,15}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !HASH_RE.test(value) || !isSha256(value)) throw new Error(code);
  return value;
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function requireInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(code);
  return value;
}

function validateCatalogShard(value: unknown): CatalogShard {
  if (!isRecord(value)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_CATALOG_SHARD_INVALID");
  const uri = requireString(value.uri, "BACKTEST_UNIVERSE_DISCOVERY_CATALOG_SHARD_URI_INVALID");
  requireHash(value.sha256, "BACKTEST_UNIVERSE_DISCOVERY_CATALOG_SHARD_HASH_INVALID");
  if (!/^oss:/i.test(uri) || /[?*]/.test(uri) || /(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(uri)) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_CATALOG_SHARD_URI_INVALID");
  }
  try {
    parseExactOssUri(uri);
  } catch {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_CATALOG_SHARD_URI_INVALID");
  }
  if (
    !["canonical-minute-bars-v1", "alpaca-minute-bars-v1", "market-data-bars-1m-v1", "market-data-bars-1m-v2"].includes(String(value.schema))
    || !["csv", "jsonl", "parquet"].includes(String(value.format))
    || !["none", "gzip"].includes(String(value.compression))
    || (value.feed !== undefined && !["sip", "boats"].includes(String(value.feed)))
    || typeof value.startDate !== "string" || !DATE_RE.test(value.startDate)
    || typeof value.endDate !== "string" || !DATE_RE.test(value.endDate)
    || value.endDate < value.startDate
    || !Array.isArray(value.symbols) || value.symbols.length === 0
    || value.symbols.some((item) => typeof item !== "string" || !SYMBOL_RE.test(item))
    || (value.sourceSymbol !== undefined && (typeof value.sourceSymbol !== "string" || !SYMBOL_RE.test(value.sourceSymbol)))
    || (value.providerSymbol !== undefined && (typeof value.providerSymbol !== "string" || !SYMBOL_RE.test(value.providerSymbol)))
    || (value.sourceSymbol === undefined) !== (value.providerSymbol === undefined)
  ) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_CATALOG_SHARD_INVALID");
  }
  return value as unknown as CatalogShard;
}

function validateCatalog(value: unknown): MinuteBarsCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.feed !== "alpaca" || value.timeframe !== "1m") {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_CATALOG_INVALID");
  }
  if (typeof value.datasetId !== "string" || !Array.isArray(value.shards) || value.shards.length === 0) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_CATALOG_INVALID");
  }
  const seen = new Set<string>();
  for (const shard of value.shards) {
    const parsedShard = validateCatalogShard(shard);
    if (seen.has(parsedShard.uri)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_CATALOG_SHARD_DUPLICATE");
    seen.add(parsedShard.uri);
  }
  return value as unknown as MinuteBarsCatalog;
}

function exactProvider(resolution: SymbolResolutionManifest | undefined, sourceSymbol: string): string {
  try {
    return providerSymbolForSource(resolution, sourceSymbol);
  } catch {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SYMBOL_RESOLUTION_INVALID");
  }
}

function normalizedRelation(raw: Record<string, unknown>): { sourceSymbol: string; providerSymbol: string } {
  const sourceSymbol = typeof raw.sourceSymbol === "string" ? raw.sourceSymbol : String(raw.snapshotSymbol ?? "");
  const providerSymbol = typeof raw.providerSymbol === "string" ? raw.providerSymbol : sourceSymbol;
  if (!SYMBOL_RE.test(sourceSymbol) || !SYMBOL_RE.test(providerSymbol)) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SYMBOL_RESOLUTION_INVALID");
  }
  return { sourceSymbol, providerSymbol };
}

function validateQuery(
  raw: unknown,
  sourceSymbol: string,
  providerSymbol: string,
  year: number,
  archiveBucket: string,
  archiveRootKey: string,
): CurrentUniverseArchiveQuery {
  if (!isRecord(raw)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_QUERY_INVALID");
  const prefixKey = `${archiveRootKey.replace(/\/+$/, "")}/symbol=${providerSymbol}/year=${year}/`;
  if (
    raw.snapshotSymbol !== sourceSymbol
    || (raw.sourceSymbol !== undefined && raw.sourceSymbol !== sourceSymbol)
    || (raw.providerSymbol !== undefined && raw.providerSymbol !== providerSymbol)
    || raw.year !== year
    || raw.prefixUri !== `oss://${archiveBucket}/${prefixKey}`
    || raw.delimiter !== "/"
    || typeof raw.pages !== "number" || !Number.isInteger(raw.pages) || raw.pages < 0
    || !Array.isArray(raw.prefixes) || raw.prefixes.some((entry) => typeof entry !== "string" || !entry.startsWith(prefixKey))
    || !Array.isArray(raw.objects) || raw.objects.some((entry) => !isRecord(entry) || typeof entry.name !== "string" || !entry.name.startsWith(prefixKey))
    || typeof raw.requestIdPresent !== "boolean"
  ) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_QUERY_INVALID");
  }
  return {
    snapshotSymbol: sourceSymbol,
    sourceSymbol,
    providerSymbol,
    year,
    prefixUri: raw.prefixUri as string,
    delimiter: "/",
    pages: raw.pages as number,
    prefixes: raw.prefixes as string[],
    objects: raw.objects as CurrentUniverseArchiveQuery["objects"],
    requestIdPresent: raw.requestIdPresent as boolean,
  };
}

export function parseCurrentUniverseDiscovery(value: unknown): CurrentUniverseDiscoveryResult {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "backtest-current-universe-discovery"
    || (value.status !== "PASS" && value.status !== "UNVERIFIED")
    || value.evidenceClass !== "OSS_READ_ONLY_UNIVERSE_ADMISSION"
    || value.readOnly !== true
    || value.brokerWriteAttempted !== false
    || !Array.isArray(value.warnings)
    || !isRecord(value.universe)
    || !isRecord(value.archive)) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SCHEMA_INVALID");
  }
  const universe = value.universe;
  const archive = value.archive;
  requireString(universe.id, "BACKTEST_UNIVERSE_DISCOVERY_UNIVERSE_ID_INVALID");
  const snapshotId = requireHash(universe.snapshotId, "BACKTEST_UNIVERSE_DISCOVERY_SNAPSHOT_ID_INVALID");
  requireString(universe.snapshotDate, "BACKTEST_UNIVERSE_DISCOVERY_SNAPSHOT_DATE_INVALID");
  requireString(universe.semantics, "BACKTEST_UNIVERSE_DISCOVERY_SEMANTICS_INVALID");
  const fingerprint = requireHash(universe.fingerprint, "BACKTEST_UNIVERSE_DISCOVERY_FINGERPRINT_INVALID");
  if (typeof universe.survivorshipBias !== "boolean" || !Array.isArray(universe.symbols) || universe.symbols.length === 0) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_UNIVERSE_INVALID");
  }
  const symbolList = universe.symbols as unknown[] as string[];
  if (symbolList.some((item) => typeof item !== "string" || !SYMBOL_RE.test(item))) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SYMBOL_INVALID");
  }
  if (new Set(symbolList).size !== symbolList.length || symbolList.some((item, index) => index > 0 && compareCodeUnits(symbolList[index - 1], item) > 0)) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SYMBOL_ORDER_INVALID");
  }
  const references = [universe.manifest, universe.snapshot];
  if (!references.every(isRecord)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_REFERENCE_INVALID");
  const manifestReference = references[0] as Record<string, unknown>;
  const snapshotReference = references[1] as Record<string, unknown>;
  const manifestUri = requireString(manifestReference.uri, "BACKTEST_UNIVERSE_DISCOVERY_REFERENCE_URI_INVALID");
  const snapshotUri = requireString(snapshotReference.uri, "BACKTEST_UNIVERSE_DISCOVERY_REFERENCE_URI_INVALID");
  const manifestHash = requireHash(manifestReference.sha256, "BACKTEST_UNIVERSE_DISCOVERY_REFERENCE_HASH_INVALID");
  const snapshotHash = requireHash(snapshotReference.sha256, "BACKTEST_UNIVERSE_DISCOVERY_REFERENCE_HASH_INVALID");
  if (typeof manifestReference.requestIdPresent !== "boolean" || typeof snapshotReference.requestIdPresent !== "boolean") {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_REFERENCE_INVALID");
  }
  const manifestLocation = parseExactOssUri(manifestUri);
  const snapshotLocation = parseExactOssUri(snapshotUri);
  if (manifestLocation.bucket !== snapshotLocation.bucket) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_REFERENCE_BUCKET_MISMATCH");

  let resolution: SymbolResolutionManifest | undefined;
  if (value.symbolResolution !== undefined) {
    resolution = parseSymbolResolutionManifest(value.symbolResolution);
    if (resolution.snapshotId !== snapshotId || resolution.snapshotSha256 !== snapshotHash) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SYMBOL_RESOLUTION_SNAPSHOT_MISMATCH");
    }
    for (const sourceSymbol of [...resolution.mappings.map((item) => item.sourceSymbol), ...resolution.exclusions.map((item) => item.sourceSymbol)]) {
      if (!symbolList.includes(sourceSymbol)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SYMBOL_RESOLUTION_UNKNOWN_SOURCE");
    }
  }

  const startYear = requireInteger(archive.startYear, "BACKTEST_UNIVERSE_DISCOVERY_START_YEAR_INVALID");
  const endYear = requireInteger(archive.endYear, "BACKTEST_UNIVERSE_DISCOVERY_END_YEAR_INVALID");
  const expectedShardCount = requireInteger(archive.expectedShardCount, "BACKTEST_UNIVERSE_DISCOVERY_EXPECTED_COUNT_INVALID");
  const adjustmentMode = archive.adjustmentMode;
  if (!["raw", "split-adjusted", "total-return-adjusted", "unknown"].includes(String(adjustmentMode))) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_ADJUSTMENT_INVALID");
  }
  const excludedShardCount = archive.excludedShardCount === undefined
    ? 0
    : requireInteger(archive.excludedShardCount, "BACKTEST_UNIVERSE_DISCOVERY_EXCLUDED_COUNT_INVALID");
  const resolvedShardCount = requireInteger(archive.resolvedShardCount, "BACKTEST_UNIVERSE_DISCOVERY_RESOLVED_COUNT_INVALID");
  const archiveUri = requireString(archive.rootUri, "BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_ROOT_INVALID");
  if (endYear < startYear || !["sip", "boats"].includes(String(archive.feed))
    || !["regular", "extended", "all"].includes(String(archive.session))
    || !Array.isArray(archive.unresolved) || !Array.isArray(archive.resolved) || !Array.isArray(archive.queries)) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_INVALID");
  }
  const archiveLocation = parseExactOssUri(archiveUri);
  if (archiveLocation.bucket !== manifestLocation.bucket) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_BUCKET_MISMATCH");
  const years = endYear - startYear + 1;
  const expected = symbolList.length * years;
  if (expectedShardCount !== expected || excludedShardCount < 0 || excludedShardCount % years !== 0) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SHARD_COVERAGE_INVALID");
  }

  const excludedValues = archive.excluded ?? [];
  if (!Array.isArray(excludedValues)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_EXCLUDED_INVALID");
  const excluded = excludedValues.map((raw): CurrentUniverseExcludedSymbol => {
    if (!isRecord(raw) || typeof raw.sourceSymbol !== "string" || !symbolList.includes(raw.sourceSymbol)
      || !isRecord(raw.evidence) || typeof raw.reason !== "string" || !raw.reason.trim() || !isRecord(raw.years)
      || raw.years.start !== startYear || raw.years.end !== endYear) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_EXCLUDED_INVALID");
    }
    const evidence = raw.evidence;
    if (typeof evidence.uri !== "string" || typeof evidence.sha256 !== "string"
      || !resolution || !resolution.exclusions.some((item) => item.sourceSymbol === raw.sourceSymbol
      && item.reason === raw.reason && item.evidence.uri === evidence.uri && item.evidence.sha256 === evidence.sha256)) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_EXCLUDED_RECEIPT_MISMATCH");
    }
    return raw as unknown as CurrentUniverseExcludedSymbol;
  });
  const excludedSources = new Set(excluded.map((item) => item.sourceSymbol));
  if (excludedSources.size !== excluded.length || excluded.length * years !== excludedShardCount) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_EXCLUDED_COVERAGE_INVALID");
  }
  if (resolution && excludedSources.size !== resolution.exclusions.length) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_EXCLUDED_COVERAGE_INVALID");
  }
  const activeExpected = expected - excludedShardCount;
  if (archive.queries.length !== activeExpected || resolvedShardCount !== archive.resolved.length
    || archive.resolved.length + archive.unresolved.length !== activeExpected) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SHARD_COVERAGE_INVALID");
  }

  const queryByKey = new Map<string, CurrentUniverseArchiveQuery>();
  for (const raw of archive.queries) {
    if (!isRecord(raw) || typeof raw.snapshotSymbol !== "string" || !symbolList.includes(raw.snapshotSymbol)
      || typeof raw.year !== "number" || !Number.isInteger(raw.year) || raw.year < startYear || raw.year > endYear) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_QUERY_INVALID");
    }
    const relation = normalizedRelation(raw);
    if (relation.sourceSymbol !== raw.snapshotSymbol || excludedSources.has(relation.sourceSymbol)
      || exactProvider(resolution, relation.sourceSymbol) !== relation.providerSymbol) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SYMBOL_RESOLUTION_INVALID");
    }
    const query = validateQuery(raw, relation.sourceSymbol, relation.providerSymbol, raw.year, archiveLocation.bucket, archiveLocation.key);
    const key = `${relation.sourceSymbol}|${raw.year}`;
    if (queryByKey.has(key)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_QUERY_DUPLICATE");
    queryByKey.set(key, query);
  }

  const resolvedValues: CurrentUniverseResolvedShard[] = [];
  const resolvedKeys = new Set<string>();
  for (const raw of archive.resolved) {
    if (!isRecord(raw) || typeof raw.snapshotSymbol !== "string" || typeof raw.year !== "number"
      || !symbolList.includes(raw.snapshotSymbol) || !Number.isInteger(raw.year) || raw.year < startYear || raw.year > endYear
      || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision <= 0
      || !isRecord(raw.query) || !isRecord(raw.archiveManifest)) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_RESOLVED_INVALID");
    }
    const relation = normalizedRelation(raw);
    if (relation.sourceSymbol !== raw.snapshotSymbol || excludedSources.has(relation.sourceSymbol)
      || exactProvider(resolution, relation.sourceSymbol) !== relation.providerSymbol) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SYMBOL_RESOLUTION_INVALID");
    }
    const key = `${relation.sourceSymbol}|${raw.year}`;
    if (!queryByKey.has(key) || resolvedKeys.has(key)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_IDENTITY_INVALID");
    const query = validateQuery(raw.query, relation.sourceSymbol, relation.providerSymbol, raw.year, archiveLocation.bucket, archiveLocation.key);
    const archiveManifestUri = requireString(raw.archiveManifest.uri, "BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_MANIFEST_URI_INVALID");
    const archiveManifestLocation = parseExactOssUri(archiveManifestUri);
    const prefixKey = `${archiveLocation.key.replace(/\/+$/, "")}/symbol=${relation.providerSymbol}/year=${raw.year}/`;
    if (archiveManifestLocation.bucket !== archiveLocation.bucket
      || archiveManifestLocation.key !== `${prefixKey}revision=${raw.revision}/manifest.json`) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_MANIFEST_IDENTITY_INVALID");
    }
    const archiveManifestSha256 = requireHash(raw.archiveManifest.sha256, "BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_MANIFEST_HASH_INVALID");
    if (typeof raw.archiveManifest.requestIdPresent !== "boolean") throw new Error("BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_MANIFEST_INVALID");
    const shard = validateCatalogShard(raw.shard);
    if (shard.startDate !== `${raw.year}-01-01` || shard.endDate !== `${raw.year}-12-31`
      || shard.symbols.length !== 1 || shard.symbols[0] !== relation.providerSymbol
      || shard.sourceSymbol !== relation.sourceSymbol || shard.providerSymbol !== relation.providerSymbol
      || raw.adjustmentMode !== adjustmentMode) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SHARD_IDENTITY_INVALID");
    }
    resolvedKeys.add(key);
    resolvedValues.push({
      ...raw,
      snapshotSymbol: relation.sourceSymbol,
      sourceSymbol: relation.sourceSymbol,
      providerSymbol: relation.providerSymbol,
      year: raw.year,
      query,
      archiveManifest: { ...raw.archiveManifest, uri: archiveManifestUri, sha256: archiveManifestSha256 },
      shard,
    } as unknown as CurrentUniverseResolvedShard);
  }

  const unresolvedValues: CurrentUniverseUnresolvedShard[] = [];
  const unresolvedKeys = new Set<string>();
  for (const raw of archive.unresolved) {
    if (!isRecord(raw) || typeof raw.snapshotSymbol !== "string" || typeof raw.year !== "number"
      || !symbolList.includes(raw.snapshotSymbol) || !Number.isInteger(raw.year) || raw.year < startYear || raw.year > endYear
      || typeof raw.code !== "string" || !Array.isArray(raw.revisions) || raw.revisions.some((revision) => (
        typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0
      )) || !isRecord(raw.query)) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_UNRESOLVED_INVALID");
    }
    const relation = normalizedRelation(raw);
    if (relation.sourceSymbol !== raw.snapshotSymbol || excludedSources.has(relation.sourceSymbol)
      || exactProvider(resolution, relation.sourceSymbol) !== relation.providerSymbol) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SYMBOL_RESOLUTION_INVALID");
    }
    const key = `${relation.sourceSymbol}|${raw.year}`;
    if (!queryByKey.has(key) || resolvedKeys.has(key) || unresolvedKeys.has(key)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_IDENTITY_INVALID");
    const query = validateQuery(raw.query, relation.sourceSymbol, relation.providerSymbol, raw.year, archiveLocation.bucket, archiveLocation.key);
    unresolvedKeys.add(key);
    unresolvedValues.push({ ...raw, snapshotSymbol: relation.sourceSymbol, sourceSymbol: relation.sourceSymbol, providerSymbol: relation.providerSymbol, year: raw.year, query } as unknown as CurrentUniverseUnresolvedShard);
  }
  if (resolvedKeys.size + unresolvedKeys.size !== activeExpected || queryByKey.size !== activeExpected) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_IDENTITY_COVERAGE_INVALID");
  }
  if (value.status === "PASS" && (!value.catalog || activeExpected === 0 || unresolvedValues.length !== 0 || adjustmentMode === "unknown")) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_PASS_INVALID");
  }
  if (value.status === "UNVERIFIED" && value.catalog !== undefined) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_UNVERIFIED_CATALOG_PRESENT");
  }
  const catalog = value.catalog === undefined ? undefined : validateCatalog(value.catalog);
  if (digestJson({ universeManifestSha256: manifestHash, snapshotSha256: snapshotHash, snapshotId, symbols: symbolList }) !== fingerprint) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_FINGERPRINT_MISMATCH");
  }
  if (value.status === "PASS") {
    if (!catalog || catalog.shards.length !== activeExpected) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_PASS_CATALOG_COVERAGE_INVALID");
    if (catalog.adjustmentMode !== adjustmentMode) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_CATALOG_ADJUSTMENT_MISMATCH");
    const catalogByUri = new Map(catalog.shards.map((shard) => [shard.uri, shard]));
    for (const resolved of resolvedValues) {
      const catalogShard = catalogByUri.get(resolved.shard.uri);
      if (!catalogShard || catalogShard.sha256 !== resolved.shard.sha256
        || catalogShard.startDate !== resolved.shard.startDate || catalogShard.endDate !== resolved.shard.endDate
        || catalogShard.symbols.join(",") !== resolved.shard.symbols.join(",")
        || catalogShard.sourceSymbol !== resolved.sourceSymbol || catalogShard.providerSymbol !== resolved.providerSymbol) {
        throw new Error("BACKTEST_UNIVERSE_DISCOVERY_PASS_CATALOG_SHARD_MISMATCH");
      }
    }
  }
  return {
    ...value,
    ...(resolution ? { symbolResolution: resolution } : {}),
    archive: {
      ...archive,
      expectedShardCount,
      adjustmentMode,
      excludedShardCount,
      excluded,
      resolved: resolvedValues.sort((left, right) => compareCodeUnits(left.sourceSymbol, right.sourceSymbol) || left.year - right.year),
      unresolved: unresolvedValues.sort((left, right) => compareCodeUnits(left.sourceSymbol, right.sourceSymbol) || left.year - right.year),
      queries: [...queryByKey.values()].sort((left, right) => compareCodeUnits(left.sourceSymbol, right.sourceSymbol) || left.year - right.year),
      resolvedShardCount,
    },
    ...(catalog ? { catalog } : {}),
  } as unknown as CurrentUniverseDiscoveryResult;
}
