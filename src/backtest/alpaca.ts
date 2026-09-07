import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeMinuteBarRows, type MinuteBar } from "./bars.ts";
import { digestJson, sha256Hex } from "./fingerprints.ts";
import { parseCorporateActions, type CorporateAction } from "./corporateActions.ts";

const execFileAsync = promisify(execFile);
const ALPACA_CLI = "alpaca";

export interface AlpacaActionQuery {
  readonly symbols: readonly string[];
  readonly since: string;
  readonly until: string;
}

export interface AlpacaFetchReceipt {
  readonly provider: "alpaca";
  readonly accessMethod: "alpaca_cli";
  readonly evidenceClass: "REAL_PROVIDER_READ_ONLY";
  readonly command: "alpaca data corporate-actions";
  readonly commandFingerprint: string;
  readonly symbols: readonly string[];
  readonly since: string;
  readonly until: string;
  readonly pages: number;
  readonly status: number;
  readonly actionCount: number;
  readonly dataFingerprint: string;
  readonly retrievedAt: string;
}

export interface AlpacaFetchResult {
  readonly actions: readonly CorporateAction[];
  readonly receipt: AlpacaFetchReceipt;
}

export interface AlpacaBarsQuery {
  readonly symbol: string;
  readonly start: string;
  readonly end: string;
  readonly feed?: "sip";
}

export interface AlpacaBarsFetchReceipt {
  readonly provider: "alpaca";
  readonly accessMethod: "alpaca_cli";
  readonly evidenceClass: "REAL_PROVIDER_READ_ONLY";
  readonly command: "alpaca data bars";
  readonly commandFingerprint: string;
  readonly symbol: string;
  readonly start: string;
  readonly end: string;
  readonly feed: "sip";
  readonly adjustment: "raw";
  readonly pages: number;
  readonly barCount: number;
  readonly dataFingerprint: string;
  readonly retrievedAt: string;
}

export interface AlpacaBarsFetchResult {
  readonly bars: readonly MinuteBar[];
  readonly receipt: AlpacaBarsFetchReceipt;
}

export interface AlpacaCliRunner {
  (args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }>;
}

interface CliCorporateActionRow {
  readonly value: unknown;
  readonly responseType?: "forward_split" | "reverse_split" | "cash_dividend";
}

export class AlpacaProviderError extends Error {
  readonly status?: number;
  readonly evidenceClass = "UNVERIFIED_PROVIDER_ERROR" as const;

  constructor(code: string, status?: number) {
    super(code);
    this.name = "AlpacaProviderError";
    this.status = status;
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
    throw new AlpacaProviderError("ALPACA_" + label.toUpperCase() + "_INVALID");
  }
}

function normalizeQuery(query: AlpacaActionQuery): AlpacaActionQuery {
  validateDate(query.since, "since");
  validateDate(query.until, "until");
  if (query.until < query.since) throw new AlpacaProviderError("ALPACA_DATE_RANGE_INVALID");
  const symbols = query.symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean).sort();
  if (symbols.length === 0 || symbols.some((symbol) => !/^[A-Z][A-Z0-9._-]{0,15}$/.test(symbol))) {
    throw new AlpacaProviderError("ALPACA_SYMBOLS_INVALID");
  }
  return { symbols, since: query.since, until: query.until };
}

function normalizeTimestamp(value: string, label: string): string {
  if (!value.endsWith("Z")) throw new AlpacaProviderError("ALPACA_" + label.toUpperCase() + "_MUST_BE_UTC");
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) throw new AlpacaProviderError("ALPACA_" + label.toUpperCase() + "_INVALID");
  return new Date(epochMs).toISOString();
}

function normalizeBarsQuery(query: AlpacaBarsQuery): Required<AlpacaBarsQuery> {
  const symbol = query.symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9._-]{0,15}$/.test(symbol)) throw new AlpacaProviderError("ALPACA_SYMBOL_INVALID");
  const start = normalizeTimestamp(query.start, "start");
  const end = normalizeTimestamp(query.end, "end");
  if (end < start) throw new AlpacaProviderError("ALPACA_DATE_RANGE_INVALID");
  if (query.feed !== undefined && query.feed !== "sip") throw new AlpacaProviderError("ALPACA_FEED_UNSUPPORTED");
  return { symbol, start, end, feed: "sip" };
}

function cliArgs(query: AlpacaActionQuery, pageToken?: string): string[] {
  const args = [
    "data", "corporate-actions",
    "--symbols", query.symbols.join(","),
    "--types", "forward_split,reverse_split,cash_dividend",
    "--start", query.since,
    "--end", query.until,
    "--limit", "1000",
    "--sort", "asc",
    "--quiet",
  ];
  if (pageToken) args.push("--page-token", pageToken);
  return args;
}

function barsCliArgs(query: Required<AlpacaBarsQuery>, pageToken?: string): string[] {
  const args = [
    "data", "bars",
    "--symbol", query.symbol,
    "--start", query.start,
    "--end", query.end,
    "--timeframe", "1Min",
    "--feed", query.feed,
    "--adjustment", "raw",
    "--limit", "1000",
    "--sort", "asc",
    "--quiet",
  ];
  if (pageToken) args.push("--page-token", pageToken);
  return args;
}

function defaultRunner(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(ALPACA_CLI, [...args], {
    env,
    timeout: 40_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  }).then((result) => ({ stdout: String(result.stdout), stderr: String(result.stderr) }));
}

function cliEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = envValue(
    env,
    "ALPACA_API_KEY",
    "APCA_API_KEY_ID",
    "ALPACA_PAPER_API_KEY_ID",
    "ALPACA_MARKET_DATA_API_KEY",
  );
  const secret = envValue(
    env,
    "ALPACA_SECRET_KEY",
    "APCA_API_SECRET_KEY",
    "ALPACA_PAPER_API_SECRET_KEY",
    "ALPACA_MARKET_DATA_SECRET_KEY",
  );
  if (!key || !secret) throw new AlpacaProviderError("ALPACA_CREDENTIALS_MISSING");
  return {
    ...env,
    ALPACA_API_KEY: key,
    ALPACA_SECRET_KEY: secret,
    APCA_API_KEY_ID: key,
    APCA_API_SECRET_KEY: secret,
    ALPACA_QUIET: "1",
  };
}

const RESPONSE_GROUP_TYPES: Readonly<Record<string, CliCorporateActionRow["responseType"]>> = {
  forward_split: "forward_split",
  forward_splits: "forward_split",
  reverse_split: "reverse_split",
  reverse_splits: "reverse_split",
  cash_dividend: "cash_dividend",
  cash_dividends: "cash_dividend",
};

function parseGroupedRows(rawActions: Record<string, unknown>): readonly CliCorporateActionRow[] {
  const rows: CliCorporateActionRow[] = [];
  for (const [group, values] of Object.entries(rawActions)) {
    const responseType = RESPONSE_GROUP_TYPES[group.toLowerCase()];
    if (!responseType) throw new AlpacaProviderError("ALPACA_CLI_ACTION_GROUP_UNSUPPORTED");
    if (!Array.isArray(values)) throw new AlpacaProviderError("ALPACA_CLI_ACTION_GROUP_NOT_ARRAY");
    for (const value of values) rows.push({ value, responseType });
  }
  return rows;
}

function parseCliPage(stdout: string): { rows: readonly CliCorporateActionRow[]; nextPageToken?: string } {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new AlpacaProviderError("ALPACA_CLI_JSON_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AlpacaProviderError("ALPACA_CLI_RESPONSE_SHAPE_INVALID");
  }
  const record = value as Record<string, unknown>;
  const rawActions = record.corporate_actions;
  let rows: readonly CliCorporateActionRow[] | undefined;
  if (Array.isArray(rawActions)) {
    rows = rawActions.map((value) => ({ value }));
  } else if (rawActions && typeof rawActions === "object") {
    rows = parseGroupedRows(rawActions as Record<string, unknown>);
  }
  if (!rows) throw new AlpacaProviderError("ALPACA_CLI_CORPORATE_ACTIONS_MISSING");
  const next = record.next_page_token;
  return {
    rows,
    nextPageToken: typeof next === "string" && next ? next : undefined,
  };
}

function parseBarsCliPage(stdout: string): { rows: readonly unknown[]; nextPageToken?: string } {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new AlpacaProviderError("ALPACA_CLI_JSON_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AlpacaProviderError("ALPACA_CLI_RESPONSE_SHAPE_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.bars)) throw new AlpacaProviderError("ALPACA_CLI_BARS_MISSING");
  const next = record.next_page_token;
  return {
    rows: record.bars,
    nextPageToken: typeof next === "string" && next ? next : undefined,
  };
}

function normalizeAlpacaBars(rows: readonly unknown[], symbol: string): readonly MinuteBar[] {
  const symbolBoundRows = rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new AlpacaProviderError("ALPACA_CLI_BAR_ROW_INVALID");
    }
    const record = row as Record<string, unknown>;
    // `alpaca data bars --symbol X` omits the redundant symbol field in its
    // current single-symbol response. Bind only that omission to the exact
    // requested symbol; an explicit provider field remains independently
    // validated below.
    if (record.symbol === undefined && record.S === undefined) return { ...record, symbol };
    return record;
  });
  try {
    return normalizeMinuteBarRows(symbolBoundRows);
  } catch {
    throw new AlpacaProviderError("ALPACA_CLI_BAR_INVALID");
  }
}

function normalizeProviderRows(rows: readonly CliCorporateActionRow[]): readonly CorporateAction[] {
  const normalized = rows.map((row) => {
    if (!row.value || typeof row.value !== "object" || Array.isArray(row.value)) {
      throw new AlpacaProviderError("ALPACA_CLI_ACTION_ROW_INVALID");
    }
    const value = row.value as Record<string, unknown>;
    const inlineType = value.type ?? value.ca_type;
    const type = String(inlineType ?? row.responseType ?? "").toLowerCase();
    if (row.responseType && inlineType !== undefined && String(inlineType).toLowerCase() !== row.responseType) {
      throw new AlpacaProviderError("ALPACA_CLI_ACTION_TYPE_GROUP_MISMATCH");
    }
    if (!["forward_split", "reverse_split", "cash_dividend"].includes(type)) {
      throw new AlpacaProviderError("ALPACA_CLI_ACTION_TYPE_UNSUPPORTED");
    }
    return {
      ...value,
      type: type === "cash_dividend" ? "dividend" : "split",
      splitFactor: type === "cash_dividend" ? undefined : value.splitFactor,
      dividendPerShare: type === "cash_dividend"
        ? (value.cash ?? value.rate ?? value.amount ?? value.cash_amount)
        : undefined,
      source: "alpaca",
    };
  });
  return parseCorporateActions({ schemaVersion: 1, provider: "alpaca", actions: normalized }).actions;
}

export async function fetchAlpacaCorporateActions(
  query: AlpacaActionQuery,
  options: { env?: NodeJS.ProcessEnv; runner?: AlpacaCliRunner; maxPages?: number } = {},
): Promise<AlpacaFetchResult> {
  const env = options.env ?? process.env;
  const normalizedQuery = normalizeQuery(query);
  const maxPages = Math.min(100_000, Math.max(1, options.maxPages ?? 10_000));
  const runner = options.runner ?? defaultRunner;
  const childEnv = cliEnvironment(env);
  const rows: CliCorporateActionRow[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) throw new AlpacaProviderError("ALPACA_PAGE_LIMIT_REACHED");
    const args = cliArgs(normalizedQuery, pageToken);
    let result: { stdout: string; stderr: string };
    try {
      result = await runner(args, childEnv);
    } catch {
      throw new AlpacaProviderError("ALPACA_CLI_EXEC_FAILED");
    }
    pages += 1;
    const page = parseCliPage(result.stdout);
    rows.push(...page.rows);
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  const actions = normalizeProviderRows(rows);
  const fingerprintArgs = cliArgs(normalizedQuery).filter((value) => value !== "--quiet");
  const receipt: AlpacaFetchReceipt = {
    provider: "alpaca",
    accessMethod: "alpaca_cli",
    evidenceClass: "REAL_PROVIDER_READ_ONLY",
    command: "alpaca data corporate-actions",
    commandFingerprint: sha256Hex(fingerprintArgs.join("\u0000")),
    symbols: normalizedQuery.symbols,
    since: normalizedQuery.since,
    until: normalizedQuery.until,
    pages,
    status: 0,
    actionCount: actions.length,
    dataFingerprint: digestJson(actions),
    retrievedAt: new Date().toISOString(),
  };
  return { actions, receipt };
}

export async function fetchAlpacaBars(
  query: AlpacaBarsQuery,
  options: { env?: NodeJS.ProcessEnv; runner?: AlpacaCliRunner; maxPages?: number } = {},
): Promise<AlpacaBarsFetchResult> {
  const normalizedQuery = normalizeBarsQuery(query);
  const maxPages = Math.min(1_000, Math.max(1, options.maxPages ?? 10));
  const runner = options.runner ?? defaultRunner;
  const childEnv = cliEnvironment(options.env ?? process.env);
  const rows: unknown[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) throw new AlpacaProviderError("ALPACA_PAGE_LIMIT_REACHED");
    let result: { stdout: string; stderr: string };
    try {
      result = await runner(barsCliArgs(normalizedQuery, pageToken), childEnv);
    } catch {
      throw new AlpacaProviderError("ALPACA_CLI_EXEC_FAILED");
    }
    pages += 1;
    const page = parseBarsCliPage(result.stdout);
    rows.push(...page.rows);
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  const bars = normalizeAlpacaBars(rows, normalizedQuery.symbol).slice().sort((left, right) => left.epochMs - right.epochMs);
  const seen = new Set<string>();
  for (const bar of bars) {
    if (bar.symbol !== normalizedQuery.symbol) throw new AlpacaProviderError("ALPACA_CLI_BAR_SYMBOL_MISMATCH");
    if (bar.timestamp < normalizedQuery.start || bar.timestamp > normalizedQuery.end) {
      throw new AlpacaProviderError("ALPACA_CLI_BAR_OUTSIDE_QUERY_RANGE");
    }
    const key = bar.symbol + "|" + bar.timestamp;
    if (seen.has(key)) throw new AlpacaProviderError("ALPACA_CLI_BAR_DUPLICATE");
    seen.add(key);
  }
  const fingerprintArgs = barsCliArgs(normalizedQuery).filter((value) => value !== "--quiet");
  return {
    bars,
    receipt: {
      provider: "alpaca",
      accessMethod: "alpaca_cli",
      evidenceClass: "REAL_PROVIDER_READ_ONLY",
      command: "alpaca data bars",
      commandFingerprint: sha256Hex(fingerprintArgs.join("\u0000")),
      symbol: normalizedQuery.symbol,
      start: normalizedQuery.start,
      end: normalizedQuery.end,
      feed: normalizedQuery.feed,
      adjustment: "raw",
      pages,
      barCount: bars.length,
      dataFingerprint: digestJson(bars),
      retrievedAt: new Date().toISOString(),
    },
  };
}
