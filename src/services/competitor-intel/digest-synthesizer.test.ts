// Unit tests for the Haiku-response parser + the deterministic fallback.
// Both are pure; no DB / no LLM. Covers the failure modes that would
// otherwise cause owner-visible regressions (mal-formed model output,
// untrusted ctaParams overriding safe defaults).

import assert from "node:assert/strict";
import test from "node:test";
import { fallbackDigest, parseSynthResponse } from "./digest-synthesizer";

test("parseSynthResponse — parses clean JSON with valid action", () => {
  const raw = JSON.stringify({
    topInsight: "3 nearby competitors launched lunch promos this week.",
    hasMovement: true,
    recommendedAction: {
      label: "Draft a matching lunch promo",
      ctaRoute: "/dashboard/ad-studio/new",
      ctaParams: { from: "market-pulse", intent: "lunch_promo_match" },
    },
  });
  const result = parseSynthResponse(raw);
  assert.ok(result);
  assert.equal(result.hasMovement, true);
  assert.equal(result.topInsight, "3 nearby competitors launched lunch promos this week.");
  assert.ok(result.recommendedAction);
  assert.equal(result.recommendedAction.label, "Draft a matching lunch promo");
  assert.equal(result.recommendedAction.ctaRoute, "/dashboard/ad-studio/new");
  assert.equal(result.recommendedAction.ctaParams.intent, "lunch_promo_match");
});

test("parseSynthResponse — strips code-fence wrapping", () => {
  const raw =
    "```json\n" +
    JSON.stringify({
      topInsight: "Quiet week.",
      hasMovement: false,
      recommendedAction: null,
    }) +
    "\n```";
  const result = parseSynthResponse(raw);
  assert.ok(result);
  assert.equal(result.hasMovement, false);
  assert.equal(result.recommendedAction, null);
});

test("parseSynthResponse — returns null on malformed JSON", () => {
  assert.equal(parseSynthResponse("not json at all"), null);
  assert.equal(parseSynthResponse(""), null);
  assert.equal(parseSynthResponse("{"), null);
});

test("parseSynthResponse — returns null when topInsight missing", () => {
  const raw = JSON.stringify({ hasMovement: true, recommendedAction: null });
  assert.equal(parseSynthResponse(raw), null);
});

test("parseSynthResponse — returns null when hasMovement is not a boolean", () => {
  const raw = JSON.stringify({ topInsight: "X", hasMovement: "yes" });
  assert.equal(parseSynthResponse(raw), null);
});

test("parseSynthResponse — drops recommendedAction when hasMovement is false", () => {
  const raw = JSON.stringify({
    topInsight: "Nothing to see here.",
    hasMovement: false,
    // Model included an action despite hasMovement=false — should be ignored.
    recommendedAction: {
      label: "Open Ad Studio",
      ctaRoute: "/dashboard/ad-studio/new",
      ctaParams: { from: "market-pulse", intent: "generic_competitor_response" },
    },
  });
  const result = parseSynthResponse(raw);
  assert.ok(result);
  assert.equal(result.recommendedAction, null);
});

test("parseSynthResponse — caps topInsight at 200 chars", () => {
  const longInsight = "x".repeat(400);
  const raw = JSON.stringify({
    topInsight: longInsight,
    hasMovement: false,
    recommendedAction: null,
  });
  const result = parseSynthResponse(raw);
  assert.ok(result);
  assert.equal(result.topInsight.length, 200);
});

test("parseSynthResponse — forces ctaRoute to /dashboard/ad-studio/new", () => {
  const raw = JSON.stringify({
    topInsight: "Move detected.",
    hasMovement: true,
    recommendedAction: {
      label: "Take action",
      // Model tried to redirect somewhere else — we override.
      ctaRoute: "https://evil.example.com/phish",
      ctaParams: { from: "market-pulse", intent: "lunch_promo_match" },
    },
  });
  const result = parseSynthResponse(raw);
  assert.ok(result?.recommendedAction);
  assert.equal(result.recommendedAction.ctaRoute, "/dashboard/ad-studio/new");
});

test("parseSynthResponse — safe defaults win over untrusted ctaParams (from + intent)", () => {
  const raw = JSON.stringify({
    topInsight: "Move detected.",
    hasMovement: true,
    recommendedAction: {
      label: "Take action",
      ctaRoute: "/dashboard/ad-studio/new",
      ctaParams: {
        from: "evil-source",
        intent: "do_something_malicious",
        // Extra param should survive — that's allowed.
        competitorCount: 3,
      },
    },
  });
  const result = parseSynthResponse(raw);
  assert.ok(result?.recommendedAction);
  // `from` always overridden to market-pulse, no matter what the model says.
  assert.equal(result.recommendedAction.ctaParams.from, "market-pulse");
  // `intent` String-cast from the model's value — preserved.
  assert.equal(result.recommendedAction.ctaParams.intent, "do_something_malicious");
  // Extra params bleed through.
  assert.equal(result.recommendedAction.ctaParams.competitorCount, 3);
});

test("fallbackDigest — movementCount=0 returns quiet-week shape", () => {
  const result = fallbackDigest(0);
  assert.equal(result.hasMovement, false);
  assert.equal(result.recommendedAction, null);
  assert.ok(result.topInsight.toLowerCase().includes("quiet"));
});

test("fallbackDigest — movementCount>0 returns generic action shape", () => {
  const result = fallbackDigest(3);
  assert.equal(result.hasMovement, true);
  assert.ok(result.recommendedAction);
  assert.equal(result.recommendedAction.ctaRoute, "/dashboard/ad-studio/new");
  assert.equal(result.recommendedAction.ctaParams.from, "market-pulse");
  assert.equal(
    result.recommendedAction.ctaParams.intent,
    "generic_competitor_response"
  );
  assert.ok(result.topInsight.includes("3"));
});
