const executionTimeZone = "America/New_York";

export type RuntimePolicy = {
  underlyings: ReadonlySet<string>;
  strikeMin: number;
  strikeMax: number;
  entryNotionalMin: number;
  entryNotionalMax: number;
  executionStart: string;
  executionEnd: string;
  orderCooldownMs: number;
  roundCooldownMs: number;
  isExecutionWindowOpen: (now?: Date) => boolean;
  requireExecutionWindow: (now?: Date) => void;
};

export function parseRuntimePolicy(argv: readonly string[]): RuntimePolicy {
  const underlyings = parseUnderlyings(option(argv, "--underlyings") ?? "QQQ,SPY");
  const strikeMin = parseNumber(option(argv, "--strike-min") ?? "720", "STRIKE_MIN_INVALID");
  const strikeMax = parseNumber(option(argv, "--strike-max") ?? "790", "STRIKE_MAX_INVALID");
  const entryNotionalMin = parseNumber(option(argv, "--entry-notional-min") ?? "84", "ENTRY_NOTIONAL_MIN_INVALID");
  const entryNotionalMax = parseNumber(option(argv, "--entry-notional-max") ?? "90", "ENTRY_NOTIONAL_MAX_INVALID");
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

  if (strikeMin > strikeMax) throw new Error("STRIKE_RANGE_INVALID");
  if (entryNotionalMin > entryNotionalMax) throw new Error("ENTRY_NOTIONAL_RANGE_INVALID");
  if (minutes(executionStart) >= minutes(executionEnd)) throw new Error("EXECUTION_WINDOW_INVALID");

  const isExecutionWindowOpen = (now = new Date()): boolean => isWithinExecutionWindow(now, executionStart, executionEnd);
  return {
    underlyings,
    strikeMin,
    strikeMax,
    entryNotionalMin,
    entryNotionalMax,
    executionStart,
    executionEnd,
    orderCooldownMs,
    roundCooldownMs,
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

function minutes(value: string): number {
  const [hours, minutesValue] = value.split(":").map(Number);
  return hours * 60 + minutesValue;
}
