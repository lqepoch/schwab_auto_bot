import { gunzipSync } from "node:zlib";
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { BacktestManifest } from "./manifest.ts";
import { compareCodeUnits, digestJson } from "./fingerprints.ts";
import { providerSymbolForSource } from "./symbolResolution.ts";

export interface MinuteBar {
  readonly timestamp: string;
  readonly epochMs: number;
  readonly symbol: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface ParsedBars {
  readonly bars: readonly MinuteBar[];
  readonly rawBytes: number;
  readonly dataFingerprint: string;
}

const REQUIRED_CSV_COLUMNS = ["timestamp", "symbol", "open", "high", "low", "close", "volume"] as const;

function parseFinite(value: unknown, field: string, line: number): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) throw new Error("BACKTEST_BAR_INVALID_" + field.toUpperCase() + "_LINE_" + line);
  return parsed;
}

function normalizeTimestamp(value: unknown, line: number): { timestamp: string; epochMs: number } {
  let text: string;
  try {
    text = value instanceof Date ? value.toISOString() : String(value ?? "").trim();
  } catch {
    throw new Error("BACKTEST_BAR_TIMESTAMP_INVALID_LINE_" + line);
  }
  if (!text || !text.endsWith("Z")) throw new Error("BACKTEST_BAR_TIMESTAMP_MUST_BE_UTC_LINE_" + line);
  const epochMs = Date.parse(text);
  if (!Number.isFinite(epochMs)) throw new Error("BACKTEST_BAR_TIMESTAMP_INVALID_LINE_" + line);
  const date = new Date(epochMs);
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
    throw new Error("BACKTEST_BAR_TIMESTAMP_NOT_MINUTE_ALIGNED_LINE_" + line);
  }
  return { timestamp: date.toISOString(), epochMs };
}

function normalizeSymbol(value: unknown, line: number): string {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9._-]{0,15}$/.test(symbol)) {
    throw new Error("BACKTEST_BAR_SYMBOL_INVALID_LINE_" + line);
  }
  return symbol;
}

function normalizeBar(value: Record<string, unknown>, line: number): MinuteBar {
  const timestamp = normalizeTimestamp(value.timestamp ?? value.t, line);
  const symbol = normalizeSymbol(value.symbol ?? value.S, line);
  const open = parseFinite(value.open ?? value.o, "open", line);
  const high = parseFinite(value.high ?? value.h, "high", line);
  const low = parseFinite(value.low ?? value.l, "low", line);
  const close = parseFinite(value.close ?? value.c, "close", line);
  const volume = parseFinite(value.volume ?? value.v, "volume", line);
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) {
    throw new Error("BACKTEST_BAR_PRICE_OR_VOLUME_OUT_OF_RANGE_LINE_" + line);
  }
  if (high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
    throw new Error("BACKTEST_BAR_OHLC_INCONSISTENT_LINE_" + line);
  }
  return { ...timestamp, symbol, open, high, low, close, volume };
}

export function normalizeMinuteBarRows(rows: readonly unknown[]): MinuteBar[] {
  return rows.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("BACKTEST_BAR_ROW_NOT_OBJECT_LINE_" + (index + 1));
    }
    return normalizeBar(value as Record<string, unknown>, index + 1);
  });
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quoted) throw new Error("BACKTEST_CSV_UNTERMINATED_QUOTE");
  fields.push(current);
  return fields;
}

function parseCsv(text: string): MinuteBar[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error("BACKTEST_CSV_HEADER_OR_DATA_MISSING");
  const header = splitCsvLine(lines[0]).map((value) => value.trim().toLowerCase());
  for (const required of REQUIRED_CSV_COLUMNS) {
    if (!header.includes(required)) throw new Error("BACKTEST_CSV_COLUMN_MISSING_" + required.toUpperCase());
  }
  return lines.slice(1).map((line, index) => {
    const fields = splitCsvLine(line);
    const row: Record<string, unknown> = {};
    for (let column = 0; column < header.length; column += 1) row[header[column]] = fields[column] ?? "";
    return normalizeBar(row, index + 2);
  });
}

function parseJsonl(text: string): MinuteBar[] {
  const values: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("BACKTEST_JSONL_INVALID_LINE_" + (index + 1));
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("BACKTEST_JSONL_ROW_NOT_OBJECT_LINE_" + (index + 1));
    }
    values.push(value);
  }
  if (values.length === 0) throw new Error("BACKTEST_JSONL_EMPTY");
  return normalizeMinuteBarRows(values);
}

function compareBars(left: MinuteBar, right: MinuteBar): number {
  return compareCodeUnits(left.symbol, right.symbol) || left.epochMs - right.epochMs;
}

export function validateAndSortBars(bars: MinuteBar[], manifest: BacktestManifest): readonly MinuteBar[] {
  const symbols = new Set(manifest.universe.symbols);
  for (const sourceSymbol of manifest.universe.symbols) {
    symbols.add(providerSymbolForSource(manifest.universe.symbolResolution, sourceSymbol));
  }
  const seen = new Set<string>();
  for (const bar of bars) {
    if (!symbols.has(bar.symbol)) throw new Error("BACKTEST_BAR_SYMBOL_NOT_IN_UNIVERSE_" + bar.symbol);
    const date = bar.timestamp.slice(0, 10);
    if (date < manifest.startDate || date > manifest.endDate) {
      throw new Error("BACKTEST_BAR_OUTSIDE_MANIFEST_RANGE_" + bar.timestamp);
    }
    const key = bar.symbol + "|" + bar.timestamp;
    if (seen.has(key)) throw new Error("BACKTEST_BAR_DUPLICATE_" + key);
    seen.add(key);
  }
  return bars.slice().sort(compareBars);
}

export function mergeParsedBars(
  parts: readonly ParsedBars[],
  manifest: BacktestManifest,
): ParsedBars {
  const bytes = parts.reduce((sum, part) => sum + part.rawBytes, 0);
  const allBars = parts.flatMap((part) => part.bars);
  const sorted = validateAndSortBars(allBars, manifest);
  return {
    bars: sorted,
    rawBytes: bytes,
    dataFingerprint: digestJson(sorted.map(({ timestamp, symbol, open, high, low, close, volume }) => ({
      timestamp, symbol, open, high, low, close, volume,
    }))),
  };
}

export function parseBars(bytes: Buffer, manifest: BacktestManifest): ParsedBars {
  if (manifest.sourceObject.format === "parquet") {
    throw new Error("BACKTEST_PARQUET_REQUIRES_ASYNC_PARSE");
  }
  const decoded = manifest.sourceObject.compression === "gzip" ? gunzipSync(bytes) : bytes;
  const text = decoded.toString("utf8");
  const bars = manifest.sourceObject.format === "csv" ? parseCsv(text) : parseJsonl(text);
  const sorted = validateAndSortBars(bars, manifest);
  return {
    bars: sorted,
    rawBytes: bytes.byteLength,
    dataFingerprint: digestJson(sorted.map(({ timestamp, symbol, open, high, low, close, volume }) => ({
      timestamp, symbol, open, high, low, close, volume,
    }))),
  };
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function isRegularArchiveSession(value: unknown): boolean {
  const session = String(value ?? "").trim().toLowerCase();
  // v1 archive objects used `intraday`; v2 calls the same official-session
  // bucket `regular`. Keep the compatibility mapping narrow and explicit.
  return session === "regular" || session === "intraday";
}

function selectParquetRows(rows: readonly unknown[], manifest: BacktestManifest): readonly unknown[] {
  const requestedFeed = manifest.sourceObject.feed;
  if (!requestedFeed) throw new Error("BACKTEST_PARQUET_SOURCE_FEED_REQUIRED");
  return rows.filter((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const record = row as Record<string, unknown>;
    const feed = String(record.feed ?? "").toLowerCase();
    if (feed !== requestedFeed) return false;
    const regular = isRegularArchiveSession(record.session);
    if (manifest.session === "regular") return regular;
    if (manifest.session === "extended") return !regular;
    return true;
  });
}

async function parseParquetBars(bytes: Buffer, manifest: BacktestManifest): Promise<ParsedBars> {
  if (manifest.sourceObject.compression !== "none") {
    throw new Error("BACKTEST_PARQUET_OUTER_COMPRESSION_UNSUPPORTED");
  }
  const file = toArrayBuffer(bytes);
  let rows: readonly unknown[];
  try {
    const metadata = await parquetMetadataAsync(file);
    const columns = parquetSchema(metadata).children.map((child) => child.element.name);
    const requiredColumns = ["symbol", "t", "session", "feed", "o", "h", "l", "c", "v"];
    if (requiredColumns.some((column) => !columns.includes(column))) {
      throw new Error("BACKTEST_PARQUET_REQUIRED_COLUMN_MISSING");
    }
    rows = await parquetReadObjects({
      file,
      compressors,
      columns: requiredColumns,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "BACKTEST_PARQUET_REQUIRED_COLUMN_MISSING") throw error;
    throw new Error("BACKTEST_PARQUET_READ_FAILED");
  }
  const selected = selectParquetRows(rows, manifest);
  if (selected.length === 0) throw new Error("BACKTEST_PARQUET_NO_ROWS_FOR_SESSION_OR_FEED");
  const sorted = validateAndSortBars(normalizeMinuteBarRows(selected), manifest);
  return {
    bars: sorted,
    rawBytes: bytes.byteLength,
    dataFingerprint: digestJson(sorted.map(({ timestamp, symbol, open, high, low, close, volume }) => ({
      timestamp, symbol, open, high, low, close, volume,
    }))),
  };
}

export async function parseBarsAsync(bytes: Buffer, manifest: BacktestManifest): Promise<ParsedBars> {
  return manifest.sourceObject.format === "parquet"
    ? parseParquetBars(bytes, manifest)
    : parseBars(bytes, manifest);
}

export function filterBars(
  bars: readonly MinuteBar[],
  options: { symbol?: string; startDate?: string; endDate?: string } = {},
): readonly MinuteBar[] {
  const symbol = options.symbol?.trim().toUpperCase();
  return bars.filter((bar) => {
    if (symbol && bar.symbol !== symbol) return false;
    const date = bar.timestamp.slice(0, 10);
    return (!options.startDate || date >= options.startDate) && (!options.endDate || date <= options.endDate);
  });
}

export function barSummary(bars: readonly MinuteBar[]): Record<string, unknown> {
  const symbols = [...new Set(bars.map((bar) => bar.symbol))].sort(compareCodeUnits);
  const bySymbol: Record<string, number> = {};
  for (const symbol of symbols) bySymbol[symbol] = bars.filter((bar) => bar.symbol === symbol).length;
  return {
    rowCount: bars.length,
    symbols,
    bySymbol,
    firstTimestamp: bars[0]?.timestamp ?? null,
    lastTimestamp: bars.at(-1)?.timestamp ?? null,
  };
}
