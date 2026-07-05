import assert from "node:assert/strict";
import test from "node:test";
import { deriveIdempotencyKey } from "@/services/agent/idempotency";

const base = { restaurantId: "r1", toolName: "send_whatsapp_campaign", args: { segment: "lapsed_30", templateName: "inactive_30" }, scope: "wamid.ABC" };

test("same inputs derive the same key (retry-safe)", () => {
  assert.equal(deriveIdempotencyKey(base), deriveIdempotencyKey({ ...base }));
});

test("argument order does not change the key", () => {
  const reordered = { ...base, args: { templateName: "inactive_30", segment: "lapsed_30" } };
  assert.equal(deriveIdempotencyKey(base), deriveIdempotencyKey(reordered));
});

test("different scope (different owner request) derives a different key", () => {
  assert.notEqual(deriveIdempotencyKey(base), deriveIdempotencyKey({ ...base, scope: "wamid.XYZ" }));
});

test("different restaurant derives a different key", () => {
  assert.notEqual(deriveIdempotencyKey(base), deriveIdempotencyKey({ ...base, restaurantId: "r2" }));
});

test("key is a stable hex digest, not raw PII", () => {
  const key = deriveIdempotencyKey(base);
  assert.match(key, /^[a-f0-9]{64}$/);
});
