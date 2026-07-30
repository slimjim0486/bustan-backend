// Tenant-WABA messaging service for the booking loop (Phase 4 / Task 4).
//
// Sends booking_* templates (and free-form replies inside the 24h customer
// service window) through the RESTAURANT's own WhatsApp Business Account —
// distinct from the coworker send path (services/coworker/*), which uses
// Bustan's own single WABA to message the owner.
//
// Adapted from the task-4 brief's sketch to match the real schema:
//   - WhatsAppIntegration's encrypted-token column is `accessTokenCipher`
//     (not `accessTokenEncrypted`).
//   - WhatsAppMessage.restaurantId is required (not nullable), so it must be
//     threaded through explicitly rather than inferred from the conversation.
//   - The 24h customer-service window is evaluated the same way crm.ts:185
//     does it: the timestamp of the most recent INBOUND message on the
//     conversation, not `lastMessageAt` (which also advances on outbound
//     sends and would never close the window).
import { prisma } from "@/lib/prisma";
import { decryptAccessToken, sendWhatsAppTemplate, sendWhatsAppText } from "@/lib/whatsapp-business";

const WINDOW_MS = 24 * 60 * 60 * 1000;

async function loadIntegration(restaurantId: string) {
  const integration = await prisma.whatsAppIntegration.findFirst({
    where: { restaurantId, status: "connected" },
  });
  if (!integration) return null;
  return {
    ...integration,
    accessToken: decryptAccessToken(integration.accessTokenCipher),
  };
}

async function isWindowOpen(conversationId: string): Promise<boolean> {
  const lastInbound = await prisma.whatsAppMessage.findFirst({
    where: { conversationId, direction: "inbound" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return Boolean(lastInbound && Date.now() - lastInbound.createdAt.getTime() <= WINDOW_MS);
}

async function persistOutbound(input: {
  restaurantId: string;
  conversationId: string;
  type: "text" | "template";
  body: string;
  providerMessageId: string | null;
  idempotencyKey?: string;
}) {
  await prisma.whatsAppMessage
    .create({
      data: {
        restaurantId: input.restaurantId,
        conversationId: input.conversationId,
        direction: "outbound",
        type: input.type,
        status: "sent",
        source: "booking_agent",
        body: input.body,
        providerMessageId: input.providerMessageId ?? undefined,
        idempotencyKey: input.idempotencyKey ?? undefined,
      },
    })
    .catch((err: unknown) => {
      // P2002 on providerMessageId/idempotencyKey uniqueness = duplicate
      // delivery attempt (e.g. a retried webhook or job) — swallow it, the
      // original row already recorded the send.
      if ((err as { code?: string })?.code !== "P2002") throw err;
    });
  await prisma.whatsAppConversation.update({
    where: { id: input.conversationId },
    data: { lastMessageAt: new Date() },
  });
}

export async function sendBookingTemplate(input: {
  restaurantId: string;
  conversationId?: string | null;
  toPhone: string;
  templateName: string;
  language?: "en" | "ar";
  parameters: string[];
  idempotencyKey?: string;
}): Promise<{ sent: boolean; providerMessageId?: string; reason?: string }> {
  const integration = await loadIntegration(input.restaurantId);
  if (!integration) return { sent: false, reason: "no_integration" };

  try {
    const providerMessageId = await sendWhatsAppTemplate({
      accessToken: integration.accessToken,
      phoneNumberId: integration.phoneNumberId,
      to: input.toPhone,
      templateName: input.templateName,
      language: input.language === "ar" ? "ar" : "en",
      parameters: input.parameters,
    });
    if (input.conversationId) {
      await persistOutbound({
        restaurantId: input.restaurantId,
        conversationId: input.conversationId,
        type: "template",
        body: `[template:${input.templateName}]`,
        providerMessageId,
        idempotencyKey: input.idempotencyKey,
      });
    }
    return { sent: true, providerMessageId };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : "send_failed" };
  }
}

export async function sendBookingText(input: {
  restaurantId: string;
  conversationId?: string | null;
  toPhone: string;
  body: string;
  idempotencyKey?: string;
}): Promise<{ sent: boolean; reason?: string; providerMessageId?: string }> {
  const integration = await loadIntegration(input.restaurantId);
  if (!integration) return { sent: false, reason: "no_integration" };

  // Mirrors crm.ts:185 — free-form text is only allowed inside the 24h
  // customer service window, measured from the last INBOUND message on the
  // conversation. No conversationId (e.g. a cold outbound) means we cannot
  // prove the window is open, so refuse rather than risk a policy violation.
  if (!input.conversationId) {
    return { sent: false, reason: "window_closed" };
  }
  if (!(await isWindowOpen(input.conversationId))) {
    return { sent: false, reason: "window_closed" };
  }

  try {
    const providerMessageId = await sendWhatsAppText({
      accessToken: integration.accessToken,
      phoneNumberId: integration.phoneNumberId,
      to: input.toPhone,
      body: input.body,
    });
    await persistOutbound({
      restaurantId: input.restaurantId,
      conversationId: input.conversationId,
      type: "text",
      body: input.body,
      providerMessageId,
      idempotencyKey: input.idempotencyKey,
    });
    return { sent: true, providerMessageId };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : "send_failed" };
  }
}
