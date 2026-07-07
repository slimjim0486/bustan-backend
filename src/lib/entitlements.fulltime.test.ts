import assert from "node:assert/strict";
import test from "node:test";

test("fulltime is Pro-level plus autonomy and fair-use output", async () => {
  const { getPlanEntitlements } = await import("./entitlements.js");
  const ft = getPlanEntitlements("fulltime");
  const pro = getPlanEntitlements("pro");

  // Autonomy on
  assert.equal(ft.agentAutonomy, "guarded_auto");
  assert.equal(ft.standingInstructionsEnabled, true);

  // Output raised well above Pro, but bounded by generous FAIR-USE ceilings on
  // the per-unit image/ad COGS surface (COO margins guardrail — not unbounded).
  assert.equal(ft.dishImageGenerationLimit, 1000); // vs Pro 300
  assert.equal(ft.imageEnhancementLimit, 300); // vs Pro 50
  assert.equal(ft.photoEnhancementMonthlyLimit, 300);
  assert.equal(ft.adProjectsPerMonth, 40); // vs Pro 20; highest-cost lever
  assert.equal(ft.adProjectMonthlyLimit, 40);
  assert.equal(ft.openaiImageMonthlyLimit, 300); // vs Pro 50
  // Cheap LLM text analyses stay truly uncapped
  assert.equal(ft.analysisLimit, null);
  assert.equal(ft.analysisMonthlyLimit, null);

  // Cost guardrail RETAINED (per-week USD/competitor caps must stay non-null)
  assert.equal(ft.sabtPackMaxCostUsdPerWeek, 1.0);
  assert.equal(ft.competitorIntelMaxCompetitors, 5);
  assert.equal(ft.competitorIntelManualRefreshesPerWeek, 1);

  // Top-tier SEO depth retained (portfolio inherits this next task — must not regress to 2)
  assert.equal(ft.seoAnalysisLimit, 4);

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
