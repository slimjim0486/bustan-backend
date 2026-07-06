import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("optInSchema requires a boolean enabled", async () => {
  const { optInSchema } = await import("./autonomy.js");
  assert.equal(optInSchema.parse({ enabled: true }).enabled, true);
  assert.throws(() => optInSchema.parse({ enabled: "yes" }));
  assert.throws(() => optInSchema.parse({}));
});

test("instructionSchema requires a string content", async () => {
  const { instructionSchema } = await import("./autonomy.js");
  assert.equal(instructionSchema.parse({ content: "Reply in Arabic" }).content, "Reply in Arabic");
  assert.throws(() => instructionSchema.parse({ content: 123 }));
});
