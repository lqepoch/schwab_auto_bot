import { readFile } from "node:fs/promises";
import { z } from "zod";
import { digestJson, isSha256 } from "./fingerprints.ts";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "DATE_MUST_BE_YYYY-MM-DD");
const hash = z.string().regex(/^[a-f0-9]{64}$/, "SHA256_MUST_BE_LOWERCASE_HEX");
const symbol = z.string().regex(/^[A-Z][A-Z0-9._-]{0,15}$/, "SYMBOL_MUST_BE_NORMALIZED");

const sourceObjectSchema = z.object({
  kind: z.enum(["object", "catalog"]).default("object"),
  uri: z.string().min(1),
  sha256: hash,
  schema: z.enum(["canonical-minute-bars-v1", "alpaca-minute-bars-v1", "minute-bars-catalog-v1"]),
  format: z.enum(["csv", "jsonl", "json"]),
  compression: z.enum(["none", "gzip"]).default("none"),
});

const universeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  fingerprint: hash,
  completeness: z.enum(["proxy", "current-constituents", "unknown"]),
  symbols: z.array(symbol).min(1),
});

const corporateActionsSchema = z.object({
  mode: z.enum(["none", "local-file", "provider-receipt"]),
  uri: z.string().min(1).optional(),
  sha256: hash.optional(),
  appliesToBars: z.boolean(),
  provider: z.enum(["alpaca", "yfinance", "fixture", "unknown"]).optional(),
});

export const BacktestManifestSchema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,95}$/, "DATASET_ID_INVALID"),
  feed: z.literal("alpaca"),
  timeframe: z.literal("1m"),
  session: z.enum(["regular", "extended", "all"]),
  adjustmentMode: z.enum(["raw", "split-adjusted", "total-return-adjusted", "unknown"]),
  startDate: dateOnly,
  endDate: dateOnly,
  sourceObject: sourceObjectSchema,
  universe: universeSchema,
  corporateActions: corporateActionsSchema,
}).superRefine((manifest, context) => {
  if (manifest.endDate < manifest.startDate) {
    context.addIssue({ code: "custom", path: ["endDate"], message: "END_DATE_BEFORE_START_DATE" });
  }
  const uri = manifest.sourceObject.uri;
  if (/[?*]/.test(uri) || /(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(uri)) {
    context.addIssue({
      code: "custom",
      path: ["sourceObject", "uri"],
      message: "SOURCE_URI_MUST_BE_EXACT_AND_IMMUTABLE",
    });
  }
  if (manifest.sourceObject.kind === "catalog" &&
      (manifest.sourceObject.schema !== "minute-bars-catalog-v1" || manifest.sourceObject.format !== "json")) {
    context.addIssue({ code: "custom", path: ["sourceObject"], message: "CATALOG_SOURCE_SCHEMA_INVALID" });
  }
  if (manifest.sourceObject.kind === "object" && manifest.sourceObject.schema === "minute-bars-catalog-v1") {
    context.addIssue({ code: "custom", path: ["sourceObject"], message: "OBJECT_SOURCE_CANNOT_BE_CATALOG" });
  }
  if (manifest.corporateActions.uri &&
      (/[?*]/.test(manifest.corporateActions.uri)
        || /(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(manifest.corporateActions.uri))) {
    context.addIssue({
      code: "custom",
      path: ["corporateActions", "uri"],
      message: "CORPORATE_ACTION_URI_MUST_BE_EXACT_AND_IMMUTABLE",
    });
  }
  if (manifest.corporateActions.mode === "none" && manifest.corporateActions.appliesToBars) {
    context.addIssue({ code: "custom", path: ["corporateActions"], message: "NONE_CANNOT_APPLY_TO_BARS" });
  }
  if (manifest.corporateActions.mode !== "none" && !manifest.corporateActions.uri) {
    context.addIssue({ code: "custom", path: ["corporateActions", "uri"], message: "CORPORATE_ACTION_URI_REQUIRED" });
  }
  if (manifest.corporateActions.mode !== "none" && !manifest.corporateActions.sha256) {
    context.addIssue({ code: "custom", path: ["corporateActions", "sha256"], message: "CORPORATE_ACTION_SHA256_REQUIRED" });
  }
  if (manifest.corporateActions.mode === "provider-receipt" && !manifest.corporateActions.provider) {
    context.addIssue({ code: "custom", path: ["corporateActions", "provider"], message: "PROVIDER_REQUIRED" });
  }
});

export type BacktestManifest = z.infer<typeof BacktestManifestSchema>;
export type SourceObject = BacktestManifest["sourceObject"];
export type BarSchema = SourceObject["schema"];

export function parseManifest(value: unknown): BacktestManifest {
  const result = BacktestManifestSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => (issue.path.join(".") || "manifest") + ":" + issue.message)
      .join(";");
    throw new Error("BACKTEST_MANIFEST_INVALID:" + details);
  }
  if (!isSha256(result.data.sourceObject.sha256)) throw new Error("BACKTEST_MANIFEST_SOURCE_SHA256_INVALID");
  return result.data;
}

export async function loadManifest(path: string): Promise<BacktestManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("BACKTEST_MANIFEST_READ_FAILED:" + (error instanceof Error ? error.message : "unknown"));
  }
  return parseManifest(value);
}

export function manifestFingerprint(manifest: BacktestManifest): string {
  return digestJson(manifest);
}

export function assertRunnableManifest(manifest: BacktestManifest): void {
  if (manifest.adjustmentMode === "unknown") {
    throw new Error("BACKTEST_ADJUSTMENT_MODE_UNKNOWN_FAIL_CLOSED");
  }
  if (manifest.universe.completeness === "unknown") {
    throw new Error("BACKTEST_UNIVERSE_COMPLETENESS_UNKNOWN_FAIL_CLOSED");
  }
}
