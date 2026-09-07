import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted recursively. Run IDs and evidence hashes must
 * not depend on insertion order, runtime, or locale.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("NON_FINITE_JSON_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return "[" + value.map((item) => stableJson(item)).join(",") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item)).join(",") + "}";
  }
  throw new TypeError("UNSUPPORTED_JSON_VALUE:" + typeof value);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestJson(value: unknown): string {
  return sha256Hex(stableJson(value));
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
