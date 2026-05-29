import assert from "node:assert/strict";
import test from "node:test";

test("buildArabicTranslationPayload includes only fields with English text and missing Arabic", async () => {
  const { buildArabicTranslationPayload } = await import("./arabic-translation.js");
  const payload = buildArabicTranslationPayload({
    restaurant: { name: "Zaatar", nameAr: null, description: "Levantine", descriptionAr: "موجود" },
    sections: [
      { id: "s1", name: "Starters", nameAr: null },
      { id: "s2", name: "Mains", nameAr: "الأطباق الرئيسية" },
    ],
    items: [
      { id: "i1", name: "Hummus", nameAr: null, description: "Chickpea dip", descriptionAr: null },
      { id: "i2", name: "Fattoush", nameAr: "فتوش", description: null, descriptionAr: null },
    ],
  });
  assert.deepEqual(payload.restaurant, { name: "Zaatar" });
  assert.deepEqual(payload.sections, [{ id: "s1", name: "Starters" }]);
  assert.deepEqual(payload.items, [{ id: "i1", name: "Hummus", description: "Chickpea dip" }]);
});

test("parseArabicTranslationResponse extracts JSON from a fenced code block", async () => {
  const { parseArabicTranslationResponse } = await import("./arabic-translation.js");
  const text = 'Here you go:\n```json\n{"restaurant":{"nameAr":"زعتر"},"sections":[],"items":[{"id":"i1","nameAr":"حمص"}]}\n```';
  const result = parseArabicTranslationResponse(text);
  assert.equal(result.restaurant?.nameAr, "زعتر");
  assert.equal(result.items[0].id, "i1");
  assert.equal(result.items[0].nameAr, "حمص");
});
