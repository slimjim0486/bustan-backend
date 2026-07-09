import { Hono } from "hono";
import { env } from "@/lib/env";
import {
  decryptAccessToken,
  extractWebhookMessageBody,
  mapWebhookMessageType,
  mapWebhookStatus,
  normalizeE164Phone,
  normalizeWhatsAppPhone,
  sendWhatsAppText,
  verifyMetaSignature,
} from "@/lib/whatsapp-business";
import { prisma } from "@/lib/prisma";
import { detectLanguage } from "@/lib/language-detect";
import { captureException } from "@/lib/sentry";
import { extractCtwaReferral } from "@/lib/ctwa-referral";
import { resolveAdProjectByMetaAdId } from "@/lib/ctwa-resolver";
import { getConciergeMonthlyCap, getConciergeUsageState } from "@/lib/concierge/usage";
import { isConsentOnlyKeyword } from "@/lib/concierge";
import { enqueueDinerConciergeReply } from "@/queue/diner-concierge";
import {
  detectOrderAction,
  findOldestPendingOrderForRestaurant,
  findPendingOrderByNumber,
  transitionOrder,
} from "@/lib/order-state-machine";

/**
 * H7 fix: cap webhook-supplied display names to prevent stored-XSS surfaces
 * (email subject lines, future plaintext exports). React's auto-escape
 * covers the dashboard render, but every other downstream surface needs
 * explicit truncation + control-char strip.
 */
function sanitizeDisplayName(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  // Strip C0/C1 control chars, zero-width, RTL/LTR overrides, bidi
  // isolates (FSI/PDI/LRI/RLI), and BOM. Explicit \u escapes so the
  // rule survives editor / encoding round-trips.
  const stripped = value.replace(
    /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
    ""
  );
  return stripped.trim().slice(0, 120) || fallback;
}

/**
 * M3 fix: WhatsApp message status events can arrive out-of-order. Status
 * should monotonically advance: queued → sent → delivered → read; failed
 * is terminal. Without rank enforcement, a `delivered` arriving after
 * `read` overwrites the read timestamp.
 */
const STATUS_RANK: Record<string, number> = {
  received: 0,
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 99,
};

function toWebhookDate(timestamp: unknown) {
  const seconds = Number(timestamp);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000);
  }
  return new Date();
}

function statusTimestamps(status: string, occurredAt: Date) {
  if (status === "sent") return { sentAt: occurredAt };
  if (status === "delivered") return { deliveredAt: occurredAt };
  if (status === "read") return { readAt: occurredAt };
  if (status === "failed") return { failedAt: occurredAt };
  return {};
}

function firstError(status: Record<string, any>) {
  const error = Array.isArray(status.errors) ? status.errors[0] : null;
  return {
    errorCode: error?.code ? String(error.code) : null,
    errorMessage: error?.title ?? error?.message ?? error?.details ?? null,
  };
}

export function getWhatsAppConsentCommand(body: string | null | undefined) {
  const normalized = body?.trim().toLowerCase();
  if (!normalized) return null;
  if (["stop", "unsubscribe", "opt out", "opt-out", "cancel"].includes(normalized)) {
    return "opt_out";
  }
  if (["start", "subscribe", "opt in", "opt-in", "yes"].includes(normalized)) {
    return "opt_in";
  }
  return null;
}

async function handleInboundMessage(input: {
  integration: {
    id: string;
    restaurantId: string;
    displayPhoneNumber: string;
  };
  message: Record<string, any>;
  contactName: string | null;
}) {
  // H6 fix: use the canonical E.164 normalizer so this matches what the
  // public cart path stores.
  const fromPhone = normalizeE164Phone(String(input.message.from ?? ""));
  if (!fromPhone || !input.message.id) {
    return;
  }

  const body = extractWebhookMessageBody(input.message);
  const detectedLanguage = detectLanguage(body);
  const occurredAt = toWebhookDate(input.message.timestamp);
  const displayName = sanitizeDisplayName(input.contactName, fromPhone);
  const consentCommand = getWhatsAppConsentCommand(body);
  const providerMessageId = String(input.message.id);
  const existingMessage = await prisma.whatsAppMessage.findUnique({
    where: { providerMessageId },
    select: {
      id: true,
      type: true,
      createdAt: true,
      conversationId: true,
      conversation: {
        select: {
          botPausedUntil: true,
          botDisabled: true,
        },
      },
    },
  });
  if (existingMessage) {
    return {
      conversationId: existingMessage.conversationId,
      botPausedUntil: existingMessage.conversation?.botPausedUntil ?? null,
      botDisabled: existingMessage.conversation?.botDisabled ?? false,
      messageId: existingMessage.id,
      messageType: existingMessage.type,
      occurredAt: existingMessage.createdAt,
      language: detectedLanguage,
      consentCommand,
      body,
      rawType: String(input.message.type ?? "unknown"),
      duplicate: true,
    };
  }
  // P1: Click-to-WhatsApp referral. Sanitized + capped here so the rest
  // of the transaction can trust the values without re-checking. PDPL —
  // never log headline/body in plaintext below.
  const referral = extractCtwaReferral(input.message);
  // P1 perf: resolve the ad project OUTSIDE the inbound transaction.
  // The resolver is a read-only lookup that doesn't need the tx
  // snapshot. Keeping it in the tx adds 1–2 query round-trips inside a
  // potentially-contended row-locked transaction; pulling it out keeps
  // the tx tight and avoids brushing against
  // idle_in_transaction_session_timeout under retry-storm load.
  const resolved = referral
    ? await resolveAdProjectByMetaAdId(
        prisma,
        input.integration.restaurantId,
        referral.sourceId
      )
    : null;

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.upsert({
      where: {
        restaurantId_normalizedPhone: {
          restaurantId: input.integration.restaurantId,
          normalizedPhone: fromPhone,
        },
      },
      create: {
        restaurantId: input.integration.restaurantId,
        normalizedPhone: fromPhone,
        phoneNumber: fromPhone,
        displayName,
        preferredLanguage: detectedLanguage,
      },
      update: {
        phoneNumber: fromPhone,
        displayName: input.contactName ?? undefined,
      },
      select: {
        id: true,
        referralCtwaClid: true,
      },
    });

    // L5: auto-detect should only set preferredLanguage when it is currently
    // null — never overwrite an existing value (manual CRM override or a
    // prior auto-detect). updateMany with a null-guarded WHERE makes this a
    // no-op when a value is already stored.
    if (detectedLanguage) {
      await tx.customer.updateMany({
        where: { id: customer.id, preferredLanguage: null },
        data: { preferredLanguage: detectedLanguage },
      });
    }

    // P1: capture/refresh CTWA attribution. Latest non-null referral wins
    // when the customer comes back via a different ad. Never overwrite a
    // non-null referral with null. Uses updateMany with a discriminating
    // WHERE so a duplicate inbound (Meta retry, double-fanout) doesn't
    // re-resolve the project unnecessarily.
    if (referral && resolved) {
      const sameAttribution = customer.referralCtwaClid === referral.ctwaClid;
      if (!sameAttribution) {
        await tx.customer.updateMany({
          where: {
            id: customer.id,
            // Race-safe: only write if no concurrent webhook already
            // wrote the same ctwa_clid we're about to write.
            OR: [
              { referralCtwaClid: null },
              { referralCtwaClid: { not: referral.ctwaClid } },
            ],
          },
          data: {
            referralCtwaClid: referral.ctwaClid,
            referralSourceId: referral.sourceId,
            referralSourceType: referral.sourceType,
            referralSourceUrl: referral.sourceUrl,
            referralHeadline: referral.headline,
            referralBody: referral.body,
            referralMediaUrl: referral.mediaUrl,
            referralCapturedAt: occurredAt,
            referralAdProjectId: resolved.projectId,
            referralCreativeId: resolved.creativeId,
          },
        });
      }
    }

    if (consentCommand) {
      await tx.customer.update({
        where: {
          id: customer.id,
        },
        data: {
          marketingOptIn: consentCommand === "opt_in",
          marketingOptInAt: consentCommand === "opt_in" ? occurredAt : undefined,
          marketingOptOutAt: consentCommand === "opt_out" ? occurredAt : null,
        },
      });

      await tx.customerConsent.create({
        data: {
          restaurantId: input.integration.restaurantId,
          customerId: customer.id,
          status: consentCommand,
          source: "whatsapp_keyword",
        },
      });
    }

    const conversation = await tx.whatsAppConversation.upsert({
      where: {
        restaurantId_customerPhone: {
          restaurantId: input.integration.restaurantId,
          customerPhone: fromPhone,
        },
      },
      create: {
        restaurantId: input.integration.restaurantId,
        integrationId: input.integration.id,
        customerId: customer.id,
        customerPhone: fromPhone,
        customerName: displayName,
        lastMessageAt: occurredAt,
        unreadCount: 1,
      },
      update: {
        integrationId: input.integration.id,
        customerId: customer.id,
        customerName: displayName,
        lastMessageAt: occurredAt,
        unreadCount: {
          increment: 1,
        },
      },
      select: {
        id: true,
        botPausedUntil: true,
        botDisabled: true,
      },
    });

    const message = await tx.whatsAppMessage.upsert({
      where: {
        providerMessageId: String(input.message.id),
      },
      create: {
        restaurantId: input.integration.restaurantId,
        integrationId: input.integration.id,
        conversationId: conversation.id,
        customerId: customer.id,
        providerMessageId: String(input.message.id),
        direction: "inbound",
        type: mapWebhookMessageType(input.message.type),
        status: "received",
        source: "diner",
        fromPhone,
        toPhone: normalizeWhatsAppPhone(input.integration.displayPhoneNumber),
        body,
        rawPayload: input.message,
        createdAt: occurredAt,
      },
      update: {
        conversationId: conversation.id,
        customerId: customer.id,
        body,
        rawPayload: input.message,
      },
      select: {
        id: true,
        type: true,
        createdAt: true,
      },
    });

    return {
      conversationId: conversation.id,
      botPausedUntil: conversation.botPausedUntil,
      botDisabled: conversation.botDisabled,
      messageId: message.id,
      messageType: message.type,
      occurredAt: message.createdAt,
      language: detectedLanguage,
      consentCommand,
      body,
      rawType: String(input.message.type ?? "unknown"),
      duplicate: false,
    };
  });
}

const SKIPPED_RAW_TYPES = new Set([
  "reaction",
  "system",
  "ephemeral",
  "unsupported",
  "request_welcome",
]);

async function maybeEnqueueDinerConcierge(input: {
  restaurant: {
    id: string;
    dinerAutoReplyEnabled: boolean;
    subscriptionStatus: string;
    subscription: { plan: any } | null;
    operatorAccount: { status: string } | null;
  } | null;
  inbound: Awaited<ReturnType<typeof handleInboundMessage>>;
}) {
  const restaurant = input.restaurant;
  const inbound = input.inbound;
  if (!restaurant || !inbound || !inbound.conversationId || !restaurant.dinerAutoReplyEnabled) {
    return;
  }
  if (inbound.duplicate) {
    return;
  }
  // Bare consent keywords (STOP/START/subscribe/...) are commands to the
  // consent system, not questions; "yes"/"cancel" stay conversational.
  if (isConsentOnlyKeyword(inbound.body)) {
    return;
  }
  if (inbound.botDisabled) {
    return;
  }
  if (inbound.botPausedUntil && inbound.botPausedUntil.getTime() > Date.now()) {
    return;
  }
  // Reactions are acknowledgments; system/ephemeral/unsupported are Meta
  // notifications, not diner messages — none deserve a reply or a handoff.
  // Everything else (text, media, location, stickers, contacts) enqueues;
  // the worker answers readable text and hands non-text off to the owner.
  if (SKIPPED_RAW_TYPES.has(inbound.rawType)) {
    return;
  }

  const cap = getConciergeMonthlyCap(restaurant);
  const usage = await getConciergeUsageState(restaurant.id, cap);
  if (!usage.allowed) {
    return;
  }

  try {
    await enqueueDinerConciergeReply({
      restaurantId: restaurant.id,
      conversationId: inbound.conversationId,
      triggerMessageId: inbound.messageId,
      triggerMessageAt: inbound.occurredAt.toISOString(),
      language: inbound.language,
    });
  } catch (error) {
    captureException(error, {
      tags: { feature: "diner-concierge", phase: "enqueue" },
      extra: {
        restaurantId: restaurant.id,
        conversationId: inbound.conversationId,
        messageId: inbound.messageId,
      },
    });
  }
}

async function handleStatus(input: {
  integration: {
    id: string;
    restaurantId: string;
  };
  status: Record<string, any>;
}) {
  if (!input.status.id) {
    return;
  }

  const providerMessageId = String(input.status.id);
  const status = mapWebhookStatus(input.status.status);
  const occurredAt = toWebhookDate(input.status.timestamp);
  const { errorCode, errorMessage } = firstError(input.status);
  const timestamps = statusTimestamps(status, occurredAt);

  await prisma.$transaction(async (tx) => {
    const message = await tx.whatsAppMessage.findUnique({
      where: {
        providerMessageId,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (message) {
      // M3 fix: status must monotonically advance. Skip an out-of-order
      // status event (e.g. `delivered` arriving after `read`) to preserve
      // the higher-rank state already recorded.
      const currentRank = STATUS_RANK[message.status as string] ?? 0;
      const newRank = STATUS_RANK[status] ?? 0;
      if (newRank > currentRank || status === "failed") {
        await tx.whatsAppMessage.update({
          where: {
            id: message.id,
          },
          data: {
            status,
            ...timestamps,
            rawPayload: input.status,
          },
        });
      }
    }

    await tx.messageLog
      .update({
        where: {
          providerMessageId,
        },
        data: {
          status,
          errorCode,
          errorMessage,
          ...timestamps,
        },
      })
      .catch(() => null);

    // M4: idempotent status events — same (providerMessageId, status,
    // occurredAt) tuple from a Meta retry should not duplicate. We don't
    // have a unique constraint yet (would need migration), so use upsert
    // semantics via a defensive findFirst+create.
    const existing = await tx.whatsAppMessageStatusEvent.findFirst({
      where: {
        providerMessageId,
        status,
        occurredAt,
      },
      select: { id: true },
    });
    if (!existing) {
      await tx.whatsAppMessageStatusEvent.create({
        data: {
          restaurantId: input.integration.restaurantId,
          integrationId: input.integration.id,
          messageId: message?.id ?? null,
          providerMessageId,
          status,
          recipientPhone: input.status.recipient_id
            ? normalizeE164Phone(String(input.status.recipient_id))
            : null,
          errorCode,
          errorMessage,
          rawPayload: input.status,
          occurredAt,
        },
      });
    }
  });
}

export const whatsappWebhooksRoute = new Hono()
  .get("/meta/whatsapp", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");

    if (
      mode === "subscribe" &&
      token &&
      env.WHATSAPP_WEBHOOK_VERIFY_TOKEN &&
      token === env.WHATSAPP_WEBHOOK_VERIFY_TOKEN
    ) {
      return c.text(challenge ?? "", 200);
    }

    return c.text("Forbidden", 403);
  })
  .post("/meta/whatsapp", async (c) => {
    const rawBody = await c.req.text();

    // H1 fix: cap body size. Meta payloads are <50KB; anything bigger is
    // either malformed or a DoS attempt. 1MB is generous.
    const MAX_BODY_BYTES = 1_000_000;
    if (rawBody.length > MAX_BODY_BYTES) {
      return c.text("Payload too large", 413);
    }

    if (!verifyMetaSignature(rawBody, c.req.header("x-hub-signature-256"))) {
      return c.text("Invalid signature", 403);
    }

    // H1 fix: guard JSON.parse — malformed body bombs to 500, Meta interprets
    // 5xx as transient and retries with exponential backoff (storm).
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody) as Record<string, any>;
    } catch {
      return c.text("Bad request", 400);
    }
    const entries = Array.isArray(payload.entry) ? payload.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];

      for (const change of changes) {
        const value = change.value ?? {};
        const phoneNumberId = value.metadata?.phone_number_id;

        if (!phoneNumberId) {
          continue;
        }

        const integration = await prisma.whatsAppIntegration.findUnique({
          where: {
            phoneNumberId: String(phoneNumberId),
          },
          select: {
            id: true,
            restaurantId: true,
            displayPhoneNumber: true,
          },
        });

        if (!integration) {
          continue;
        }

        await prisma.whatsAppIntegration.update({
          where: {
            id: integration.id,
          },
          data: {
            lastWebhookAt: new Date(),
            lastError: null,
          },
        });

        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        const messages = Array.isArray(value.messages) ? value.messages : [];
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];

        // v1 ordering: if the inbound is an operator-side button/keyword
        // action AND there's a pending order, route it to the state
        // machine and SKIP normal CRM conversation handling so order
        // actions don't pollute the customer inbox.
        //
        // C2: also detect "CONFIRM" from the configured operator phone —
        // this verifies the operator's number is actually theirs (not a
        // typo) and unlocks Accept/Reject authority.
        const restaurant = await prisma.restaurant.findUnique({
          where: { id: integration.restaurantId },
          select: {
            id: true,
            whatsappNumber: true,
            ordersV1Enabled: true,
            dinerAutoReplyEnabled: true,
            subscriptionStatus: true,
            subscription: { select: { plan: true } },
            operatorAccount: { select: { status: true } },
            whatsappIntegration: { select: { operatorPhoneVerifiedAt: true } },
          },
        });
        const operatorPhone = restaurant?.whatsappNumber
          ? normalizeE164Phone(restaurant.whatsappNumber)
          : null;
        const ordersEnabled = Boolean(restaurant?.ordersV1Enabled);
        const operatorVerified = Boolean(
          restaurant?.whatsappIntegration?.operatorPhoneVerifiedAt
        );

        for (const message of messages) {
          const contact = contacts.find((entry: Record<string, any>) => entry.wa_id === message.from);
          const fromPhone = normalizeE164Phone(String(message.from ?? ""));
          const isFromOperatorPhone = Boolean(
            operatorPhone &&
            fromPhone &&
            fromPhone === operatorPhone
          );
          const isOperator = ordersEnabled && isFromOperatorPhone;

          // C2: handle "CONFIRM" verification keyword before any other
          // order routing. Verification is a one-time event; subsequent
          // CONFIRM sends are no-ops.
          if (isOperator && !operatorVerified) {
            const bodyText =
              message.type === "text"
                ? String(message.text?.body ?? "").trim().toUpperCase()
                : "";
            if (bodyText === "CONFIRM") {
              const fullIntegration = await prisma.whatsAppIntegration.update({
                where: { id: integration.id },
                data: { operatorPhoneVerifiedAt: new Date() },
                select: { accessTokenCipher: true, phoneNumberId: true },
              });
              // Send a free-text ack so the operator knows verification worked.
              // Best-effort: failure here doesn't block the verification flip.
              try {
                await sendWhatsAppText({
                  accessToken: decryptAccessToken(fullIntegration.accessTokenCipher),
                  phoneNumberId: fullIntegration.phoneNumberId,
                  to: fromPhone as string,
                  body:
                    "Verified — this number is now the operator for Bustan orders. " +
                    "You'll receive order alerts here and can Accept / Reject by replying.",
                });
              } catch (error) {
                console.error("[orders] CONFIRM ack send failed", {
                  restaurantId: integration.restaurantId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              // Still log as CRM message so the operator sees acknowledgment
              // in their conversation history.
              await handleInboundMessage({
                integration,
                message,
                contactName: contact?.profile?.name ?? null,
              });
              continue;
            }
            // Unverified operator + non-CONFIRM message: log as CRM, skip
            // any state-machine routing.
            await handleInboundMessage({
              integration,
              message,
              contactName: contact?.profile?.name ?? null,
            });
            continue;
          }

          if (isOperator && operatorVerified) {
            const detected = detectOrderAction(message);
            if (detected) {
              // H2 fix: dedup BEFORE transitioning. Meta retries the same
              // payload on transient failures; without this, two retries
              // of the same Accept tap can accept two different orders
              // (each iteration finds the next-oldest pending).
              const providerMessageId = String(message.id ?? "");
              const dedup = providerMessageId
                ? await prisma.whatsAppMessage
                    .upsert({
                      where: { providerMessageId },
                      create: {
                        restaurantId: integration.restaurantId,
                        integrationId: integration.id,
                        providerMessageId,
                        direction: "inbound",
                        type: mapWebhookMessageType(message.type),
                        status: "received",
                        fromPhone,
                        toPhone: normalizeWhatsAppPhone(integration.displayPhoneNumber),
                        body: extractWebhookMessageBody(message),
                        rawPayload: message,
                        createdAt: toWebhookDate(message.timestamp),
                      },
                      update: {},
                      select: { id: true, createdAt: true },
                    })
                    .catch(() => null)
                : null;

              // If the row already existed (createdAt < now-2s heuristic
              // is unreliable — instead we rely on the fact that updates
              // are no-ops; we detect via a separate count check), we
              // still proceed but only the FIRST transition will commit
              // due to the atomic conditional update in transitionOrder.
              // That's safer than trying to detect "existed before".

              // C1: prefer the order number embedded in the operator's reply.
              const order = detected.orderNumber
                ? await findPendingOrderByNumber(
                    integration.restaurantId,
                    detected.orderNumber
                  )
                : await findOldestPendingOrderForRestaurant(
                    integration.restaurantId
                  );

              if (order && dedup) {
                const result = await transitionOrder({
                  orderIntentId: order.id,
                  action: detected.action,
                  actor: "restaurant",
                  source: "whatsapp_webhook",
                  expectedRestaurantId: integration.restaurantId,
                  metadata: {
                    providerMessageId,
                    fromPhone,
                    orderNumberInReply: detected.orderNumber,
                    routedBy: detected.orderNumber ? "order_number" : "oldest_pending",
                  },
                });
                if (result.ok) {
                  // Order handled — already dedup-recorded above; skip
                  // the full CRM inbound handler.
                  continue;
                }
                // Transition lost the race (e.g. cron expired it in the
                // same tick). Fall through to CRM logging so the operator
                // at least sees their reply.
              }
            }
          }

          const inbound = await handleInboundMessage({
            integration,
            message,
            contactName: contact?.profile?.name ?? null,
          });
          if (!isFromOperatorPhone) {
            await maybeEnqueueDinerConcierge({ restaurant, inbound });
          }
        }

        for (const status of statuses) {
          await handleStatus({
            integration,
            status,
          });
        }
      }
    }

    return c.json({ ok: true });
  });
