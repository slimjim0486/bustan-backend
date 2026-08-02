import assert from "node:assert/strict";
import test from "node:test";
import { validateDepositSettlement } from "./deposit-settlement";

const valid = {
  bookingRestaurantId: "restaurant_1",
  relayedRestaurantId: "restaurant_1",
  expectedStripeSessionId: "cs_test_expected",
  relayedStripeSessionId: "cs_test_expected",
  depositAed: 50,
  amountTotalMinor: 5000,
  currency: "aed",
  paymentIntentId: "pi_test_123",
};

test("deposit settlement must bind tenant, session, amount, currency, and payment intent", () => {
  assert.equal(validateDepositSettlement(valid), null);
  assert.equal(validateDepositSettlement({ ...valid, relayedRestaurantId: "restaurant_2" }), "restaurant_mismatch");
  assert.equal(validateDepositSettlement({ ...valid, relayedStripeSessionId: "cs_other" }), "session_mismatch");
  assert.equal(validateDepositSettlement({ ...valid, amountTotalMinor: 4900 }), "amount_mismatch");
  assert.equal(validateDepositSettlement({ ...valid, currency: "usd" }), "currency_mismatch");
  assert.equal(validateDepositSettlement({ ...valid, paymentIntentId: null }), "missing_payment_intent");
});
