import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COWORKER_TEMPLATE_LIBRARY,
  buildMetaComponents,
  findTemplate,
  renderTemplatePreview,
  toSubmitInput,
  validateTemplate,
} from "./templates";

test("library contains both locales of both daily-brief variants", () => {
  const names = COWORKER_TEMPLATE_LIBRARY.map((d) => `${d.name}:${d.locale}`).sort();
  assert.deepEqual(names, [
    "booking_owner_day_summary:ar",
    "booking_owner_day_summary:en",
    "coworker_daily_brief_full:ar",
    "coworker_daily_brief_full:en",
    "coworker_daily_brief_lite:ar",
    "coworker_daily_brief_lite:en",
  ]);
});

test("booking_owner_day_summary: en+ar both present, UTILITY, 5 params", () => {
  const en = findTemplate("booking_owner_day_summary", "en");
  const ar = findTemplate("booking_owner_day_summary", "ar");
  assert.ok(en, "expected en variant");
  assert.ok(ar, "expected ar variant");
  assert.equal(en?.category, "UTILITY");
  assert.equal(ar?.category, "UTILITY");
  assert.equal(en?.variables.length, 5);
  assert.equal(ar?.variables.length, 5);
  assert.equal(validateTemplate(en!).ok, true);
  assert.equal(validateTemplate(ar!).ok, true);
});

test("template footers identify the WhatsApp surface as Bustan", () => {
  for (const template of COWORKER_TEMPLATE_LIBRARY) {
    assert.ok(template.footer?.includes("Bustan") || template.footer?.includes("بستان"));
    assert.doesNotMatch(template.footer ?? "", /Coworker|كوركر/i);
  }
});

test("findTemplate returns highest-version definition", () => {
  const tpl = findTemplate("coworker_daily_brief_full", "en");
  assert.ok(tpl, "expected template");
  assert.equal(tpl.locale, "en");
  assert.equal(tpl.category, "UTILITY");
});

test("renderTemplatePreview substitutes positional variables", () => {
  const tpl = findTemplate("coworker_daily_brief_full", "en");
  assert.ok(tpl);
  const rendered = renderTemplatePreview(tpl, [
    "Saleem",
    "Karama",
    "4,820",
    "▲12%",
    "87",
    "55",
    "Hummus Beiruti",
    "Lamb Mandi down 30%",
    "2",
    "1 VIP hasn't ordered in 28d",
  ]);
  assert.match(rendered, /Good morning Saleem/);
  assert.match(rendered, /AED 4,820 \(▲12%/);
  assert.match(rendered, /Top item: Hummus Beiruti/);
  // No leftover placeholders
  assert.doesNotMatch(rendered, /\{\{\d+\}\}/);
});

test("renderTemplatePreview rejects wrong arity", () => {
  const tpl = findTemplate("coworker_daily_brief_lite", "en");
  assert.ok(tpl);
  assert.throws(() => renderTemplatePreview(tpl, ["only", "two"]));
});

test("validateTemplate flags gapped variable indices", () => {
  // {{1}} {{3}} skips {{2}} — Meta rejects this.
  const result = validateTemplate({
    name: "x",
    locale: "en",
    category: "UTILITY",
    version: 1,
    body: "Hi {{1}} and {{3}}",
    variables: [
      { name: "a", example: "a" },
      { name: "b", example: "b" },
    ],
  });
  assert.equal(result.ok, false);
});

test("validateTemplate flags missing examples count", () => {
  const result = validateTemplate({
    name: "x",
    locale: "en",
    category: "UTILITY",
    version: 1,
    body: "Hi {{1}} and {{2}}",
    variables: [{ name: "a", example: "a" }],
  });
  assert.equal(result.ok, false);
});

test("validateTemplate flags whitespace-padded body", () => {
  const result = validateTemplate({
    name: "x",
    locale: "en",
    category: "UTILITY",
    version: 1,
    body: " hi ",
    variables: [],
  });
  assert.equal(result.ok, false);
});

test("validateTemplate flags button title too long", () => {
  const result = validateTemplate({
    name: "x",
    locale: "en",
    category: "UTILITY",
    version: 1,
    body: "hi",
    variables: [],
    buttons: [{ id: "x", title: "this label is way too long for whatsapp" }],
  });
  assert.equal(result.ok, false);
});

test("buildMetaComponents emits body example matching variable count", () => {
  const tpl = findTemplate("coworker_daily_brief_full", "en");
  assert.ok(tpl);
  const components = buildMetaComponents(tpl);
  const body = components.find((c) => c.type === "BODY");
  assert.ok(body?.example);
  assert.equal(body.example.body_text[0].length, tpl.variables.length);
});

test("toSubmitInput produces a Meta-compatible payload shape", () => {
  const tpl = findTemplate("coworker_daily_brief_lite", "ar");
  assert.ok(tpl);
  const submit = toSubmitInput(tpl);
  assert.equal(submit.name, "coworker_daily_brief_lite");
  assert.equal(submit.locale, "ar");
  assert.equal(submit.category, "UTILITY");
  const types = submit.components.map((c) => c.type);
  assert.ok(types.includes("BODY"));
  assert.ok(types.includes("BUTTONS"));
});
