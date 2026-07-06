import assert from "node:assert/strict";
import test from "node:test";

test("resolveCheckoutPriceId maps each plan to its configured price", async () => {
  process.env.STRIPE_PRO_PRICE_ID_V2 = "price_pro_v2";
  process.env.STRIPE_FULLTIME_PRICE_ID = "price_ft";
  process.env.STRIPE_STARTER_PRICE_ID = "price_starter";
  const { resolveCheckoutPriceId } = await import("./stripe.js");

  assert.equal(resolveCheckoutPriceId("pro"), "price_pro_v2");
  assert.equal(resolveCheckoutPriceId("fulltime"), "price_ft");
  assert.equal(resolveCheckoutPriceId("starter"), "price_starter");
});
