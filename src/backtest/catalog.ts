import { readExactObject } from "./objectStore.ts";
import { parseBarsAsync, mergeParsedBars, type ParsedBars } from "./bars.ts";
import { compareCodeUnits } from "./fingerprints.ts";
import type { BacktestManifest, SourceObject } from "./manifest.ts";
import { z } from "zod";
import { gunzipSync } from "node:zlib";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const symbol = z.string().regex(/^[A-Z][A-Z0-9._-]{0,15}$/);

const catalogShardSchema = z.object({
  uri: z.string().min(1),
  sha256: hash,
  schema: z.enum([
    "canonical-minute-bars-v1",
    "alpaca-minute-bars-v1",
    "market-data-bars-1m-v1",
    "market-data-bars-1m-v2",
  ]),
  format: z.enum(["csv", "jsonl", "parquet"]),
  compression: z.enum(["none", "gzip"]).default("none"),
  feed: z.enum(["sip", "boats"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  symbols: z.array(symbol).min(1),
});

const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.string().min(1),
  feed: z.literal("alpaca"),
  timeframe: z.literal("1m"),
  shards: z.array(catalogShardSchema).min(1),
});

export type CatalogShard = z.infer<typeof catalogShardSchema>;
export type MinuteBarsCatalog = z.infer<typeof catalogSchema>;

export interface DatasetReadResult extends ParsedBars {
  readonly sourceObjects: readonly string[];
  readonly catalogFingerprint?: string;
}

function assertExactUri(uri: string): void {
  if (/[?*]/.test(uri) || /(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(uri)) {
    throw new Error("BACKTEST_CATALOG_SHARD_URI_NOT_EXACT");
  }
}

function parseCatalog(bytes: Buffer, compression: "none" | "gzip"): MinuteBarsCatalog {
  let value: unknown;
  try {
    const decoded = compression === "gzip" ? gunzipSync(bytes) : bytes;
    value = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error("BACKTEST_CATALOG_JSON_INVALID");
  }
  const result = catalogSchema.safeParse(value);
  if (!result.success) throw new Error("BACKTEST_CATALOG_SCHEMA_INVALID");
  for (const shard of result.data.shards) {
    assertExactUri(shard.uri);
    if (shard.endDate < shard.startDate) throw new Error("BACKTEST_CATALOG_SHARD_DATE_RANGE_INVALID");
    if (shard.format === "parquet" && (
      !shard.schema.startsWith("market-data-bars-1m-")
      || shard.compression !== "none"
      || !shard.feed
    )) {
      throw new Error("BACKTEST_CATALOG_PARQUET_SHARD_INVALID");
    }
  }
  return result.data;
}

function sourceForShard(shard: CatalogShard): SourceObject {
  return {
    kind: "object",
    uri: shard.uri,
    sha256: shard.sha256,
    schema: shard.schema,
    format: shard.format,
    compression: shard.compression,
    feed: shard.feed,
  };
}

function validateShardBounds(parsed: ParsedBars, shard: CatalogShard): void {
  const symbols = new Set(shard.symbols);
  for (const bar of parsed.bars) {
    const date = bar.timestamp.slice(0, 10);
    if (!symbols.has(bar.symbol)) throw new Error("BACKTEST_CATALOG_BAR_SYMBOL_OUTSIDE_SHARD");
    if (date < shard.startDate || date > shard.endDate) {
      throw new Error("BACKTEST_CATALOG_BAR_OUTSIDE_SHARD_RANGE");
    }
  }
}

function assertCatalogMatchesManifest(catalog: MinuteBarsCatalog, manifest: BacktestManifest): void {
  if (catalog.datasetId !== manifest.datasetId || catalog.feed !== manifest.feed || catalog.timeframe !== manifest.timeframe) {
    throw new Error("BACKTEST_CATALOG_MANIFEST_MISMATCH");
  }
  const universe = new Set(manifest.universe.symbols);
  for (const shard of catalog.shards) {
    if (shard.startDate < manifest.startDate || shard.endDate > manifest.endDate) {
      throw new Error("BACKTEST_CATALOG_SHARD_OUTSIDE_MANIFEST_RANGE");
    }
    if (shard.symbols.some((symbol) => !universe.has(symbol))) {
      throw new Error("BACKTEST_CATALOG_SHARD_SYMBOL_OUTSIDE_UNIVERSE");
    }
  }
}

export async function readDatasetBars(
  manifestPath: string,
  manifest: BacktestManifest,
  options: {
    allowNetwork?: boolean;
    env?: NodeJS.ProcessEnv;
    requiredSymbols?: readonly string[];
    startDate?: string;
    endDate?: string;
  } = {},
): Promise<DatasetReadResult> {
  const source = manifest.sourceObject;
  const topLevel = await readExactObject(manifestPath, source, options);
  if (source.kind !== "catalog") {
    const parsed = await parseBarsAsync(topLevel.bytes, manifest);
    return { ...parsed, sourceObjects: [source.uri] };
  }
  const catalog = parseCatalog(topLevel.bytes, source.compression);
  assertCatalogMatchesManifest(catalog, manifest);
  const parts: ParsedBars[] = [];
  const sourceObjects = [source.uri];
  const requiredSymbols = options.requiredSymbols?.map((value) => value.trim().toUpperCase());
  if (requiredSymbols && requiredSymbols.length === 0) throw new Error("BACKTEST_CATALOG_REQUIRED_SYMBOLS_EMPTY");
  const startDate = options.startDate ?? manifest.startDate;
  const endDate = options.endDate ?? manifest.endDate;
  if (startDate > endDate) throw new Error("BACKTEST_CATALOG_DATE_RANGE_INVALID");
  const orderedShards = catalog.shards.slice().sort((left, right) => compareCodeUnits(left.uri, right.uri));
  const selectedShards = orderedShards.filter((shard) => {
    const dateOverlaps = shard.endDate >= startDate && shard.startDate <= endDate;
    const symbolOverlaps = !requiredSymbols || requiredSymbols.some((symbol) => shard.symbols.includes(symbol));
    return dateOverlaps && symbolOverlaps;
  });
  if (selectedShards.length === 0) throw new Error("BACKTEST_CATALOG_NO_MATCHING_SHARDS");
  for (const shard of selectedShards) {
    const shardSource = sourceForShard(shard);
    const shardObject = await readExactObject(manifestPath, shardSource, options);
    const parsed = await parseBarsAsync(shardObject.bytes, { ...manifest, sourceObject: shardSource });
    validateShardBounds(parsed, shard);
    parts.push(parsed);
    sourceObjects.push(shard.uri);
  }
  const merged = mergeParsedBars(parts, manifest);
  return {
    ...merged,
    sourceObjects,
    catalogFingerprint: topLevel.sha256,
  };
}
