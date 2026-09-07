import { readExactUri } from "./objectStore.ts";
import { compareCodeUnits, sha256Hex, stableJson, digestJson } from "./fingerprints.ts";
import type { BacktestManifest } from "./manifest.ts";
import { excludedSourceSymbols, providerSymbolForSource } from "./symbolResolution.ts";

export type CorporateActionType = "split" | "dividend";

export interface CorporateAction {
  readonly symbol: string;
  readonly exDate: string;
  readonly type: CorporateActionType;
  readonly splitFactor?: number;
  readonly dividendPerShare?: number;
  readonly source: "alpaca" | "yfinance" | "fixture" | "unknown";
  readonly providerId?: string;
  /** All provider IDs observed for one economic event after safe de-duplication. */
  readonly providerIds?: readonly string[];
  /** Number of additional provider rows folded into this economic event. */
  readonly duplicateCount?: number;
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

function normalizeProviderIds(row: Record<string, unknown>): readonly string[] {
  const values: unknown[] = [];
  if (row.providerIds !== undefined) {
    if (!Array.isArray(row.providerIds)) throw new Error("BACKTEST_ACTION_PROVIDER_IDS_INVALID");
    const listedIds = row.providerIds.map((value) => String(value ?? "").trim());
    if (listedIds.some((id) => !id) || new Set(listedIds).size !== listedIds.length) {
      throw new Error("BACKTEST_ACTION_PROVIDER_ID_DUPLICATE");
    }
    values.push(...listedIds);
  }
  if (row.providerId !== undefined) values.push(row.providerId);
  if (row.id !== undefined) values.push(row.id);
  const ids = values.map((value) => {
    const id = String(value ?? "").trim();
    if (!id) throw new Error("BACKTEST_ACTION_PROVIDER_ID_INVALID");
    return id;
  });
  return [...new Set(ids)].sort(compareCodeUnits);
}

function normalizeDuplicateCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("BACKTEST_ACTION_DUPLICATE_COUNT_INVALID");
  }
  return value > 0 ? value : undefined;
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
  const normalizedProviderIds = normalizeProviderIds(row);
  const duplicateCount = normalizeDuplicateCount(row.duplicateCount);
  if (normalizedProviderIds.length > 1 && (duplicateCount ?? 0) < normalizedProviderIds.length - 1) {
    throw new Error("BACKTEST_ACTION_DUPLICATE_COUNT_INCONSISTENT");
  }
  const providerFields = normalizedProviderIds.length > 0
    ? { providerId: normalizedProviderIds[0], providerIds: normalizedProviderIds }
    : {};
  const duplicateFields = duplicateCount === undefined ? {} : { duplicateCount };
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
      ...providerFields,
      ...duplicateFields,
    };
  }
  if (rawType === "dividend") {
    return {
      symbol,
      exDate,
      type: "dividend",
      dividendPerShare: normalizeNumber(row.dividendPerShare ?? row.cash, "BACKTEST_DIVIDEND_AMOUNT_INVALID"),
      source,
      ...providerFields,
      ...duplicateFields,
    };
  }
  throw new Error("BACKTEST_ACTION_TYPE_UNSUPPORTED");
}

function providerIds(action: CorporateAction): readonly string[] {
  const values = action.providerIds ?? (action.providerId ? [action.providerId] : []);
  return [...new Set(values)].sort(compareCodeUnits);
}

function economicIdentity(action: CorporateAction): string {
  return stableJson({
    symbol: action.symbol,
    exDate: action.exDate,
    type: action.type,
    ...(action.type === "split"
      ? { splitFactor: action.splitFactor }
      : { dividendPerShare: action.dividendPerShare }),
  });
}

function compareActions(left: CorporateAction, right: CorporateAction): number {
  return compareCodeUnits(left.symbol, right.symbol)
    || compareCodeUnits(left.exDate, right.exDate)
    || compareCodeUnits(left.type, right.type)
    || compareCodeUnits(economicIdentity(left), economicIdentity(right))
    || compareCodeUnits(left.source, right.source)
    || compareCodeUnits(left.providerId ?? "", right.providerId ?? "");
}

function mergeEconomicDuplicate(left: CorporateAction, right: CorporateAction): CorporateAction {
  const ids = [...new Set([...providerIds(left), ...providerIds(right)])].sort(compareCodeUnits);
  const duplicateCount = (left.duplicateCount ?? 0) + (right.duplicateCount ?? 0) + 1;
  return {
    ...left,
    ...(ids.length > 0 ? { providerId: ids[0], providerIds: ids } : {}),
    duplicateCount,
  };
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
  const normalized = input.actions.map((action) => normalizeAction(action, provider)).sort(compareActions);
  const byEconomicIdentity = new Map<string, CorporateAction>();
  const providerIdentity = new Map<string, string>();
  for (const action of normalized) {
    const identity = economicIdentity(action);
    for (const id of providerIds(action)) {
      const providerKey = `${action.source}|${id}`;
      const previous = providerIdentity.get(providerKey);
      if (previous !== undefined) {
        throw new Error(previous === identity
          ? "BACKTEST_ACTION_PROVIDER_ID_DUPLICATE"
          : "BACKTEST_ACTION_PROVIDER_ID_CONFLICT");
      }
      providerIdentity.set(providerKey, identity);
    }
    const existing = byEconomicIdentity.get(identity);
    byEconomicIdentity.set(identity, existing ? mergeEconomicDuplicate(existing, action) : action);
  }
  const actions = [...byEconomicIdentity.values()].sort(compareActions);
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
  const excluded = new Set(excludedSourceSymbols(manifest.universe.symbolResolution));
  const activeSourceSymbols = manifest.universe.symbols.filter((sourceSymbol) => !excluded.has(sourceSymbol));
  const providerSymbols = new Set(activeSourceSymbols.map((sourceSymbol) => (
    providerSymbolForSource(manifest.universe.symbolResolution, sourceSymbol)
  )));
  if (actions.some((action) => !providerSymbols.has(action.symbol) && !activeSourceSymbols.includes(action.symbol))) {
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
  return actions
    .filter((action) => action.symbol === symbol && action.exDate === date)
    .slice()
    .sort(compareActions);
}

export interface CorporateActionDuplicateSummary {
  readonly duplicateCount: number;
  readonly providerDuplicateIds: readonly string[];
}

export function summarizeCorporateActionDuplicates(
  actions: readonly CorporateAction[],
): CorporateActionDuplicateSummary {
  const providerDuplicateIds = new Set<string>();
  let duplicateCount = 0;
  for (const action of actions) {
    duplicateCount += action.duplicateCount ?? 0;
    const ids = providerIds(action);
    for (const id of ids.slice(1)) providerDuplicateIds.add(id);
  }
  return {
    duplicateCount,
    providerDuplicateIds: [...providerDuplicateIds].sort(compareCodeUnits),
  };
}
