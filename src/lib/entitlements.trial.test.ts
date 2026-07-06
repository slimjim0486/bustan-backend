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
