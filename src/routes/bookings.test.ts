import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("listQuerySchema parses dates and a status CSV", async () => {
  const { listQuerySchema } = await import("./bookings.js");
  const parsed = listQuerySchema.parse({
    from: "2026-07-29T20:00:00Z",
    to: "2026-08-05T20:00:00Z",
    status: "CONFIRMED,NO_SHOW",
  });
  assert.ok(parsed.from instanceof Date);
  assert.deepEqual(parsed.statuses, ["CONFIRMED", "NO_SHOW"]);
  assert.deepEqual(listQuerySchema.parse({}).statuses, undefined);
  assert.throws(() => listQuerySchema.parse({ status: "CONFIRMED,BOGUS" }));
});

test("manualBookingSchema requires phone, name, service, slot", async () => {
  const { manualBookingSchema } = await import("./bookings.js");
  const parsed = manualBookingSchema.parse({
    customerPhone: "0501234567",
    customerName: "Fatima",
    serviceId: "svc_1",
    slotAt: "2026-08-01T14:00:00Z",
  });
  assert.ok(parsed.slotAt instanceof Date);
  assert.throws(() => manualBookingSchema.parse({ customerName: "x" }));
});

test("resolveSchema accepts only COMPLETED or NO_SHOW", async () => {
  const { resolveSchema } = await import("./bookings.js");
  assert.equal(resolveSchema.parse({ status: "COMPLETED" }).status, "COMPLETED");
  assert.equal(resolveSchema.parse({ status: "NO_SHOW" }).status, "NO_SHOW");
  assert.throws(() => resolveSchema.parse({ status: "CANCELLED" }));
});
