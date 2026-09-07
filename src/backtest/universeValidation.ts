import { compareCodeUnits, digestJson, isSha256 } from "./fingerprints.ts";
import { parseExactOssUri } from "./objectStore.ts";
import type { CatalogShard, MinuteBarsCatalog } from "./catalog.ts";
import type { CurrentUniverseDiscoveryResult } from "./universe.ts";

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
  const symbols = universe.symbols as unknown[];
  if (symbols.some((item) => typeof item !== "string" || !SYMBOL_RE.test(item))) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SYMBOL_INVALID");
  }
  const symbolList = symbols as string[];
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
  const startYear = requireInteger(archive.startYear, "BACKTEST_UNIVERSE_DISCOVERY_START_YEAR_INVALID");
  const endYear = requireInteger(archive.endYear, "BACKTEST_UNIVERSE_DISCOVERY_END_YEAR_INVALID");
  const expectedShardCount = requireInteger(archive.expectedShardCount, "BACKTEST_UNIVERSE_DISCOVERY_EXPECTED_COUNT_INVALID");
  const resolvedShardCount = requireInteger(archive.resolvedShardCount, "BACKTEST_UNIVERSE_DISCOVERY_RESOLVED_COUNT_INVALID");
  const archiveUri = requireString(archive.rootUri, "BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_ROOT_INVALID");
  if (endYear < startYear || !["sip", "boats"].includes(String(archive.feed))
    || !["regular", "extended", "all"].includes(String(archive.session))
    || !Array.isArray(archive.unresolved) || !Array.isArray(archive.resolved) || !Array.isArray(archive.queries)) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_INVALID");
  }
  const archiveLocation = parseExactOssUri(archiveUri);
  if (archiveLocation.bucket !== manifestLocation.bucket) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_BUCKET_MISMATCH");
  const expected = symbolList.length * (endYear - startYear + 1);
  if (expectedShardCount !== expected || archive.queries.length !== expected
    || resolvedShardCount !== archive.resolved.length
    || archive.resolved.length + archive.unresolved.length !== expected) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SHARD_COVERAGE_INVALID");
  }
  if (value.status === "PASS" && (archive.unresolved.length !== 0 || !value.catalog)) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_PASS_INVALID");
  }
  if (value.status === "UNVERIFIED" && value.catalog !== undefined) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_UNVERIFIED_CATALOG_PRESENT");
  }
  const catalog = value.catalog === undefined ? undefined : validateCatalog(value.catalog);
  if (digestJson({ universeManifestSha256: manifestHash, snapshotSha256: snapshotHash, snapshotId, symbols: symbolList }) !== fingerprint) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_FINGERPRINT_MISMATCH");
  }
  const prefixFor = (item: string, year: number): string => `${archiveLocation.key.replace(/\/+$/, "")}/symbol=${item}/year=${year}/`;
  const validateQuery = (raw: unknown, item: string, year: number): void => {
    if (!isRecord(raw) || raw.snapshotSymbol !== item || raw.year !== year
      || raw.prefixUri !== `oss://${archiveLocation.bucket}/${prefixFor(item, year)}`
      || raw.delimiter !== "/" || typeof raw.pages !== "number" || !Number.isInteger(raw.pages) || raw.pages < 0
      || !Array.isArray(raw.prefixes) || raw.prefixes.some((entry) => typeof entry !== "string" || !entry.startsWith(prefixFor(item, year)))
      || !Array.isArray(raw.objects) || raw.objects.some((entry) => !isRecord(entry) || typeof entry.name !== "string" || !entry.name.startsWith(prefixFor(item, year)))
      || typeof raw.requestIdPresent !== "boolean") {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_QUERY_INVALID");
    }
  };
  const queryKeys = new Set<string>();
  for (const raw of archive.queries) {
    if (!isRecord(raw) || typeof raw.snapshotSymbol !== "string" || typeof raw.year !== "number"
      || !symbolList.includes(raw.snapshotSymbol) || !Number.isInteger(raw.year) || raw.year < startYear || raw.year > endYear) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_QUERY_INVALID");
    }
    validateQuery(raw, raw.snapshotSymbol, raw.year);
    const key = `${raw.snapshotSymbol}|${raw.year}`;
    if (queryKeys.has(key)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_QUERY_DUPLICATE");
    queryKeys.add(key);
  }
  const resolvedKeys = new Set<string>();
  for (const raw of archive.resolved) {
    if (!isRecord(raw) || typeof raw.snapshotSymbol !== "string" || typeof raw.year !== "number"
      || !symbolList.includes(raw.snapshotSymbol) || !Number.isInteger(raw.year) || raw.year < startYear || raw.year > endYear
      || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision <= 0
      || !isRecord(raw.query) || !isRecord(raw.archiveManifest)) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_RESOLVED_INVALID");
    }
    const key = `${raw.snapshotSymbol}|${raw.year}`;
    if (!queryKeys.has(key) || resolvedKeys.has(key)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_IDENTITY_INVALID");
    validateQuery(raw.query, raw.snapshotSymbol, raw.year);
    const archiveManifestUri = requireString(raw.archiveManifest.uri, "BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_MANIFEST_URI_INVALID");
    const archiveManifestLocation = parseExactOssUri(archiveManifestUri);
    if (archiveManifestLocation.bucket !== archiveLocation.bucket
      || archiveManifestLocation.key !== `${prefixFor(raw.snapshotSymbol, raw.year)}revision=${raw.revision}/manifest.json`) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_MANIFEST_IDENTITY_INVALID");
    }
    requireHash(raw.archiveManifest.sha256, "BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_MANIFEST_HASH_INVALID");
    if (typeof raw.archiveManifest.requestIdPresent !== "boolean") throw new Error("BACKTEST_UNIVERSE_DISCOVERY_ARCHIVE_MANIFEST_INVALID");
    const shard = validateCatalogShard(raw.shard);
    if (shard.startDate !== `${raw.year}-01-01` || shard.endDate !== `${raw.year}-12-31`
      || shard.symbols.length !== 1 || shard.symbols[0] !== raw.snapshotSymbol) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SHARD_IDENTITY_INVALID");
    }
    resolvedKeys.add(key);
  }
  const unresolvedKeys = new Set<string>();
  for (const raw of archive.unresolved) {
    if (!isRecord(raw) || typeof raw.snapshotSymbol !== "string" || typeof raw.year !== "number"
      || !symbolList.includes(raw.snapshotSymbol) || !Number.isInteger(raw.year) || raw.year < startYear || raw.year > endYear
      || typeof raw.code !== "string" || !Array.isArray(raw.revisions) || raw.revisions.some((revision) => (
        typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0
      )) || !isRecord(raw.query)) {
      throw new Error("BACKTEST_UNIVERSE_DISCOVERY_UNRESOLVED_INVALID");
    }
    const key = `${raw.snapshotSymbol}|${raw.year}`;
    if (!queryKeys.has(key) || resolvedKeys.has(key) || unresolvedKeys.has(key)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_IDENTITY_INVALID");
    validateQuery(raw.query, raw.snapshotSymbol, raw.year);
    unresolvedKeys.add(key);
  }
  if (resolvedKeys.size + unresolvedKeys.size !== expected) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_IDENTITY_COVERAGE_INVALID");
  if (value.status === "PASS") {
    if (!catalog || catalog.shards.length !== expected) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_PASS_CATALOG_COVERAGE_INVALID");
    const catalogByUri = new Map(catalog.shards.map((shard) => [shard.uri, shard]));
    for (const raw of archive.resolved) {
      const shard = validateCatalogShard(raw.shard);
      const catalogShard = catalogByUri.get(shard.uri);
      if (!catalogShard || catalogShard.sha256 !== shard.sha256 || catalogShard.startDate !== shard.startDate
        || catalogShard.endDate !== shard.endDate || catalogShard.symbols.join(",") !== shard.symbols.join(",")) {
        throw new Error("BACKTEST_UNIVERSE_DISCOVERY_PASS_CATALOG_SHARD_MISMATCH");
      }
    }
  }
  return value as unknown as CurrentUniverseDiscoveryResult;
}
