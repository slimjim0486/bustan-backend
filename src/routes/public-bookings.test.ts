import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("BOOKING_ID_RE accepts cuid-shaped ids and rejects garbage", async () => {
  const { BOOKING_ID_RE } = await import("./public-bookings.js");
  assert.ok(BOOKING_ID_RE.test("cmdz1a2b3c4d5e6f7g8h9"));
  assert.ok(!BOOKING_ID_RE.test("../etc"));
  assert.ok(!BOOKING_ID_RE.test("short"));
  assert.ok(!BOOKING_ID_RE.test("a".repeat(40)));
});

test("serializePublicBooking exposes only the safe public fields", async () => {
  const { serializePublicBooking } = await import("./public-bookings.js");

  const slotAt = new Date("2026-08-01T14:00:00Z");
  const booking = {
    id: "cmdz1a2b3c4d5e6f7g8h9",
    status: "CONFIRMED",
    slotAt,
    depositAed: 50,
    feeAed: 50,
    service: { name: "Blow-dry", durationMinutes: 45 },
    restaurant: {
      name: "Glow Salon",
      whatsappIntegration: { displayPhoneNumber: "+971501234567" },
    },
    customer: { displayName: "Fatima Al Mansouri" },
  };

  const payload = serializePublicBooking(booking as any);

  assert.deepEqual(payload, {
    id: "cmdz1a2b3c4d5e6f7g8h9",
    status: "CONFIRMED",
    slotAt,
    depositAed: 50,
    serviceName: "Blow-dry",
    durationMinutes: 45,
    businessName: "Glow Salon",
    businessWhatsApp: "+971501234567",
    customerFirstName: "Fatima",
  });
  assert.ok(!("feeAed" in payload));
});

test("serializePublicBooking is null-safe for missing whatsapp integration and customer name", async () => {
  const { serializePublicBooking } = await import("./public-bookings.js");

  const booking = {
    id: "cmdz1a2b3c4d5e6f7g8h9",
    status: "INQUIRY",
    slotAt: new Date("2026-08-01T14:00:00Z"),
    depositAed: 0,
    feeAed: 0,
    service: { name: "Haircut", durationMinutes: 30 },
    restaurant: { name: "Glow Salon", whatsappIntegration: null },
    customer: { displayName: "   " },
  };

  const payload = serializePublicBooking(booking as any);
  assert.equal(payload.businessWhatsApp, null);
  assert.equal(payload.customerFirstName, null);
});

test("rateLimitKeys: per-booking bucket varies by bookingId, per-IP bucket does not", async () => {
  const { rateLimitKeys } = await import("./public-bookings.js");

  const guessA = rateLimitKeys("1.2.3.4", "cmdz1a2b3c4d5e6f7g8h9");
  const guessB = rateLimitKeys("1.2.3.4", "cmdz9z8y7x6w5v4u3t2s1");
  const otherIp = rateLimitKeys("5.6.7.8", "cmdz1a2b3c4d5e6f7g8h9");

  // Different booking IDs from the same IP get different per-booking keys
  // (so bucket 1 alone would never engage against enumeration)...
  assert.notEqual(guessA.perBookingKey, guessB.perBookingKey);
  // ...but the per-IP bucket is identical across every guess from that IP,
  // which is what actually makes enumeration trip a limit.
  assert.equal(guessA.perIpKey, guessB.perIpKey);
  // A different IP gets its own per-IP bucket.
  assert.notEqual(guessA.perIpKey, otherIp.perIpKey);
});
