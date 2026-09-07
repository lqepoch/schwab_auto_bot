import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
}

export interface AlpacaFetchResult {
  readonly actions: readonly CorporateAction[];
  readonly receipt: AlpacaFetchReceipt;
}

export interface AlpacaCliRunner {
  (args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }>;
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

function defaultRunner(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(ALPACA_CLI, [...args], {
    env,
    timeout: 40_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  }).then((result) => ({ stdout: String(result.stdout), stderr: String(result.stderr) }));
}

function parseCliPage(stdout: string): { rows: readonly unknown[]; nextPageToken?: string } {
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
  const rows = Array.isArray(rawActions)
    ? rawActions
    : rawActions && typeof rawActions === "object"
      ? Object.values(rawActions as Record<string, unknown>)
      : undefined;
  if (!rows) throw new AlpacaProviderError("ALPACA_CLI_CORPORATE_ACTIONS_MISSING");
  const next = record.next_page_token;
  return {
    rows,
    nextPageToken: typeof next === "string" && next ? next : undefined,
  };
}

function normalizeProviderRows(rows: readonly unknown[]): readonly CorporateAction[] {
  const normalized = rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new AlpacaProviderError("ALPACA_CLI_ACTION_ROW_INVALID");
    }
    const value = row as Record<string, unknown>;
    const type = String(value.type ?? value.ca_type ?? "").toLowerCase();
    if (!["forward_split", "reverse_split", "cash_dividend"].includes(type)) {
      throw new AlpacaProviderError("ALPACA_CLI_ACTION_TYPE_UNSUPPORTED");
    }
    return {
      ...value,
      type: type === "cash_dividend" ? "dividend" : "split",
      splitFactor: type === "cash_dividend" ? undefined : value.splitFactor,
      dividendPerShare: type === "cash_dividend" ? (value.cash ?? value.amount ?? value.cash_amount) : undefined,
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
  const key = envValue(env, "ALPACA_API_KEY", "APCA_API_KEY_ID", "ALPACA_MARKET_DATA_API_KEY");
  const secret = envValue(env, "ALPACA_SECRET_KEY", "APCA_API_SECRET_KEY", "ALPACA_MARKET_DATA_SECRET_KEY");
  if (!key || !secret) throw new AlpacaProviderError("ALPACA_CREDENTIALS_MISSING");
  const normalizedQuery = normalizeQuery(query);
  const maxPages = Math.min(10, Math.max(1, options.maxPages ?? 10));
  const runner = options.runner ?? defaultRunner;
  const childEnv = {
    ...env,
    ALPACA_API_KEY: key,
    ALPACA_SECRET_KEY: secret,
    APCA_API_KEY_ID: key,
    APCA_API_SECRET_KEY: secret,
    ALPACA_QUIET: "1",
  };
  const rows: unknown[] = [];
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
  };
  return { actions, receipt };
}
