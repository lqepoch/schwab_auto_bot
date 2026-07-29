import assert from "node:assert/strict";
import test from "node:test";
import { classifyPreviewRejection, previewRejectionCooldownFromError, previewRejectionDetails, previewRejectionSummary } from "../src/preview_rejection.ts";

test("classifies Preview rejection text into a cooldown category", () => {
  assert.deepEqual(classifyPreviewRejection({ errors: [{ detail: "Insufficient buying power" }] }), { code: "INSUFFICIENT_FUNDS", cooldownMs: 15_000 });
  assert.deepEqual(classifyPreviewRejection({ validationRuleName: "Order already working" }), { code: "DUPLICATE_OR_STATE_CONFLICT", cooldownMs: 30_000 });
  assert.deepEqual(classifyPreviewRejection({ detail: "Invalid quantity for vertical" }), { code: "PRICE_OR_QUANTITY", cooldownMs: 300_000 });
  assert.deepEqual(classifyPreviewRejection({ detail: "Market closed temporarily" }), { code: "MARKET_TRANSIENT", cooldownMs: 30_000 });
  assert.deepEqual(classifyPreviewRejection({ detail: "unrecognized result" }), { code: "UNKNOWN", cooldownMs: 60_000 });
});

test("uses only the emitted cooldown token when routing a rejected task", () => {
  assert.equal(previewRejectionCooldownFromError(new Error("SCHWAB_PREVIEW_REJECTED cooldownMs=300000"), 30_000), 300_000);
  assert.equal(previewRejectionCooldownFromError(new Error("SCHWAB_PREVIEW_REJECTED"), 30_000), 30_000);
});

test("retains only allow-listed, redacted Schwab Preview rejection details", () => {
  const details = previewRejectionDetails({
    orderValidationResult: {
      rejects: [{
        validationRuleName: "VERTICAL_ORDER_RULE",
        message: "Account 123456789 rejected order 1007377900223",
        activityMessage: "Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
        originalSeverity: "ERROR",
        overrideName: "NO_OVERRIDE",
        overrideSeverity: "ERROR",
        ignored: "must not be persisted",
      }],
      reviews: [],
    },
  });

  assert.deepEqual(details, [{
    validationRuleName: "VERTICAL_ORDER_RULE",
    message: "Account [REDACTED_NUMBER] rejected order [REDACTED_NUMBER]",
    activityMessage: "Bearer [REDACTED]",
    originalSeverity: "ERROR",
    overrideName: "NO_OVERRIDE",
    overrideSeverity: "ERROR",
  }]);
  assert.equal(previewRejectionSummary(details), "VERTICAL_ORDER_RULE: Account [REDACTED_NUMBER] rejected order [REDACTED_NUMBER]");
});
