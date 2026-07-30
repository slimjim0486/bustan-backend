// Booking WhatsApp template library (Phase 4 / Task 4).
//
// Distinct from WHATSAPP_TEMPLATE_LIBRARY in ./whatsapp-business.ts (the
// MARKETING winback/re-engagement templates) — these are per-tenant UTILITY
// templates sent through the RESTAURANT's own WABA (Embedded Signup) to
// diners who booked, not to Bustan's own coworker WABA.
//
// EN bodies are owner-approved verbatim (sign-off 2026-07-30) — do not
// reword a single character. AR bodies are translations reviewed for
// placeholder integrity (same {{n}} count/order as the EN body).
export interface BookingTemplateVariant {
  body: string;
}

export interface BookingTemplateDefinition {
  name: string;
  category: "UTILITY";
  paramCount: number;
  languages: { en: BookingTemplateVariant; ar: BookingTemplateVariant };
}

export const BOOKING_TEMPLATE_LIBRARY: BookingTemplateDefinition[] = [
  {
    name: "booking_confirmation",
    category: "UTILITY",
    paramCount: 5,
    languages: {
      en: {
        body: "Hi {{1}}, your booking at {{2}} is confirmed ✅ {{3}} — {{4}}. Your AED {{5}} deposit will be credited to your bill on arrival. Need to change anything? Just reply here.",
      },
      ar: {
        body: "مرحباً {{1}}، تم تأكيد حجزك في {{2}} ✅ {{3}} — {{4}}. سيتم خصم وديعتك بقيمة {{5}} درهم من فاتورتك عند الوصول. تحتاج لتغيير أي شيء؟ فقط رد هنا.",
      },
    },
  },
  {
    name: "booking_reminder_24h",
    category: "UTILITY",
    paramCount: 3,
    languages: {
      en: {
        body: "Hi {{1}}, a reminder from {{2}}: your appointment is tomorrow at {{3}}. Your deposit counts toward your bill when you arrive. Reply here to reschedule.",
      },
      ar: {
        body: "مرحباً {{1}}، تذكير من {{2}}: موعدك غداً الساعة {{3}}. وديعتك تُحتسب ضمن فاتورتك عند الوصول. رد هنا لإعادة الجدولة.",
      },
    },
  },
  {
    name: "booking_reminder_2h",
    category: "UTILITY",
    paramCount: 3,
    languages: {
      en: {
        body: "Hi {{1}}, see you soon! Your appointment at {{2}} is today at {{3}}. Your slot is saved and your deposit goes toward your bill.",
      },
      ar: {
        body: "مرحباً {{1}}، نراك قريباً! موعدك في {{2}} اليوم الساعة {{3}}. موعدك محجوز ووديعتك تُحتسب ضمن فاتورتك.",
      },
    },
  },
  {
    name: "booking_deposit_nudge",
    category: "UTILITY",
    paramCount: 5,
    languages: {
      en: {
        body: "Hi {{1}}, we're still holding your {{2}} slot at {{3}}. Confirm it with the AED {{4}} deposit here: {{5}} — the hold expires soon.",
      },
      ar: {
        body: "مرحباً {{1}}، ما زلنا نحتفظ بموعد {{2}} الخاص بك في {{3}}. أكده بدفع وديعة {{4}} درهم هنا: {{5}} — ينتهي الحجز قريباً.",
      },
    },
  },
];

export interface BookingTemplateContext {
  customerName: string;
  businessName: string;
  serviceName: string;
  slotGstFormatted: string;
  depositAed: number;
  payUrl: string;
}

export function buildBookingTemplateParams(templateName: string, ctx: BookingTemplateContext): string[] {
  switch (templateName) {
    case "booking_confirmation":
      return [ctx.customerName, ctx.businessName, ctx.serviceName, ctx.slotGstFormatted, String(ctx.depositAed)];
    case "booking_reminder_24h":
    case "booking_reminder_2h":
      return [ctx.customerName, ctx.businessName, ctx.slotGstFormatted];
    case "booking_deposit_nudge":
      return [ctx.customerName, ctx.serviceName, ctx.businessName, String(ctx.depositAed), ctx.payUrl];
    default:
      throw new Error(`Unknown booking template: ${templateName}`);
  }
}

/**
 * Renders the real customer-facing body for a booking template by
 * substituting `{{n}}` placeholders with `parameters`, in order — the same
 * convention as `renderNumberedTemplateBody` (services/campaign-send.ts) and
 * `renderTemplatePreview` (lib/whatsapp-business.ts, lib/coworker/templates.ts).
 * Used by booking-messaging.ts so a persisted `WhatsAppMessage.body` row for
 * a template send shows the actual message ("Hi Fatima, your booking at
 * Glow Salon is confirmed…"), not an opaque `[template:name]` placeholder.
 */
export function renderBookingTemplateBody(
  templateName: string,
  language: "en" | "ar",
  parameters: string[]
): string {
  const template = BOOKING_TEMPLATE_LIBRARY.find((t) => t.name === templateName);
  if (!template) {
    throw new Error(`Unknown booking template: ${templateName}`);
  }
  const body = template.languages[language].body;
  return parameters.reduce(
    (nextBody, value, index) => nextBody.replace(new RegExp(`\\{\\{${index + 1}\\}\\}`, "g"), value),
    body
  );
}

export function formatSlotGst(slotAt: Date, language: "en" | "ar" = "en"): string {
  return new Intl.DateTimeFormat(language === "ar" ? "ar-AE" : "en-AE", {
    timeZone: "Asia/Dubai",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(slotAt);
}
