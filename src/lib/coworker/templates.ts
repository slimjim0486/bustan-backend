// Bustan-owned Coworker template library. Source of truth for what we ship
// to Meta for approval AND what we render at send time. v1 = Daily Brief only;
// event-driven nudges (review_alert, vip_ordered, abandoned_cart, review_pattern)
// are reserved names but not shipped until their backing data is persisted.
//
// Every template is UTILITY-categorized and frames the message as being about
// the recipient's own business (their numbers, their reviews) — this is the
// Meta approval pattern with >95% pass rate for B2B/SaaS coworker bots.
//
// IMPORTANT — when a template body changes, you MUST bump the version field
// AND submit again. Meta never lets you mutate an approved template; you
// create a new one and supersede the old.

import {
  CoworkerTemplateComponent,
  SubmitTemplateInput,
} from "@/lib/coworker/meta-client";

export type CoworkerTemplateLocale = "en" | "ar";

export interface CoworkerTemplateDefinition {
  /** Meta template name (snake_case, lowercase, ≤512 chars). */
  name: string;
  locale: CoworkerTemplateLocale;
  category: "UTILITY";
  body: string;
  /** Ordered variable names — used for both Meta examples and runtime
   *  rendering. Length must match the count of {{n}} placeholders in `body`. */
  variables: { name: string; example: string }[];
  /** Optional reply-button labels (≤3, ≤20 chars each). */
  buttons?: { id: string; title: string }[];
  /** Optional footer (≤60 chars). */
  footer?: string;
  /** Bump when body/buttons/footer change. */
  version: number;
}

// ── Template definitions ───────────────────────────────────────

const DAILY_BRIEF_FULL_EN: CoworkerTemplateDefinition = {
  name: "coworker_daily_brief_full",
  locale: "en",
  category: "UTILITY",
  version: 1,
  body: [
    "Good morning {{1}} ☀️",
    "",
    "{{2}} yesterday:",
    "💰 AED {{3}} ({{4}} vs same day last week)",
    "📦 {{5}} orders · avg ticket AED {{6}}",
    "🏆 Top item: {{7}}",
    "⚠️ {{8}}",
    "",
    "{{9}} reviews waiting · {{10}}",
  ].join("\n"),
  variables: [
    { name: "owner_first_name", example: "Saleem" },
    { name: "restaurant_name", example: "Karama" },
    { name: "revenue_aed", example: "4,820" },
    { name: "wow_delta", example: "▲12%" },
    { name: "orders_count", example: "87" },
    { name: "avg_ticket_aed", example: "55" },
    { name: "top_item_name", example: "Hummus Beiruti" },
    { name: "alert_line", example: "Lamb Mandi down 30%" },
    { name: "pending_reviews_count", example: "2" },
    { name: "winback_line", example: "1 VIP hasn't ordered in 28d" },
  ],
  buttons: [
    { id: "brief:full_report", title: "📊 Full report" },
    { id: "brief:reply_reviews", title: "⭐ Reply reviews" },
    { id: "brief:winback_vip", title: "🔁 Win-back VIP" },
  ],
  footer: "Reply STOP to pause Bustan on WhatsApp.",
};

const DAILY_BRIEF_FULL_AR: CoworkerTemplateDefinition = {
  name: "coworker_daily_brief_full",
  locale: "ar",
  category: "UTILITY",
  version: 1,
  body: [
    "صباح الخير {{1}} ☀️",
    "",
    "{{2}} أمس:",
    "💰 {{3}} درهم ({{4}} مقارنة بنفس اليوم الأسبوع الماضي)",
    "📦 {{5}} طلب · متوسط الفاتورة {{6}} درهم",
    "🏆 الأكثر طلباً: {{7}}",
    "⚠️ {{8}}",
    "",
    "{{9}} تقييمات بانتظار الرد · {{10}}",
  ].join("\n"),
  variables: [
    { name: "owner_first_name", example: "سليم" },
    { name: "restaurant_name", example: "كرامة" },
    { name: "revenue_aed", example: "4,820" },
    { name: "wow_delta", example: "▲12%" },
    { name: "orders_count", example: "87" },
    { name: "avg_ticket_aed", example: "55" },
    { name: "top_item_name", example: "حمص بيروتي" },
    { name: "alert_line", example: "مندي اللحم انخفض 30%" },
    { name: "pending_reviews_count", example: "2" },
    { name: "winback_line", example: "عميل VIP لم يطلب منذ 28 يوم" },
  ],
  buttons: [
    { id: "brief:full_report", title: "📊 التقرير الكامل" },
    { id: "brief:reply_reviews", title: "⭐ الرد على التقييمات" },
    { id: "brief:winback_vip", title: "🔁 استرجاع العملاء" },
  ],
  footer: "أرسل STOP لإيقاف بستان على واتساب.",
};

const DAILY_BRIEF_LITE_EN: CoworkerTemplateDefinition = {
  name: "coworker_daily_brief_lite",
  locale: "en",
  category: "UTILITY",
  version: 1,
  body: [
    "Good morning {{1}} ☀️",
    "",
    "{{2}} — yesterday's snapshot:",
    "⭐ Google rating {{3}} ({{4}} reviews)",
    "👀 {{5}} menu views",
    "{{6}}",
    "",
    "{{7}}",
  ].join("\n"),
  variables: [
    { name: "owner_first_name", example: "Saleem" },
    { name: "restaurant_name", example: "Karama" },
    { name: "google_rating", example: "4.6" },
    { name: "review_count", example: "238" },
    { name: "menu_views", example: "124" },
    { name: "menu_health_line", example: "📷 3 menu items missing photos" },
    { name: "next_step_line", example: "Tap Full Report to see this week's biggest fix" },
  ],
  buttons: [
    { id: "brief:full_report", title: "📊 Full report" },
    { id: "brief:reply_reviews", title: "⭐ Reply reviews" },
    { id: "brief:ask_anything", title: "💬 Ask anything" },
  ],
  footer: "Reply STOP to pause Bustan on WhatsApp.",
};

const DAILY_BRIEF_LITE_AR: CoworkerTemplateDefinition = {
  name: "coworker_daily_brief_lite",
  locale: "ar",
  category: "UTILITY",
  version: 1,
  body: [
    "صباح الخير {{1}} ☀️",
    "",
    "{{2}} — ملخص الأمس:",
    "⭐ تقييم جوجل {{3}} ({{4}} تقييم)",
    "👀 {{5}} مشاهدة للقائمة",
    "{{6}}",
    "",
    "{{7}}",
  ].join("\n"),
  variables: [
    { name: "owner_first_name", example: "سليم" },
    { name: "restaurant_name", example: "كرامة" },
    { name: "google_rating", example: "4.6" },
    { name: "review_count", example: "238" },
    { name: "menu_views", example: "124" },
    { name: "menu_health_line", example: "📷 3 أصناف بدون صور" },
    { name: "next_step_line", example: "اضغط التقرير الكامل لتعرف أهم تحسين هذا الأسبوع" },
  ],
  buttons: [
    { id: "brief:full_report", title: "📊 التقرير الكامل" },
    { id: "brief:reply_reviews", title: "⭐ الرد على التقييمات" },
    { id: "brief:ask_anything", title: "💬 اسأل أي شيء" },
  ],
  footer: "أرسل STOP لإيقاف بستان على واتساب.",
};

export const COWORKER_TEMPLATE_LIBRARY: ReadonlyArray<CoworkerTemplateDefinition> = [
  DAILY_BRIEF_FULL_EN,
  DAILY_BRIEF_FULL_AR,
  DAILY_BRIEF_LITE_EN,
  DAILY_BRIEF_LITE_AR,
];

// ── Validator ─────────────────────────────────────────────────

export type CoworkerTemplateValidation = { ok: true } | { ok: false; reason: string };

export function validateTemplate(def: CoworkerTemplateDefinition): CoworkerTemplateValidation {
  if (!def.body.trim()) {
    return { ok: false, reason: "Body is empty." };
  }
  if (def.body !== def.body.trim()) {
    return { ok: false, reason: "Body must not start or end with whitespace." };
  }
  if (def.body.length > 1024) {
    return { ok: false, reason: `Body is ${def.body.length} chars; Meta limit is 1024.` };
  }
  if (/[!?]{4,}/.test(def.body)) {
    return { ok: false, reason: "Body has excessive punctuation (4+ consecutive ! or ?)." };
  }

  const matches = Array.from(def.body.matchAll(/\{\{(\d+)\}\}/g));
  const indices = matches.map((m) => Number.parseInt(m[1], 10));
  const expected = def.variables.length;

  if (expected === 0 && indices.length > 0) {
    return { ok: false, reason: `Body references ${indices.length} variables but declares none.` };
  }
  if (expected > 0) {
    const distinct = Array.from(new Set(indices)).sort((a, b) => a - b);
    if (distinct.length !== expected) {
      return {
        ok: false,
        reason: `Body uses ${distinct.length} distinct variables but declares ${expected}.`,
      };
    }
    for (let i = 0; i < distinct.length; i++) {
      if (distinct[i] !== i + 1) {
        return {
          ok: false,
          reason: `Variables must be {{1}}, {{2}}, … in order. Found {{${distinct[i]}}} at position ${i + 1}.`,
        };
      }
    }
  }
  if (def.buttons) {
    if (def.buttons.length === 0 || def.buttons.length > 3) {
      return { ok: false, reason: "Buttons must be 1–3 quick replies." };
    }
    for (const b of def.buttons) {
      if (b.title.length === 0 || b.title.length > 20) {
        return { ok: false, reason: `Button title "${b.title}" must be 1–20 chars.` };
      }
      if (!b.id || b.id.length > 256) {
        return { ok: false, reason: `Button id "${b.id}" must be 1–256 chars.` };
      }
    }
  }
  if (def.footer && def.footer.length > 60) {
    return { ok: false, reason: `Footer is ${def.footer.length} chars; Meta limit is 60.` };
  }
  return { ok: true };
}

// Self-check at module load: every shipped template MUST pass validation.
// Catches breakage at import time, not at deploy time.
for (const def of COWORKER_TEMPLATE_LIBRARY) {
  const result = validateTemplate(def);
  if (!result.ok) {
    throw new Error(
      `Coworker template "${def.name}" (${def.locale}) is invalid: ${result.reason}`
    );
  }
}

// ── Meta payload builder ──────────────────────────────────────

export function buildMetaComponents(def: CoworkerTemplateDefinition): CoworkerTemplateComponent[] {
  const components: CoworkerTemplateComponent[] = [
    {
      type: "BODY",
      text: def.body,
      ...(def.variables.length > 0
        ? { example: { body_text: [def.variables.map((v) => v.example)] } }
        : {}),
    },
  ];
  if (def.footer) {
    components.push({ type: "FOOTER", text: def.footer });
  }
  if (def.buttons && def.buttons.length > 0) {
    components.push({
      type: "BUTTONS",
      buttons: def.buttons.map((b) => ({ type: "QUICK_REPLY", text: b.title })),
    });
  }
  return components;
}

export function toSubmitInput(def: CoworkerTemplateDefinition): SubmitTemplateInput {
  return {
    name: def.name,
    locale: def.locale,
    category: def.category,
    components: buildMetaComponents(def),
  };
}

// ── Runtime renderer ──────────────────────────────────────────

export function renderTemplatePreview(
  def: CoworkerTemplateDefinition,
  values: string[]
): string {
  if (values.length !== def.variables.length) {
    throw new Error(
      `Template ${def.name} expects ${def.variables.length} values, got ${values.length}.`
    );
  }
  return values.reduce(
    (body, value, index) =>
      body.replace(new RegExp(`\\{\\{${index + 1}\\}\\}`, "g"), value),
    def.body
  );
}

export function findTemplate(
  name: string,
  locale: CoworkerTemplateLocale
): CoworkerTemplateDefinition | undefined {
  // Returns the highest-version definition (the live one).
  return COWORKER_TEMPLATE_LIBRARY
    .filter((d) => d.name === name && d.locale === locale)
    .sort((a, b) => b.version - a.version)[0];
}
