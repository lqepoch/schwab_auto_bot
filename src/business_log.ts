import type { OptionOrderInfo } from "./order_policy.ts";

export function formatFixedPriceReplace(meta: Pick<OptionOrderInfo, "key" | "underlying" | "lowerStrike" | "higherStrike">, price: number): string {
  return `刷新 ${formatStrategy(meta)} Replace ${price.toFixed(2)}`;
}

export function formatFixedPriceRebuy(meta: Pick<OptionOrderInfo, "key" | "underlying" | "lowerStrike" | "higherStrike">, price: number): string {
  return `补买 ${formatStrategy(meta)} ${price.toFixed(2)}`;
}

export function formatRefreshSpreadSkipped(
  meta: Pick<OptionOrderInfo, "key" | "underlying" | "lowerStrike" | "higherStrike">,
  orderId: string,
  spreadWidth: number,
): string {
  return `跳过刷新 ${formatStrategy(meta)} order=${orderId} 差价=${spreadWidth} 要求=1`;
}

function formatStrategy(meta: Pick<OptionOrderInfo, "key" | "underlying" | "lowerStrike" | "higherStrike">): string {
  const right = meta.key.split(":")[2] === "P" ? "Put" : "Call";
  return `${meta.underlying} ${formatStrike(meta.lowerStrike)}/${formatStrike(meta.higherStrike)} ${right}`;
}

function formatStrike(strike: number): string {
  return Number.isInteger(strike) ? String(strike) : String(strike);
}
