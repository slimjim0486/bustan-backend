import assert from "node:assert/strict";
import test from "node:test";

test("a Part-time (pro) sub in trial gets uncapped Full-time-level output", async () => {
  const { getRestaurantEntitlements } = await import("./entitlements.js");
  const ent = getRestaurantEntitlements({
    subscription: { plan: "pro", status: "trial" },
  });
  // Uncapped during trial
  assert.equal(ent.dishImageGenerationLimit, null);
  assert.equal(ent.adProjectsPerMonth, null);
  // But the stored plan identity is preserved (billing/UI truth)
  assert.equal(ent.plan, "pro");
});

test("an active (non-trial) pro sub keeps Pro caps", async () => {
  const { getRestaurantEntitlements } = await import("./entitlements.js");
  const ent = getRestaurantEntitlements({
    subscription: { plan: "pro", status: "active" },
  });
  assert.equal(ent.dishImageGenerationLimit, 300);
  assert.equal(ent.adProjectsPerMonth, 20);
});

test("a plan-less draft with trial status stays capped (free Trial-shift, not the paid trial)", async () => {
  const { getRestaurantEntitlements } = await import("./entitlements.js");
  const ent = getRestaurantEntitlements({ subscriptionStatus: "trial" }); // no subscription/plan
  assert.equal(ent.plan, null);
  assert.equal(ent.dishImageGenerationLimit, 10); // DRAFT_ENTITLEMENTS value, NOT null
  assert.equal(ent.adProjectsPerMonth, 0);
});
