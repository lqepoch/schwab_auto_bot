import { z } from "zod";
import { compareCodeUnits, isSha256 } from "./fingerprints.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const symbol = z.string().regex(/^[A-Z][A-Z0-9._-]{0,15}$/);
const exactFileUri = z.string().min(1).refine((value) => (
  /^file:/i.test(value)
    && !/[?*]/.test(value)
    && !/(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(value)
), "RECEIPT_URI_MUST_BE_EXACT_FILE");

const evidenceUri = z.string().min(1).refine((value) => (
  /^(?:file|oss|https?):/i.test(value)
    && !/[?*]/.test(value)
    && !/(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(value)
), "EVIDENCE_URI_MUST_BE_EXACT");

const mappingSchema = z.object({
  sourceSymbol: symbol,
  providerSymbol: symbol,
});

const exclusionSchema = z.object({
  sourceSymbol: symbol,
  reason: z.string().trim().min(1),
  evidence: z.object({
    uri: evidenceUri,
    sha256: hash,
  }),
});

export const symbolResolutionManifestSchema = z.object({
  receiptUri: exactFileUri,
  receiptSha256: hash,
  snapshotId: hash,
  snapshotSha256: hash,
  mappings: z.array(mappingSchema),
  exclusions: z.array(exclusionSchema),
});

const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("backtest-symbol-resolution-receipt"),
  status: z.literal("PASS"),
  evidenceClass: z.literal("LOCAL_HASH_FIXED_SYMBOL_RESOLUTION"),
  readOnly: z.literal(true),
  brokerWriteAttempted: z.literal(false),
  snapshot: z.object({ id: hash, sha256: hash }),
  mappings: z.array(mappingSchema),
  exclusions: z.array(exclusionSchema),
  warnings: z.array(z.string()),
});

export type SymbolResolutionManifest = z.infer<typeof symbolResolutionManifestSchema>;
export type SymbolResolutionMapping = z.infer<typeof mappingSchema>;
export type SymbolResolutionExclusion = z.infer<typeof exclusionSchema>;
export type SymbolResolutionReceipt = z.infer<typeof receiptSchema>;

export interface SymbolResolutionReceiptInput {
  readonly uri: string;
  readonly sha256: string;
  readonly receipt: SymbolResolutionReceipt;
}

export interface SymbolResolutionPlan {
  readonly receiptUri?: string;
  readonly receiptSha256?: string;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly mappings: readonly SymbolResolutionMapping[];
  readonly exclusions: readonly SymbolResolutionExclusion[];
}

function code(error: string): Error {
  return new Error("BACKTEST_SYMBOL_RESOLUTION_" + error);
}

function assertHashes(id: string, sha256: string): void {
  if (!isSha256(id) || !isSha256(sha256)) throw code("SNAPSHOT_HASH_INVALID");
}

function normalizeEntries(
  mappings: readonly SymbolResolutionMapping[],
  exclusions: readonly SymbolResolutionExclusion[],
): { readonly mappings: readonly SymbolResolutionMapping[]; readonly exclusions: readonly SymbolResolutionExclusion[] } {
  const sourceSymbols = new Set<string>();
  const providerSymbols = new Set<string>();
  for (const mapping of mappings) {
    if (sourceSymbols.has(mapping.sourceSymbol)) throw code("MAPPING_SOURCE_DUPLICATE");
    if (providerSymbols.has(mapping.providerSymbol)) throw code("MAPPING_PROVIDER_DUPLICATE");
    sourceSymbols.add(mapping.sourceSymbol);
    providerSymbols.add(mapping.providerSymbol);
  }
  for (const exclusion of exclusions) {
    if (sourceSymbols.has(exclusion.sourceSymbol)) throw code("SOURCE_MAPPING_EXCLUSION_CONFLICT");
    if (providerSymbols.has(exclusion.sourceSymbol)) throw code("MAPPING_PROVIDER_EXCLUSION_CONFLICT");
    sourceSymbols.add(exclusion.sourceSymbol);
  }
  return {
    mappings: mappings.slice().sort((left, right) => compareCodeUnits(left.sourceSymbol, right.sourceSymbol)),
    exclusions: exclusions.slice().sort((left, right) => compareCodeUnits(left.sourceSymbol, right.sourceSymbol)),
  };
}

function assertSourceCoverage(
  mappings: readonly SymbolResolutionMapping[],
  exclusions: readonly SymbolResolutionExclusion[],
  sourceSymbols: readonly string[],
): void {
  const sortedSourceSymbols = sourceSymbols.slice().sort(compareCodeUnits);
  if (new Set(sortedSourceSymbols).size !== sortedSourceSymbols.length) throw code("SOURCE_SYMBOL_DUPLICATE");
  const sourceSet = new Set(sortedSourceSymbols);
  const receiptSources = new Set<string>([
    ...mappings.map((item) => item.sourceSymbol),
    ...exclusions.map((item) => item.sourceSymbol),
  ]);
  for (const sourceSymbol of receiptSources) {
    if (!sourceSet.has(sourceSymbol)) throw code("SOURCE_SYMBOL_UNKNOWN");
  }
}

export function parseSymbolResolutionReceipt(value: unknown): SymbolResolutionReceipt {
  const result = receiptSchema.safeParse(value);
  if (!result.success) throw code("RECEIPT_SCHEMA_INVALID");
  assertHashes(result.data.snapshot.id, result.data.snapshot.sha256);
  const entries = normalizeEntries(result.data.mappings, result.data.exclusions);
  return {
    ...result.data,
    mappings: [...entries.mappings],
    exclusions: [...entries.exclusions],
  };
}

export function parseSymbolResolutionManifest(value: unknown): SymbolResolutionManifest {
  const result = symbolResolutionManifestSchema.safeParse(value);
  if (!result.success) throw code("MANIFEST_SCHEMA_INVALID");
  assertHashes(result.data.snapshotId, result.data.snapshotSha256);
  const entries = normalizeEntries(result.data.mappings, result.data.exclusions);
  return { ...result.data, mappings: [...entries.mappings], exclusions: [...entries.exclusions] };
}

export function bindSymbolResolution(
  input: SymbolResolutionReceiptInput,
  snapshot: { readonly id: string; readonly sha256: string },
  sourceSymbols: readonly string[],
): SymbolResolutionPlan {
  if (!isSha256(input.sha256)) throw code("RECEIPT_HASH_INVALID");
  if (!/^file:/i.test(input.uri) || /[?*]/.test(input.uri) || /(^|[/])(?:latest|current)(?:[/_.-]|$)/i.test(input.uri)) {
    throw code("RECEIPT_URI_INVALID");
  }
  assertHashes(snapshot.id, snapshot.sha256);
  const receipt = parseSymbolResolutionReceipt(input.receipt);
  if (receipt.snapshot.id !== snapshot.id || receipt.snapshot.sha256 !== snapshot.sha256) {
    throw code("SNAPSHOT_BINDING_MISMATCH");
  }
  assertSourceCoverage(receipt.mappings, receipt.exclusions, sourceSymbols);
  return {
    receiptUri: input.uri,
    receiptSha256: input.sha256,
    snapshotId: snapshot.id,
    snapshotSha256: snapshot.sha256,
    mappings: receipt.mappings,
    exclusions: receipt.exclusions,
  };
}

export function identitySymbolResolution(
  snapshot: { readonly id: string; readonly sha256: string },
  sourceSymbols: readonly string[],
): SymbolResolutionPlan {
  assertHashes(snapshot.id, snapshot.sha256);
  return {
    snapshotId: snapshot.id,
    snapshotSha256: snapshot.sha256,
    mappings: sourceSymbols
      .slice()
      .sort(compareCodeUnits)
      .map((sourceSymbol) => ({ sourceSymbol, providerSymbol: sourceSymbol })),
    exclusions: [],
  };
}

export function providerSymbolForSource(
  resolution: Pick<SymbolResolutionPlan, "mappings" | "exclusions"> | SymbolResolutionManifest | undefined,
  sourceSymbol: string,
): string {
  const exclusion = resolution?.exclusions.find((item) => item.sourceSymbol === sourceSymbol);
  if (exclusion) throw code("SOURCE_SYMBOL_EXCLUDED_" + sourceSymbol);
  const mapping = resolution?.mappings.find((item) => item.sourceSymbol === sourceSymbol);
  return mapping?.providerSymbol ?? sourceSymbol;
}

export function excludedSourceSymbols(
  resolution: Pick<SymbolResolutionPlan, "exclusions"> | SymbolResolutionManifest | undefined,
): readonly string[] {
  return resolution?.exclusions.map((item) => item.sourceSymbol).sort(compareCodeUnits) ?? [];
}
