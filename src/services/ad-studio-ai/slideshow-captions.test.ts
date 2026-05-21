// Unit tests for the slideshow caption post-processing.
// These functions are the last line of defense between Claude's free-text
// output and the SVG compositor / frontend renderer — bugs here showed up
// in production as Arabic tofu glyphs on the slideshow image overlay.

import assert from "node:assert/strict";
import test from "node:test";
import { scrubToLatin, normalizePostBody } from "@/services/ad-studio-ai/slideshow-captions";

test("scrubToLatin", async (t) => {
  await t.test("keeps plain ASCII unchanged", () => {
    assert.equal(scrubToLatin("POV: you walked into the best mandi spot"), "POV: you walked into the best mandi spot");
  });

  await t.test("preserves accented Latin characters", () => {
    assert.equal(scrubToLatin("Café Niño's mañana brunch"), "Café Niño's mañana brunch");
  });

  await t.test("preserves common General Punctuation", () => {
    // em-dash, en-dash, curly quotes, ellipsis
    assert.equal(scrubToLatin("Best — really — Friday's spot…"), "Best — really — Friday's spot…");
  });

  await t.test("strips Arabic glyphs (the tofu bug)", () => {
    // Arabic for "best food in town" — would render as tofu boxes on the SVG band.
    assert.equal(scrubToLatin("أفضل طعام في المدينة"), "");
  });

  await t.test("strips mixed Latin + Arabic, keeping Latin", () => {
    // Claude sometimes mixes scripts; we keep the English and drop the Arabic.
    const out = scrubToLatin("Marina dinner مطعم");
    assert.equal(out, "Marina dinner");
  });

  await t.test("strips emoji", () => {
    assert.equal(scrubToLatin("So good 🔥🔥 try it"), "So good try it");
  });

  await t.test("collapses whitespace runs introduced by drops", () => {
    // After dropping the emoji + Arabic, two spaces collapse to one.
    assert.equal(scrubToLatin("Try   the    mandi"), "Try the mandi");
  });

  await t.test("preserves newlines for post-body paragraphing", () => {
    assert.equal(scrubToLatin("First line\nSecond line"), "First line\nSecond line");
  });

  await t.test("handles empty input", () => {
    assert.equal(scrubToLatin(""), "");
  });
});

test("normalizePostBody", async (t) => {
  await t.test("moves inline hashtags to their own paragraph", () => {
    const input = "We just opened in Marina. Try the mandi tonight. #DubaiEats #JLT #mandi";
    const expected = "We just opened in Marina. Try the mandi tonight.\n\n#DubaiEats #JLT #mandi";
    assert.equal(normalizePostBody(input), expected);
  });

  await t.test("collapses triple+ newlines to one blank line", () => {
    const input = "Para one.\n\n\n\nPara two.";
    assert.equal(normalizePostBody(input), "Para one.\n\nPara two.");
  });

  await t.test("preserves already-clean formatting", () => {
    const input = "Para one.\n\nPara two.\n\n#tag1 #tag2";
    assert.equal(normalizePostBody(input), "Para one.\n\nPara two.\n\n#tag1 #tag2");
  });

  await t.test("tidies messy hashtag spacing", () => {
    const input = "Body text.    #tag1   #tag2  #tag3";
    const expected = "Body text.\n\n#tag1 #tag2 #tag3";
    assert.equal(normalizePostBody(input), expected);
  });

  await t.test("handles body with no hashtags", () => {
    const input = "Just body text. No tags.";
    assert.equal(normalizePostBody(input), "Just body text. No tags.");
  });

  await t.test("handles empty input", () => {
    assert.equal(normalizePostBody(""), "");
  });
});
