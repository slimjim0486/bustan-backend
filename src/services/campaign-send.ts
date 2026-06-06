import crypto from "node:crypto";
import type { Campaign } from "@prisma/client";
import { ApiError } from "@/lib/errors";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import {
  buildTemplateParameters,
  decryptAccessToken,
  renderTemplatePreview,
  sendWhatsAppTemplate,
} from "@/lib/whatsapp-business";
import {
  isMarketingEligible,
  marketingEligibleWhere,
} from "@/lib/marketing-eligibility";

export type CampaignSegmentType = "inactive_30" | "weekend_special" | "new_promotion";

export interface CampaignSendOptions {
  restaurantId: string;
  restaurantName: string;
  type: CampaignSegmentType;
  /** Parameterized inactive cutoff in days; only meaningful for type inactive_30. Default 30. */
  inactiveDays?: number;
  templateName?: string;
  body?: string;
  name?: string;
  promotionId?: string | null;
}

export interface CampaignSendResult {
  campaign: Campaign; // FULL updated Campaign row (route response spreads it — preserve API contract)
  targeted: number;
  sent: number;
  failed: number;
  skippedFrequency: number;
  skippedTier: number;
  optedInTotal: number;
  segment: string;
  mode: "meta_cloud_api" | "whatsapp_link";
}

/**
 * C-3 fix: derive a deterministic 64-bit signed integer from a restaurant ID
 * to feed `pg_advisory_xact_lock`. Postgres advisory locks accept either a
 * single bigint or two int4s. We use the first 8 bytes of SHA-256(restaurantId)
 * interpreted as a signed bigint (within JS BigInt range, then converted to
 * a string Prisma can pass as `bigint`). Hash-collision risk is acceptable:
 * the worst case is two unrelated restaurants serialize their campaign sends.
 */
export function restaurantIdToLockKey(restaurantId: string): bigint {
  const hash = crypto.createHash("sha256").update(restaurantId).digest();
  // Read first 8 bytes as signed BigInt to fit Postgres bigint range.
  return hash.readBigInt64BE(0);
}

export function buildWhatsappUrl(phoneNumber: string, body: string) {
  const digitsOnly = phoneNumber.replace(/\D/g, "");
  const url = new URL(`https://wa.me/${digitsOnly}`);
  url.searchParams.set("text", body);
  return url.toString();
}

export function getDefaultCampaignBody(input: {
  type: "inactive_30" | "weekend_special" | "new_promotion";
  restaurantName: string;
  promotionTitle?: string | null;
}) {
  if (input.type === "inactive_30") {
    return `Hi {{name}}, we miss you at ${input.restaurantName}. Your favorites are ready whenever you are. Reply here to order on WhatsApp.`;
  }

  if (input.type === "new_promotion") {
    const offer = input.promotionTitle ? `: ${input.promotionTitle}` : "";
    return `Hi {{name}}, ${input.restaurantName} just added a new offer${offer}. Reply here and we will help you order.`;
  }

  return `Hi {{name}}, planning weekend food? ${input.restaurantName} is taking WhatsApp orders now. Reply here to place yours.`;
}

export function personalizeBody(body: string, customerName: string) {
  return body.replace(/\{\{\s*name\s*\}\}/gi, customerName);
}

export function renderNumberedTemplateBody(body: string, parameters: string[]) {
  return parameters.reduce(
    (nextBody, value, index) =>
      nextBody.replace(new RegExp(`\\{\\{${index + 1}\\}\\}`, "g"), value),
    body
  );
}

export function getCampaignDeliveryMode(input: {
  integrationStatus?: string | null;
  templateStatus?: string | null;
}) {
  return input.integrationStatus === "connected" && input.templateStatus === "approved"
    ? "meta_cloud_api"
    : "whatsapp_link";
}

export async function executeCampaignSend(
  options: CampaignSendOptions
): Promise<CampaignSendResult> {
  const restaurantId = options.restaurantId;
  const targetSegment =
    options.type === "inactive_30" && options.inactiveDays && options.inactiveDays !== 30
      ? `inactive_${options.inactiveDays}`
      : options.type;

  const promotion = options.promotionId
    ? await prisma.promotion.findFirst({
        where: {
          id: options.promotionId,
          restaurantId,
        },
        select: {
          id: true,
          title: true,
        },
      })
    : null;

  if (options.promotionId && !promotion) {
    throw new ApiError("Promotion not found", 404);
  }

  const templateName = options.templateName ?? options.type;
  const [integration, templateRecord] = await Promise.all([
    prisma.whatsAppIntegration.findFirst({
      where: {
        restaurantId,
        status: "connected",
      },
    }),
    prisma.whatsAppTemplate.findUnique({
      where: {
        restaurantId_name_language: {
          restaurantId,
          name: templateName,
          language: "en",
        },
      },
    }),
  ]);
  const deliveryMode = getCampaignDeliveryMode({
    integrationStatus: integration?.status,
    templateStatus: templateRecord?.status,
  });
  const canSendViaApi = deliveryMode === "meta_cloud_api";
  const inactiveCutoff = new Date(Date.now() - (options.inactiveDays ?? 30) * 24 * 60 * 60 * 1000);
  // C6 fix: campaigns must NEVER send to customers without proof of
  // consent. The eligibility rule (boolean + timestamp + opt_in paper
  // trail, with latest-consent precedence) lives in marketing-eligibility.ts
  // and is shared with the audience-preview counts in the summary endpoint
  // so the two can never drift apart again. The `consents.some(opt_in)`
  // part of the where also defends against direct DB writes / migrations
  // that flip the boolean without a paper trail.
  const baseWhere = marketingEligibleWhere(restaurantId);
  const customerWhere =
    options.type === "inactive_30"
      ? {
          ...baseWhere,
          lastOrderAt: { lt: inactiveCutoff },
        }
      : baseWhere;

  // Run the segment query and the universe count in parallel.
  // optedInTotal is the universe (every opted-in customer regardless of
  // segment) — used downstream so the API response can explain *why*
  // a segment matched 0 (e.g. "0 of 4 opted-in customers qualify for
  // 30-day inactive — they need at least one prior order").
  const [candidates, optedInTotal] = await Promise.all([
    prisma.customer.findMany({
      where: customerWhere,
      orderBy: [{ lastOrderAt: "asc" }, { createdAt: "asc" }],
      take: 100,
      include: {
        consents: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true },
        },
      },
    }),
    prisma.customer.count({ where: baseWhere }),
  ]);
  // Final precedence check: only customers whose MOST RECENT consent
  // is opt_in are sent to. If they ever opted out, they're excluded
  // even if marketingOptIn = true (defense-in-depth against flips).
  const customers = candidates.filter((cust) =>
    isMarketingEligible({
      marketingOptIn: cust.marketingOptIn,
      marketingOptInAt: cust.marketingOptInAt,
      latestConsentStatus: cust.consents[0]?.status ?? null,
    })
  );
  const fallbackBody = getDefaultCampaignBody({
    type: options.type,
    restaurantName: options.restaurantName,
    promotionTitle: promotion?.title,
  });
  const body = canSendViaApi && templateRecord ? templateRecord.body : options.body ?? fallbackBody;
  const campaignName =
    options.name ??
    (options.type === "inactive_30"
      ? "30-day reactivation"
      : options.type === "new_promotion"
        ? "New promotion broadcast"
        : "Weekend special broadcast");

  // C-3 + C-4 fix: budget-reservation pattern. Concurrent campaign sends
  // (double-click, two operators, two campaigns at once) used to race —
  // each saw the same `sentInWindow` count and could push the WABA over
  // its messaging tier, triggering Meta's quality-rating freeze. Same
  // race for the per-(customer, template) frequency cap.
  //
  // Fix: wrap the count + reservation in a single transaction guarded by
  // a Postgres advisory lock keyed on the restaurant. The lock auto-
  // releases on commit, so we don't hold a connection during the slow
  // Meta HTTP loop. After commit, the budget is committed in MessageLog
  // (status=queued for sendable, skipped_* for held-back rows), and we
  // iterate the queued rows for the actual API sends.
  const frequencyWindow = new Date(
    Date.now() - env.WHATSAPP_FREQUENCY_CAP_HOURS * 60 * 60 * 1000
  );
  const tierWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const lockKey = restaurantIdToLockKey(restaurantId);

  const reservation = await prisma.$transaction(async (tx) => {
    // pg_advisory_xact_lock blocks until acquired and releases on commit.
    // Single integer key derived from restaurantId — the hash collision
    // risk is acceptable (worst case: two unrelated restaurants serialize
    // their campaigns; correctness preserved).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;

    let tierBudget = Number.MAX_SAFE_INTEGER;
    if (canSendViaApi) {
      const sentInWindow = await tx.messageLog.count({
        where: {
          restaurantId,
          channel: "whatsapp",
          direction: "outbound",
          // Reserved rows count toward the budget — defends against a
          // race where two transactions stack reservations while the
          // first hasn't committed any "sent" yet. `queued` is a
          // reservation; `sent/delivered/read` is the real consumption.
          status: { in: ["queued", "sent", "delivered", "read"] },
          createdAt: { gte: tierWindowStart },
        },
      });
      tierBudget = Math.max(0, env.WHATSAPP_DAILY_TIER_LIMIT - sentInWindow);
    }

    const newCampaign = await tx.campaign.create({
      data: {
        restaurantId,
        promotionId: promotion?.id ?? null,
        type: options.type,
        status: canSendViaApi ? "sending" : "logged",
        name: campaignName,
        templateName,
        body,
        targetSegment,
        targetCount: customers.length,
        loggedCount: 0,
      },
    });

    const reservations: Array<{
      customerId: string;
      status: "queued" | "skipped_tier_cap" | "skipped_frequency_cap";
    }> = [];
    let queuedCount = 0;
    let skippedTier = 0;
    let skippedFrequency = 0;

    if (canSendViaApi) {
      // Frequency cap: bulk-fetch all (customerId, templateName) pairs
      // sent in the window, in one query — avoids the previous N+1.
      const recentSends = await tx.messageLog.findMany({
        where: {
          customerId: { in: customers.map((c) => c.id) },
          templateName,
          channel: "whatsapp",
          direction: "outbound",
          status: { in: ["queued", "sent", "delivered", "read"] },
          createdAt: { gte: frequencyWindow },
        },
        select: { customerId: true },
      });
      const frequencyHit = new Set(
        recentSends.map((row) => row.customerId).filter((id): id is string => id !== null)
      );

      for (const customer of customers) {
        if (frequencyHit.has(customer.id)) {
          reservations.push({ customerId: customer.id, status: "skipped_frequency_cap" });
          skippedFrequency += 1;
        } else if (queuedCount >= tierBudget) {
          reservations.push({ customerId: customer.id, status: "skipped_tier_cap" });
          skippedTier += 1;
        } else {
          reservations.push({ customerId: customer.id, status: "queued" });
          queuedCount += 1;
        }
      }
    } else {
      // Owner-driven WhatsApp link mode — no API budget, no frequency
      // cap, just log the link rows directly. Status will be flipped
      // to "logged" by the post-transaction phase.
      for (const customer of customers) {
        reservations.push({ customerId: customer.id, status: "queued" });
        queuedCount += 1;
      }
    }

    if (reservations.length > 0) {
      await tx.messageLog.createMany({
        data: reservations.map((res) => ({
          restaurantId,
          customerId: res.customerId,
          campaignId: newCampaign.id,
          channel: "whatsapp",
          direction: "outbound",
          status: res.status,
          body:
            res.status === "skipped_tier_cap"
              ? "[skipped: daily messaging tier reached]"
              : res.status === "skipped_frequency_cap"
                ? "[skipped: same template sent in last 24h]"
                : "",
          templateName,
        })),
      });
    }

    return { campaign: newCampaign, queuedCount, skippedTier, skippedFrequency };
  });

  const campaign = reservation.campaign;
  const tierCappedCount = reservation.skippedTier;

  let accessToken: string | null = null;
  if (canSendViaApi && integration) {
    accessToken = decryptAccessToken(integration.accessTokenCipher);
  }

  let loggedCount = 0;
  let failedCount = 0;
  let frequencyCappedCount = reservation.skippedFrequency;

  // Pull the reserved queued rows for the actual API send loop. The
  // reservation has already enforced tier + frequency caps atomically —
  // this loop just iterates and dispatches.
  const queuedRows = await prisma.messageLog.findMany({
    where: { campaignId: campaign.id, status: "queued" },
    include: { customer: true },
  });

  for (const queued of queuedRows) {
    const customer = queued.customer;
    if (!customer) continue;

    const parameters = buildTemplateParameters({
      templateName,
      customerName: customer.displayName,
      restaurantName: options.restaurantName,
      promotionTitle: promotion?.title,
    });
    const personalizedBody =
      canSendViaApi && templateRecord
        ? renderNumberedTemplateBody(templateRecord.body, parameters)
        : options.body
          ? personalizeBody(options.body, customer.displayName)
          : renderTemplatePreview(templateName, parameters);

    if (!canSendViaApi || !integration || !accessToken) {
      // Owner-driven mode: flip the queued reservation to `logged` and
      // attach the wa.me URL.
      await prisma.messageLog.update({
        where: { id: queued.id },
        data: {
          status: "logged",
          body: personalizedBody,
          whatsappUrl: buildWhatsappUrl(customer.phoneNumber, personalizedBody),
        },
      });
      loggedCount += 1;
      continue;
    }

    try {
      const providerMessageId = await sendWhatsAppTemplate({
        accessToken,
        phoneNumberId: integration.phoneNumberId,
        to: customer.phoneNumber,
        templateName,
        language: "en",
        parameters,
      });
      const sentAt = new Date();

      await prisma.$transaction(async (tx) => {
        const conversation = await tx.whatsAppConversation.upsert({
          where: {
            restaurantId_customerPhone: {
              restaurantId,
              customerPhone: customer.normalizedPhone,
            },
          },
          create: {
            restaurantId,
            integrationId: integration.id,
            customerId: customer.id,
            customerPhone: customer.normalizedPhone,
            customerName: customer.displayName,
            lastMessageAt: sentAt,
          },
          update: {
            integrationId: integration.id,
            customerId: customer.id,
            customerName: customer.displayName,
            lastMessageAt: sentAt,
          },
          select: {
            id: true,
          },
        });

        await tx.messageLog.update({
          where: { id: queued.id },
          data: {
            status: "sent",
            body: personalizedBody,
            providerMessageId,
            sentAt,
          },
        });

        await tx.whatsAppMessage.create({
          data: {
            restaurantId,
            integrationId: integration.id,
            conversationId: conversation.id,
            customerId: customer.id,
            messageLogId: queued.id,
            providerMessageId,
            direction: "outbound",
            type: "template",
            status: "sent",
            fromPhone: integration.displayPhoneNumber,
            toPhone: customer.normalizedPhone,
            body: personalizedBody,
            sentAt,
          },
        });
      });

      loggedCount += 1;
    } catch (error) {
      failedCount += 1;
      await prisma.messageLog.update({
        where: { id: queued.id },
        data: {
          status: "failed",
          body: personalizedBody,
          whatsappUrl: buildWhatsappUrl(customer.phoneNumber, personalizedBody),
          errorMessage: error instanceof Error ? error.message : "WhatsApp send failed",
          failedAt: new Date(),
        },
      });
    }
  }

  // C-2 (correctness) fix: campaign final status must reflect what
  // actually happened. Previously, when every customer was tier-capped,
  // status was wrongly set to "sent". Compute against `attempted`
  // (queuedRows.length) — the rows we actually tried — not the original
  // candidate count.
  const attempted = queuedRows.length;
  const heldBack = tierCappedCount + frequencyCappedCount;
  const campaignStatus = canSendViaApi
    ? attempted === 0
      ? heldBack > 0
        ? "held"
        : "logged"
      : failedCount === attempted
        ? "failed"
        : "sent"
    : "logged";
  const updatedCampaign = await prisma.campaign.update({
    where: {
      id: campaign.id,
    },
    data: {
      status: campaignStatus,
      loggedCount,
      loggedAt: new Date(),
    },
  });

  return {
    campaign: updatedCampaign,
    targeted: customers.length,
    // In whatsapp_link mode loggedCount represents the rows we wrote
    // wa.me URLs for — surface that as `sent` so the frontend can show
    // a non-zero outcome ("Logged N for manual send") instead of "0".
    sent: loggedCount,
    failed: failedCount,
    skippedFrequency: frequencyCappedCount,
    skippedTier: tierCappedCount,
    // optedInTotal lets the UI distinguish "you have no opted-in
    // customers" from "you have opted-in customers but none match
    // this segment" when targeted === 0.
    optedInTotal,
    segment: targetSegment,
    mode: deliveryMode,
  };
}

/**
 * Preview-time audience count + delivery mode — same candidate query + in-memory
 * isMarketingEligible precedence filter as the send, WITHOUT creating/sending anything.
 */
export async function resolveCampaignAudience(options: {
  restaurantId: string;
  type: CampaignSegmentType;
  inactiveDays?: number;
  templateName: string;
}): Promise<{
  eligibleCount: number;
  optedInTotal: number;
  mode: "meta_cloud_api" | "whatsapp_link";
  templateStatus: string | null;
}> {
  const restaurantId = options.restaurantId;
  const [integration, templateRecord] = await Promise.all([
    prisma.whatsAppIntegration.findFirst({
      where: {
        restaurantId,
        status: "connected",
      },
    }),
    prisma.whatsAppTemplate.findUnique({
      where: {
        restaurantId_name_language: {
          restaurantId,
          name: options.templateName,
          language: "en",
        },
      },
    }),
  ]);
  const mode = getCampaignDeliveryMode({
    integrationStatus: integration?.status,
    templateStatus: templateRecord?.status,
  });
  const inactiveCutoff = new Date(Date.now() - (options.inactiveDays ?? 30) * 24 * 60 * 60 * 1000);
  const baseWhere = marketingEligibleWhere(restaurantId);
  const customerWhere =
    options.type === "inactive_30"
      ? {
          ...baseWhere,
          lastOrderAt: { lt: inactiveCutoff },
        }
      : baseWhere;

  const [candidates, optedInTotal] = await Promise.all([
    prisma.customer.findMany({
      where: customerWhere,
      orderBy: [{ lastOrderAt: "asc" }, { createdAt: "asc" }],
      take: 100,
      include: {
        consents: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true },
        },
      },
    }),
    prisma.customer.count({ where: baseWhere }),
  ]);
  const customers = candidates.filter((cust) =>
    isMarketingEligible({
      marketingOptIn: cust.marketingOptIn,
      marketingOptInAt: cust.marketingOptInAt,
      latestConsentStatus: cust.consents[0]?.status ?? null,
    })
  );

  return {
    eligibleCount: customers.length,
    optedInTotal,
    mode,
    templateStatus: templateRecord?.status ?? null,
  };
}
