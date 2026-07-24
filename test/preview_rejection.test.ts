import assert from "node:assert/strict";
import test from "node:test";
import { classifyPreviewRejection, previewRejectionCooldownFromError } from "../src/preview_rejection.ts";

test("classifies Preview rejection text without retaining raw broker details", () => {
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
