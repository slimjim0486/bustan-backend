import assert from "node:assert/strict";
import test from "node:test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("deposit session params: one-off AED payment with booking metadata everywhere", async () => {
  const { buildDepositSessionParams } = await import("./deposits.js");
  const params = buildDepositSessionParams({
    bookingId: "bk1", restaurantId: "r1", businessName: "Glow Salon", serviceName: "Blow-dry",
    depositAed: 50, successUrl: "https://getbustan.com/booking/bk1?paid=1",
    cancelUrl: "https://getbustan.com/pay/bk1?cancelled=1", nowUnix: 1_800_000_000,
  });
  assert.equal(params.mode, "payment");
  const item = params.line_items?.[0];
  assert.equal(item?.price_data?.currency, "aed");
  assert.equal(item?.price_data?.unit_amount, 5000); // 50 AED in fils
  assert.equal(params.metadata?.kind, "booking_deposit");
  assert.equal(params.metadata?.bookingId, "bk1");
  assert.equal(params.metadata?.restaurantId, "r1");
  assert.equal(params.payment_intent_data?.metadata?.bookingId, "bk1");
  assert.equal(params.expires_at, 1_800_000_000 + 3600); // 1h session; 6h booking hold is pg-boss's job
});
