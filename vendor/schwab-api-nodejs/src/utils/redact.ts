const DEFAULT_REPLACEMENT = '[REDACTED]';

const SENSITIVE_KEYWORDS = [
  'authorization',
  'access_token',
  'refresh_token',
  'clientsecret',
  'client_secret',
  'secret',
  'token',
  'password',
  'cookie',
  'set-cookie',
];

const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /(access_token\"?\s*[:=]\s*\")(.*?)(\")/gi,
  /(refresh_token\"?\s*[:=]\s*\")(.*?)(\")/gi,
  /(client_secret\"?\s*[:=]\s*\")(.*?)(\")/gi,
  /(authorization\"?\s*[:=]\s*\")(.*?)(\")/gi,
  /(Bearer\s+)([A-Za-z0-9\-_.]+)/gi,
];

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function redactString(value: string, replacement: string): string {
  let result = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    result = result.replace(pattern, (_, prefix, _secret, suffix) => `${prefix}${replacement}${suffix}`);
  }
  return result;
}

function redactUnknown(value: unknown, replacement: string, visited: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      return redactString(value, replacement);
    }
    return value;
  }

  if (visited.has(value)) {
    return visited.get(value);
  }

  if (Array.isArray(value)) {
    const redactedArray = value.map((item) => redactUnknown(item, replacement, visited));
    visited.set(value, redactedArray);
    return redactedArray;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof URLSearchParams) {
    const clone = new URLSearchParams();
    value.forEach((paramValue, key) => {
      if (shouldRedactKey(key)) {
        clone.set(key, replacement);
      } else {
        clone.set(key, redactString(paramValue, replacement));
      }
    });
    return clone;
  }

  const result: Record<string, unknown> = {};
  visited.set(value, result);

  for (const [key, val] of Object.entries(value)) {
    if (shouldRedactKey(key)) {
      result[key] = replacement;
    } else {
      result[key] = redactUnknown(val, replacement, visited);
    }
  }

  return result;
}

export function redactSensitive<T>(value: T, replacement: string = DEFAULT_REPLACEMENT): T {
  return redactUnknown(value, replacement, new WeakMap()) as T;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (shouldRedactKey(key)) {
      result[key] = DEFAULT_REPLACEMENT;
    } else {
      result[key] = redactString(value, DEFAULT_REPLACEMENT);
    }
  }
  return result;
}
