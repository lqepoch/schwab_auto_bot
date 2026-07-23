/**
 * 将任意对象序列化为稳定的 JSON 字符串，确保键的顺序一致。
 * 这对于生成缓存键或比较对象内容十分有用。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, val]) => [key, stableStringify(val)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${val}`).join(',')}}`;
}

/**
 * 使用 JSON 序列化方式深拷贝参数，避免外部修改影响缓存值。
 *
 * 注意：该方式无法保留 `Date`、`Map`、`Set`、`undefined`、`BigInt` 或函数等特殊类型，
 * 仅适用于包含普通 JSON 值的简单对象。
 */
export function cloneParameters<T extends Record<string, unknown> | undefined>(value: T): T {
  if (!value) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}
