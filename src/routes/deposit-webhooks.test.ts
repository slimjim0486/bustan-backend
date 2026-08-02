import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("depositWebhookSchema accepts a valid checkout.session.completed payload", async () => {
  const { depositWebhookSchema } = await import("./deposit-webhooks.js");
  const parsed = depositWebhookSchema.parse({
    type: "checkout.session.completed",
    data: {
      eventId: "evt_test_1234567890",
      bookingId: "booking_cuid_1234",
      restaurantId: "restaurant_cuid_1234",
      stripeSessionId: "cs_test_1234567890",
      paymentIntentId: "pi_test_1234567890",
      paymentStatus: "paid",
      amountTotal: 5000,
      currency: "aed",
    },
  });
  assert.equal(parsed.type, "checkout.session.completed");
  assert.equal(parsed.data.bookingId, "booking_cuid_1234");
  assert.equal(parsed.data.paymentStatus, "paid");
});

test("depositWebhookSchema rejects a missing bookingId", async () => {
  const { depositWebhookSchema } = await import("./deposit-webhooks.js");
  assert.throws(() =>
    depositWebhookSchema.parse({
      type: "checkout.session.completed",
      data: {
        eventId: "evt_test_1234567890",
        restaurantId: "restaurant_cuid_1234",
        stripeSessionId: "cs_test_1234567890",
        paymentIntentId: "pi_test_1234567890",
        paymentStatus: "paid",
        amountTotal: 5000,
        currency: "aed",
      },
    })
  );
});

test("depositWebhookSchema rejects an unknown event type", async () => {
  const { depositWebhookSchema } = await import("./deposit-webhooks.js");
  assert.throws(() =>
    depositWebhookSchema.parse({
      type: "checkout.session.expired",
      data: {
        bookingId: "booking_cuid_1234",
        restaurantId: "restaurant_cuid_1234",
        stripeSessionId: "cs_test_1234567890",
        paymentIntentId: "pi_test_1234567890",
        paymentStatus: "unpaid",
        amountTotal: 5000,
        currency: "aed",
      },
    })
  );
});
