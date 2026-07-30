// CLI: push BOOKING_TEMPLATE_LIBRARY (en+ar) to Meta for a single tenant's
// WABA (Embedded Signup integration), via createWhatsAppTemplateWithComponents.
//
// Distinct from `coworker:submit-templates` — that pushes Bustan's OWN
// coworker templates once, globally. Booking templates are per-tenant: each
// restaurant's WABA must have its own approved copies of
// booking_confirmation / booking_reminder_24h / booking_reminder_2h /
// booking_deposit_nudge before the booking loop (confirmation, reminders,
// deposit nudge) can send them.
//
// Usage:
//   npm run booking:submit-templates <restaurantId>
//
// NOTE (2026-07-30, Task 4): do NOT run this against a real tenant until its
// WABA is connected (Task 16 sets up the E2E test tenant). Submitting now
// would 404/error against a restaurant with no `connected` WhatsAppIntegration
// row. The script exists and typechecks ahead of that so Meta's approval lead
// time (usually hours, sometimes days) doesn't block Task 16/9/11.
//
// Deviation note (per approved-copy sign-off): if Meta rejects
// booking_deposit_nudge for a bare URL in the body ({{5}} = payUrl), the
// contingency is to resubmit with a URL button
// (https://getbustan.com/pay/{{1}}) and body params
// [customerName, serviceName, businessName, depositAed] instead — log that
// deviation in docs/EXECUTION_LOG.md if it happens; this script does not
// attempt that fallback automatically.
import "dotenv/config";

import { BOOKING_TEMPLATE_LIBRARY, buildBookingTemplateParams } from "@/lib/booking-templates";
import { createWhatsAppTemplateWithComponents, decryptAccessToken } from "@/lib/whatsapp-business";

const SAMPLE_CONTEXT = {
  customerName: "Fatima",
  businessName: "Glow Salon",
  serviceName: "Blow-dry",
  slotGstFormatted: "Thu 6 Aug, 6:00 PM",
  depositAed: 50,
  payUrl: "https://getbustan.com/pay/sample",
};

function buildBodyComponent(body: string, exampleParams: string[]) {
  return {
    type: "BODY",
    text: body,
    ...(exampleParams.length > 0 ? { example: { body_text: [exampleParams] } } : {}),
  };
}

async function main() {
  const restaurantId = process.argv[2];
  if (!restaurantId) {
    console.error("Usage: npm run booking:submit-templates <restaurantId>");
    process.exit(1);
  }

  const { prisma } = await import("@/lib/prisma");

  const integration = await prisma.whatsAppIntegration.findFirst({
    where: { restaurantId, status: "connected" },
  });
  if (!integration) {
    console.error(
      `No connected WhatsAppIntegration for restaurant ${restaurantId}. Connect the WABA (Embedded Signup) before submitting templates.`
    );
    process.exit(1);
  }

  const accessToken = decryptAccessToken(integration.accessTokenCipher);

  console.log(`[booking-templates] submitting ${BOOKING_TEMPLATE_LIBRARY.length} templates x 2 locales`);
  console.log(`  restaurant: ${restaurantId}`);
  console.log(`  waba: ${integration.wabaId ?? "(missing wabaId — will fail)"}`);

  for (const template of BOOKING_TEMPLATE_LIBRARY) {
    for (const language of ["en", "ar"] as const) {
      const body = template.languages[language].body;
      const params = buildBookingTemplateParams(template.name, SAMPLE_CONTEXT);

      try {
        const response = await createWhatsAppTemplateWithComponents({
          accessToken,
          wabaId: integration.wabaId ?? "",
          name: template.name,
          category: template.category,
          language,
          components: [buildBodyComponent(body, params)],
        });
        console.log(
          `  [ok] ${template.name} (${language}) -> id=${response.id ?? "?"} status=${response.status ?? "?"}`
        );
      } catch (error) {
        console.error(
          `  [error] ${template.name} (${language}): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[booking-templates] submit failed:", error);
    process.exit(1);
  });
