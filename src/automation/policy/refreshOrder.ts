import type { OptionOrderInfo } from "./order.ts";

export const REQUIRED_REFRESH_SPREAD_WIDTH = 1;

export function refreshSpreadWidth(
  meta: Pick<OptionOrderInfo, "lowerStrike" | "higherStrike">,
): number {
  return Number((meta.higherStrike - meta.lowerStrike).toFixed(8));
}

export function isRefreshSpreadEligible(
  meta: Pick<OptionOrderInfo, "lowerStrike" | "higherStrike">,
): boolean {
  return Math.abs(refreshSpreadWidth(meta) - REQUIRED_REFRESH_SPREAD_WIDTH) < 1e-9;
}

export class RefreshSpreadSkipTracker {
  private readonly reported = new Set<string>();

  shouldReport(
    orderId: string,
    meta: Pick<OptionOrderInfo, "lowerStrike" | "higherStrike">,
  ): boolean {
    if (isRefreshSpreadEligible(meta)) return false;
    const key = `${orderId}:${refreshSpreadWidth(meta)}`;
    if (this.reported.has(key)) return false;
    this.reported.add(key);
    return true;
  }
}
