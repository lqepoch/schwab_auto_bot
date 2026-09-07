import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atomicWriteJson } from "../utils/atomicJson.ts";
import {
  parseCorporateActions,
  summarizeCorporateActionDuplicates,
  type CorporateAction,
} from "./corporateActions.ts";
import { compareCodeUnits, digestJson, isSha256, sha256Hex } from "./fingerprints.ts";
import {
  buildCurrentUniverseBacktestManifest,
  parseCurrentUniverseDiscovery,
  type CurrentUniverseDiscoveryResult,
} from "./universe.ts";

interface ActionReceiptRecord {
  readonly path: string;
  readonly sha256: string;
  readonly actionsPath: string;
  readonly actionsSha256: string;
  readonly symbols: readonly string[];
  readonly since: string;
  readonly until: string;
  readonly rawProviderRowCount: number;
  readonly actionCount: number;
  readonly duplicateCount: number;
  readonly providerDuplicateIds: readonly string[];
  readonly dataFingerprint: string;
  readonly actions: readonly CorporateAction[];
}

export interface UniverseActionsReceiptInput {
  readonly path: string;
  readonly sha256: string;
}

export interface MaterializeCurrentUniverseInput {
  readonly discovery: CurrentUniverseDiscoveryResult;
  readonly discoverySha256?: string;
  readonly actionReceipts: readonly UniverseActionsReceiptInput[];
  readonly catalogPath: string;
  readonly manifestPath: string;
  readonly actionsPath: string;
}

export interface MaterializeCurrentUniverseResult {
  readonly status: "PASS";
  readonly kind: "backtest-current-universe-materialization";
  readonly evidenceClass: "LOCAL_FROZEN_DISCOVERY_AND_ACTION_RECEIPTS";
  readonly readOnly: true;
  readonly brokerWriteAttempted: false;
  readonly discoveryStatus: "PASS";
  readonly discoverySha256: string;
  readonly catalogPath: string;
  readonly catalogSha256: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly actionsPath: string;
  readonly actionsSha256: string;
  readonly actionReceiptSha256: readonly string[];
  readonly actionCoverage: {
    readonly symbols: readonly string[];
    readonly since: string;
    readonly until: string;
    readonly batchCount: number;
  };
  readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function requiredHash(value: unknown, code: string): string {
  const text = requiredString(value, code);
  if (!isSha256(text)) throw new Error(code);
  return text;
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function sortedProviderIds(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(code);
  const ids = value.map((item) => item.trim());
  if (new Set(ids).size !== ids.length || ids.some((item, index) => index > 0 && compareCodeUnits(ids[index - 1], item) > 0)) {
    throw new Error(code);
  }
  return ids;
}

function date(value: unknown, code: string): string {
  const text = requiredString(value, code);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new Error(code);
  }
  return text;
}

function symbols(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => (
    typeof item !== "string" || !/^[A-Z][A-Z0-9._-]{0,15}$/.test(item)
  ))) throw new Error(code);
  const result = [...value] as string[];
  if (new Set(result).size !== result.length || result.some((item, index) => index > 0 && compareCodeUnits(result[index - 1], item) > 0)) {
    throw new Error(code);
  }
  return result;
}

function localPath(value: string, baseDirectory: string, code: string): string {
  try {
    if (value.toLowerCase().startsWith("file:")) return fileURLToPath(new URL(value));
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error(code);
    return resolve(baseDirectory, value);
  } catch {
    throw new Error(code);
  }
}

async function loadActionReceipt(input: UniverseActionsReceiptInput): Promise<ActionReceiptRecord> {
  const receiptPath = resolve(input.path);
  const receiptBytes = await readFile(receiptPath).catch(() => {
    throw new Error("BACKTEST_UNIVERSE_ACTION_RECEIPT_READ_FAILED");
  });
  if (!isSha256(input.sha256) || sha256Hex(receiptBytes) !== input.sha256) {
    throw new Error("BACKTEST_UNIVERSE_ACTION_RECEIPT_SHA256_MISMATCH");
  }
  let value: unknown;
  try {
    value = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    throw new Error("BACKTEST_UNIVERSE_ACTION_RECEIPT_JSON_INVALID");
  }
  if (!isRecord(value) || value.kind !== "alpaca-corporate-actions-receipt" || value.status !== "PASS"
    || value.evidenceClass !== "REAL_PROVIDER_READ_ONLY" || value.readOnly !== true || value.brokerWriteAttempted !== false) {
    throw new Error("BACKTEST_UNIVERSE_ACTION_RECEIPT_SCHEMA_INVALID");
  }
  const receipt = value.receipt;
  if (!isRecord(receipt) || receipt.provider !== "alpaca" || receipt.accessMethod !== "alpaca_cli" || receipt.status !== 0) {
    throw new Error("BACKTEST_UNIVERSE_ACTION_RECEIPT_QUERY_INVALID");
  }
  const batchSymbols = symbols(receipt.symbols, "BACKTEST_UNIVERSE_ACTION_RECEIPT_SYMBOLS_INVALID");
  const since = date(receipt.since, "BACKTEST_UNIVERSE_ACTION_RECEIPT_SINCE_INVALID");
  const until = date(receipt.until, "BACKTEST_UNIVERSE_ACTION_RECEIPT_UNTIL_INVALID");
  if (until < since) throw new Error("BACKTEST_UNIVERSE_ACTION_RECEIPT_RANGE_INVALID");
  requiredHash(receipt.commandFingerprint, "BACKTEST_UNIVERSE_ACTION_RECEIPT_COMMAND_FINGERPRINT_INVALID");
  const rawProviderRowCount = nonNegativeInteger(receipt.rawProviderRowCount, "BACKTEST_UNIVERSE_ACTION_RECEIPT_RAW_ROW_COUNT_INVALID");
  const actionCount = nonNegativeInteger(receipt.actionCount, "BACKTEST_UNIVERSE_ACTION_RECEIPT_ACTION_COUNT_INVALID");
  const duplicateCount = nonNegativeInteger(receipt.duplicateCount, "BACKTEST_UNIVERSE_ACTION_RECEIPT_DUPLICATE_COUNT_INVALID");
  const providerDuplicateIds = sortedProviderIds(
    receipt.providerDuplicateIds,
    "BACKTEST_UNIVERSE_ACTION_RECEIPT_PROVIDER_DUPLICATE_IDS_INVALID",
  );
  const actionsPathValue = requiredString(value.actionsPath, "BACKTEST_UNIVERSE_ACTIONS_PATH_MISSING");
  const actionsPath = localPath(actionsPathValue, dirname(receiptPath), "BACKTEST_UNIVERSE_ACTIONS_PATH_INVALID");
  const actionsSha256 = requiredHash(value.actionsSha256, "BACKTEST_UNIVERSE_ACTIONS_SHA256_INVALID");
  const actionBytes = await readFile(actionsPath).catch(() => {
    throw new Error("BACKTEST_UNIVERSE_ACTIONS_READ_FAILED");
  });
  if (sha256Hex(actionBytes) !== actionsSha256) throw new Error("BACKTEST_UNIVERSE_ACTIONS_SHA256_MISMATCH");
  let actionValue: unknown;
  try {
    actionValue = JSON.parse(actionBytes.toString("utf8"));
  } catch {
    throw new Error("BACKTEST_UNIVERSE_ACTIONS_JSON_INVALID");
  }
  const parsed = parseCorporateActions(actionValue);
  if (parsed.provider !== "alpaca") throw new Error("BACKTEST_UNIVERSE_ACTIONS_PROVIDER_INVALID");
  const duplicateSummary = summarizeCorporateActionDuplicates(parsed.actions);
  if (actionCount !== parsed.actions.length || duplicateCount !== duplicateSummary.duplicateCount
    || rawProviderRowCount !== actionCount + duplicateCount
    || providerDuplicateIds.join("\u0000") !== duplicateSummary.providerDuplicateIds.join("\u0000")) {
    throw new Error("BACKTEST_UNIVERSE_ACTION_RECEIPT_COUNTS_MISMATCH");
  }
  const dataFingerprint = requiredHash(receipt.dataFingerprint, "BACKTEST_UNIVERSE_ACTION_RECEIPT_FINGERPRINT_INVALID");
  if (digestJson(parsed.actions) !== dataFingerprint) throw new Error("BACKTEST_UNIVERSE_ACTION_RECEIPT_FINGERPRINT_MISMATCH");
  for (const action of parsed.actions) {
    if (!batchSymbols.includes(action.symbol) || action.exDate < since || action.exDate > until) {
      throw new Error("BACKTEST_UNIVERSE_ACTION_OUTSIDE_RECEIPT_COVERAGE");
    }
  }
  return {
    path: receiptPath,
    sha256: input.sha256,
    actionsPath,
    actionsSha256,
    symbols: batchSymbols,
    since,
    until,
    rawProviderRowCount,
    actionCount,
    duplicateCount,
    providerDuplicateIds,
    dataFingerprint,
    actions: parsed.actions,
  };
}

function assertCoverage(
  discovery: CurrentUniverseDiscoveryResult,
  batches: readonly ActionReceiptRecord[],
): { readonly symbols: readonly string[]; readonly since: string; readonly until: string } {
  const requiredSymbols = discovery.universe.symbols;
  const requiredYears = Array.from(
    { length: discovery.archive.endYear - discovery.archive.startYear + 1 },
    (_, offset) => discovery.archive.startYear + offset,
  );
  const covered = new Set<string>();
  for (const batch of batches) {
    for (const item of batch.symbols) {
      if (!requiredSymbols.includes(item)) throw new Error("BACKTEST_UNIVERSE_ACTION_COVERAGE_SYMBOL_OUTSIDE_UNIVERSE");
      covered.add(item);
    }
  }
  if (covered.size !== requiredSymbols.length) throw new Error("BACKTEST_UNIVERSE_ACTION_COVERAGE_SYMBOL_INCOMPLETE");
  for (const symbol of requiredSymbols) {
    for (const year of requiredYears) {
      const start = `${year}-01-01`;
      const end = `${year}-12-31`;
      if (!batches.some((batch) => batch.symbols.includes(symbol) && batch.since <= start && batch.until >= end)) {
        throw new Error(`BACKTEST_UNIVERSE_ACTION_COVERAGE_INCOMPLETE_${symbol}_${year}`);
      }
    }
  }
  const since = requiredYears.length > 0 ? `${requiredYears[0]}-01-01` : discovery.archive.startYear.toString();
  const until = requiredYears.length > 0 ? `${requiredYears[requiredYears.length - 1]}-12-31` : discovery.archive.endYear.toString();
  return { symbols: requiredSymbols, since, until };
}

export async function materializeCurrentUniverseCatalog(
  input: MaterializeCurrentUniverseInput,
): Promise<MaterializeCurrentUniverseResult> {
  const discovery = parseCurrentUniverseDiscovery(input.discovery);
  if (discovery.status !== "PASS" || !discovery.catalog) {
    throw new Error("BACKTEST_UNIVERSE_DISCOVERY_NOT_PASS");
  }
  const discoverySha256 = input.discoverySha256 ?? digestJson(discovery);
  if (!isSha256(discoverySha256)) throw new Error("BACKTEST_UNIVERSE_DISCOVERY_SHA256_INVALID");
  if (input.actionReceipts.length === 0) throw new Error("BACKTEST_UNIVERSE_ACTION_RECEIPT_REQUIRED");
  const batches = await Promise.all(input.actionReceipts.map(loadActionReceipt));
  const coverage = assertCoverage(discovery, batches);
  const allActions = batches.flatMap((batch) => batch.actions);
  const actionFile = parseCorporateActions({ schemaVersion: 1, provider: "alpaca", actions: allActions });
  const actionBundle = {
    schemaVersion: 1 as const,
    provider: "alpaca" as const,
    coverage: {
      symbols: coverage.symbols,
      since: coverage.since,
      until: coverage.until,
      receipts: batches.map((batch) => ({
        path: batch.path,
        sha256: batch.sha256,
        actionsSha256: batch.actionsSha256,
        symbols: batch.symbols,
        since: batch.since,
        until: batch.until,
      })),
    },
    actions: actionFile.actions,
  };
  await atomicWriteJson(input.actionsPath, actionBundle, { directoryMode: 0o750, fileMode: 0o640, pretty: true });
  await atomicWriteJson(input.catalogPath, discovery.catalog, { directoryMode: 0o750, fileMode: 0o640, pretty: true });
  const actionsBytes = await readFile(input.actionsPath);
  const catalogBytes = await readFile(input.catalogPath);
  const manifest = buildCurrentUniverseBacktestManifest(discovery, {
    catalogUri: pathToFileURL(resolve(input.catalogPath)).href,
    catalogSha256: sha256Hex(catalogBytes),
    corporateActions: {
      uri: pathToFileURL(resolve(input.actionsPath)).href,
      sha256: sha256Hex(actionsBytes),
      provider: "alpaca",
    },
    discoverySha256,
  });
  await atomicWriteJson(input.manifestPath, manifest, { directoryMode: 0o750, fileMode: 0o640, pretty: true });
  const manifestBytes = await readFile(input.manifestPath);
  return {
    status: "PASS",
    kind: "backtest-current-universe-materialization",
    evidenceClass: "LOCAL_FROZEN_DISCOVERY_AND_ACTION_RECEIPTS",
    readOnly: true,
    brokerWriteAttempted: false,
    discoveryStatus: "PASS",
    discoverySha256,
    catalogPath: resolve(input.catalogPath),
    catalogSha256: sha256Hex(catalogBytes),
    manifestPath: resolve(input.manifestPath),
    manifestSha256: sha256Hex(manifestBytes),
    actionsPath: resolve(input.actionsPath),
    actionsSha256: sha256Hex(actionsBytes),
    actionReceiptSha256: batches.map((batch) => batch.sha256),
    actionCoverage: { ...coverage, batchCount: batches.length },
    warnings: [
      "MATERIALIZED_FROM_FROZEN_DISCOVERY_AND_EXPLICIT_ACTION_RECEIPT_HASHES",
      "CURRENT_UNIVERSE_DECLARES_SURVIVORSHIP_BIAS",
      "SESSION_DECLARATION_REMAINS_UNVERIFIED",
    ],
  };
}
