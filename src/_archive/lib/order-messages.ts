/**
 * Build + send the WhatsApp order template messages. Wraps the lower-level
 * sendWhatsAppTemplate so the orders endpoint and the webhook state-machine
 * handler share one place that knows how to:
 *   - render template variables in the canonical order
 *   - persist a WhatsAppMessage row + conversation update
 *   - normalize Telr amounts to the AED string Meta expects
 */

import { prisma } from "@/lib/prisma";
import {
  decryptAccessToken,
  normalizeE164Phone,
  sendWhatsAppTemplate,
} from "@/lib/whatsapp-business";
import {
  getOrderTemplate,
  type OrderTemplateName,
} from "@/lib/whatsapp-order-templates";

type IntegrationLike = {
  id: string;
  restaurantId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  accessTokenCipher: string;
};

function formatAed(totalMajor: number | string): string {
  const num = typeof totalMajor === "string" ? Number(totalMajor) : totalMajor;
  return num.toFixed(2);
}

export function buildOrderTemplateParameters(
  templateName: OrderTemplateName,
  input: Record<string, string | number | undefined>
): string[] {
  const template = getOrderTemplate(templateName);
  return template.variables.map((variableName) => {
    const value = input[variableName];
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `Missing variable "${variableName}" for template ${templateName}`
      );
    }
    if (typeof value === "number") {
      // AED amounts already pass through formatAed; this catches counts.
      return String(value);
    }
    return value;
  });
}

export async function sendOrderTemplate(input: {
  integration: IntegrationLike;
  toPhone: string;
  templateName: OrderTemplateName;
  parameters: string[];
  /**
   * If provided, link the outbound WhatsAppMessage to the customer record
   * so the CRM conversation surface picks it up. Optional — restaurant
   * alerts don't have a customer record (they're going to the restaurant).
   */
  customerId?: string;
  /**
   * If provided, attach the message to an existing conversation. v1 we
   * skip conversation upsert for restaurant-facing alerts since those
   * don't belong in the customer-message inbox.
   */
  conversationId?: string;
  /**
   * M7: parameters used ONLY for the persisted WhatsAppMessage.body. The
   * Meta-side template still renders with the full `parameters` array (so
   * the operator's WhatsApp shows the real customer phone), but the DB
   * copy can be masked to limit PII surface area in exports / CRM views.
   * If null, the persisted body is rendered from `parameters` directly.
   */
  storedBodyParameters?: string[];
}) {
  const accessToken = decryptAccessToken(input.integration.accessTokenCipher);
  const normalizedTo = normalizeE164Phone(input.toPhone);
  if (!normalizedTo) {
    throw new Error(`Invalid recipient phone for order template: ${input.toPhone}`);
  }

  const providerMessageId = await sendWhatsAppTemplate({
    accessToken,
    phoneNumberId: input.integration.phoneNumberId,
    to: normalizedTo,
    templateName: input.templateName,
    language: "en",
    parameters: input.parameters,
  });

  const sentAt = new Date();
  const message = await prisma.whatsAppMessage.create({
    data: {
      restaurantId: input.integration.restaurantId,
      integrationId: input.integration.id,
      conversationId: input.conversationId ?? null,
      customerId: input.customerId ?? null,
      providerMessageId,
      direction: "outbound",
      type: "template",
      status: "sent",
      fromPhone: input.integration.displayPhoneNumber,
      toPhone: normalizedTo,
      // Body is the human-readable rendered template — useful for support
      // and for the dashboard preview without re-rendering at read time.
      body: renderOrderTemplateBody(
        input.templateName,
        input.storedBodyParameters ?? input.parameters
      ),
      sentAt,
    },
    select: { id: true, providerMessageId: true },
  });

  return { messageId: message.id, providerMessageId };
}

function renderOrderTemplateBody(
  templateName: OrderTemplateName,
  parameters: string[]
): string {
  const template = getOrderTemplate(templateName);
  return parameters.reduce(
    (body, value, index) =>
      body.replace(new RegExp(`\\{\\{${index + 1}\\}\\}`, "g"), value),
    template.body
  );
}

export const orderMessageHelpers = {
  formatAed,
};
