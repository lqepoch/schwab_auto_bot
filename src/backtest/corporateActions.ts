import { readExactUri } from "./objectStore.ts";
import { compareCodeUnits, sha256Hex, digestJson } from "./fingerprints.ts";
import type { BacktestManifest } from "./manifest.ts";

export type CorporateActionType = "split" | "dividend";

export interface CorporateAction {
  readonly symbol: string;
  readonly exDate: string;
  readonly type: CorporateActionType;
  readonly splitFactor?: number;
  readonly dividendPerShare?: number;
  readonly source: "alpaca" | "yfinance" | "fixture" | "unknown";
  readonly providerId?: string;
}

export interface CorporateActionsFile {
  readonly schemaVersion: 1;
  readonly provider: "alpaca" | "yfinance" | "fixture" | "unknown";
  readonly actions: readonly CorporateAction[];
}

export interface CorporateActionsLoadResult {
  readonly actions: readonly CorporateAction[];
  readonly dataFingerprint: string;
  readonly sourceUri: string | null;
}

function requireString(value: unknown, code: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(code);
  return text;
}

function normalizeDate(value: unknown): string {
  const date = requireString(value, "BACKTEST_ACTION_DATE_MISSING");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + "T00:00:00Z"))) {
    throw new Error("BACKTEST_ACTION_DATE_INVALID");
  }
  return date;
}

function normalizeNumber(value: unknown, code: string): number {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(number) || number <= 0) throw new Error(code);
  return number;
}

function normalizeAction(value: unknown, provider: CorporateActionsFile["provider"]): CorporateAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BACKTEST_ACTION_ROW_INVALID");
  }
  const row = value as Record<string, unknown>;
  const symbol = requireString(row.symbol, "BACKTEST_ACTION_SYMBOL_MISSING").toUpperCase();
  if (!/^[A-Z][A-Z0-9._-]{0,15}$/.test(symbol)) throw new Error("BACKTEST_ACTION_SYMBOL_INVALID");
  const exDate = normalizeDate(row.exDate ?? row.ex_date);
  const rawType = String(row.type ?? row.ca_type ?? "").trim().toLowerCase();
  const source = (row.source ?? provider) as CorporateAction["source"];
  if (!["alpaca", "yfinance", "fixture", "unknown"].includes(source)) {
    throw new Error("BACKTEST_ACTION_SOURCE_INVALID");
  }
  if (rawType === "split") {
    const oldRate = row.oldRate ?? row.old_rate;
    const newRate = row.newRate ?? row.new_rate;
    const splitFactor = row.splitFactor ?? (
      oldRate !== undefined && newRate !== undefined
        ? normalizeNumber(newRate, "BACKTEST_SPLIT_RATE_INVALID") / normalizeNumber(oldRate, "BACKTEST_SPLIT_RATE_INVALID")
        : undefined
    );
    return {
      symbol,
      exDate,
      type: "split",
      splitFactor: normalizeNumber(splitFactor, "BACKTEST_SPLIT_FACTOR_INVALID"),
      source,
      providerId: row.id === undefined ? undefined : String(row.id),
    };
  }
  if (rawType === "dividend") {
    return {
      symbol,
      exDate,
      type: "dividend",
      dividendPerShare: normalizeNumber(row.dividendPerShare ?? row.cash, "BACKTEST_DIVIDEND_AMOUNT_INVALID"),
      source,
      providerId: row.id === undefined ? undefined : String(row.id),
    };
  }
  throw new Error("BACKTEST_ACTION_TYPE_UNSUPPORTED");
}

export function parseCorporateActions(value: unknown): CorporateActionsFile {
  const record = Array.isArray(value) ? { schemaVersion: 1, provider: "unknown", actions: value } : value;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("BACKTEST_ACTIONS_FILE_INVALID");
  }
  const input = record as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new Error("BACKTEST_ACTIONS_SCHEMA_UNSUPPORTED");
  const provider = (input.provider ?? "unknown") as CorporateActionsFile["provider"];
  if (!["alpaca", "yfinance", "fixture", "unknown"].includes(provider)) {
    throw new Error("BACKTEST_ACTIONS_PROVIDER_INVALID");
  }
  if (!Array.isArray(input.actions)) throw new Error("BACKTEST_ACTIONS_ARRAY_MISSING");
  const actions = input.actions.map((action) => normalizeAction(action, provider));
  actions.sort((left, right) =>
    compareCodeUnits(left.symbol, right.symbol)
    || compareCodeUnits(left.exDate, right.exDate)
    || compareCodeUnits(left.type, right.type));
  const seen = new Set<string>();
  for (const action of actions) {
    const key = action.symbol + "|" + action.exDate + "|" + action.type;
    if (seen.has(key)) throw new Error("BACKTEST_ACTION_DUPLICATE_" + key);
    seen.add(key);
  }
  return { schemaVersion: 1, provider, actions };
}

export function validateCorporateActionPolicy(
  manifest: BacktestManifest,
  actions: readonly CorporateAction[],
  options: { requireEvidence?: boolean } = {},
): readonly string[] {
  const warnings: string[] = [];
  const actionMode = manifest.corporateActions.mode;
  if (manifest.adjustmentMode === "raw" && actionMode !== "none" && manifest.corporateActions.appliesToBars) {
    throw new Error("BACKTEST_RAW_BARS_CANNOT_MARK_ACTIONS_ALREADY_APPLIED");
  }
  if (manifest.adjustmentMode !== "raw" && actionMode !== "none" && !manifest.corporateActions.appliesToBars) {
    throw new Error("BACKTEST_ADJUSTED_BARS_CANNOT_APPLY_ACTIONS_AGAIN");
  }
  if (manifest.adjustmentMode === "raw" && actionMode === "none") {
    if (options.requireEvidence) throw new Error("BACKTEST_RAW_BARS_CORPORATE_ACTION_EVIDENCE_REQUIRED");
    warnings.push("RAW_BARS_WITHOUT_CORPORATE_ACTION_EVIDENCE");
  }
  if (manifest.adjustmentMode !== "raw" && actionMode !== "none") {
    warnings.push("CORPORATE_ACTIONS_ARE_EVIDENCE_ONLY_NO_SECOND_ADJUSTMENT");
  }
  if (actions.some((action) => !manifest.universe.symbols.includes(action.symbol))) {
    warnings.push("CORPORATE_ACTION_SYMBOL_OUTSIDE_UNIVERSE");
  }
  return warnings;
}

export async function loadCorporateActions(
  manifestPath: string,
  manifest: BacktestManifest,
  options: { allowNetwork?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<CorporateActionsLoadResult> {
  if (manifest.corporateActions.mode === "none") {
    return { actions: [], dataFingerprint: digestJson([]), sourceUri: null };
  }
  const uri = manifest.corporateActions.uri as string;
  const exact = await readExactUri(manifestPath, uri, manifest.corporateActions.sha256 as string, options);
  const bytes = exact.bytes;
  if (sha256Hex(bytes) !== exact.sha256) throw new Error("BACKTEST_CORPORATE_ACTIONS_SHA256_MISMATCH");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("BACKTEST_CORPORATE_ACTIONS_JSON_INVALID");
  }
  const parsed = parseCorporateActions(value);
  return {
    actions: parsed.actions,
    dataFingerprint: digestJson(parsed),
    sourceUri: uri,
  };
}

export function actionsForDate(
  actions: readonly CorporateAction[],
  symbol: string,
  date: string,
): readonly CorporateAction[] {
  return actions.filter((action) => action.symbol === symbol && action.exDate === date);
}
