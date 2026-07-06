import assert from "node:assert/strict";
import test from "node:test";

test("portfolio inherits Full-time autonomy + uncapped, keeps multi-brand", async () => {
  const { getPlanEntitlements } = await import("./entitlements.js");
  const p = getPlanEntitlements("portfolio");

  assert.equal(p.agentAutonomy, "guarded_auto");
  assert.equal(p.standingInstructionsEnabled, true);
  // Full-time-level fair-use ceilings, applied per brand
  assert.equal(p.dishImageGenerationLimit, 1000);
  assert.equal(p.adProjectsPerMonth, 40);

  // Multi-brand still on (this is what makes it Head-of-group)
  assert.equal(p.multiBrandEnable, true);
  assert.equal(p.menuCloningEnabled, true);
  assert.equal(p.crossBrandAnalyticsEnabled, true);
  assert.equal(p.qrCodeGeneratorEnabled, true);
});

test("pending portfolio inherits Full-time base but multi-brand still gated off", async () => {
  const mod = await import("./entitlements.js");
  // getPendingPortfolioEntitlements is module-internal; assert via the state path:
  // pending_setup returns fulltime-level base without multi-brand.
  const pending = (mod as unknown as {
    getRestaurantEntitlements: (s: unknown) => Record<string, unknown>;
  }).getRestaurantEntitlements({
    operatorAccount: { status: "active", brands: [{}, {}] }, // 2 brands => pending_setup
  });
  assert.equal(pending.agentAutonomy, "guarded_auto");
  assert.equal(pending.multiBrandEnable, false);
});
