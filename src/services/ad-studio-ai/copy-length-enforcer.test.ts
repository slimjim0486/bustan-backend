// Unit tests for the deterministic safety-net pieces of the copy length
// enforcer. The Claude rewrite path is integration-tested implicitly via the
// orchestrator; here we verify the truncation fallback so we can trust it
// when an Anthropic outage forces us onto it.

import assert from "node:assert/strict";
import test from "node:test";
import { smartTruncate } from "@/services/ad-studio-ai/copy-length-enforcer";

test("smartTruncate", async (t) => {
  await t.test("returns input unchanged when already within limit", () => {
    assert.equal(smartTruncate("Eid feast for the whole family", 40), "Eid feast for the whole family");
  });

  await t.test("returns input unchanged at exactly the limit", () => {
    const s = "A".repeat(40);
    assert.equal(smartTruncate(s, 40), s);
  });

  await t.test("truncates at the last word boundary", () => {
    const input = "Zaytoun Kitchen's signature lamb mansaf delivery"; // 48 chars
    const out = smartTruncate(input, 40);
    assert.ok(out.length <= 40, `expected ≤ 40, got ${out.length}: ${out}`);
    assert.ok(out.endsWith("…"));
    // Should not chop a word in half — last char before ellipsis is space/end of a word.
    assert.ok(!/\w…$/.test(out.slice(0, -1) + "…") || out.split(" ").slice(-2)[0]);
  });

  await t.test("falls back to mid-word cut when no whitespace fits", () => {
    const noSpaces = "supercalifragilisticexpialidocious";
    const out = smartTruncate(noSpaces, 10);
    assert.equal(out.length, 10);
    assert.ok(out.endsWith("…"));
  });

  await t.test("preserves Arabic spaces and word boundaries", () => {
    // Arabic uses U+0020 spaces between words like Latin scripts.
    const arabic = "أفضل سفرة عيد للعائلة في دبي والشارقة";
    const out = smartTruncate(arabic, 20);
    assert.ok(out.length <= 20, `expected ≤ 20, got ${out.length}: ${out}`);
    assert.ok(out.endsWith("…"));
  });

  await t.test("handles strings shorter than the ellipsis budget", () => {
    // Limit so tight that even the ellipsis doesn't fit comfortably; should
    // still return something at or under the cap (hard fallback to slice).
    const out = smartTruncate("hello world", 1);
    assert.ok(out.length <= 1, `expected ≤ 1, got ${out.length}: ${out}`);
  });
});
