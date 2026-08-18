import { orderInfo, type Json, type OptionOrderInfo } from "./policy/order.ts";

export type OrderInfoResolver = (order: Json) => OptionOrderInfo | null;

type CacheEntry = Readonly<{
  signature: string;
  value: OptionOrderInfo | null;
}>;

/**
 * Cache OCC/vertical parsing for broker-order objects while remaining safe if
 * a caller mutates structural leg fields in place. Status, price and quantity
 * deliberately do not participate in the signature because OptionOrderInfo
 * does not derive them and policy validation reads those values live.
 *
 * WeakMap avoids retaining old broker snapshots after authority replacement.
 */
export class RuntimeOrderMetadataCache {
  private readonly entries = new WeakMap<Json, CacheEntry>();

  get(order: Json): OptionOrderInfo | null {
    const signature = structuralSignature(order);
    const cached = this.entries.get(order);
    if (cached?.signature === signature) return cached.value;

    const value = orderInfo(order);
    this.entries.set(order, { signature, value });
    return value;
  }
}

function structuralSignature(order: Json): string {
  const legs = order.orderLegCollection;
  if (!Array.isArray(legs)) return `invalid:${typeof legs}`;
  return legs.map((leg: Json) => [
    String(leg?.instruction ?? ""),
    String(leg?.instrument?.symbol ?? ""),
  ].join("\u001f")).join("\u001e");
}
