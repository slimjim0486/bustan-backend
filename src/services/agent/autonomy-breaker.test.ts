import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("hasHitBurstLimit: false below limit, true at/above", async () => {
  const { hasHitBurstLimit, HIGH_IMPACT_HOURLY_LIMIT } = await import("./autonomy.js");
  assert.equal(hasHitBurstLimit(HIGH_IMPACT_HOURLY_LIMIT - 1, HIGH_IMPACT_HOURLY_LIMIT), false);
  assert.equal(hasHitBurstLimit(HIGH_IMPACT_HOURLY_LIMIT, HIGH_IMPACT_HOURLY_LIMIT), true);
  assert.equal(hasHitBurstLimit(HIGH_IMPACT_HOURLY_LIMIT + 1, HIGH_IMPACT_HOURLY_LIMIT), true);
});

test("resolveWindowStart: uses now-window when no resume", async () => {
  const { resolveWindowStart } = await import("./autonomy.js");
  const now = new Date("2026-07-06T12:00:00Z");
  assert.equal(resolveWindowStart(now, null, 60 * 60 * 1000).toISOString(), "2026-07-06T11:00:00.000Z");
});

test("resolveWindowStart: uses resumedAt when more recent than the window", async () => {
  const { resolveWindowStart } = await import("./autonomy.js");
  const now = new Date("2026-07-06T12:00:00Z");
  const resumed = new Date("2026-07-06T11:50:00Z");
  assert.equal(resolveWindowStart(now, resumed, 60 * 60 * 1000).toISOString(), resumed.toISOString());
});

test("resolveWindowStart: ignores a stale resume older than the window", async () => {
  const { resolveWindowStart } = await import("./autonomy.js");
  const now = new Date("2026-07-06T12:00:00Z");
  const stale = new Date("2026-07-06T09:00:00Z");
  assert.equal(resolveWindowStart(now, stale, 60 * 60 * 1000).toISOString(), "2026-07-06T11:00:00.000Z");
});
