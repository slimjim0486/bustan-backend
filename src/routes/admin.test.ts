import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("markPaidSchema accepts a valid PAID payload", async () => {
  const { markPaidSchema } = await import("./admin.js");
  const parsed = markPaidSchema.parse({ status: "PAID", reference: "IBAN-2026-08-01" });
  assert.equal(parsed.status, "PAID");
  assert.equal(parsed.reference, "IBAN-2026-08-01");
});

test("markPaidSchema rejects status PENDING", async () => {
  const { markPaidSchema } = await import("./admin.js");
  assert.throws(() => markPaidSchema.parse({ status: "PENDING", reference: "IBAN-2026-08-01" }));
});

test("markPaidSchema rejects an empty reference", async () => {
  const { markPaidSchema } = await import("./admin.js");
  assert.throws(() => markPaidSchema.parse({ status: "PAID", reference: "" }));
});

test("markPaidSchema rejects a reference over 200 chars", async () => {
  const { markPaidSchema } = await import("./admin.js");
  assert.throws(() => markPaidSchema.parse({ status: "PAID", reference: "x".repeat(201) }));
});
