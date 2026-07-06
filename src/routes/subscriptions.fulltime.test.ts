import assert from "node:assert/strict";
import test from "node:test";

// Regression guard for the final-review Critical: the webhook-sync schema used
// to persist a Stripe subscription rejected `plan: "fulltime"`, so a paid
// Full-time buyer's checkout.session.completed 400'd and no Subscription row
// was created. The enum must accept "fulltime".
test("webhookSchema accepts a fulltime checkout.session.completed payload", async () => {
  const { webhookSchema } = await import("./subscriptions.js");

  const parsed = webhookSchema.parse({
    type: "checkout.session.completed",
    data: {
      restaurantId: "clh0000000000000000000000", // cuid-shaped
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: "sub_test",
      plan: "fulltime",
      status: "trial",
    },
  });

  assert.equal(parsed.data.plan, "fulltime");
});

test("webhookSchema still accepts the existing plans", async () => {
  const { webhookSchema } = await import("./subscriptions.js");

  for (const plan of ["starter", "pro", "portfolio"] as const) {
    const parsed = webhookSchema.parse({
      type: "customer.subscription.updated",
      data: { plan, status: "active" },
    });
    assert.equal(parsed.data.plan, plan);
  }
});
