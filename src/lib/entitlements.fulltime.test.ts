import assert from "node:assert/strict";
import test from "node:test";

test("fulltime is Pro-level plus autonomy and uncapped output", async () => {
  const { getPlanEntitlements } = await import("./entitlements.js");
  const ft = getPlanEntitlements("fulltime");
  const pro = getPlanEntitlements("pro");

  // Autonomy on
  assert.equal(ft.agentAutonomy, "guarded_auto");
  assert.equal(ft.standingInstructionsEnabled, true);

  // Output caps lifted vs Pro
  assert.equal(ft.dishImageGenerationLimit, null);
  assert.equal(ft.imageEnhancementLimit, null);
  assert.equal(ft.photoEnhancementMonthlyLimit, null);
  assert.equal(ft.adProjectsPerMonth, null);
  assert.equal(ft.adProjectMonthlyLimit, null);
  assert.equal(ft.openaiImageMonthlyLimit, null);

  // Priority above Pro
  assert.ok(ft.imageGenerationPriority > pro.imageGenerationPriority);
  assert.equal(ft.priorityImageGeneration, true);

  // Still single-brand (not portfolio)
  assert.equal(ft.multiBrandEnable, false);

  // Inherits Pro capabilities
  assert.equal(ft.menuAssistantEnabled, true);
  assert.equal(ft.adStudioEnabled, true);
  assert.equal(ft.arabicMenuEnabled, true);
});
