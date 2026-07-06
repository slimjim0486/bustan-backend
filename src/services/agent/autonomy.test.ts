import assert from "node:assert/strict";
import test from "node:test";

// Mirror the env preamble other unit tests use so importing modules that read
// env at load time (via @/lib/env) never crashes the runner.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/bustan_test";
process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
process.env.IP_HASH_PEPPER = "test-only-ip-hash-pepper-1234";

test("resolveEffectiveAutonomy: guarded_auto only when plan allows AND owner opted in", async () => {
  const { resolveEffectiveAutonomy } = await import("./autonomy.js");
  const { getPlanEntitlements } = await import("../../lib/entitlements.js");
  const guarded = getPlanEntitlements("fulltime"); // agentAutonomy: "guarded_auto"
  const drafty = getPlanEntitlements("pro"); // agentAutonomy: "draft_only"

  assert.equal(resolveEffectiveAutonomy({ agentAutonomyOptIn: true }, guarded), "guarded_auto");
  assert.equal(resolveEffectiveAutonomy({ agentAutonomyOptIn: false }, guarded), "draft_only");
  assert.equal(resolveEffectiveAutonomy({ agentAutonomyOptIn: true }, drafty), "draft_only");
  assert.equal(resolveEffectiveAutonomy({ agentAutonomyOptIn: false }, drafty), "draft_only");
});

test("high-impact action types get 5 minutes grace", async () => {
  const { isHighImpactActionType, graceMsForAutoExecute } = await import("./autonomy.js");
  assert.equal(isHighImpactActionType("whatsapp_campaign_send"), true);
  assert.equal(isHighImpactActionType("menu_items_delete"), true);
  assert.equal(isHighImpactActionType("dish_images_generate"), true);
  assert.equal(graceMsForAutoExecute("whatsapp_campaign_send"), 5 * 60 * 1000);
});

test("reversible edits get 60 seconds grace", async () => {
  const { isHighImpactActionType, graceMsForAutoExecute } = await import("./autonomy.js");
  assert.equal(isHighImpactActionType("menu_item_update"), false);
  assert.equal(graceMsForAutoExecute("menu_item_update"), 60 * 1000);
});
