import { Hono } from "hono";
import { z } from "zod";
import { getEffectiveRestaurantBillingState } from "@/lib/entitlements";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { buildPublicMenuItemWhere } from "@/lib/menu-visibility";
import { prisma } from "@/lib/prisma";
import {
  assertAllowedPublicOrigin,
  consumeRateLimit,
  getClientIp,
} from "@/lib/public-request-guards";
import { normalizeE164Phone } from "@/lib/whatsapp-business";
import { generateOrderNumber } from "@/lib/order-numbers";

const redirectQuerySchema = z.object({
  source: z
    .enum(["floating", "contact", "menu_item", "promotion", "cart_order"])
    .default("floating"),
  menuItemId: z.string().cuid().optional(),
  promotionId: z.string().cuid().optional(),
  path: z.string().max(255).optional(),
  campaign: z.string().max(120).optional(),
});

const cartRedirectSchema = z.object({
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
  totalPrice: z.coerce.number().nonnegative(),
  currency: z
    .string()
    .trim()
    .min(3)
    .max(3)
    .default("AED")
    .transform((value) => value.toUpperCase()),
  path: z.string().max(255).optional(),
  campaign: z.string().max(120).optional(),
  customer: z
    .object({
      name: z.string().trim().min(2).max(120),
      phoneNumber: z.string().trim().min(8).max(32),
      fulfillmentMethod: z.enum(["delivery", "pickup"]),
      address: z.string().trim().max(240).optional(),
      notes: z.string().trim().max(300).optional(),
      marketingConsent: z.boolean().default(false),
    })
    .optional(),
});

/**
 * Digits-only output for building wa.me URLs (which require no `+`).
 * Distinct from `normalizeE164Phone` which is the canonical Customer.
 * normalizedPhone format used by the webhook ingest.
 */
function normalizeWhatsappNumber(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const digitsOnly = value.replace(/\D/g, "");
  return digitsOnly.length >= 8 ? digitsOnly : null;
}

function buildWhatsappMessage(input: {
  prefill?: string | null;
  itemName?: string | null;
  promotionTitle?: string | null;
}) {
  const intro =
    input.prefill?.trim() || `Hi, I found your menu on Bustan`;

  if (input.itemName) {
    return `${intro} and I'm interested in ${input.itemName}. Is it available now?`;
  }

  if (input.promotionTitle) {
    return `${intro} and I'd like to ask about the ${input.promotionTitle} offer. Is it available now?`;
  }

  return `${intro} and I had a question about the menu.`;
}

function formatWhatsappMoney(amount: number, currency: string) {
  const rounded = Math.round(amount * 100) / 100;
  const formatted = rounded
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");

  return `${currency} ${formatted}`;
}

function normalizeCartItems(items: Array<{ menuItemId: string; quantity: number; unitPrice: number }>) {
  const quantities = new Map<string, { menuItemId: string; quantity: number; unitPrice: number }>();

  for (const item of items) {
    const existing = quantities.get(item.menuItemId);
    if (existing) {
      existing.quantity += item.quantity;
      continue;
    }

    quantities.set(item.menuItemId, { ...item });
  }

  return Array.from(quantities.values());
}

function buildCartWhatsappMessage(input: {
  slug: string;
  currency: string;
  items: Array<{ name: string; quantity: number; lineTotal: number }>;
  totalPrice: number;
  customer?: {
    name: string;
    phoneNumber: string;
    fulfillmentMethod: "delivery" | "pickup";
    address?: string;
    notes?: string;
  };
}) {
  const itemLines = input.items.map(
    (item) => `${item.quantity}x ${item.name} - ${formatWhatsappMoney(item.lineTotal, input.currency)}`
  );
  const fulfillmentLabel =
    input.customer?.fulfillmentMethod === "pickup" ? "Pickup" : "Delivery";

  return [
    `New Order from getbustan.com/${input.slug}`,
    "",
    ...itemLines,
    "",
    `Total: ${formatWhatsappMoney(input.totalPrice, input.currency)}`,
    "",
    `Name: ${input.customer?.name ?? "___"}`,
    `Phone: ${input.customer?.phoneNumber ?? "___"}`,
    `Delivery/Pickup: ${input.customer ? fulfillmentLabel : "___"}`,
    `Address/Area: ${input.customer?.address || "___"}`,
    input.customer?.notes ? `Notes: ${input.customer.notes}` : "Notes: ___",
  ].join("\n");
}

function getEffectiveMenuItemPrice(menuItem: {
  price: { toString(): string };
  promotionItems: Array<{
    promotion: {
      promoPrice: { toString(): string } | null;
    };
  }>;
}) {
  const basePrice = Number(menuItem.price.toString());
  const promoPrice = menuItem.promotionItems[0]?.promotion.promoPrice;
  const nextPrice = promoPrice ? Number(promoPrice.toString()) : null;

  if (
    nextPrice !== null &&
    Number.isFinite(nextPrice) &&
    nextPrice > 0 &&
    nextPrice < basePrice
  ) {
    return nextPrice;
  }

  return basePrice;
}

export const whatsappRoute = new Hono()
  .get("/redirect/:restaurantId", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const query = redirectQuerySchema.parse(c.req.query());

      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        include: {
          subscription: true,
          operatorAccount: {
            include: {
              _count: {
                select: {
                  brands: true,
                },
              },
            },
          },
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      const effectiveBillingState = getEffectiveRestaurantBillingState(restaurant);
      if (!effectiveBillingState.isPublished) {
        throw new ApiError("Restaurant not found", 404);
      }

      const whatsappNumber = normalizeWhatsappNumber(restaurant.whatsappNumber);
      if (!whatsappNumber) {
        throw new ApiError("WhatsApp is not configured for this restaurant", 404);
      }

      const [menuItem, promotion] = await Promise.all([
        query.menuItemId
          ? prisma.menuItem.findFirst({
              where: {
                ...buildPublicMenuItemWhere(),
                id: query.menuItemId,
                restaurantId: restaurant.id,
              },
              select: {
                id: true,
                name: true,
              },
            })
          : Promise.resolve(null),
        query.promotionId
          ? prisma.promotion.findFirst({
              where: {
                id: query.promotionId,
                restaurantId: restaurant.id,
              },
              select: {
                id: true,
                title: true,
              },
            })
          : Promise.resolve(null),
      ]);

      const message = buildWhatsappMessage({
        prefill: restaurant.whatsappPrefill,
        itemName: menuItem?.name,
        promotionTitle: promotion?.title,
      });

      try {
        await prisma.whatsAppClick.create({
          data: {
            restaurantId: restaurant.id,
            menuItemId: menuItem?.id ?? null,
            promotionId: promotion?.id ?? null,
            source: query.source,
            path: query.path ?? null,
            campaign: query.campaign ?? null,
            referrer: c.req.header("referer") ?? c.req.header("referrer") ?? null,
            userAgent: c.req.header("user-agent") ?? null,
          },
        });
      } catch (error) {
        console.error("Failed to record WhatsApp click", error);
      }

      const whatsappUrl = new URL(`https://wa.me/${whatsappNumber}`);
      whatsappUrl.searchParams.set("text", message);

      return c.redirect(whatsappUrl.toString(), 302);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/cart-redirect/:restaurantId", async (c) => {
    try {
      const clientIp = getClientIp(c);
      assertAllowedPublicOrigin(c);

      const globalLimit = consumeRateLimit({
        key: `whatsapp-cart:global:${clientIp}`,
        limit: 30,
        windowMs: 10 * 60_000,
      });
      if (!globalLimit.allowed) {
        throw new ApiError("Too many cart requests. Please try again shortly.", 429);
      }

      const restaurantId = c.req.param("restaurantId");
      const payload = cartRedirectSchema.parse(await c.req.json());
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        include: {
          subscription: true,
          operatorAccount: {
            include: {
              _count: {
                select: {
                  brands: true,
                },
              },
            },
          },
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      const effectiveBillingState = getEffectiveRestaurantBillingState(restaurant);
      if (!effectiveBillingState.isPublished) {
        throw new ApiError("Restaurant not found", 404);
      }

      const whatsappNumber = normalizeWhatsappNumber(restaurant.whatsappNumber);
      if (!whatsappNumber) {
        throw new ApiError("WhatsApp is not configured for this restaurant", 404);
      }

      const perRestaurantLimit = consumeRateLimit({
        key: `whatsapp-cart:${clientIp}:${restaurantId}`,
        limit: 10,
        windowMs: 10 * 60_000,
      });
      if (!perRestaurantLimit.allowed) {
        throw new ApiError("Too many cart requests for this menu. Please try again shortly.", 429);
      }

      const allowedPaths = new Set([`/${restaurant.slug}`, `/embed/${restaurant.slug}`]);
      if (payload.path && !allowedPaths.has(payload.path)) {
        throw new ApiError("Invalid cart path", 400);
      }

      const normalizedItems = normalizeCartItems(payload.items);
      const itemIds = normalizedItems.map((item) => item.menuItemId);
      const now = new Date();

      const menuItems = await prisma.menuItem.findMany({
        where: {
          ...buildPublicMenuItemWhere(now),
          id: {
            in: itemIds,
          },
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
            select: {
              promotion: {
                select: {
                  promoPrice: true,
                },
              },
            },
            orderBy: {
              displayOrder: "asc",
            },
            take: 1,
          },
        },
      });

      if (menuItems.length !== itemIds.length) {
        throw new ApiError("One or more cart items are unavailable", 400);
      }

      const menuItemsById = new Map(menuItems.map((item) => [item.id, item]));
      const currency = menuItems[0]?.currency ?? payload.currency;
      const orderItems = normalizedItems.map((entry) => {
        const menuItem = menuItemsById.get(entry.menuItemId);
        if (!menuItem) {
          throw new ApiError("One or more cart items are unavailable", 400);
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

      const totalPrice =
        Math.round(
          orderItems.reduce((sum, item) => sum + item.lineTotal, 0) * 100
        ) / 100;
      const itemCount = orderItems.reduce((sum, item) => sum + item.quantity, 0);
      const message = buildCartWhatsappMessage({
        slug: restaurant.slug,
        currency,
        items: orderItems,
        totalPrice,
        customer: payload.customer,
      });

      try {
        await prisma.$transaction(async (tx) => {
          let customerId: string | null = null;
          // H6 fix: use canonical E.164 (`+9715…`) — same format the webhook
          // path uses, so a diner who messages the restaurant AND orders
          // via the menu page is one Customer row, not two.
          const normalizedCustomerPhone = payload.customer
            ? normalizeE164Phone(payload.customer.phoneNumber)
            : null;

          if (payload.customer && normalizedCustomerPhone) {
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
                // M6 fix: only write opt_out timestamp when transitioning from
                // a prior opt_in. First-time customers who decline are
                // "never_asked", not "opt_out" — preserves the dashboard's
                // ability to legitimately re-opt-in later.
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
                // M6 fix: only flip to opt_out timestamp when this update is
                // a transition from a prior consent state — let webhook STOP
                // events be the source of truth for opt-out.
                marketingOptOutAt: payload.customer.marketingConsent ? null : undefined,
                lastOrderAt: capturedAt,
                orderCount: {
                  increment: 1,
                },
                totalSpend: {
                  increment: totalPrice,
                },
                currency,
              },
              select: {
                id: true,
              },
            });

            customerId = customer.id;

            // M5 (back-port from orders.ts): only persist a consent row on
            // explicit opt-in. A first-time customer leaving the checkbox
            // unticked is "never asked" — recording opt_out poisons the
            // audit trail and blocks legitimate future re-opt-in.
            if (payload.customer.marketingConsent) {
              await tx.customerConsent.create({
                data: {
                  restaurantId: restaurant.id,
                  customerId: customer.id,
                  status: "opt_in",
                  source: "public_checkout",
                  ipAddress: clientIp,
                  userAgent: c.req.header("user-agent") ?? null,
                },
              });
            }
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

          await tx.whatsAppCartOrder.create({
            data: {
              restaurantId: restaurant.id,
              clickId: click.id,
              totalPrice,
              currency,
              itemCount,
              items: {
                create: orderItems.map((item) => ({
                  menuItemId: item.menuItemId,
                  quantity: item.quantity,
                  unitPrice: item.unitPrice,
                })),
              },
            },
          });

          if (payload.customer) {
            // Legacy click-to-WhatsApp orders bypass the v1 state machine:
            // status `completed` so they don't show in the new dashboards
            // or get touched by the expiry cron.
            await tx.orderIntent.create({
              data: {
                restaurantId: restaurant.id,
                customerId,
                clickId: click.id,
                orderNumber: generateOrderNumber(),
                status: "completed",
                fulfillmentMethod: payload.customer.fulfillmentMethod,
                customerName: payload.customer.name,
                phoneNumber: payload.customer.phoneNumber,
                address: payload.customer.address || null,
                notes: payload.customer.notes || null,
                totalPrice,
                currency,
                itemCount,
                sourcePath: payload.path ?? null,
                campaign: payload.campaign ?? null,
                items: {
                  create: orderItems.map((item) => ({
                    menuItemId: item.menuItemId,
                    itemName: item.name,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                  })),
                },
              },
            });
          }
        });
      } catch (error) {
        console.error("Failed to record WhatsApp cart order", error);
      }

      const whatsappUrl = new URL(`https://wa.me/${whatsappNumber}`);
      whatsappUrl.searchParams.set("text", message);

      return c.json({ url: whatsappUrl.toString() }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
