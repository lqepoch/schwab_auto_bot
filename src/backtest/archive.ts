import { z } from "zod";
import { digestJson, isSha256, sha256Hex } from "./fingerprints.ts";
import { parseManifest, type BacktestManifest } from "./manifest.ts";
import {
  createReadOnlyOssStore,
  parseExactOssUri,
  readOssConfiguration,
} from "./objectStore.ts";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const symbol = z.string().regex(/^[A-Z][A-Z0-9._-]{0,15}$/);

const archiveManifestSchema = z.object({
  schema_version: z.literal("market-data-bars-1m-manifest-v1"),
  provider: z.literal("alpaca"),
  timeframe: z.literal("1m"),
  adjustment: z.enum(["raw", "split-adjusted", "total-return-adjusted", "unknown"]),
  quality_status: z.literal("PASS"),
  data_schema_version: z.enum(["market-data-bars-1m-v1", "market-data-bars-1m-v2"]),
  symbol,
  year: z.number().int().min(1900).max(9999),
  asof: dateOnly,
  manifest_key: z.string().min(1),
  universe_snapshot_id: hash,
  universe_semantics: z.string().min(1),
  survivorship_bias: z.boolean(),
  bars: z.object({
    key: z.string().min(1),
    sha256: hash,
    byte_count: z.number().int().positive(),
  }),
});

export type ArchiveBarsManifest = z.infer<typeof archiveManifestSchema>;

export interface ArchiveActionsInput {
  readonly uri: string;
  readonly sha256: string;
  readonly provider?: "alpaca" | "yfinance";
}

export interface ArchiveImportInput {
  readonly archiveManifestUri: string;
  readonly archiveManifestBytes: Buffer;
  readonly archiveManifestSha256: string;
  readonly session?: "regular" | "extended" | "all";
  readonly feed?: "sip" | "boats";
  readonly actions?: ArchiveActionsInput;
}

export interface ArchiveImportResult {
  readonly manifest: BacktestManifest;
  readonly archive: ArchiveBarsManifest;
  readonly storagePrefix: string;
  readonly archiveManifestSha256: string;
  readonly manifestRequestId?: string;
}

function assertSafeLogicalKey(key: string, code: string): void {
  if (
    !key
    || key.startsWith("/")
    || key.includes("..")
    || key.includes("//")
    || /[?*]/.test(key)
    || /(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(key)
  ) {
    throw new Error(code);
  }
}

function archiveManifestFromBytes(bytes: Buffer): ArchiveBarsManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("BACKTEST_ARCHIVE_MANIFEST_JSON_INVALID");
  }
  const parsed = archiveManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error("BACKTEST_ARCHIVE_MANIFEST_SCHEMA_INVALID");
  assertSafeLogicalKey(parsed.data.manifest_key, "BACKTEST_ARCHIVE_MANIFEST_KEY_INVALID");
  assertSafeLogicalKey(parsed.data.bars.key, "BACKTEST_ARCHIVE_BARS_KEY_INVALID");
  return parsed.data;
}

function deriveStoragePrefix(actualManifestKey: string, logicalManifestKey: string): string {
  if (!actualManifestKey.endsWith(logicalManifestKey)) {
    throw new Error("BACKTEST_ARCHIVE_STORAGE_PREFIX_UNRESOLVED");
  }
  return actualManifestKey.slice(0, actualManifestKey.length - logicalManifestKey.length);
}

function archiveDatasetId(archive: ArchiveBarsManifest, archiveManifestSha256: string): string {
  return `alpaca-archive-${archive.symbol.toLowerCase()}-${archive.year}-${archiveManifestSha256.slice(0, 12)}`;
}

function actionDeclaration(actions: ArchiveActionsInput | undefined): BacktestManifest["corporateActions"] {
  if (!actions) return { mode: "none", appliesToBars: false };
  if (!isSha256(actions.sha256)) throw new Error("BACKTEST_ARCHIVE_ACTIONS_SHA256_INVALID");
  return {
    mode: "provider-receipt",
    uri: actions.uri,
    sha256: actions.sha256,
    appliesToBars: false,
    provider: actions.provider ?? "alpaca",
  };
}

export function buildArchiveBacktestManifest(input: ArchiveImportInput): ArchiveImportResult {
  if (!isSha256(input.archiveManifestSha256)) throw new Error("BACKTEST_ARCHIVE_MANIFEST_SHA256_INVALID");
  const archive = archiveManifestFromBytes(input.archiveManifestBytes);
  if (archive.adjustment === "unknown") throw new Error("BACKTEST_ARCHIVE_ADJUSTMENT_UNKNOWN");
  const { bucket, key: actualManifestKey } = parseExactOssUri(input.archiveManifestUri);
  const storagePrefix = deriveStoragePrefix(actualManifestKey, archive.manifest_key);
  const actualBarsKey = storagePrefix + archive.bars.key;
  assertSafeLogicalKey(actualBarsKey, "BACKTEST_ARCHIVE_RESOLVED_BARS_KEY_INVALID");
  const feed = input.feed ?? "sip";
  const manifest = parseManifest({
    schemaVersion: 1,
    datasetId: archiveDatasetId(archive, input.archiveManifestSha256),
    feed: "alpaca",
    timeframe: "1m",
    session: input.session ?? "regular",
    adjustmentMode: archive.adjustment,
    startDate: `${archive.year}-01-01`,
    endDate: `${archive.year}-12-31`,
    sourceObject: {
      kind: "object",
      uri: `oss://${bucket}/${actualBarsKey}`,
      sha256: archive.bars.sha256,
      schema: archive.data_schema_version,
      format: "parquet",
      compression: "none",
      feed,
    },
    universe: {
      id: `archive-single-symbol-${archive.symbol.toLowerCase()}`,
      source: "single-symbol proxy derived from an exact Alpaca archive manifest",
      fingerprint: digestJson([archive.symbol]),
      completeness: "proxy",
      symbols: [archive.symbol],
    },
    corporateActions: input.actions
      ? { ...actionDeclaration(input.actions), appliesToBars: archive.adjustment !== "raw" }
      : { mode: "none", appliesToBars: false },
    archiveProvenance: {
      archiveManifestUri: input.archiveManifestUri,
      archiveManifestSha256: input.archiveManifestSha256,
      logicalManifestKey: archive.manifest_key,
      storagePrefix,
      sourceAsOf: archive.asof,
      qualityStatus: archive.quality_status,
      universeSnapshotId: archive.universe_snapshot_id,
      universeSemantics: archive.universe_semantics,
      survivorshipBias: archive.survivorship_bias,
    },
  });
  return {
    manifest,
    archive,
    storagePrefix,
    archiveManifestSha256: input.archiveManifestSha256,
  };
}

export async function importArchiveBacktestManifest(
  archiveManifestUri: string,
  options: {
    readonly allowNetwork?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly session?: "regular" | "extended" | "all";
    readonly feed?: "sip" | "boats";
    readonly actions?: ArchiveActionsInput;
  } = {},
): Promise<ArchiveImportResult> {
  if (!options.allowNetwork) throw new Error("BACKTEST_NETWORK_DISABLED");
  const configuration = readOssConfiguration(options.env);
  if (!configuration.configured || !configuration.config) throw new Error("BACKTEST_OSS_CONFIG_MISSING");
  const uri = parseExactOssUri(archiveManifestUri);
  if (uri.bucket !== configuration.config.bucket) throw new Error("BACKTEST_OSS_BUCKET_MISMATCH");
  const store = createReadOnlyOssStore(configuration.config);
  const head = await store.head(archiveManifestUri);
  const bytes = await store.get(archiveManifestUri);
  return {
    ...buildArchiveBacktestManifest({
      archiveManifestUri,
      archiveManifestBytes: bytes,
      archiveManifestSha256: sha256Hex(bytes),
      session: options.session,
      feed: options.feed,
      actions: options.actions,
    }),
    manifestRequestId: head.requestId,
  };
}
