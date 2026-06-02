import crypto from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/errors";
import { env } from "@/lib/env";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";

/**
 * C-3 fix: derive a deterministic 64-bit signed integer from a restaurant ID
 * to feed `pg_advisory_xact_lock`. Postgres advisory locks accept either a
 * single bigint or two int4s. We use the first 8 bytes of SHA-256(restaurantId)
 * interpreted as a signed bigint (within JS BigInt range, then converted to
 * a string Prisma can pass as `bigint`). Hash-collision risk is acceptable:
 * the worst case is two unrelated restaurants serialize their campaign sends.
 */
function restaurantIdToLockKey(restaurantId: string): bigint {
  const hash = crypto.createHash("sha256").update(restaurantId).digest();
  // Read first 8 bytes as signed BigInt to fit Postgres bigint range.
  return hash.readBigInt64BE(0);
}
import {
  WHATSAPP_TEMPLATE_LIBRARY,
  buildTemplateParameters,
  createWhatsAppTemplate,
  decryptAccessToken,
  validateTemplateBody,
  encryptAccessToken,
  exchangeEmbeddedSignupCode,
  extractEmbeddedSignupCustomerAssets,
  fetchMetaUserId,
  fetchWhatsAppAccountPhoneNumbers,
  fetchWhatsAppPhoneNumber,
  fetchWhatsAppTemplates,
  getEmbeddedSignupConfig,
  getTokenLastFour,
  markWhatsAppMessageRead,
  mapTemplateStatus,
  normalizeWhatsAppPhone,
  renderTemplatePreview,
  registerWhatsAppPhoneNumber,
  sendWhatsAppText,
  sendWhatsAppTemplate,
  subscribeWhatsAppBusinessAccount,
} from "@/lib/whatsapp-business";
import { ORDER_TEMPLATE_DEFINITIONS } from "@/lib/whatsapp-order-templates";
import {
  isMarketingEligible,
  marketingEligibleWhere,
} from "@/lib/marketing-eligibility";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { requireAuth } from "@/middleware/auth";

const campaignSchema = z.object({
  type: z.enum(["inactive_30", "weekend_special", "new_promotion"]),
  name: z.string().trim().min(2).max(120).optional(),
  templateName: z.string().trim().min(2).max(80).optional(),
  body: z.string().trim().min(10).max(900).optional(),
  promotionId: z.string().cuid().optional(),
});

const consentSchema = z.object({
  marketingOptIn: z.boolean(),
});

const customersQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  // `recent` matches the summary endpoint's default. `name` is A→Z so
  // operators can scan alphabetically when they know the diner's name.
  sortBy: z.enum(["recent", "spend", "orders", "name"]).default("recent"),
  // Offset pagination. Acceptable for the realistic upper bound (a few
  // thousand customers per restaurant); switch to keyset if a tenant
  // ever blows past that.
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const integrationSchema = z.object({
  code: z.string().min(8),
  signupSession: z
    .object({
      event: z.string().optional(),
      type: z.string().optional(),
      data: z.record(z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});

const replySchema = z.object({
  body: z.string().trim().min(1).max(4096).optional(),
  templateName: z.string().trim().min(2).max(80).optional(),
});

const templateSubmitSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

async function getOwnedRestaurant(restaurantId: string, clerkId: string) {
  // P1 — also pull subscription + operatorAccount so the GET handler can
  // compute entitlements without a second restaurant fetch. The other
  // routes that call this helper (whatsapp-integration, campaigns, etc.)
  // ignore the extra fields, so this is a free additive widening.
  const restaurant = await prisma.restaurant.findFirst({
    where: {
      id: restaurantId,
      owner: {
        clerkId,
      },
    },
    include: {
      subscription: true,
      operatorAccount: { include: { _count: { select: { brands: true } } } },
    },
  });

  if (!restaurant) {
    throw new ApiError("Restaurant not found", 404);
  }

  return restaurant;
}

function toNumber(value: { toString(): string } | number | null | undefined) {
  if (value === null || value === undefined) {
    return 0;
  }

  return Number(value.toString());
}

function buildWhatsappUrl(phoneNumber: string, body: string) {
  const digitsOnly = phoneNumber.replace(/\D/g, "");
  const url = new URL(`https://wa.me/${digitsOnly}`);
  url.searchParams.set("text", body);
  return url.toString();
}

function getDefaultCampaignBody(input: {
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

function personalizeBody(body: string, customerName: string) {
  return body.replace(/\{\{\s*name\s*\}\}/gi, customerName);
}

function renderNumberedTemplateBody(body: string, parameters: string[]) {
  return parameters.reduce(
    (nextBody, value, index) =>
      nextBody.replace(new RegExp(`\\{\\{${index + 1}\\}\\}`, "g"), value),
    body
  );
}

function isWithinCustomerServiceWindow(value: Date | null | undefined) {
  return Boolean(value && Date.now() - value.getTime() <= 24 * 60 * 60 * 1000);
}

export function getCampaignDeliveryMode(input: {
  integrationStatus?: string | null;
  templateStatus?: string | null;
}) {
  return input.integrationStatus === "connected" && input.templateStatus === "approved"
    ? "meta_cloud_api"
    : "whatsapp_link";
}

function buildTemplateLibrary(records: Array<{
  name: string;
  language: string;
  status: string;
  metaTemplateId: string | null;
  rejectionReason: string | null;
  lastSyncedAt: Date | null;
}>) {
  return WHATSAPP_TEMPLATE_LIBRARY.map((template) => {
    const record = records.find(
      (entry) => entry.name === template.name && entry.language === template.language
    );

    return {
      ...template,
      status: record?.status ?? "draft",
      metaTemplateId: record?.metaTemplateId ?? null,
      rejectionReason: record?.rejectionReason ?? null,
      lastSyncedAt: record?.lastSyncedAt ?? null,
    };
  });
}

// Static metadata so the CRM UI can render "this fires when X happens" without
// asking the order state machine. Keyed by template name so adding a new
// utility template forces a compile-time choice about where it fires.
const TRANSACTIONAL_TEMPLATE_METADATA: Record<
  (typeof ORDER_TEMPLATE_DEFINITIONS)[number]["name"],
  { trigger: string; recipient: "customer" | "restaurant" }
> = {
  order_received_v1: {
    trigger: "Customer places a new order on the menu page.",
    recipient: "customer",
  },
  order_accepted_v1: {
    trigger: "You tap Accept on a new order in the dashboard.",
    recipient: "customer",
  },
  order_ready_v1: {
    trigger: "You tap Mark Ready on the order (pickup, delivery, or dine-in).",
    recipient: "customer",
  },
  order_cancelled_v1: {
    trigger: "Order is rejected, expires after 15 min, or fails payment.",
    recipient: "customer",
  },
  order_new_alert_v1: {
    trigger: "A new order needs the restaurant's attention.",
    recipient: "restaurant",
  },
};

function buildTransactionalTemplateLibrary(records: Array<{
  name: string;
  language: string;
  status: string;
  metaTemplateId: string | null;
  rejectionReason: string | null;
  lastSyncedAt: Date | null;
}>) {
  return ORDER_TEMPLATE_DEFINITIONS.map((template) => {
    const record = records.find(
      (entry) => entry.name === template.name && entry.language === template.language
    );
    const meta = TRANSACTIONAL_TEMPLATE_METADATA[template.name];

    return {
      name: template.name,
      label: template.label,
      category: template.category,
      language: template.language,
      body: template.body,
      variables: template.variables,
      footer: template.footer ?? null,
      trigger: meta.trigger,
      recipient: meta.recipient,
      status: record?.status ?? "draft",
      metaTemplateId: record?.metaTemplateId ?? null,
      rejectionReason: record?.rejectionReason ?? null,
      lastSyncedAt: record?.lastSyncedAt ?? null,
    };
  });
}

export const crmRoute = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
    };
  };
}>()
  .get("/:restaurantId", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const auth = c.get("auth");
      const ownedRestaurant = await getOwnedRestaurant(restaurantId, auth.clerkId);
      // P1: derive entitlements from the same row we just fetched —
      // saves a second restaurant lookup per CRM summary load.
      const entitlements = getRestaurantEntitlements(ownedRestaurant);
      const adStudioEnabled = entitlements.adStudioEnabled;

      const inactiveCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const [
        customerCount,
        optedInCount,
        repeatCustomerCount,
        inactive30Count,
        orderCount,
        revenue,
        recentOrders,
        customers,
        campaigns,
        promotions,
        integration,
        templateRecords,
        conversations,
      ] = await Promise.all([
        prisma.customer.count({ where: { restaurantId } }),
        // Opted-in count must use the SAME eligibility rule as the campaign
        // send (provable consent), otherwise the audience preview over-counts
        // legacy boolean-only customers and promises sends that get filtered
        // out. See marketing-eligibility.ts.
        prisma.customer.count({ where: marketingEligibleWhere(restaurantId) }),
        prisma.customer.count({ where: { restaurantId, orderCount: { gt: 1 } } }),
        prisma.customer.count({
          where: {
            ...marketingEligibleWhere(restaurantId),
            lastOrderAt: {
              lt: inactiveCutoff,
            },
          },
        }),
        prisma.orderIntent.count({ where: { restaurantId } }),
        prisma.orderIntent.aggregate({
          where: { restaurantId },
          _sum: {
            totalPrice: true,
          },
        }),
        prisma.orderIntent.findMany({
          where: { restaurantId },
          orderBy: { createdAt: "desc" },
          take: 10,
          include: {
            customer: true,
            items: {
              orderBy: { createdAt: "asc" },
            },
          },
        }),
        prisma.customer.findMany({
          where: { restaurantId },
          orderBy: [{ lastOrderAt: "desc" }, { createdAt: "desc" }],
          take: 50,
          include: {
            consents: {
              orderBy: {
                createdAt: "desc",
              },
              take: 1,
            },
          },
        }),
        prisma.campaign.findMany({
          where: { restaurantId },
          orderBy: { createdAt: "desc" },
          take: 10,
          include: {
            promotion: {
              select: {
                id: true,
                title: true,
              },
            },
            messages: {
              select: {
                id: true,
                customerId: true,
                status: true,
                whatsappUrl: true,
                createdAt: true,
              },
              orderBy: {
                createdAt: "desc",
              },
              take: 5,
            },
          },
        }),
        prisma.promotion.findMany({
          where: {
            restaurantId,
            isActive: true,
          },
          orderBy: [{ isFeatured: "desc" }, { displayOrder: "asc" }],
          take: 20,
          select: {
            id: true,
            title: true,
            subtitle: true,
            promoPrice: true,
            startsAt: true,
            endsAt: true,
          },
        }),
        prisma.whatsAppIntegration.findUnique({
          where: {
            restaurantId,
          },
          select: {
            id: true,
            status: true,
            wabaId: true,
            businessAccountId: true,
            phoneNumberId: true,
            displayPhoneNumber: true,
            tokenLastFour: true,
            connectedAt: true,
            lastWebhookAt: true,
            lastTemplateSyncAt: true,
            lastError: true,
            updatedAt: true,
          },
        }),
        prisma.whatsAppTemplate.findMany({
          where: {
            restaurantId,
          },
          select: {
            name: true,
            language: true,
            status: true,
            metaTemplateId: true,
            rejectionReason: true,
            lastSyncedAt: true,
          },
        }),
        prisma.whatsAppConversation.findMany({
          where: {
            restaurantId,
          },
          orderBy: {
            lastMessageAt: "desc",
          },
          take: 10,
          include: {
            messages: {
              orderBy: {
                createdAt: "desc",
              },
              take: 25,
            },
            // P1: pull the customer's CTWA referral block so the inbox
            // row can show "From: <ad headline>" with a link to the
            // attributed Ad Studio project. We only select fields the
            // frontend actually renders (no ctwaClid, no creativeId —
            // they're back-end-only). We DO need at least one column to
            // detect "has referral" since we don't expose ctwaClid;
            // referralCapturedAt is non-null IFF referral exists.
            customer: {
              select: {
                referralSourceType: true,
                referralHeadline: true,
                referralBody: true,
                referralMediaUrl: true,
                referralCapturedAt: true,
                referralAdProjectId: true,
                referralAdProject: {
                  select: { id: true, name: true },
                },
              },
            },
          },
        }),
      ]);

      return c.json({
        stats: {
          customerCount,
          optedInCount,
          repeatCustomerCount,
          inactive30Count,
          orderCount,
          estimatedRevenue: toNumber(revenue._sum.totalPrice),
        },
        recentOrders: recentOrders.map((order) => ({
          id: order.id,
          customerId: order.customerId,
          customerName: order.customerName,
          phoneNumber: order.phoneNumber,
          fulfillmentMethod: order.fulfillmentMethod,
          address: order.address,
          notes: order.notes,
          totalPrice: toNumber(order.totalPrice),
          currency: order.currency,
          itemCount: order.itemCount,
          createdAt: order.createdAt,
          items: order.items.map((item) => ({
            id: item.id,
            menuItemId: item.menuItemId,
            itemName: item.itemName,
            quantity: item.quantity,
            unitPrice: toNumber(item.unitPrice),
          })),
        })),
        customers: customers.map((customer) => ({
          id: customer.id,
          displayName: customer.displayName,
          phoneNumber: customer.phoneNumber,
          marketingOptIn: customer.marketingOptIn,
          lastOrderAt: customer.lastOrderAt,
          orderCount: customer.orderCount,
          totalSpend: toNumber(customer.totalSpend),
          currency: customer.currency,
          preferredLanguage: customer.preferredLanguage,
          createdAt: customer.createdAt,
          latestConsent: customer.consents[0]
            ? {
                status: customer.consents[0].status,
                source: customer.consents[0].source,
                createdAt: customer.consents[0].createdAt,
              }
            : null,
        })),
        campaigns: campaigns.map((campaign) => ({
          id: campaign.id,
          type: campaign.type,
          status: campaign.status,
          name: campaign.name,
          templateName: campaign.templateName,
          body: campaign.body,
          targetSegment: campaign.targetSegment,
          targetCount: campaign.targetCount,
          loggedCount: campaign.loggedCount,
          createdAt: campaign.createdAt,
          loggedAt: campaign.loggedAt,
          promotion: campaign.promotion,
          messages: campaign.messages,
        })),
        promotions: promotions.map((promotion) => ({
          ...promotion,
          promoPrice: toNumber(promotion.promoPrice),
        })),
        whatsapp: {
          embeddedSignup: getEmbeddedSignupConfig(),
          integration,
          templates: buildTemplateLibrary(templateRecords),
          transactionalTemplates: buildTransactionalTemplateLibrary(templateRecords),
          conversations: conversations.map((conversation) => {
            const c = conversation.customer;
            // referralCapturedAt is non-null IFF the referral was
            // captured — we use it as the "has referral" sentinel
            // because ctwaClid (the natural choice) isn't exposed
            // to the response.
            const hasReferral = Boolean(c?.referralCapturedAt);
            // P1: full payload only on Pro+. Starter sees a teaser flag
            // so we can render an upsell hint without leaking the ad
            // headline (which is the most upgrade-driving signal).
            const referral = hasReferral
              ? adStudioEnabled
                ? {
                    sourceType: c?.referralSourceType ?? null,
                    headline: c?.referralHeadline ?? null,
                    body: c?.referralBody ?? null,
                    mediaUrl: c?.referralMediaUrl ?? null,
                    capturedAt: c?.referralCapturedAt ?? null,
                    adProjectId: c?.referralAdProjectId ?? null,
                    adProjectName: c?.referralAdProject?.name ?? null,
                    teaser: false as const,
                  }
                : { teaser: true as const }
              : null;
            return {
              id: conversation.id,
              customerId: conversation.customerId,
              customerPhone: conversation.customerPhone,
              customerName: conversation.customerName,
              lastMessageAt: conversation.lastMessageAt,
              unreadCount: conversation.unreadCount,
              referral,
              latestMessage: conversation.messages[0]
                ? {
                    id: conversation.messages[0].id,
                    direction: conversation.messages[0].direction,
                    type: conversation.messages[0].type,
                    status: conversation.messages[0].status,
                    body: conversation.messages[0].body,
                    createdAt: conversation.messages[0].createdAt,
                  }
                : null,
              messages: conversation.messages
                .slice()
                .reverse()
                .map((message) => ({
                  id: message.id,
                  direction: message.direction,
                  type: message.type,
                  status: message.status,
                  body: message.body,
                  providerMessageId: message.providerMessageId,
                  sentAt: message.sentAt,
                  deliveredAt: message.deliveredAt,
                  readAt: message.readAt,
                  failedAt: message.failedAt,
                  createdAt: message.createdAt,
                })),
            };
          }),
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/:restaurantId/customers", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const auth = c.get("auth");
      await getOwnedRestaurant(restaurantId, auth.clerkId);
      const { search, sortBy, offset, limit } = customersQuerySchema.parse(
        Object.fromEntries(new URL(c.req.url).searchParams.entries())
      );

      // Search is a case-insensitive substring match on displayName OR
      // phoneNumber. Phone search is forgiving: we strip non-digits from
      // the term so "+971 50 749" and "971507" both find the same row.
      const where: Prisma.CustomerWhereInput = { restaurantId };
      if (search) {
        const phoneDigits = search.replace(/\D/g, "");
        where.OR = [
          { displayName: { contains: search, mode: "insensitive" } },
          { phoneNumber: { contains: search, mode: "insensitive" } },
          ...(phoneDigits.length >= 3
            ? [{ normalizedPhone: { contains: phoneDigits } }]
            : []),
        ];
      }

      // Sort presets — each falls back to recency so identical primary
      // values (two customers with 0 orders, etc.) still land in a
      // stable, useful order.
      const orderBy: Prisma.CustomerOrderByWithRelationInput[] =
        sortBy === "spend"
          ? [{ totalSpend: "desc" }, { lastOrderAt: "desc" }]
          : sortBy === "orders"
            ? [{ orderCount: "desc" }, { lastOrderAt: "desc" }]
            : sortBy === "name"
              ? [{ displayName: "asc" }]
              : [{ lastOrderAt: "desc" }, { createdAt: "desc" }];

      const [rows, total] = await Promise.all([
        prisma.customer.findMany({
          where,
          orderBy,
          skip: offset,
          take: limit,
          include: {
            consents: {
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        }),
        prisma.customer.count({ where }),
      ]);

      return c.json({
        customers: rows.map((customer) => ({
          id: customer.id,
          displayName: customer.displayName,
          phoneNumber: customer.phoneNumber,
          marketingOptIn: customer.marketingOptIn,
          lastOrderAt: customer.lastOrderAt,
          orderCount: customer.orderCount,
          totalSpend: toNumber(customer.totalSpend),
          currency: customer.currency,
          preferredLanguage: customer.preferredLanguage,
          createdAt: customer.createdAt,
          latestConsent: customer.consents[0]
            ? {
                status: customer.consents[0].status,
                source: customer.consents[0].source,
                createdAt: customer.consents[0].createdAt,
              }
            : null,
        })),
        total,
        nextOffset: offset + rows.length < total ? offset + rows.length : null,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/whatsapp-integration", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const auth = c.get("auth");
      await getOwnedRestaurant(restaurantId, auth.clerkId);
      const data = integrationSchema.parse(await c.req.json());
      const sessionAssets = extractEmbeddedSignupCustomerAssets(data.signupSession);

      if (sessionAssets.event === "CANCEL" || sessionAssets.errorCode || sessionAssets.errorMessage) {
        throw new ApiError(
          sessionAssets.errorMessage ??
            `Meta signup was not completed${sessionAssets.currentStep ? ` at ${sessionAssets.currentStep}` : ""}.`,
          400
        );
      }

      if (!sessionAssets.wabaId || !sessionAssets.phoneNumberId) {
        throw new ApiError("Meta signup did not return a WhatsApp Business Account and phone number.", 400);
      }

      const accessToken = await exchangeEmbeddedSignupCode(data.code);
      // C-1 fix: resolve Meta `user_id` so data-deletion + deauthorize
      // callbacks can fan-out across this user's integrations. Failure
      // here is non-fatal — best-effort.
      const metaUserId = await fetchMetaUserId(accessToken);
      const [phoneNumber, accountPhoneNumbers] = await Promise.all([
        fetchWhatsAppPhoneNumber({
          accessToken,
          phoneNumberId: sessionAssets.phoneNumberId,
        }),
        fetchWhatsAppAccountPhoneNumbers({
          accessToken,
          wabaId: sessionAssets.wabaId,
        }),
      ]);
      const verifiedPhone = accountPhoneNumbers.data?.find(
        (entry) => entry.id === sessionAssets.phoneNumberId
      );

      if (!verifiedPhone) {
        throw new ApiError("The selected phone number was not found on the selected WhatsApp Business Account.", 400);
      }

      await subscribeWhatsAppBusinessAccount({
        accessToken,
        wabaId: sessionAssets.wabaId,
      });
      await registerWhatsAppPhoneNumber({
        accessToken,
        phoneNumberId: sessionAssets.phoneNumberId,
      });

      const displayPhoneNumber =
        phoneNumber.display_phone_number ??
        verifiedPhone.display_phone_number ??
        sessionAssets.displayPhoneNumber ??
        "";

      const integration = await prisma.whatsAppIntegration.upsert({
        where: {
          restaurantId,
        },
        create: {
          restaurantId,
          status: "connected",
          wabaId: sessionAssets.wabaId,
          businessAccountId: sessionAssets.businessAccountId ?? null,
          metaUserId,
          phoneNumberId: sessionAssets.phoneNumberId,
          displayPhoneNumber: normalizeWhatsAppPhone(displayPhoneNumber),
          accessTokenCipher: encryptAccessToken(accessToken),
          tokenLastFour: getTokenLastFour(accessToken),
          connectedAt: new Date(),
          lastError: null,
        },
        update: {
          status: "connected",
          wabaId: sessionAssets.wabaId,
          businessAccountId: sessionAssets.businessAccountId ?? undefined,
          metaUserId: metaUserId ?? undefined,
          phoneNumberId: sessionAssets.phoneNumberId,
          displayPhoneNumber: normalizeWhatsAppPhone(displayPhoneNumber),
          accessTokenCipher: encryptAccessToken(accessToken),
          tokenLastFour: getTokenLastFour(accessToken),
          connectedAt: new Date(),
          lastError: null,
        },
        select: {
          id: true,
          status: true,
          wabaId: true,
          businessAccountId: true,
          phoneNumberId: true,
          displayPhoneNumber: true,
          tokenLastFour: true,
          connectedAt: true,
          lastWebhookAt: true,
          lastTemplateSyncAt: true,
          lastError: true,
          updatedAt: true,
        },
      });

      await prisma.whatsAppTemplate.createMany({
        data: WHATSAPP_TEMPLATE_LIBRARY.map((template) => ({
          restaurantId,
          integrationId: integration.id,
          name: template.name,
          label: template.label,
          category: template.category,
          language: template.language,
          status: "draft",
          body: template.body,
          variables: template.variables,
        })),
        skipDuplicates: true,
      });

      return c.json({ integration }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .delete("/:restaurantId/whatsapp-integration", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const auth = c.get("auth");
      await getOwnedRestaurant(restaurantId, auth.clerkId);

      // C4 fix: zero out the encrypted token on disconnect. Previously the
      // ~60-day Meta token cipher persisted in the row even after a
      // "disconnect" — combined with a future key compromise or backup
      // leak, that's recoverable credentials. PDPL/GDPR right-to-erasure
      // also expects credentials wiped on disconnect.
      const integration = await prisma.whatsAppIntegration.update({
        where: {
          restaurantId,
        },
        data: {
          status: "disconnected",
          lastError: null,
          accessTokenCipher: "",
          tokenLastFour: null,
          wabaId: null,
          // M-3: also null the Meta user ID so a future deletion
          // callback for this user only fans out to integrations they
          // still control.
          metaUserId: null,
          // Reset connectedAt so the dashboard "connected since" badge
          // doesn't lie after disconnect.
          connectedAt: null,
        },
        select: {
          id: true,
          status: true,
        },
      });

      return c.json({ integration });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/whatsapp-integration/sync-templates", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const auth = c.get("auth");
      await getOwnedRestaurant(restaurantId, auth.clerkId);

      const integration = await prisma.whatsAppIntegration.findUnique({
        where: {
          restaurantId,
        },
      });

      if (!integration?.wabaId) {
        throw new ApiError("Connect a WhatsApp Business account before syncing templates.", 400);
      }

      const accessToken = decryptAccessToken(integration.accessTokenCipher);
      const response = await fetchWhatsAppTemplates({
        accessToken,
        wabaId: integration.wabaId,
      });
      const templates = response.data ?? [];
      const syncedAt = new Date();

      for (const template of templates) {
        // Look up first in the marketing library, then in the utility
        // (order) template definitions. Either match gives us a nicer
        // label and known `variables` array than Meta's response alone.
        const marketingLibraryTemplate = WHATSAPP_TEMPLATE_LIBRARY.find(
          (entry) => entry.name === template.name
        );
        const transactionalLibraryTemplate = ORDER_TEMPLATE_DEFINITIONS.find(
          (entry) => entry.name === template.name
        );
        const libraryLabel =
          marketingLibraryTemplate?.label ?? transactionalLibraryTemplate?.label;
        const libraryCategory =
          marketingLibraryTemplate?.category ?? transactionalLibraryTemplate?.category;
        const libraryVariables =
          marketingLibraryTemplate?.variables ??
          transactionalLibraryTemplate?.variables ??
          [];
        const libraryBody =
          marketingLibraryTemplate?.body ?? transactionalLibraryTemplate?.body ?? "";
        const body =
          template.components?.find((component) => component.type?.toUpperCase() === "BODY")?.text ??
          libraryBody;

        await prisma.whatsAppTemplate.upsert({
          where: {
            restaurantId_name_language: {
              restaurantId,
              name: template.name,
              language: template.language ?? "en",
            },
          },
          create: {
            restaurantId,
            integrationId: integration.id,
            name: template.name,
            label: libraryLabel ?? template.name.replace(/_/g, " "),
            category: template.category ?? libraryCategory ?? "MARKETING",
            language: template.language ?? "en",
            status: mapTemplateStatus(template.status),
            body,
            variables: libraryVariables,
            metaTemplateId: template.id ?? null,
            rejectionReason:
              template.rejected_reason && template.rejected_reason !== "NONE"
                ? template.rejected_reason
                : null,
            lastSyncedAt: syncedAt,
          },
          update: {
            integrationId: integration.id,
            category: template.category ?? libraryCategory ?? "MARKETING",
            status: mapTemplateStatus(template.status),
            body,
            metaTemplateId: template.id ?? null,
            rejectionReason:
              template.rejected_reason && template.rejected_reason !== "NONE"
                ? template.rejected_reason
                : null,
            lastSyncedAt: syncedAt,
          },
        });
      }

      await prisma.whatsAppIntegration.update({
        where: {
          id: integration.id,
        },
        data: {
          lastTemplateSyncAt: syncedAt,
          lastError: null,
        },
      });

      return c.json({ synced: templates.length, syncedAt });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/whatsapp-templates/submit", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const auth = c.get("auth");
      await getOwnedRestaurant(restaurantId, auth.clerkId);
      const data = templateSubmitSchema.parse(await c.req.json());
      const template = WHATSAPP_TEMPLATE_LIBRARY.find((entry) => entry.name === data.name);

      if (!template) {
        throw new ApiError("Template not found", 404);
      }

      const integration = await prisma.whatsAppIntegration.findFirst({
        where: {
          restaurantId,
          status: "connected",
        },
      });

      if (!integration?.wabaId) {
        throw new ApiError("Connect a WhatsApp Business account before submitting templates.", 400);
      }

      // M2 fix: lint the template body before posting to Meta. Catches
      // common rejection causes (URLs in MARKETING, shouting, bad variable
      // numbering, oversize) and surfaces them as actionable 400s instead
      // of letting Meta reject post-submit and confuse the operator.
      const validation = validateTemplateBody({
        body: template.body,
        category: template.category,
        variables: template.variables,
      });
      if (!validation.ok) {
        throw new ApiError(validation.reason, 400);
      }

      const accessToken = decryptAccessToken(integration.accessTokenCipher);
      const bodyExamples = (template.variables ?? []).map((varName: string) => {
        switch (varName) {
          case "customer_name":
            return "Sarah";
          case "restaurant_name":
            return "Bustan Sample Kitchen";
          case "promotion_title":
            return "Weekend Brunch Special";
          default:
            return "Sample";
        }
      });

      const response = await createWhatsAppTemplate({
        accessToken,
        wabaId: integration.wabaId,
        name: template.name,
        category: template.category,
        language: template.language,
        body: template.body,
        bodyExamples,
      });
      const submittedAt = new Date();
      const record = await prisma.whatsAppTemplate.upsert({
        where: {
          restaurantId_name_language: {
            restaurantId,
            name: template.name,
            language: template.language,
          },
        },
        create: {
          restaurantId,
          integrationId: integration.id,
          name: template.name,
          label: template.label,
          category: response.category ?? template.category,
          language: template.language,
          status: mapTemplateStatus(response.status) === "draft" ? "pending" : mapTemplateStatus(response.status),
          body: template.body,
          variables: template.variables,
          metaTemplateId: response.id ?? null,
          lastSyncedAt: submittedAt,
        },
        update: {
          integrationId: integration.id,
          category: response.category ?? template.category,
          status: mapTemplateStatus(response.status) === "draft" ? "pending" : mapTemplateStatus(response.status),
          body: template.body,
          variables: template.variables,
          metaTemplateId: response.id ?? undefined,
          rejectionReason: null,
          lastSyncedAt: submittedAt,
        },
      });

      return c.json({ template: record }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/conversations/:conversationId/messages", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const conversationId = c.req.param("conversationId");
      const auth = c.get("auth");
      const restaurant = await getOwnedRestaurant(restaurantId, auth.clerkId);
      const data = replySchema.parse(await c.req.json());

      if (!data.body && !data.templateName) {
        throw new ApiError("Reply body or template is required.", 400);
      }

      const [integration, conversation] = await Promise.all([
        prisma.whatsAppIntegration.findFirst({
          where: {
            restaurantId,
            status: "connected",
          },
        }),
        prisma.whatsAppConversation.findFirst({
          where: {
            id: conversationId,
            restaurantId,
          },
          include: {
            customer: true,
            messages: {
              where: {
                direction: "inbound",
              },
              orderBy: {
                createdAt: "desc",
              },
              take: 1,
            },
          },
        }),
      ]);

      if (!integration) {
        throw new ApiError("Connect a WhatsApp Business account before replying.", 400);
      }

      if (!conversation) {
        throw new ApiError("Conversation not found", 404);
      }

      const accessToken = decryptAccessToken(integration.accessTokenCipher);
      const customerName =
        conversation.customerName ??
        conversation.customer?.displayName ??
        conversation.customerPhone;
      let providerMessageId: string;
      let body: string;
      let type: "text" | "template";
      let templateName: string | null = null;

      if (data.templateName) {
        const templateRecord = await prisma.whatsAppTemplate.findUnique({
          where: {
            restaurantId_name_language: {
              restaurantId,
              name: data.templateName,
              language: "en",
            },
          },
        });

        if (!templateRecord || templateRecord.status !== "approved") {
          throw new ApiError("Select an approved WhatsApp template before sending this reply.", 400);
        }

        const parameters = buildTemplateParameters({
          templateName: data.templateName,
          customerName,
          restaurantName: restaurant.name,
        });
        providerMessageId = await sendWhatsAppTemplate({
          accessToken,
          phoneNumberId: integration.phoneNumberId,
          to: conversation.customerPhone,
          templateName: data.templateName,
          language: "en",
          parameters,
        });
        body = renderNumberedTemplateBody(templateRecord.body, parameters);
        type = "template";
        templateName = data.templateName;
      } else {
        const lastInboundAt = conversation.messages[0]?.createdAt ?? null;
        if (!isWithinCustomerServiceWindow(lastInboundAt)) {
          throw new ApiError("Use an approved template to reply outside the 24-hour customer service window.", 400);
        }

        body = data.body as string;
        providerMessageId = await sendWhatsAppText({
          accessToken,
          phoneNumberId: integration.phoneNumberId,
          to: conversation.customerPhone,
          body,
        });
        type = "text";
      }

      const sentAt = new Date();
      const message = await prisma.$transaction(async (tx) => {
        const messageLog = await tx.messageLog.create({
          data: {
            restaurantId,
            customerId: conversation.customerId,
            direction: "outbound",
            status: "sent",
            body,
            templateName,
            providerMessageId,
            sentAt,
          },
          select: {
            id: true,
          },
        });

        const created = await tx.whatsAppMessage.create({
          data: {
            restaurantId,
            integrationId: integration.id,
            conversationId: conversation.id,
            customerId: conversation.customerId,
            messageLogId: messageLog.id,
            providerMessageId,
            direction: "outbound",
            type,
            status: "sent",
            fromPhone: integration.displayPhoneNumber,
            toPhone: conversation.customerPhone,
            body,
            sentAt,
          },
        });

        await tx.whatsAppConversation.update({
          where: {
            id: conversation.id,
          },
          data: {
            lastMessageAt: sentAt,
          },
        });

        return created;
      });

      return c.json({ message }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .patch("/:restaurantId/conversations/:conversationId/read", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const conversationId = c.req.param("conversationId");
      const auth = c.get("auth");
      await getOwnedRestaurant(restaurantId, auth.clerkId);

      const conversation = await prisma.whatsAppConversation.findFirst({
        where: {
          id: conversationId,
          restaurantId,
        },
        include: {
          integration: true,
          messages: {
            where: {
              direction: "inbound",
              providerMessageId: {
                not: null,
              },
            },
            orderBy: {
              createdAt: "desc",
            },
            take: 1,
          },
        },
      });

      if (!conversation) {
        throw new ApiError("Conversation not found", 404);
      }

      const latestInbound = conversation.messages[0];
      // M5 fix: don't decrypt the token when the integration is no longer
      // connected. A disconnected integration may have an empty cipher
      // (DELETE wipes it) or one that's encrypted with a rotated key —
      // both cases throw inside decryptAccessToken and surface a 503 to
      // the user just for marking a message read. Silently skip instead.
      if (
        conversation.integration?.status === "connected" &&
        conversation.integration.accessTokenCipher &&
        latestInbound?.providerMessageId
      ) {
        await markWhatsAppMessageRead({
          accessToken: decryptAccessToken(conversation.integration.accessTokenCipher),
          phoneNumberId: conversation.integration.phoneNumberId,
          messageId: latestInbound.providerMessageId,
        }).catch(() => null);
      }

      const updated = await prisma.whatsAppConversation.update({
        where: {
          id: conversation.id,
        },
        data: {
          unreadCount: 0,
        },
        select: {
          id: true,
          unreadCount: true,
        },
      });

      return c.json({ conversation: updated });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/campaigns", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const auth = c.get("auth");
      const restaurant = await getOwnedRestaurant(restaurantId, auth.clerkId);
      const data = campaignSchema.parse(await c.req.json());

      const promotion = data.promotionId
        ? await prisma.promotion.findFirst({
            where: {
              id: data.promotionId,
              restaurantId,
            },
            select: {
              id: true,
              title: true,
            },
          })
        : null;

      if (data.promotionId && !promotion) {
        throw new ApiError("Promotion not found", 404);
      }

      const templateName = data.templateName ?? data.type;
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
      const inactiveCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      // C6 fix: campaigns must NEVER send to customers without proof of
      // consent. The eligibility rule (boolean + timestamp + opt_in paper
      // trail, with latest-consent precedence) lives in marketing-eligibility.ts
      // and is shared with the audience-preview counts in the summary endpoint
      // so the two can never drift apart again. The `consents.some(opt_in)`
      // part of the where also defends against direct DB writes / migrations
      // that flip the boolean without a paper trail.
      const baseWhere = marketingEligibleWhere(restaurantId);
      const customerWhere =
        data.type === "inactive_30"
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
        type: data.type,
        restaurantName: restaurant.name,
        promotionTitle: promotion?.title,
      });
      const body = canSendViaApi && templateRecord ? templateRecord.body : data.body ?? fallbackBody;
      const campaignName =
        data.name ??
        (data.type === "inactive_30"
          ? "30-day reactivation"
          : data.type === "new_promotion"
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
            type: data.type,
            status: canSendViaApi ? "sending" : "logged",
            name: campaignName,
            templateName,
            body,
            targetSegment: data.type,
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
          restaurantName: restaurant.name,
          promotionTitle: promotion?.title,
        });
        const personalizedBody =
          canSendViaApi && templateRecord
            ? renderNumberedTemplateBody(templateRecord.body, parameters)
            : data.body
              ? personalizeBody(data.body, customer.displayName)
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

      return c.json({
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
        segment: data.type,
        mode: deliveryMode,
      }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .patch("/:restaurantId/customers/:customerId/consent", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const customerId = c.req.param("customerId");
      const auth = c.get("auth");
      await getOwnedRestaurant(restaurantId, auth.clerkId);
      const data = consentSchema.parse(await c.req.json());

      const updated = await prisma.$transaction(async (tx) => {
        const existingCustomer = await tx.customer.findFirst({
          where: {
            id: customerId,
            restaurantId,
          },
          select: {
            id: true,
          },
        });

        if (!existingCustomer) {
          throw new ApiError("Customer not found", 404);
        }

        // C5 fix: opt-out precedence. If this PATCH is trying to flip a
        // customer back to opt_in BUT the latest user-initiated consent
        // record is opt_out (e.g. they texted STOP), refuse. The customer
        // must opt back in via a fresh user-side event (form / keyword) —
        // the dashboard cannot override a user's stated preference.
        // WhatsApp's marketing policy treats this as a tier-degrading
        // violation; PDPL/GDPR explicitly forbid manual re-opt-in by the
        // controller without the data subject's renewed consent.
        if (data.marketingOptIn) {
          const latestConsent = await tx.customerConsent.findFirst({
            where: { restaurantId, customerId },
            orderBy: { createdAt: "desc" },
            select: { status: true, source: true },
          });
          if (
            latestConsent?.status === "opt_out" &&
            (latestConsent.source === "whatsapp_keyword" ||
              latestConsent.source === "whatsapp")
          ) {
            throw new ApiError(
              "This customer texted STOP. They must opt in again themselves before you can re-enable marketing.",
              409
            );
          }
        }

        const customer = await tx.customer.update({
          where: {
            id: customerId,
          },
          data: {
            marketingOptIn: data.marketingOptIn,
            marketingOptInAt: data.marketingOptIn ? new Date() : undefined,
            marketingOptOutAt: data.marketingOptIn ? null : new Date(),
          },
        });

        await tx.customerConsent.create({
          data: {
            restaurantId,
            customerId,
            status: data.marketingOptIn ? "opt_in" : "opt_out",
            source: "dashboard",
          },
        });

        return customer;
      });

      return c.json({
        id: updated.id,
        marketingOptIn: updated.marketingOptIn,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .patch("/:restaurantId/customers/:customerId/language", requireAuth, async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const customerId = c.req.param("customerId");
      const auth = c.get("auth");
      await getOwnedRestaurant(restaurantId, auth.clerkId);

      const { preferredLanguage } = z
        .object({ preferredLanguage: z.enum(["en", "ar"]).nullable() })
        .parse(await c.req.json());

      const customer = await prisma.customer.findFirst({
        where: { id: customerId, restaurantId },
        select: { id: true },
      });
      if (!customer) {
        throw new ApiError("Customer not found", 404);
      }

      const updated = await prisma.customer.update({
        where: { id: customer.id },
        data: { preferredLanguage },
        select: { id: true, preferredLanguage: true },
      });

      return c.json(updated);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
