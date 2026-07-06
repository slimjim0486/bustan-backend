import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

// Pure decision matrix. decideAutoExecution lives in autonomy.ts (kept out of
// auto-execute.ts so this test needn't load the heavy glue deps).
const AUTO = {
  hasDraft: true, isDryRun: false, tier: 2, effective: "guarded_auto" as const, highImpact: false, paused: false,
};

test("passthrough when no draft", async () => {
  const { decideAutoExecution } = await import("./autonomy.js");
  assert.equal(decideAutoExecution({ ...AUTO, hasDraft: false }), "passthrough");
});
test("passthrough when dry run", async () => {
  const { decideAutoExecution } = await import("./autonomy.js");
  assert.equal(decideAutoExecution({ ...AUTO, isDryRun: true }), "passthrough");
});
test("passthrough when tier is not 2", async () => {
  const { decideAutoExecution } = await import("./autonomy.js");
  assert.equal(decideAutoExecution({ ...AUTO, tier: 1 }), "passthrough");
});
test("passthrough when account is draft_only", async () => {
  const { decideAutoExecution } = await import("./autonomy.js");
  assert.equal(decideAutoExecution({ ...AUTO, effective: "draft_only" }), "passthrough");
});
test("auto when guarded_auto tier-2 reversible", async () => {
  const { decideAutoExecution } = await import("./autonomy.js");
  assert.equal(decideAutoExecution(AUTO), "auto");
});
test("auto when guarded_auto high-impact but not paused", async () => {
  const { decideAutoExecution } = await import("./autonomy.js");
  assert.equal(decideAutoExecution({ ...AUTO, highImpact: true, paused: false }), "auto");
});
test("pause_to_draft when guarded_auto high-impact and paused", async () => {
  const { decideAutoExecution } = await import("./autonomy.js");
  assert.equal(decideAutoExecution({ ...AUTO, highImpact: true, paused: true }), "pause_to_draft");
});
