import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { atomicWriteJson } from "../utils/atomicJson.ts";
import { compareCodeUnits, digestJson, sha256Hex } from "./fingerprints.ts";
import {
  parseCorporateActions,
  summarizeCorporateActionDuplicates,
  type CorporateAction,
} from "./corporateActions.ts";

const execFileAsync = promisify(execFile);

/**
 * This script asks yfinance for actions only. It deliberately never calls
 * `download()` or requests intraday prices; OSS remains the minute-bar source.
 */
const PYTHON_ACTION_SCRIPT = String.raw`
import json, sys
try:
    import yfinance as yf
except Exception as exc:
    print("YFINANCE_DEPENDENCY_MISSING", file=sys.stderr)
    raise SystemExit(2)
query = json.loads(sys.argv[1])
rows = []
results = []
for request in query["requests"]:
    archive_symbol = request["archiveSymbol"]
    query_symbol = request["querySymbol"]
    try:
        actions = yf.Ticker(query_symbol).actions
        if actions is None:
            results.append({"archiveSymbol": archive_symbol, "querySymbol": query_symbol, "status": "failed", "errorCode": "ACTIONS_OBJECT_MISSING", "rowCount": 0})
            continue
        row_count = 0
        for index, row in actions.iterrows():
            # yfinance exposes the exchange-local action date through the
            # timestamp index; retain that calendar date, never UTC-shift it.
            date = index.date().isoformat()
            if date < query["since"] or date > query["until"]:
                continue
            dividends = float(row.get("Dividends", 0) or 0)
            splits = float(row.get("Stock Splits", 0) or 0)
            if dividends > 0:
                rows.append({"symbol": archive_symbol, "exDate": date, "type": "dividend", "dividendPerShare": dividends, "source": "yfinance"})
                row_count += 1
            if splits > 0 and splits != 1:
                rows.append({"symbol": archive_symbol, "exDate": date, "type": "split", "splitFactor": splits, "source": "yfinance"})
                row_count += 1
        results.append({"archiveSymbol": archive_symbol, "querySymbol": query_symbol, "status": "success", "rowCount": row_count})
    except Exception:
        results.append({"archiveSymbol": archive_symbol, "querySymbol": query_symbol, "status": "failed", "errorCode": "TICKER_ACTIONS_FAILED", "rowCount": 0})
        continue
print(json.dumps({"actions": rows, "results": results}, separators=(",", ":")))
`;

export interface YFinanceActionQuery {
  readonly symbols: readonly string[];
  readonly since: string;
  readonly until: string;
  /** Explicit archive/provider symbol -> Yahoo query symbol; no dialect guessing. */
  readonly querySymbols?: Readonly<Record<string, string>>;
}

export interface YFinanceFetchReceipt {
  readonly provider: "yfinance";
  readonly accessMethod: "python";
  readonly evidenceClass: "REAL_PROVIDER_READ_ONLY";
  readonly command: "python -c yfinance.actions";
  readonly commandFingerprint: string;
  readonly interpreter: string;
  readonly symbols: readonly string[];
  readonly querySymbols: Readonly<Record<string, string>>;
  readonly symbolResults: readonly {
    readonly archiveSymbol: string;
    readonly querySymbol: string;
    readonly status: "success";
    readonly rowCount: number;
  }[];
  readonly batches: readonly {
    readonly symbols: readonly string[];
    readonly querySymbols: Readonly<Record<string, string>>;
    readonly commandFingerprint: string;
    readonly rawProviderRowCount: number;
    readonly status: "PASS";
  }[];
  readonly since: string;
  readonly until: string;
  readonly status: number;
  readonly rawProviderRowCount: number;
  readonly actionCount: number;
  readonly duplicateCount: number;
  readonly providerDuplicateIds: readonly string[];
  readonly dataFingerprint: string;
  readonly retrievedAt: string;
}

export interface YFinanceFetchResult {
  readonly actions: readonly CorporateAction[];
  readonly receipt: YFinanceFetchReceipt;
}

interface YFinanceBatchResult {
  readonly actions: readonly CorporateAction[];
  readonly rows: readonly Record<string, unknown>[];
  readonly symbolResults: readonly {
    readonly archiveSymbol: string;
    readonly querySymbol: string;
    readonly status: "success";
    readonly rowCount: number;
  }[];
}

export interface YFinanceRunner {
  (interpreter: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }>;
}

export class YFinanceProviderError extends Error {
  readonly evidenceClass = "UNVERIFIED_PROVIDER_ERROR" as const;

  constructor(code: string) {
    super(code);
    this.name = "YFinanceProviderError";
  }
}

function envValue(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function validateDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + "T00:00:00Z"))) {
    throw new YFinanceProviderError("YFINANCE_" + label.toUpperCase() + "_INVALID");
  }
}

function normalizeQuery(query: YFinanceActionQuery): YFinanceActionQuery {
  validateDate(query.since, "since");
  validateDate(query.until, "until");
  if (query.until < query.since) throw new YFinanceProviderError("YFINANCE_DATE_RANGE_INVALID");
  const symbols = query.symbols.map((value) => value.trim().toUpperCase()).filter(Boolean).sort(compareCodeUnits);
  if (symbols.length === 0 || symbols.some((value) => !/^[A-Z][A-Z0-9._-]{0,15}$/.test(value))) {
    throw new YFinanceProviderError("YFINANCE_SYMBOLS_INVALID");
  }
  if (new Set(symbols).size !== symbols.length) throw new YFinanceProviderError("YFINANCE_SYMBOLS_DUPLICATE");
  const requestedMap = query.querySymbols ?? {};
  const querySymbols: Record<string, string> = {};
  const queryTargets = new Set<string>();
  for (const [archiveSymbol, requestedSymbol] of Object.entries(requestedMap)) {
    const normalizedArchiveSymbol = archiveSymbol.trim().toUpperCase();
    const normalizedQuerySymbol = requestedSymbol.trim().toUpperCase();
    if (!symbols.includes(normalizedArchiveSymbol)) throw new YFinanceProviderError("YFINANCE_QUERY_SYMBOL_MAP_UNKNOWN_ARCHIVE_SYMBOL");
    if (!/^[A-Z][A-Z0-9._-]{0,15}$/.test(normalizedQuerySymbol)) throw new YFinanceProviderError("YFINANCE_QUERY_SYMBOL_MAP_INVALID");
    if (Object.hasOwn(querySymbols, normalizedArchiveSymbol)) {
      throw new YFinanceProviderError("YFINANCE_QUERY_SYMBOL_MAP_DUPLICATE_ARCHIVE_SYMBOL");
    }
    if (queryTargets.has(normalizedQuerySymbol)) {
      throw new YFinanceProviderError("YFINANCE_QUERY_SYMBOL_MAP_DUPLICATE_QUERY_SYMBOL");
    }
    querySymbols[normalizedArchiveSymbol] = normalizedQuerySymbol;
    queryTargets.add(normalizedQuerySymbol);
  }
  for (const archiveSymbol of symbols) {
    if (Object.hasOwn(querySymbols, archiveSymbol)) continue;
    if (queryTargets.has(archiveSymbol)) {
      throw new YFinanceProviderError("YFINANCE_QUERY_SYMBOL_MAP_DUPLICATE_QUERY_SYMBOL");
    }
    querySymbols[archiveSymbol] = archiveSymbol;
    queryTargets.add(archiveSymbol);
  }
  return { symbols, since: query.since, until: query.until, querySymbols };
}

function defaultRunner(interpreter: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(interpreter, [...args], {
    env,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  }).then((result) => ({ stdout: String(result.stdout), stderr: String(result.stderr) }));
}

interface RawSymbolResult {
  readonly archiveSymbol: string;
  readonly querySymbol: string;
  readonly status: "success" | "failed";
  readonly rowCount: number;
  readonly errorCode?: string;
}

function parseBatch(stdout: string): { readonly rows: readonly Record<string, unknown>[]; readonly results: readonly RawSymbolResult[] } {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new YFinanceProviderError("YFINANCE_JSON_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray((value as Record<string, unknown>).actions)
    || !Array.isArray((value as Record<string, unknown>).results)) {
    throw new YFinanceProviderError("YFINANCE_ACTIONS_RESPONSE_INVALID");
  }
  const rows = (value as Record<string, unknown>).actions as unknown[];
  if (rows.some((row: unknown) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new YFinanceProviderError("YFINANCE_ACTION_ROW_INVALID");
  }
  const resultValues = (value as Record<string, unknown>).results as unknown[];
  const results = resultValues.map((item): RawSymbolResult => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new YFinanceProviderError("YFINANCE_SYMBOL_RESULT_INVALID");
    const record = item as Record<string, unknown>;
    if (typeof record.archiveSymbol !== "string" || typeof record.querySymbol !== "string"
      || (record.status !== "success" && record.status !== "failed")
      || typeof record.rowCount !== "number" || !Number.isSafeInteger(record.rowCount) || record.rowCount < 0) {
      throw new YFinanceProviderError("YFINANCE_SYMBOL_RESULT_INVALID");
    }
    return {
      archiveSymbol: record.archiveSymbol,
      querySymbol: record.querySymbol,
      status: record.status,
      rowCount: record.rowCount,
      ...(typeof record.errorCode === "string" ? { errorCode: record.errorCode } : {}),
    };
  });
  return { rows: rows as Record<string, unknown>[], results };
}

function stderrFromError(error: unknown): string {
  if (!error || typeof error !== "object" || !("stderr" in error)) return "";
  const stderr = (error as { readonly stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : String(stderr ?? "");
}

function boundedInteger(value: number | undefined, fallback: number, max: number, code: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new YFinanceProviderError(code);
  return result;
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<readonly R[]> {
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

export async function fetchYfinanceCorporateActions(
  query: YFinanceActionQuery,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly interpreter?: string;
    readonly runner?: YFinanceRunner;
    readonly batchSize?: number;
    readonly concurrency?: number;
  } = {},
): Promise<YFinanceFetchResult> {
  const env = options.env ?? process.env;
  const normalizedQuery = normalizeQuery(query);
  const interpreter = (options.interpreter ?? envValue(env, "BACKTEST_YFINANCE_PYTHON", "YFINANCE_PYTHON") ?? "python3").trim();
  if (!interpreter || interpreter.startsWith("-")) throw new YFinanceProviderError("YFINANCE_PYTHON_INVALID");
  const batchSize = boundedInteger(options.batchSize, 50, 100, "YFINANCE_BATCH_SIZE_INVALID");
  const concurrency = boundedInteger(options.concurrency, 2, 4, "YFINANCE_CONCURRENCY_INVALID");
  const requests = normalizedQuery.symbols.map((archiveSymbol) => ({
    archiveSymbol,
    querySymbol: normalizedQuery.querySymbols?.[archiveSymbol] ?? archiveSymbol,
  }));
  const requestBatches = Array.from({ length: Math.ceil(requests.length / batchSize) }, (_, index) => requests.slice(index * batchSize, (index + 1) * batchSize));
  const batches = await mapConcurrent(requestBatches, concurrency, async (batch): Promise<YFinanceBatchResult & { readonly fingerprint: string }> => {
    const payload = {
      requests: batch,
      since: normalizedQuery.since,
      until: normalizedQuery.until,
    };
    const args = ["-c", PYTHON_ACTION_SCRIPT, JSON.stringify(payload)];
    let result: { stdout: string; stderr: string };
    try {
      result = await (options.runner ?? defaultRunner)(interpreter, args, { ...env, PYTHONUNBUFFERED: "1" });
    } catch (error) {
      if (stderrFromError(error).includes("YFINANCE_DEPENDENCY_MISSING")) {
        throw new YFinanceProviderError("YFINANCE_DEPENDENCY_MISSING");
      }
      throw new YFinanceProviderError("YFINANCE_PYTHON_EXEC_FAILED");
    }
    if (result.stderr.includes("YFINANCE_DEPENDENCY_MISSING")) throw new YFinanceProviderError("YFINANCE_DEPENDENCY_MISSING");
    const parsed = parseBatch(result.stdout);
    if (parsed.results.length !== batch.length || parsed.results.some((item, index) => (
      item.archiveSymbol !== batch[index]?.archiveSymbol || item.querySymbol !== batch[index]?.querySymbol || item.status !== "success"
    ))) {
      throw new YFinanceProviderError("YFINANCE_SYMBOL_FETCH_FAILED");
    }
    const actionRows = parsed.rows;
    const expectedRawRowCount = parsed.results.reduce((sum, item) => sum + item.rowCount, 0);
    if (expectedRawRowCount !== actionRows.length) {
      throw new YFinanceProviderError("YFINANCE_RAW_ROW_COUNT_MISMATCH");
    }
    const batchSymbols = new Set(batch.map((item) => item.archiveSymbol));
    if (actionRows.some((row) => typeof row.symbol !== "string" || !batchSymbols.has(row.symbol.toUpperCase()))) {
      throw new YFinanceProviderError("YFINANCE_ACTION_SYMBOL_OUTSIDE_BATCH");
    }
    let actions: readonly CorporateAction[];
    try {
      actions = parseCorporateActions({ schemaVersion: 1, provider: "yfinance", actions: actionRows }).actions;
    } catch {
      throw new YFinanceProviderError("YFINANCE_ACTION_NORMALIZATION_FAILED");
    }
    return {
      actions,
      rows: actionRows,
      symbolResults: parsed.results.map((item) => ({
        archiveSymbol: item.archiveSymbol,
        querySymbol: item.querySymbol,
        status: "success",
        rowCount: item.rowCount,
      })),
      fingerprint: digestJson({ interpreter, payload }),
    };
  });
  const rows = batches.flatMap((batch) => batch.rows);
  const actions = parseCorporateActions({ schemaVersion: 1, provider: "yfinance", actions: rows }).actions;
  for (const action of actions) {
    if (!normalizedQuery.symbols.includes(action.symbol) || action.exDate < normalizedQuery.since || action.exDate > normalizedQuery.until) {
      throw new YFinanceProviderError("YFINANCE_ACTION_OUTSIDE_QUERY");
    }
  }
  const duplicateSummary = summarizeCorporateActionDuplicates(actions);
  return {
    actions,
    receipt: {
      provider: "yfinance",
      accessMethod: "python",
      evidenceClass: "REAL_PROVIDER_READ_ONLY",
      command: "python -c yfinance.actions",
      commandFingerprint: digestJson({ interpreter, query: normalizedQuery, batches: batches.map((batch) => batch.fingerprint), command: "yfinance.actions" }),
      interpreter,
      symbols: normalizedQuery.symbols,
      querySymbols: normalizedQuery.querySymbols ?? {},
      symbolResults: batches.flatMap((batch) => batch.symbolResults),
      since: normalizedQuery.since,
      until: normalizedQuery.until,
      status: 0,
      rawProviderRowCount: rows.length,
      actionCount: actions.length,
      duplicateCount: duplicateSummary.duplicateCount,
      providerDuplicateIds: duplicateSummary.providerDuplicateIds,
      dataFingerprint: digestJson(actions),
      retrievedAt: new Date().toISOString(),
      batches: batches.map((batch) => ({
        symbols: batch.symbolResults.map((item) => item.archiveSymbol),
        querySymbols: Object.fromEntries(batch.symbolResults.map((item) => [item.archiveSymbol, item.querySymbol])),
        commandFingerprint: batch.fingerprint,
        rawProviderRowCount: batch.rows.length,
        status: "PASS",
      })),
    },
  };
}

export async function writeFetchedYfinanceActions(
  outputPath: string,
  result: YFinanceFetchResult,
): Promise<{ readonly path: string; readonly sha256: string }> {
  await atomicWriteJson(outputPath, {
    schemaVersion: 1,
    provider: "yfinance",
    coverage: {
      symbols: result.receipt.symbols,
      querySymbols: result.receipt.querySymbols,
      symbolResults: result.receipt.symbolResults,
      batches: result.receipt.batches,
      since: result.receipt.since,
      until: result.receipt.until,
      queryFingerprint: result.receipt.commandFingerprint,
      interpreter: result.receipt.interpreter,
    },
    actions: result.actions,
  }, { directoryMode: 0o750, fileMode: 0o640, pretty: true });
  const bytes = await readFile(outputPath);
  return { path: outputPath, sha256: sha256Hex(bytes) };
}

export { PYTHON_ACTION_SCRIPT };
