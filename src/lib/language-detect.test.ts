import assert from "node:assert/strict";
import test from "node:test";

test("detectLanguage returns ar for predominantly Arabic text", async () => {
  const { detectLanguage } = await import("./language-detect.js");
  assert.equal(detectLanguage("مرحبا، أريد طلب طعام"), "ar");
});

test("detectLanguage returns en for Latin text", async () => {
  const { detectLanguage } = await import("./language-detect.js");
  assert.equal(detectLanguage("Hi, I'd like to order"), "en");
});

test("detectLanguage ignores stray emoji / single Arabic word in mostly-English", async () => {
  const { detectLanguage } = await import("./language-detect.js");
  assert.equal(detectLanguage("Order 🎉 شكرا thanks so much for the food"), "en");
});

test("detectLanguage returns null for empty / no-letter input", async () => {
  const { detectLanguage } = await import("./language-detect.js");
  assert.equal(detectLanguage(""), null);
  assert.equal(detectLanguage("123 !!! 🎉"), null);
});
