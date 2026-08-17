import assert from "node:assert/strict";
import test from "node:test";
import {
  safeRuntimeError,
  sanitizeRuntimeDiagnostic,
} from "../src/automation/observability/runtimeError.ts";

test("runtime diagnostics redact OAuth credentials and authorization headers", () => {
  const value = sanitizeRuntimeDiagnostic(
    "authorization: Bearer abcdefghijklmnop access_token=abc123 refresh_token='refresh-secret' client_secret=topsecret",
  );
  assert.equal(
    value,
    "Authorization=[REDACTED] access_token=[REDACTED] refresh_token=[REDACTED] client_secret=[REDACTED]",
  );
});

test("runtime diagnostics redact callback codes and broker account path segments", () => {
  const value = sanitizeRuntimeDiagnostic(
    "GET https://127.0.0.1/callback?code=oauth-code&state=ok /trader/v1/accounts/account-hash/orders/123",
  );
  assert.match(value, /code=\[REDACTED\]/);
  assert.match(value, /\/accounts\/\[REDACTED\]\/orders\/123/);
  assert.doesNotMatch(value, /oauth-code|account-hash/);
});

test("safeRuntimeError renders one line and truncates oversized failures", () => {
  const rendered = safeRuntimeError(new Error(`socket failed\nrefresh_token=secret ${"x".repeat(700)}`));
  assert.match(rendered, /^Error: socket failed \| refresh_token=\[REDACTED\]/);
  assert.ok(rendered.length <= 500);
  assert.doesNotMatch(rendered, /secret/);
  assert.doesNotMatch(rendered, /\n/);
});

test("safeRuntimeError supports non-Error failures without exposing bearer tokens", () => {
  assert.equal(
    safeRuntimeError("Bearer abcdefghijklmnop"),
    "Bearer [REDACTED]",
  );
});
