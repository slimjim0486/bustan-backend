import assert from "node:assert/strict";
import test from "node:test";
import { BOOKING_TEMPLATE_LIBRARY, buildBookingTemplateParams, formatSlotGst } from "./booking-templates";
import { validateTemplateBody } from "./whatsapp-business";

test("library has the four customer templates, en+ar, UTILITY", () => {
  const names = BOOKING_TEMPLATE_LIBRARY.map((t) => t.name);
  for (const n of ["booking_confirmation", "booking_reminder_24h", "booking_reminder_2h", "booking_deposit_nudge"]) {
    assert.ok(names.includes(n), n);
  }
  for (const t of BOOKING_TEMPLATE_LIBRARY) {
    assert.equal(t.category, "UTILITY");
    assert.ok(t.languages.en && t.languages.ar, `${t.name} bilingual`);
  }
});

test("every body passes the Meta pre-submit linter and param counts match", () => {
  // validateTemplateBody({ body, category, variables }) — the `variables`
  // array is only used by the linter to check placeholder count/order, so a
  // list of dummy names of the right length is sufficient here.
  for (const t of BOOKING_TEMPLATE_LIBRARY) {
    for (const lang of ["en", "ar"] as const) {
      const body = t.languages[lang].body;
      const variables = Array.from({ length: t.paramCount }, (_, i) => `param${i + 1}`);
      const result = validateTemplateBody({ body, category: t.category, variables });
      assert.ok(result.ok, `${t.name}/${lang}: ${result.ok ? "" : result.reason}`);
      const highest = Math.max(0, ...[...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
      assert.equal(highest, t.paramCount, `${t.name}/${lang} param count`);
    }
  }
});

test("param builders produce correctly ordered arrays", () => {
  const p = buildBookingTemplateParams("booking_confirmation", {
    customerName: "Fatima",
    businessName: "Glow Salon",
    serviceName: "Blow-dry",
    slotGstFormatted: "Thu 6 Aug, 6:00 PM",
    depositAed: 50,
    payUrl: "https://getbustan.com/pay/x",
  });
  assert.deepEqual(p, ["Fatima", "Glow Salon", "Blow-dry", "Thu 6 Aug, 6:00 PM", "50"]);
});

test("param builders: reminders and deposit nudge order params correctly", () => {
  const ctx = {
    customerName: "Fatima",
    businessName: "Glow Salon",
    serviceName: "Blow-dry",
    slotGstFormatted: "Thu 6 Aug, 6:00 PM",
    depositAed: 50,
    payUrl: "https://getbustan.com/pay/x",
  };
  assert.deepEqual(buildBookingTemplateParams("booking_reminder_24h", ctx), [
    "Fatima",
    "Glow Salon",
    "Thu 6 Aug, 6:00 PM",
  ]);
  assert.deepEqual(buildBookingTemplateParams("booking_reminder_2h", ctx), [
    "Fatima",
    "Glow Salon",
    "Thu 6 Aug, 6:00 PM",
  ]);
  assert.deepEqual(buildBookingTemplateParams("booking_deposit_nudge", ctx), [
    "Fatima",
    "Blow-dry",
    "Glow Salon",
    "50",
    "https://getbustan.com/pay/x",
  ]);
});

test("param builders throw on unknown template name", () => {
  assert.throws(() =>
    buildBookingTemplateParams("not_a_real_template", {
      customerName: "a",
      businessName: "b",
      serviceName: "c",
      slotGstFormatted: "d",
      depositAed: 1,
      payUrl: "e",
    })
  );
});

test("formatSlotGst renders a Dubai-timezone string without throwing", () => {
  const slot = new Date("2026-08-06T14:00:00.000Z");
  const en = formatSlotGst(slot, "en");
  assert.ok(en.length > 0);
  const ar = formatSlotGst(slot, "ar");
  assert.ok(ar.length > 0);
});
