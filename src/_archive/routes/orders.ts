/**
 * WhatsApp Ordering v1 — public endpoints.
 *
 *   POST /api/orders/:restaurantId        create an order from a cart
 *   GET  /api/orders/:orderNumber/status  public status (orderNumber + token = auth)
 *
 * The POST endpoint replaces the legacy `POST /api/whatsapp/cart-redirect/:restaurantId`
 * flow. Creates a real OrderIntent, sends both the customer receipt AND the
 * restaurant alert as proper WhatsApp template messages, and returns a status
 * URL + HMAC token the frontend redirects to.
 *
 * Hardening summary (post-review):
 *   - H3: strict UAE E.164 validation; normalizedPhone persisted on OrderIntent.
 *   - H4: post-commit message-id update uses updateMany with where-guard.
 *   - H5/M5: customerConsent only written when consent === true.
 *   - H8: 8-char order number + HMAC token gate on status page.
 *   - H9: admin endpoints have rate limits + body-size caps.
 *   - L2: status endpoint shows integration display number, not whatsappNumber.
 *   - L3: today query uses UAE-local midnight (Asia/Dubai = UTC+4).
 */

import { Prisma } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { env } from "@/lib/env";
import { getEffectiveRestaurantBillingState } from "@/lib/entitlements";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { buildPublicMenuItemWhere } from "@/lib/menu-visibility";
import {
  deriveOrderUrlToken,
  generateOrderNumber,
  verifyOrderUrlToken,
} from "@/lib/order-numbers";
import { sendOrderTemplate } from "@/lib/order-messages";
import { transitionOrder } from "@/lib/order-state-machine";
import { prisma } from "@/lib/prisma";
import {
  assertAllowedPublicOrigin,
  consumeRateLimit,
  getClientIp,
} from "@/lib/public-request-guards";
import { normalizeUaePhone } from "@/lib/uae-phone";
import {
  createWhatsAppTemplateWithComponents,
  decryptAccessToken,
  mapTemplateStatus,
  validateTemplateBody,
} from "@/lib/whatsapp-business";
import {
  ORDER_TEMPLATE_DEFINITIONS,
  buildMetaTemplateComponents,
} from "@/lib/whatsapp-order-templates";
import { requireAuth } from "@/middleware/auth";

const ORDER_EXPIRY_MINUTES = 15;
const UAE_VAT_RATE = 0.05;
const MAX_ADMIN_BODY_BYTES = 4 * 1024;

const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        menuItemId: z.string().cuid(),
        quantity: z.coerce.number().int().positive().max(20),
        unitPrice: z.coerce.number().nonnegative(),
      })
    )
    .min(1)
    .max(25),
  currency: z
    .string()
    .trim()
    .min(3)
    .max(3)
    .default("AED")
    .transform((v) => v.toUpperCase()),
  path: z.string().max(255).optional(),
  campaign: z.string().max(120).optional(),
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    phoneNumber: z.string().trim().min(8).max(32),
    fulfillmentMethod: z.enum(["delivery", "pickup", "dine_in"]),
    address: z.string().trim().max(240).optional(),
    notes: z.string().trim().max(300).optional(),
    marketingConsent: z.boolean().default(false),
  }),
});

function normalizeCartItems(
  items: Array<{ menuItemId: string; quantity: number; unitPrice: number }>
) {
  const dedup = new Map<string, { menuItemId: string; quantity: number; unitPrice: number }>();
  for (const item of items) {
    const existing = dedup.get(item.menuItemId);
    if (existing) {
      existing.quantity += item.quantity;
      continue;
    }
    dedup.set(item.menuItemId, { ...item });
  }
  return Array.from(dedup.values());
}

function getEffectiveMenuItemPrice(menuItem: {
  price: { toString(): string };
  promotionItems: Array<{ promotion: { promoPrice: { toString(): string } | null } }>;
}) {
  const basePrice = Number(menuItem.price.toString());
  const promo = menuItem.promotionItems[0]?.promotion.promoPrice;
  const promoPrice = promo ? Number(promo.toString()) : null;
  if (promoPrice !== null && Number.isFinite(promoPrice) && promoPrice > 0 && promoPrice < basePrice) {
    return promoPrice;
  }
  return basePrice;
}

function fulfillmentLabel(method: "delivery" | "pickup" | "dine_in") {
  if (method === "delivery") return "Delivery";
  if (method === "pickup") return "Pickup";
  return "Dine-in";
}

function buildOrderUrl(orderNumber: string, token: string) {
  // H8: token is the auth gate; orderNumber is just a human-readable handle.
  const base = env.FRONTEND_APP_URL.replace(/\/$/, "");
  return `${base}/order/${orderNumber}?t=${token}`;
}

export const ordersRoute = new Hono()
  .post("/:restaurantId", async (c) => {
    try {
      const clientIp = getClientIp(c);
      assertAllowedPublicOrigin(c);

      const globalLimit = consumeRateLimit({
        key: `orders:global:${clientIp}`,
        limit: 30,
        windowMs: 10 * 60_000,
      });
      if (!globalLimit.allowed) {
        throw new ApiError("Too many order requests. Please try again shortly.", 429);
      }

      const restaurantId = c.req.param("restaurantId");
      const payload = createOrderSchema.parse(await c.req.json());

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        include: {
          subscription: true,
          whatsappIntegration: true,
          operatorAccount: { include: { _count: { select: { brands: true } } } },
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      const billingState = getEffectiveRestaurantBillingState(restaurant);
      if (!billingState.isPublished) {
        throw new ApiError("Restaurant not found", 404);
      }

      if (!restaurant.ordersV1Enabled) {
        throw new ApiError("Direct ordering is not enabled for this restaurant.", 404);
      }

      const integration = restaurant.whatsappIntegration;
      if (!integration || integration.status !== "connected") {
        throw new ApiError(
          "Direct ordering requires a connected WhatsApp Business account.",
          409
        );
      }

      const perRestaurantLimit = consumeRateLimit({
        key: `orders:${clientIp}:${restaurantId}`,
        limit: 10,
        windowMs: 10 * 60_000,
      });
      if (!perRestaurantLimit.allowed) {
        throw new ApiError("Too many order requests for this restaurant. Please try again shortly.", 429);
      }

      // H3: strict UAE validation. The frontend pre-normalizes but we don't
      // trust client input — if the phone isn't UAE-shaped, fail at the
      // boundary with a clear message rather than send a receipt to nowhere.
      const normalizedCustomerPhone = normalizeUaePhone(payload.customer.phoneNumber);
      if (!normalizedCustomerPhone) {
        throw new ApiError(
          "Please enter a valid UAE WhatsApp number (e.g. +97150 123 4567).",
          400
        );
      }

      const perPhoneLimit = consumeRateLimit({
        key: `orders:phone:${normalizedCustomerPhone}`,
        limit: 3,
        windowMs: 60 * 60_000,
      });
      if (!perPhoneLimit.allowed) {
        throw new ApiError("This number has placed too many orders recently. Try again later.", 429);
      }

      if (payload.path) {
        const allowedPaths = new Set([`/${restaurant.slug}`, `/embed/${restaurant.slug}`]);
        if (!allowedPaths.has(payload.path)) {
          throw new ApiError("Invalid cart path", 400);
        }
      }

      const normalizedItems = normalizeCartItems(payload.items);
      const itemIds = normalizedItems.map((i) => i.menuItemId);
      const now = new Date();

      const menuItems = await prisma.menuItem.findMany({
        where: {
          ...buildPublicMenuItemWhere(now),
          id: { in: itemIds },
          restaurantId: restaurant.id,
        },
        select: {
          id: true,
          name: true,
          price: true,
          currency: true,
          promotionItems: {
            where: {
              promotion: {
                restaurantId: restaurant.id,
                type: "discounted_item",
                isActive: true,
                OR: [{ startsAt: null }, { startsAt: { lte: now } }],
                AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
              },
            },
            select: { promotion: { select: { promoPrice: true } } },
            orderBy: { displayOrder: "asc" },
            take: 1,
          },
        },
      });

      if (menuItems.length !== itemIds.length) {
        throw new ApiError("One or more cart items are no longer available.", 409, {
          code: "cart_items_unavailable",
        });
      }

      const menuItemsById = new Map(menuItems.map((m) => [m.id, m]));
      const currency = menuItems[0]?.currency ?? payload.currency;
      const orderItems = normalizedItems.map((entry) => {
        const menuItem = menuItemsById.get(entry.menuItemId);
        if (!menuItem) {
          throw new ApiError("One or more cart items are no longer available.", 409, {
          code: "cart_items_unavailable",
        });
        }
        const unitPrice = getEffectiveMenuItemPrice(menuItem);
        return {
          menuItemId: menuItem.id,
          name: menuItem.name,
          quantity: entry.quantity,
          unitPrice,
          lineTotal: Math.round(unitPrice * entry.quantity * 100) / 100,
        };
      });

      const subtotal = Math.round(orderItems.reduce((s, i) => s + i.lineTotal, 0) * 100) / 100;
      const vatAmount = Math.round(subtotal * UAE_VAT_RATE * 100) / 100;
      const totalPrice = Math.round((subtotal + vatAmount) * 100) / 100;
      const itemCount = orderItems.reduce((s, i) => s + i.quantity, 0);
      const expiresAt = new Date(now.getTime() + ORDER_EXPIRY_MINUTES * 60_000);

      // H8: 8 chars of Crockford = ~40 bits. Collisions are effectively
      // impossible, but the unique-index retry keeps us correct under any
      // future entropy-tuning. Up to 10 attempts now (was 5).
      let orderNumber: string | null = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = generateOrderNumber();
        const exists = await prisma.orderIntent.findUnique({
          where: { orderNumber: candidate },
          select: { id: true },
        });
        if (!exists) {
          orderNumber = candidate;
          break;
        }
      }
      if (!orderNumber) {
        throw new ApiError("Could not allocate an order number. Try again.", 503);
      }
      const urlToken = deriveOrderUrlToken(orderNumber);

      const created = await prisma.$transaction(async (tx) => {
        const capturedAt = new Date();

        const customer = await tx.customer.upsert({
          where: {
            restaurantId_normalizedPhone: {
              restaurantId: restaurant.id,
              normalizedPhone: normalizedCustomerPhone,
            },
          },
          create: {
            restaurantId: restaurant.id,
            normalizedPhone: normalizedCustomerPhone,
            phoneNumber: payload.customer.phoneNumber,
            displayName: payload.customer.name,
            marketingOptIn: payload.customer.marketingConsent,
            marketingOptInAt: payload.customer.marketingConsent ? capturedAt : null,
            marketingOptOutAt: null,
            lastOrderAt: capturedAt,
            orderCount: 1,
            totalSpend: totalPrice,
            currency,
          },
          update: {
            phoneNumber: payload.customer.phoneNumber,
            displayName: payload.customer.name,
            marketingOptIn: payload.customer.marketingConsent,
            marketingOptInAt: payload.customer.marketingConsent ? capturedAt : undefined,
            marketingOptOutAt: payload.customer.marketingConsent ? null : undefined,
            lastOrderAt: capturedAt,
            orderCount: { increment: 1 },
            totalSpend: { increment: totalPrice },
            currency,
          },
          select: { id: true },
        });

        // M5 fix: only write consent row for explicit opt-in. A first-time
        // customer leaving the checkbox unticked is "never asked", not
        // "opted out" — recording opt_out poisons the audit trail and
        // blocks legitimate future opt-in flows. Matches the existing
        // whatsapp.ts pattern (H6/M6 fix there).
        if (payload.customer.marketingConsent) {
          await tx.customerConsent.create({
            data: {
              restaurantId: restaurant.id,
              customerId: customer.id,
              status: "opt_in",
              source: "orders_v1_checkout",
              ipAddress: clientIp,
              userAgent: c.req.header("user-agent") ?? null,
            },
          });
        }

        const click = await tx.whatsAppClick.create({
          data: {
            restaurantId: restaurant.id,
            source: "cart_order",
            path: payload.path ?? null,
            campaign: payload.campaign ?? null,
            referrer: c.req.header("referer") ?? c.req.header("referrer") ?? null,
            userAgent: c.req.header("user-agent") ?? null,
          },
        });

        const orderIntent = await tx.orderIntent.create({
          data: {
            restaurantId: restaurant.id,
            customerId: customer.id,
            clickId: click.id,
            orderNumber: orderNumber!,
            urlToken,
            status: "pending",
            fulfillmentMethod: payload.customer.fulfillmentMethod,
            customerName: payload.customer.name,
            phoneNumber: payload.customer.phoneNumber,
            // H3: persist E.164 alongside the raw display string so any
            // downstream send uses the trusted normalized form.
            normalizedPhone: normalizedCustomerPhone,
            address: payload.customer.address || null,
            notes: payload.customer.notes || null,
            totalPrice,
            currency,
            itemCount,
            sourcePath: payload.path ?? null,
            campaign: payload.campaign ?? null,
            expiresAt,
            paymentProvider: "cod",
            paymentStatus: "unpaid",
            paymentAmountMinor: BigInt(Math.round(totalPrice * 100)),
            items: {
              create: orderItems.map((item) => ({
                menuItemId: item.menuItemId,
                itemName: item.name,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
              })),
            },
          },
          select: { id: true, customerId: true },
        });

        await tx.orderIntentEvent.create({
          data: {
            orderIntentId: orderIntent.id,
            fromStatus: null,
            toStatus: "pending",
            actor: "customer",
            source: "orders_v1_checkout",
            metadata: {
              clientIp,
              subtotal,
              vatAmount,
              currency,
            },
          },
        });

        return { orderIntentId: orderIntent.id, customerId: orderIntent.customerId };
      });

      const itemsSummary = orderItems
        .map((i) => `${i.quantity}× ${i.name}`)
        .join(", ")
        .slice(0, 180);

      let restaurantMessageId: string | null = null;
      let customerMessageId: string | null = null;

      // M7: full phone goes to Meta (operator needs it for delivery
      // callbacks) but the persisted WhatsAppMessage.body in our DB stores
      // a masked version so customer phones aren't redundantly indexed in
      // the CRM message log + retention exports.
      const maskedPhone = `${normalizedCustomerPhone.slice(0, 5)}•••${normalizedCustomerPhone.slice(-4)}`;
      const restaurantAlertParameters = [
        orderNumber,
        payload.customer.name,
        normalizedCustomerPhone,
        itemsSummary,
        totalPrice.toFixed(2),
        "COD",
        fulfillmentLabel(payload.customer.fulfillmentMethod),
      ];
      const restaurantAlertStoredParameters = [
        orderNumber,
        payload.customer.name,
        maskedPhone,
        itemsSummary,
        totalPrice.toFixed(2),
        "COD",
        fulfillmentLabel(payload.customer.fulfillmentMethod),
      ];

      try {
        const restaurantAlert = await sendOrderTemplate({
          integration,
          toPhone: integration.displayPhoneNumber,
          templateName: "order_new_alert_v1",
          parameters: restaurantAlertParameters,
          storedBodyParameters: restaurantAlertStoredParameters,
        });
        restaurantMessageId = restaurantAlert.messageId;
      } catch (error) {
        // M2: persist the failure so the operator's dashboard can surface it.
        console.error("[orders] failed to send restaurant alert", {
          orderNumber,
          error: error instanceof Error ? error.message : String(error),
        });
        await prisma.orderIntentEvent
          .create({
            data: {
              orderIntentId: created.orderIntentId,
              fromStatus: "pending",
              toStatus: "pending",
              actor: "system",
              source: "alert_send_failed",
              metadata: { error: error instanceof Error ? error.message : String(error) },
            },
          })
          .catch(() => undefined);
      }

      try {
        const customerReceipt = await sendOrderTemplate({
          integration,
          toPhone: normalizedCustomerPhone,
          templateName: "order_received_v1",
          customerId: created.customerId ?? undefined,
          parameters: [
            payload.customer.name.split(/\s+/)[0] ?? payload.customer.name,
            orderNumber,
            restaurant.name,
            totalPrice.toFixed(2),
            buildOrderUrl(orderNumber, urlToken),
          ],
        });
        customerMessageId = customerReceipt.messageId;
      } catch (error) {
        console.error("[orders] failed to send customer receipt", {
          orderNumber,
          error: error instanceof Error ? error.message : String(error),
        });
        await prisma.orderIntentEvent
          .create({
            data: {
              orderIntentId: created.orderIntentId,
              fromStatus: "pending",
              toStatus: "pending",
              actor: "system",
              source: "receipt_send_failed",
              metadata: { error: error instanceof Error ? error.message : String(error) },
            },
          })
          .catch(() => undefined);
      }

      // H4: updateMany with where-guard so we can never overwrite a value
      // that a later flow (e.g. dashboard accept happening before this
      // line runs) might have set.
      if (restaurantMessageId || customerMessageId) {
        await prisma.orderIntent.updateMany({
          where: {
            id: created.orderIntentId,
            restaurantWhatsappMessageId: null,
            customerWhatsappMessageId: null,
          },
          data: {
            restaurantWhatsappMessageId: restaurantMessageId,
            customerWhatsappMessageId: customerMessageId,
          },
        });
      }

      return c.json(
        {
          orderNumber,
          status: "pending" as const,
          paymentStatus: "unpaid" as const,
          paymentProvider: "cod" as const,
          paymentUrl: null,
          subtotal,
          vatAmount,
          totalPrice,
          currency,
          expiresAt: expiresAt.toISOString(),
          statusUrl: buildOrderUrl(orderNumber, urlToken),
          urlToken,
        },
        201
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/:orderNumber/status", async (c) => {
    try {
      const orderNumber = c.req.param("orderNumber");
      const token = c.req.query("t") ?? "";

      // H8: HMAC token gates access. Legacy completed orders (no token)
      // are no longer accessible via this endpoint — they don't need to
      // be since the customer never had a link to begin with.
      if (!token || !verifyOrderUrlToken(orderNumber, token)) {
        throw new ApiError("Order not found", 404);
      }

      // Modest rate limit so an attacker can't brute-force tokens at high
      // throughput. ~33 bits effective entropy via the orderNumber-derived
      // HMAC is plenty when paired with this rate cap.
      const statusLimit = consumeRateLimit({
        key: `orders-status:${getClientIp(c)}`,
        limit: 60,
        windowMs: 60_000,
      });
      if (!statusLimit.allowed) {
        throw new ApiError("Too many status checks. Try again shortly.", 429);
      }

      const order = await prisma.orderIntent.findUnique({
        where: { orderNumber },
        include: {
          restaurant: {
            select: {
              name: true,
              slug: true,
              logoUrl: true,
              whatsappIntegration: {
                select: { displayPhoneNumber: true },
              },
            },
          },
          items: {
            select: {
              itemName: true,
              quantity: true,
              unitPrice: true,
            },
          },
        },
      });

      if (!order) {
        throw new ApiError("Order not found", 404);
      }

      if (order.completedAt) {
        const expiry = order.completedAt.getTime() + 24 * 60 * 60_000;
        if (Date.now() > expiry) {
          throw new ApiError("Order link has expired", 410);
        }
      }

      const subtotal = order.items.reduce(
        (sum, i) => sum + Number(i.unitPrice.toString()) * i.quantity,
        0
      );
      const subtotalRounded = Math.round(subtotal * 100) / 100;
      const totalRounded = Number(order.totalPrice.toString());
      const vatAmount = Math.round((totalRounded - subtotalRounded) * 100) / 100;

      // L2: surface the integration's display phone (the public WABA number)
      // rather than restaurant.whatsappNumber (the operator's personal phone
      // and the operator-action trust source — should not be enumerable).
      const helpPhone =
        order.restaurant.whatsappIntegration?.displayPhoneNumber ?? null;

      return c.json({
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        paymentProvider: order.paymentProvider,
        paymentUrl: order.paymentUrl,
        fulfillmentMethod: order.fulfillmentMethod,
        estimatedPrepMinutes: order.estimatedPrepMinutes,
        rejectionReason: order.rejectionReason,
        timestamps: {
          createdAt: order.createdAt,
          acceptedAt: order.acceptedAt,
          readyAt: order.readyAt,
          completedAt: order.completedAt,
          rejectedAt: order.rejectedAt,
          expiresAt: order.expiresAt,
        },
        restaurant: {
          name: order.restaurant.name,
          slug: order.restaurant.slug,
          whatsappNumber: helpPhone,
          logoUrl: order.restaurant.logoUrl,
        },
        items: order.items.map((i) => ({
          name: i.itemName,
          quantity: i.quantity,
          unitPrice: Number(i.unitPrice.toString()),
          lineTotal: Math.round(Number(i.unitPrice.toString()) * i.quantity * 100) / 100,
        })),
        totals: {
          subtotal: subtotalRounded,
          vat: vatAmount,
          total: totalRounded,
          currency: order.currency,
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

/* ─────────────────────────────────────────────────────────────────────
 * Dashboard endpoints (authenticated).
 *
 *   GET  /api/orders/admin/:restaurantId
 *   POST /api/orders/admin/:restaurantId/:orderNumber/accept
 *   POST /api/orders/admin/:restaurantId/:orderNumber/reject
 *   POST /api/orders/admin/:restaurantId/:orderNumber/mark-ready
 *   POST /api/orders/admin/:restaurantId/:orderNumber/mark-completed
 *
 * H9: rate-limited per clerkId, body-size capped, ownership-guarded
 * atomically via transitionOrder.expectedRestaurantId.
 * ───────────────────────────────────────────────────────────────────── */

const acceptSchema = z.object({
  estimatedPrepMinutes: z.coerce.number().int().min(1).max(240).optional(),
});

const rejectSchema = z.object({
  reason: z.string().trim().min(1).max(280).optional(),
});

async function readSmallJson(raw: string): Promise<unknown> {
  if (raw.length > MAX_ADMIN_BODY_BYTES) {
    throw new ApiError("Request body too large", 413);
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("Invalid JSON", 400);
  }
}

async function getOwnedRestaurant(restaurantId: string, clerkId: string) {
  const restaurant = await prisma.restaurant.findFirst({
    where: {
      id: restaurantId,
      owner: { clerkId },
    },
    select: { id: true, ordersV1Enabled: true },
  });
  if (!restaurant) {
    throw new ApiError("Restaurant not found", 404);
  }
  return restaurant;
}

/**
 * Self-service eligibility check. Returns the prerequisites for enabling
 * direct ordering + whether all are met. Used by both the GET endpoint
 * (to render the "Get started" card) and the POST /enable endpoint (to
 * block enablement until everything is in place).
 *
 * Prerequisites:
 *   1. WhatsApp Business integration connected
 *   2. restaurant.whatsappNumber set (operator's personal WA)
 *   3. All 5 order templates approved by Meta
 */
async function getOrdersV1Eligibility(restaurantId: string) {
  const [restaurant, templates] = await Promise.all([
    prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        whatsappNumber: true,
        ordersV1Enabled: true,
        whatsappIntegration: {
          select: { status: true, displayPhoneNumber: true },
        },
      },
    }),
    prisma.whatsAppTemplate.findMany({
      where: {
        restaurantId,
        name: { in: ORDER_TEMPLATE_DEFINITIONS.map((t) => t.name) },
      },
      select: { name: true, status: true },
    }),
  ]);

  const integrationConnected =
    restaurant?.whatsappIntegration?.status === "connected";
  const hasWhatsappNumber = Boolean(restaurant?.whatsappNumber);
  const approvedNames = new Set(
    templates.filter((t) => t.status === "approved").map((t) => t.name)
  );
  const allTemplatesApproved = ORDER_TEMPLATE_DEFINITIONS.every((tpl) =>
    approvedNames.has(tpl.name)
  );
  const approvedCount = ORDER_TEMPLATE_DEFINITIONS.filter((tpl) =>
    approvedNames.has(tpl.name)
  ).length;

  const blockers = [
    {
      key: "whatsapp_connected" as const,
      label: "WhatsApp Business account connected",
      met: integrationConnected,
      hint: integrationConnected
        ? null
        : "Connect via Dashboard → WhatsApp CRM → Connect WhatsApp.",
    },
    {
      key: "whatsapp_number" as const,
      label: "Operator WhatsApp number set",
      met: hasWhatsappNumber,
      hint: hasWhatsappNumber
        ? null
        : "Set under Dashboard → Storefront → WhatsApp number (the number you'll use to manage orders).",
    },
    {
      key: "templates_approved" as const,
      label: `All 5 order templates approved by Meta (${approvedCount}/5)`,
      met: allTemplatesApproved,
      hint: allTemplatesApproved
        ? null
        : "Submit templates above and wait for Meta approval (usually 24–48h).",
    },
  ];

  return {
    ordersV1Enabled: restaurant?.ordersV1Enabled ?? false,
    canEnable: blockers.every((b) => b.met),
    blockers,
  };
}

async function getOwnedOrder(orderNumber: string, restaurantId: string) {
  const order = await prisma.orderIntent.findUnique({
    where: { orderNumber },
    select: { id: true, restaurantId: true, orderNumber: true, status: true },
  });
  if (!order || order.restaurantId !== restaurantId) {
    throw new ApiError("Order not found", 404);
  }
  return order;
}

function enforceAdminRateLimit(clerkId: string) {
  const limit = consumeRateLimit({
    key: `orders-admin:${clerkId}`,
    limit: 60,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    throw new ApiError("Too many admin actions. Slow down.", 429);
  }
}

export const ordersAdminRoute = new Hono<{
  Variables: { auth: { clerkId: string; email: string | null } };
}>()
  .get("/:restaurantId", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      enforceAdminRateLimit(auth.clerkId);
      const restaurantId = c.req.param("restaurantId");
      await getOwnedRestaurant(restaurantId, auth.clerkId);

      // Surface verification status + the WABA number the operator must
      // message — the dashboard banner needs both to give clear instructions.
      const [integrationStatus, eligibility] = await Promise.all([
        prisma.whatsAppIntegration.findUnique({
          where: { restaurantId },
          select: {
            operatorPhoneVerifiedAt: true,
            displayPhoneNumber: true,
          },
        }),
        getOrdersV1Eligibility(restaurantId),
      ]);

      // L3: rolling "today" boundary at UAE-local midnight (UTC+04:00).
      // Server runs UTC; without this, the Today section rolls over at
      // 4am Dubai which surprises operators.
      const now = new Date();
      const uaeOffsetMs = 4 * 60 * 60_000;
      const uaeNow = new Date(now.getTime() + uaeOffsetMs);
      uaeNow.setUTCHours(0, 0, 0, 0);
      const since = new Date(uaeNow.getTime() - uaeOffsetMs);

      const [pending, active, today] = await Promise.all([
        prisma.orderIntent.findMany({
          where: { restaurantId, status: "pending" },
          orderBy: { createdAt: "asc" },
          include: {
            items: { select: { itemName: true, quantity: true, unitPrice: true } },
          },
        }),
        prisma.orderIntent.findMany({
          where: {
            restaurantId,
            status: { in: ["accepted", "preparing", "ready"] },
          },
          orderBy: { acceptedAt: "asc" },
          include: {
            items: { select: { itemName: true, quantity: true, unitPrice: true } },
          },
        }),
        prisma.orderIntent.findMany({
          where: {
            restaurantId,
            status: { in: ["completed", "rejected", "cancelled", "expired"] },
            createdAt: { gte: since },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: {
            id: true,
            orderNumber: true,
            status: true,
            customerName: true,
            phoneNumber: true,
            totalPrice: true,
            currency: true,
            itemCount: true,
            fulfillmentMethod: true,
            createdAt: true,
            completedAt: true,
            rejectedAt: true,
            paymentStatus: true,
          },
        }),
      ]);

      const todayCount = today.length;
      const todayGross = today
        .filter((o) => o.status === "completed")
        .reduce((s, o) => s + Number(o.totalPrice.toString()), 0);
      const rejectedCount = today.filter(
        (o) => o.status === "rejected" || o.status === "expired"
      ).length;
      const avgTicket =
        todayCount > 0
          ? Math.round(
              (today.reduce((s, o) => s + Number(o.totalPrice.toString()), 0) /
                todayCount) *
                100
            ) / 100
          : 0;
      const todayCurrency = today[0]?.currency ?? "AED";

      const serializeOrder = (
        order: {
          id: string;
          orderNumber: string;
          status: string;
          customerName: string;
          phoneNumber: string;
          totalPrice: { toString(): string };
          currency: string;
          itemCount: number;
          fulfillmentMethod: string;
          address?: string | null;
          notes?: string | null;
          estimatedPrepMinutes?: number | null;
          createdAt: Date;
          acceptedAt?: Date | null;
          readyAt?: Date | null;
          expiresAt?: Date | null;
          paymentStatus: string;
          items?: Array<{
            itemName: string;
            quantity: number;
            unitPrice: { toString(): string };
          }>;
        }
      ) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        customerName: order.customerName,
        phoneNumber: order.phoneNumber,
        totalPrice: Number(order.totalPrice.toString()),
        currency: order.currency,
        itemCount: order.itemCount,
        fulfillmentMethod: order.fulfillmentMethod,
        address: order.address ?? null,
        notes: order.notes ?? null,
        estimatedPrepMinutes: order.estimatedPrepMinutes ?? null,
        createdAt: order.createdAt,
        acceptedAt: order.acceptedAt ?? null,
        readyAt: order.readyAt ?? null,
        expiresAt: order.expiresAt ?? null,
        paymentStatus: order.paymentStatus,
        items: order.items?.map((item) => ({
          name: item.itemName,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice.toString()),
        })),
      });

      return c.json({
        pending: pending.map(serializeOrder),
        active: active.map(serializeOrder),
        today: today.map(serializeOrder),
        todayStats: {
          count: todayCount,
          gross: Math.round(todayGross * 100) / 100,
          rejectedCount,
          avgTicket,
          currency: todayCurrency,
        },
        operatorVerification: {
          verifiedAt: integrationStatus?.operatorPhoneVerifiedAt ?? null,
          wabaDisplayNumber: integrationStatus?.displayPhoneNumber ?? null,
        },
        eligibility,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/:orderNumber/accept", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      enforceAdminRateLimit(auth.clerkId);
      const restaurantId = c.req.param("restaurantId");
      const orderNumber = c.req.param("orderNumber");
      await getOwnedRestaurant(restaurantId, auth.clerkId);
      const order = await getOwnedOrder(orderNumber, restaurantId);
      const body = acceptSchema.parse(await readSmallJson(await c.req.text()));
      const result = await transitionOrder({
        orderIntentId: order.id,
        action: { type: "accept", prepMinutes: body.estimatedPrepMinutes },
        actor: "restaurant",
        source: "dashboard_orders_accept",
        expectedRestaurantId: restaurantId,
      });
      if (!result.ok) throw new ApiError(result.reason, 409);
      return c.json({ ok: true, status: result.status });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/:orderNumber/reject", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      enforceAdminRateLimit(auth.clerkId);
      const restaurantId = c.req.param("restaurantId");
      const orderNumber = c.req.param("orderNumber");
      await getOwnedRestaurant(restaurantId, auth.clerkId);
      const order = await getOwnedOrder(orderNumber, restaurantId);
      const body = rejectSchema.parse(await readSmallJson(await c.req.text()));
      const result = await transitionOrder({
        orderIntentId: order.id,
        action: { type: "reject", reason: body.reason },
        actor: "restaurant",
        source: "dashboard_orders_reject",
        expectedRestaurantId: restaurantId,
      });
      if (!result.ok) throw new ApiError(result.reason, 409);
      return c.json({ ok: true, status: result.status });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/:orderNumber/mark-ready", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      enforceAdminRateLimit(auth.clerkId);
      const restaurantId = c.req.param("restaurantId");
      const orderNumber = c.req.param("orderNumber");
      await getOwnedRestaurant(restaurantId, auth.clerkId);
      const order = await getOwnedOrder(orderNumber, restaurantId);
      const result = await transitionOrder({
        orderIntentId: order.id,
        action: { type: "mark_ready" },
        actor: "restaurant",
        source: "dashboard_orders_mark_ready",
        expectedRestaurantId: restaurantId,
      });
      if (!result.ok) throw new ApiError(result.reason, 409);
      return c.json({ ok: true, status: result.status });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/:orderNumber/mark-completed", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      enforceAdminRateLimit(auth.clerkId);
      const restaurantId = c.req.param("restaurantId");
      const orderNumber = c.req.param("orderNumber");
      await getOwnedRestaurant(restaurantId, auth.clerkId);
      const order = await getOwnedOrder(orderNumber, restaurantId);
      const result = await transitionOrder({
        orderIntentId: order.id,
        action: { type: "mark_completed" },
        actor: "restaurant",
        source: "dashboard_orders_mark_completed",
        expectedRestaurantId: restaurantId,
      });
      if (!result.ok) throw new ApiError(result.reason, 409);
      return c.json({ ok: true, status: result.status });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  /* ───────── Order template management ─────────
   * GET   /api/orders/admin/:restaurantId/templates         current local status of each
   * POST  /api/orders/admin/:restaurantId/templates/submit  submit the 5 to Meta
   *
   * Order templates (UTILITY) are separate from the existing CRM
   * marketing templates — they need their own submission flow because
   * `createWhatsAppTemplate` only sends BODY components, while order
   * templates also need FOOTER + BUTTONS (quick-reply / URL).
   */
  .get("/:restaurantId/templates", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      enforceAdminRateLimit(auth.clerkId);
      const restaurantId = c.req.param("restaurantId");
      await getOwnedRestaurant(restaurantId, auth.clerkId);

      const existing = await prisma.whatsAppTemplate.findMany({
        where: {
          restaurantId,
          name: { in: ORDER_TEMPLATE_DEFINITIONS.map((t) => t.name) },
        },
        select: {
          name: true,
          status: true,
          metaTemplateId: true,
          rejectionReason: true,
          lastSyncedAt: true,
          category: true,
        },
      });
      const byName = new Map(existing.map((row) => [row.name, row]));

      return c.json({
        templates: ORDER_TEMPLATE_DEFINITIONS.map((tpl) => {
          const row = byName.get(tpl.name);
          const buttons = (tpl as { buttons?: readonly unknown[] }).buttons;
          return {
            name: tpl.name,
            label: tpl.label,
            category: tpl.category,
            language: tpl.language,
            preview: tpl.body,
            buttonCount: buttons?.length ?? 0,
            // null = never submitted; 'pending'/'approved'/'rejected' = Meta state
            status: row?.status ?? null,
            metaTemplateId: row?.metaTemplateId ?? null,
            rejectionReason: row?.rejectionReason ?? null,
            lastSyncedAt: row?.lastSyncedAt ?? null,
          };
        }),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  /* Self-service enable / disable. Mirrors the CLI script
   * (scripts/enable-orders-v1.ts) but available to the restaurant owner
   * from /dashboard/orders. Enable refuses unless all eligibility blockers
   * are met. Disable always succeeds (kill switch for when something goes
   * wrong during a pilot). */
  .post("/:restaurantId/enable", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      enforceAdminRateLimit(auth.clerkId);
      const restaurantId = c.req.param("restaurantId");
      await getOwnedRestaurant(restaurantId, auth.clerkId);

      const eligibility = await getOrdersV1Eligibility(restaurantId);
      if (!eligibility.canEnable) {
        const unmet = eligibility.blockers.filter((b) => !b.met).map((b) => b.label);
        throw new ApiError(
          `Cannot enable yet: ${unmet.join("; ")}`,
          400,
          { code: "eligibility_unmet", blockers: eligibility.blockers }
        );
      }

      await prisma.restaurant.update({
        where: { id: restaurantId },
        data: { ordersV1Enabled: true },
      });

      return c.json({ ok: true, ordersV1Enabled: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/disable", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      enforceAdminRateLimit(auth.clerkId);
      const restaurantId = c.req.param("restaurantId");
      await getOwnedRestaurant(restaurantId, auth.clerkId);

      await prisma.restaurant.update({
        where: { id: restaurantId },
        data: { ordersV1Enabled: false },
      });

      return c.json({ ok: true, ordersV1Enabled: false });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/templates/submit", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      enforceAdminRateLimit(auth.clerkId);
      const restaurantId = c.req.param("restaurantId");
      await getOwnedRestaurant(restaurantId, auth.clerkId);

      const integration = await prisma.whatsAppIntegration.findFirst({
        where: { restaurantId, status: "connected" },
      });
      if (!integration?.wabaId) {
        throw new ApiError(
          "Connect a WhatsApp Business account before submitting order templates.",
          400
        );
      }
      const accessToken = decryptAccessToken(integration.accessTokenCipher);

      const submittedAt = new Date();
      const results: Array<{
        name: string;
        ok: boolean;
        status?: string;
        metaTemplateId?: string;
        error?: string;
      }> = [];

      for (const tpl of ORDER_TEMPLATE_DEFINITIONS) {
        const validation = validateTemplateBody({
          body: tpl.body,
          category: tpl.category,
          variables: tpl.variables,
        });
        if (!validation.ok) {
          results.push({ name: tpl.name, ok: false, error: validation.reason });
          continue;
        }

        try {
          const components = buildMetaTemplateComponents(tpl);
          const response = await createWhatsAppTemplateWithComponents({
            accessToken,
            wabaId: integration.wabaId,
            name: tpl.name,
            category: tpl.category,
            language: tpl.language,
            components,
          });

          const localStatus = mapTemplateStatus(response.status) === "draft"
            ? "pending"
            : mapTemplateStatus(response.status);

          await prisma.whatsAppTemplate.upsert({
            where: {
              restaurantId_name_language: {
                restaurantId,
                name: tpl.name,
                language: tpl.language,
              },
            },
            create: {
              restaurantId,
              integrationId: integration.id,
              name: tpl.name,
              label: tpl.label,
              category: response.category ?? tpl.category,
              language: tpl.language,
              status: localStatus,
              body: tpl.body,
              variables: tpl.variables as unknown as Prisma.InputJsonValue,
              metaTemplateId: response.id ?? null,
              lastSyncedAt: submittedAt,
            },
            update: {
              integrationId: integration.id,
              category: response.category ?? tpl.category,
              status: localStatus,
              body: tpl.body,
              variables: tpl.variables as unknown as Prisma.InputJsonValue,
              metaTemplateId: response.id ?? undefined,
              rejectionReason: null,
              lastSyncedAt: submittedAt,
            },
          });

          results.push({
            name: tpl.name,
            ok: true,
            status: localStatus,
            metaTemplateId: response.id,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Meta returns 400 with "name already exists" if you re-submit
          // an already-submitted template — treat as success, just refresh
          // our local record.
          if (/already exists|duplicate/i.test(message)) {
            results.push({ name: tpl.name, ok: true, status: "pending" });
            continue;
          }
          results.push({ name: tpl.name, ok: false, error: message });
        }
      }

      return c.json({
        results,
        submitted: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
