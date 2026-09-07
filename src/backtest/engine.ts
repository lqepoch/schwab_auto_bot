import { actionsForDate, type CorporateAction } from "./corporateActions.ts";
import type { MinuteBar } from "./bars.ts";
import type { BacktestManifest } from "./manifest.ts";

const SCALE = 1_000_000n;

export interface ReferenceSimulationOptions {
  readonly initialCash: number;
  readonly symbol: string;
}

export interface SimulationTrade {
  readonly side: "buy" | "sell";
  readonly timestamp: string;
  readonly quantity: number;
  readonly price: number;
  readonly notional: number;
}

export interface SimulationResult {
  readonly strategy: "long-only-cash-equity-v1";
  readonly symbol: string;
  readonly initialCash: number;
  readonly finalCash: number;
  readonly totalReturnPct: number;
  readonly maxDrawdownPct: number;
  readonly barsProcessed: number;
  readonly sharesBought: number;
  readonly trades: readonly SimulationTrade[];
  readonly assumptions: readonly string[];
}

function toUnits(value: number, label: string): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error("BACKTEST_" + label.toUpperCase() + "_INVALID");
  return BigInt(Math.round(value * Number(SCALE)));
}

function fromUnits(value: bigint): number {
  const result = Number(value) / Number(SCALE);
  return Object.is(result, -0) ? 0 : Number(result.toFixed(6));
}

function processActions(
  actions: readonly CorporateAction[],
  date: string,
  symbol: string,
  shares: bigint,
  cash: bigint,
): { shares: bigint; cash: bigint } {
  let nextShares = shares;
  let nextCash = cash;
  for (const action of actionsForDate(actions, symbol, date)) {
    if (action.type === "split") {
      const factor = toUnits(action.splitFactor as number, "SPLIT_FACTOR");
      nextShares = (nextShares * factor) / SCALE;
    } else if (nextShares > 0n) {
      nextCash += nextShares * toUnits(action.dividendPerShare as number, "DIVIDEND_AMOUNT");
    }
  }
  return { shares: nextShares, cash: nextCash };
}

export function simulateLongOnlyCashEquity(
  bars: readonly MinuteBar[],
  manifest: BacktestManifest,
  actions: readonly CorporateAction[],
  options: ReferenceSimulationOptions,
): SimulationResult {
  const symbol = options.symbol.trim().toUpperCase();
  const selected = bars.filter((bar) => bar.symbol === symbol);
  if (selected.length === 0) throw new Error("BACKTEST_SYMBOL_HAS_NO_BARS_" + symbol);
  if (!manifest.universe.symbols.includes(symbol)) throw new Error("BACKTEST_SYMBOL_NOT_IN_UNIVERSE_" + symbol);
  const initialCashUnits = toUnits(options.initialCash, "INITIAL_CASH");
  if (initialCashUnits <= 0n) throw new Error("BACKTEST_INITIAL_CASH_MUST_BE_POSITIVE");
  const applyActions = manifest.adjustmentMode === "raw" && manifest.corporateActions.mode !== "none";
  const assumptions = [
    "buy floor(cash / first bar open) whole shares",
    "hold through the selected minute range and liquidate at the final bar close",
    "no commission, slippage, borrow, financing, or broker writes",
    applyActions
      ? "raw bars apply the hashed split/dividend actions exactly once before each ex-date bar"
      : "bars are consumed at their declared adjustment mode; corporate actions are never applied a second time",
  ];
  let cash = initialCashUnits;
  let shares = 0n;
  let peak = initialCashUnits;
  let maxDrawdown = 0;
  let bought = 0n;
  const appliedActionDates = new Set<string>();
  const trades: SimulationTrade[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const bar = selected[index];
    const actionDate = bar.timestamp.slice(0, 10);
    if (applyActions && !appliedActionDates.has(actionDate)) {
      const adjusted = processActions(actions, bar.timestamp.slice(0, 10), symbol, shares, cash);
      shares = adjusted.shares;
      cash = adjusted.cash;
      appliedActionDates.add(actionDate);
    }
    const open = toUnits(bar.open, "BAR_PRICE");
    const close = toUnits(bar.close, "BAR_PRICE");
    if (index === 0) {
      shares = open > 0n ? cash / open : 0n;
      if (shares > 0n) {
        cash -= shares * open;
        bought = shares;
        trades.push({
          side: "buy",
          timestamp: bar.timestamp,
          quantity: Number(shares),
          price: fromUnits(open),
          notional: fromUnits(shares * open),
        });
      }
    }
    const marked = cash + shares * close;
    if (marked > peak) peak = marked;
    if (peak > 0n) maxDrawdown = Math.max(maxDrawdown, Number((peak - marked) * 10_000n / peak) / 100);
    if (index === selected.length - 1 && shares > 0n) {
      cash += shares * close;
      trades.push({
        side: "sell",
        timestamp: bar.timestamp,
        quantity: Number(shares),
        price: fromUnits(close),
        notional: fromUnits(shares * close),
      });
      shares = 0n;
    }
  }
  const finalCash = fromUnits(cash);
  const initialCash = fromUnits(initialCashUnits);
  const totalReturnPct = Number((((cash - initialCashUnits) * 10_000n) / initialCashUnits)) / 100;
  return {
    strategy: "long-only-cash-equity-v1",
    symbol,
    initialCash,
    finalCash,
    totalReturnPct: Number(totalReturnPct.toFixed(6)),
    maxDrawdownPct: Number(maxDrawdown.toFixed(6)),
    barsProcessed: selected.length,
    sharesBought: Number(bought),
    trades,
    assumptions,
  };
}
