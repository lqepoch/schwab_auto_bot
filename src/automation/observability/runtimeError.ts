const MAX_RUNTIME_ERROR_LENGTH = 500;

const AUTHORIZATION_PATTERN = /\bauthorization\s*[:=]\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|password|cookie|set-cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SECRET_QUERY_PATTERN = /([?&](?:code|access_token|refresh_token|client_secret)=)[^&\s]+/gi;
const ACCOUNT_PATH_PATTERN = /(\/accounts\/)[^/\s?]+/gi;

export function sanitizeRuntimeDiagnostic(value: string): string {
  const sanitized = value
    .replace(AUTHORIZATION_PATTERN, "Authorization=[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[REDACTED]")
    .replace(SECRET_QUERY_PATTERN, "$1[REDACTED]")
    .replace(ACCOUNT_PATH_PATTERN, "$1[REDACTED]")
    .replace(/[\r\n]+/g, " | ");
  return sanitized.length <= MAX_RUNTIME_ERROR_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_RUNTIME_ERROR_LENGTH - 3)}...`;
}

export function safeRuntimeError(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return sanitizeRuntimeDiagnostic(raw || "UNKNOWN_ERROR");
}
