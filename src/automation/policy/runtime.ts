import { ENTRY_PRICE_MAX_CENTS, ENTRY_PRICE_MIN_CENTS } from "./entryPrice.ts";

const executionTimeZone = "America/New_York";

export type StrikeRange = Readonly<{ minimum: number; maximum: number }>;

export type RuntimePolicy = {
  underlyings: ReadonlySet<string>;
  strikeMin: number;
  strikeMax: number;
  strikeRanges: ReadonlyMap<string, readonly StrikeRange[]>;
  entryNotionalMin: number;
  entryNotionalMax: number;
  executionStart: string;
  executionEnd: string;
  orderCooldownMs: number;
  roundCooldownMs: number;
  fixedPriceRefreshIntervalMs: number;
  maxRefreshRounds: number | null;
  repeatBuyAtOrderPrice: boolean;
  disableSellOrders: boolean;
  isWithinStrikeRange: (underlying: string, lowerStrike: number, higherStrike: number) => boolean;
  isExecutionWindowOpen: (now?: Date) => boolean;
  requireExecutionWindow: (now?: Date) => void;
};

export function parseRuntimePolicy(argv: readonly string[]): RuntimePolicy {
  const configuredStrikeRanges = option(argv, "--refresh-strike-ranges");
  if (configuredStrikeRanges !== undefined && ["--underlyings", "--strike-min", "--strike-max"].some((name) => argv.includes(name))) {
    throw new Error("REFRESH_STRIKE_RANGES_CONFLICT");
  }
  const parsedStrikeRanges = configuredStrikeRanges === undefined ? null : parseRefreshStrikeRanges(configuredStrikeRanges);
  const underlyings = parsedStrikeRanges === null
    ? parseUnderlyings(option(argv, "--underlyings") ?? "QQQ,SPY")
    : new Set(parsedStrikeRanges.keys());
  const strikeMin = parseNumber(option(argv, "--strike-min") ?? "720", "STRIKE_MIN_INVALID");
  const strikeMax = parseNumber(option(argv, "--strike-max") ?? "790", "STRIKE_MAX_INVALID");
  const entryNotionalMin = parseNumber(option(argv, "--entry-notional-min") ?? String(ENTRY_PRICE_MIN_CENTS), "ENTRY_NOTIONAL_MIN_INVALID");
  const entryNotionalMax = parseNumber(option(argv, "--entry-notional-max") ?? String(ENTRY_PRICE_MAX_CENTS), "ENTRY_NOTIONAL_MAX_INVALID");
  const executionStart = parseTime(option(argv, "--execution-start") ?? "09:15", "EXECUTION_START_INVALID");
  const executionEnd = parseTime(option(argv, "--execution-end") ?? "15:45", "EXECUTION_END_INVALID");
  const orderCooldownMs = parsePositiveSeconds(
    option(argv, "--order-cooldown-seconds") ?? "1",
    "ORDER_COOLDOWN_INVALID",
  );
  const roundCooldownMs = parsePositiveSeconds(
    option(argv, "--round-cooldown-seconds") ?? "5",
    "ROUND_COOLDOWN_INVALID",
  );
  const fixedPriceRefreshIntervalMs = parsePositiveSeconds(
    option(argv, "--fixed-price-refresh-interval-seconds") ?? "2",
    "FIXED_PRICE_REFRESH_INTERVAL_INVALID",
  );
  const maxRefreshRounds = parseOptionalPositiveInteger(
    option(argv, "--max-refresh-rounds"),
    "MAX_REFRESH_ROUNDS_INVALID",
  );
  const repeatBuyAtOrderPrice = argv.includes("--repeat-buy-at-order-price");
  const disableSellOrders = argv.includes("--disable-sell-orders");

  if (strikeMin > strikeMax) throw new Error("STRIKE_RANGE_INVALID");
  if (entryNotionalMin > entryNotionalMax) throw new Error("ENTRY_NOTIONAL_RANGE_INVALID");
  if (entryNotionalMin !== ENTRY_PRICE_MIN_CENTS || entryNotionalMax !== ENTRY_PRICE_MAX_CENTS) throw new Error("ENTRY_NOTIONAL_POLICY_FIXED");
  if (minutes(executionStart) >= minutes(executionEnd)) throw new Error("EXECUTION_WINDOW_INVALID");

  const strikeRanges = parsedStrikeRanges ?? new Map(
    [...underlyings].map((underlying) => [underlying, [{ minimum: strikeMin, maximum: strikeMax }]]),
  );
  const effectiveStrikeMin = Math.min(...[...strikeRanges.values()].flat().map((range) => range.minimum));
  const effectiveStrikeMax = Math.max(...[...strikeRanges.values()].flat().map((range) => range.maximum));
  const isWithinStrikeRange = (underlying: string, lowerStrike: number, higherStrike: number): boolean =>
    strikeRanges.get(underlying)?.some((range) => lowerStrike >= range.minimum && higherStrike <= range.maximum) ?? false;
  const isExecutionWindowOpen = (now = new Date()): boolean => isWithinExecutionWindow(now, executionStart, executionEnd);
  return {
    underlyings,
    strikeMin: effectiveStrikeMin,
    strikeMax: effectiveStrikeMax,
    strikeRanges,
    entryNotionalMin,
    entryNotionalMax,
    executionStart,
    executionEnd,
    orderCooldownMs,
    roundCooldownMs,
    fixedPriceRefreshIntervalMs,
    maxRefreshRounds,
    repeatBuyAtOrderPrice,
    disableSellOrders,
    isWithinStrikeRange,
    isExecutionWindowOpen,
    requireExecutionWindow(now = new Date()): void {
      if (!isExecutionWindowOpen(now)) throw new Error("EXECUTION_WINDOW_CLOSED");
    },
  };
}

export function isWithinInclusiveRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function isWithinExecutionWindow(now: Date, start: string, end: string): boolean {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: executionTimeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  if (!parts.weekday || ["Sat", "Sun"].includes(parts.weekday)) return false;
  const current = Number(parts.hour) * 60 + Number(parts.minute);
  return current >= minutes(start) && current < minutes(end);
}

function option(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`DUPLICATE_OPTION_${name.slice(2).toUpperCase().replaceAll("-", "_")}`);
  if (indexes.length === 0) return undefined;
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`OPTION_VALUE_MISSING_${name.slice(2).toUpperCase().replaceAll("-", "_")}`);
  return value;
}

function parseUnderlyings(raw: string): ReadonlySet<string> {
  const values = raw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !/^[A-Z]{1,6}$/.test(value))) {
    throw new Error("UNDERLYINGS_INVALID");
  }
  return new Set(values);
}

function parseRefreshStrikeRanges(raw: string): ReadonlyMap<string, readonly StrikeRange[]> {
  const entries = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("REFRESH_STRIKE_RANGES_INVALID");
  const ranges = new Map<string, StrikeRange[]>();
  for (const entry of entries) {
    const match = entry.match(/^([A-Za-z]{1,6}):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) throw new Error("REFRESH_STRIKE_RANGES_INVALID");
    const [, rawUnderlying, rawMinimum, rawMaximum] = match;
    const minimum = Number(rawMinimum);
    const maximum = Number(rawMaximum);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || minimum > maximum) {
      throw new Error("REFRESH_STRIKE_RANGES_INVALID");
    }
    const underlying = rawUnderlying.toUpperCase();
    const values = ranges.get(underlying) ?? [];
    values.push({ minimum, maximum });
    ranges.set(underlying, values);
  }
  return ranges;
}

function parseNumber(raw: string, code: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

function parseTime(raw: string, code: string): string {
  if (!/^\d{2}:\d{2}$/.test(raw)) throw new Error(code);
  const [hours, minutesValue] = raw.split(":").map(Number);
  if (hours > 23 || minutesValue > 59) throw new Error(code);
  return raw;
}

function parsePositiveSeconds(raw: string, code: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(code);
  return value * 1_000;
}

function parseOptionalPositiveInteger(raw: string | undefined, code: string): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) throw new Error(code);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function minutes(value: string): number {
  const [hours, minutesValue] = value.split(":").map(Number);
  return hours * 60 + minutesValue;
}
