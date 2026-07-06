import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { verifyWebhookSyncRequest } from "@/lib/webhook-sync";
import { getCurrentUser, requireAuth } from "@/middleware/auth";
import {
  cancelStripeSubscription,
  createBillingPortalSession,
  createCheckoutSession,
  createPortfolioCheckoutSession,
} from "@/services/stripe";

const createSchema = z.object({
  restaurantId: z.string().cuid(),
  plan: z.enum(["pro", "fulltime"]),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const portalSchema = z.object({
  restaurantId: z.string().cuid(),
  returnUrl: z.string().url(),
});

const createPortfolioSchema = z.object({
  brandCount: z.number().int().min(3).default(3),
  groupName: z.string().min(2).max(100).optional(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  restaurantId: z.string().cuid().optional(),
});

const portfolioPortalSchema = z.object({
  operatorAccountId: z.string().cuid(),
  returnUrl: z.string().url(),
});

export const webhookSchema = z.object({
  type: z.enum([
    "checkout.session.completed",
    "customer.subscription.created",
    "invoice.payment_failed",
    "customer.subscription.deleted",
    "customer.subscription.updated",
  ]),
  data: z.object({
    restaurantId: z.string().cuid().optional(),
    operatorAccountId: z.string().cuid().optional(),
    legacyRestaurantId: z.string().cuid().optional(),
    stripeCustomerId: z.string().optional(),
    stripeSubscriptionId: z.string().optional(),
    plan: z.enum(["starter", "pro", "fulltime", "portfolio"]).optional(),
    status: z.enum(["trial", "active", "paused", "cancelled"]).optional(),
    currentPeriodEnd: z.string().datetime().nullable().optional(),
    quantity: z.number().int().positive().optional(),
  }),
});

function getRestaurantBillingState(
  status: "trial" | "active" | "paused" | "cancelled",
  currentPeriodEnd?: string | null
) {
  return {
    subscriptionStatus: status,
    isPublished: status === "trial" || status === "active",
    trialEndsAt:
      status === "trial" && currentPeriodEnd ? new Date(currentPeriodEnd) : null,
  };
}

function getOperatorMutation(data: z.infer<typeof webhookSchema>["data"]) {
  return {
    ...(data.status ? { status: data.status } : {}),
    ...(data.stripeCustomerId !== undefined
      ? { stripeCustomerId: data.stripeCustomerId }
      : {}),
    ...(data.stripeSubscriptionId !== undefined
      ? { stripeSubscriptionId: data.stripeSubscriptionId }
      : {}),
    ...(data.currentPeriodEnd !== undefined
      ? {
          currentPeriodEnd: data.currentPeriodEnd ? new Date(data.currentPeriodEnd) : null,
        }
      : {}),
    ...(data.quantity !== undefined ? { brandLimit: Math.max(data.quantity, 3) } : {}),
  };
}

function getSubscriptionMutation(
  data: z.infer<typeof webhookSchema>["data"]
) {
  return {
    ...(data.plan ? { plan: data.plan } : {}),
    ...(data.status ? { status: data.status } : {}),
    ...(data.stripeCustomerId !== undefined
      ? { stripeCustomerId: data.stripeCustomerId }
      : {}),
    ...(data.stripeSubscriptionId !== undefined
      ? { stripeSubscriptionId: data.stripeSubscriptionId }
      : {}),
    ...(data.currentPeriodEnd !== undefined
      ? {
          currentPeriodEnd: data.currentPeriodEnd ? new Date(data.currentPeriodEnd) : null,
        }
      : {}),
  };
}

async function cancelLegacySubscriptionForPortfolioUpgrade(input: {
  legacyRestaurantId?: string;
  newPortfolioSubscriptionId?: string;
}) {
  if (!input.legacyRestaurantId) {
    return;
  }

  const legacyRestaurant = await prisma.restaurant.findUnique({
    where: { id: input.legacyRestaurantId },
    include: {
      subscription: true,
    },
  });

  const legacyStripeSubscriptionId = legacyRestaurant?.subscription?.stripeSubscriptionId;
  const legacyStatus = legacyRestaurant?.subscription?.status;

  if (
    !legacyRestaurant?.subscription ||
    !legacyStripeSubscriptionId ||
    !legacyStatus ||
    legacyStatus === "cancelled" ||
    legacyStripeSubscriptionId === input.newPortfolioSubscriptionId
  ) {
    return;
  }

  await cancelStripeSubscription(legacyStripeSubscriptionId);

  await prisma.subscription.update({
    where: {
      restaurantId: legacyRestaurant.id,
    },
    data: {
      status: "cancelled",
    },
  });
}

export const subscriptionsRoute = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
    };
  };
}>()
  .post("/create", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = createSchema.parse(await c.req.json());

      const restaurant = await prisma.restaurant.findFirst({
        where: {
          id: data.restaurantId,
          owner: {
            clerkId: auth.clerkId,
          },
        },
        include: {
          owner: true,
          subscription: true,
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      if (
        restaurant.subscription?.stripeSubscriptionId &&
        restaurant.subscription.status !== "cancelled"
      ) {
        throw new ApiError(
          "A Stripe subscription already exists for this restaurant. Use the billing portal to manage it.",
          409
        );
      }

      const session = await createCheckoutSession({
        customerEmail: restaurant.owner.email,
        stripeCustomerId: restaurant.subscription?.stripeCustomerId,
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        plan: data.plan,
        successUrl: data.successUrl,
        cancelUrl: data.cancelUrl,
      });

      return c.json({
        checkoutUrl: session.url,
        sessionId: session.id,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/create-portfolio", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const user = await getCurrentUser(auth);
      const data = createPortfolioSchema.parse(await c.req.json());

      const ownedRestaurants = await prisma.restaurant.findMany({
        where: { ownerId: user.id },
        include: {
          subscription: true,
        },
        orderBy: { createdAt: "asc" },
      });

      const legacyRestaurant = data.restaurantId
        ? ownedRestaurants.find((restaurant) => restaurant.id === data.restaurantId) ?? null
        : ownedRestaurants[0] ?? null;

      if (!legacyRestaurant) {
        throw new ApiError("Create at least one restaurant before upgrading to Portfolio.", 404);
      }

      const groupName = data.groupName || "My Portfolio";

      const operator = await prisma.operatorAccount.upsert({
        where: { ownerId: user.id },
        update: {
          name: groupName,
          brandLimit: Math.max(data.brandCount, 3),
        },
        create: {
          ownerId: user.id,
          name: groupName,
          brandLimit: Math.max(data.brandCount, 3),
        },
        include: {
          brands: true,
        },
      });

      if (!legacyRestaurant.operatorAccountId) {
        await prisma.restaurant.update({
          where: { id: legacyRestaurant.id },
          data: {
            operatorAccountId: operator.id,
          },
        });
      }

      if (operator.stripeSubscriptionId && operator.status !== "cancelled") {
        throw new ApiError(
          "A Stripe subscription already exists for this portfolio. Use the billing portal to manage it.",
          409
        );
      }

      const session = await createPortfolioCheckoutSession({
        customerEmail: user.email,
        stripeCustomerId: operator.stripeCustomerId,
        operatorAccountId: operator.id,
        operatorName: operator.name,
        brandCount: Math.max(data.brandCount, operator.brands.length || 1),
        successUrl: data.successUrl,
        cancelUrl: data.cancelUrl,
        legacyRestaurantId: legacyRestaurant.id,
      });

      return c.json({
        checkoutUrl: session.url,
        sessionId: session.id,
        operatorAccountId: operator.id,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/portal", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = portalSchema.parse(await c.req.json());
      const restaurant = await prisma.restaurant.findFirst({
        where: {
          id: data.restaurantId,
          owner: {
            clerkId: auth.clerkId,
          },
        },
        include: {
          subscription: true,
        },
      });

      if (!restaurant || !restaurant.subscription?.stripeCustomerId) {
        throw new ApiError("Active Stripe customer not found", 404);
      }

      const session = await createBillingPortalSession({
        stripeCustomerId: restaurant.subscription.stripeCustomerId,
        returnUrl: data.returnUrl,
      });

      return c.json({
        url: session.url,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/portfolio/portal", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = portfolioPortalSchema.parse(await c.req.json());
      const operator = await prisma.operatorAccount.findFirst({
        where: {
          id: data.operatorAccountId,
          owner: {
            clerkId: auth.clerkId,
          },
        },
      });

      if (!operator || !operator.stripeCustomerId) {
        throw new ApiError("Active Stripe customer not found", 404);
      }

      const session = await createBillingPortalSession({
        stripeCustomerId: operator.stripeCustomerId,
        returnUrl: data.returnUrl,
      });

      return c.json({
        url: session.url,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/webhook", async (c) => {
    try {
      const rawPayload = await c.req.text();
      verifyWebhookSyncRequest({
        payload: rawPayload,
        signatureHeader: c.req.header("x-webhook-signature"),
        timestampHeader: c.req.header("x-webhook-timestamp"),
      });

      let jsonPayload: unknown;
      try {
        jsonPayload = JSON.parse(rawPayload);
      } catch {
        throw new ApiError("Invalid JSON payload", 400);
      }

      const payload = webhookSchema.parse(jsonPayload);

      switch (payload.type) {
        case "checkout.session.completed": {
          if (!payload.data.plan) {
            throw new ApiError("Missing checkout webhook metadata", 400);
          }

          const status = payload.data.status ?? "trial";
          if (payload.data.operatorAccountId && payload.data.plan === "portfolio") {
            await prisma.operatorAccount.update({
              where: { id: payload.data.operatorAccountId },
              data: getOperatorMutation({
                ...payload.data,
                status,
              }),
            });

            await prisma.restaurant.updateMany({
              where: {
                operatorAccountId: payload.data.operatorAccountId,
              },
              data: getRestaurantBillingState(status, payload.data.currentPeriodEnd),
            });

            await cancelLegacySubscriptionForPortfolioUpgrade({
              legacyRestaurantId: payload.data.legacyRestaurantId,
              newPortfolioSubscriptionId: payload.data.stripeSubscriptionId,
            });
          } else if (payload.data.restaurantId) {
            const subscriptionMutation = getSubscriptionMutation({
              ...payload.data,
              status,
            });

            await prisma.subscription.upsert({
              where: {
                restaurantId: payload.data.restaurantId,
              },
              update: subscriptionMutation,
              create: {
                restaurantId: payload.data.restaurantId,
                plan: payload.data.plan,
                status,
                stripeCustomerId: payload.data.stripeCustomerId,
                stripeSubscriptionId: payload.data.stripeSubscriptionId,
                currentPeriodEnd: payload.data.currentPeriodEnd
                  ? new Date(payload.data.currentPeriodEnd)
                  : null,
              },
            });

            await prisma.restaurant.update({
              where: {
                id: payload.data.restaurantId,
              },
              data: getRestaurantBillingState(status, payload.data.currentPeriodEnd),
            });
          } else {
            throw new ApiError("Missing webhook target", 400);
          }
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated": {
          if (!payload.data.stripeSubscriptionId || !payload.data.status) {
            throw new ApiError("Missing subscription update payload", 400);
          }

          if (payload.data.operatorAccountId && payload.data.plan === "portfolio") {
            await prisma.operatorAccount.update({
              where: { id: payload.data.operatorAccountId },
              data: getOperatorMutation(payload.data),
            });

            await prisma.restaurant.updateMany({
              where: {
                operatorAccountId: payload.data.operatorAccountId,
              },
              data: getRestaurantBillingState(
                payload.data.status,
                payload.data.currentPeriodEnd
              ),
            });
          } else if (payload.data.restaurantId) {
            if (!payload.data.plan) {
              throw new ApiError("Missing subscription plan for restaurant sync", 400);
            }

            await prisma.subscription.upsert({
              where: {
                restaurantId: payload.data.restaurantId,
              },
              update: getSubscriptionMutation(payload.data),
              create: {
                restaurantId: payload.data.restaurantId,
                plan: payload.data.plan,
                status: payload.data.status,
                stripeCustomerId: payload.data.stripeCustomerId,
                stripeSubscriptionId: payload.data.stripeSubscriptionId,
                currentPeriodEnd: payload.data.currentPeriodEnd
                  ? new Date(payload.data.currentPeriodEnd)
                  : null,
              },
            });

            await prisma.restaurant.updateMany({
              where: {
                id: payload.data.restaurantId,
              },
              data: getRestaurantBillingState(
                payload.data.status,
                payload.data.currentPeriodEnd
              ),
            });
          } else {
            await prisma.subscription.updateMany({
              where: {
                stripeSubscriptionId: payload.data.stripeSubscriptionId,
              },
              data: getSubscriptionMutation(payload.data),
            });

            await prisma.restaurant.updateMany({
              where: {
                subscription: {
                  stripeSubscriptionId: payload.data.stripeSubscriptionId,
                },
              },
              data: getRestaurantBillingState(
                payload.data.status,
                payload.data.currentPeriodEnd
              ),
            });
          }
          break;
        }
        case "invoice.payment_failed":
        case "customer.subscription.deleted": {
          if (!payload.data.stripeSubscriptionId) {
            throw new ApiError("Missing Stripe subscription id", 400);
          }

          const status =
            payload.type === "invoice.payment_failed" ? "paused" : "cancelled";

          await prisma.subscription.updateMany({
            where: {
              stripeSubscriptionId: payload.data.stripeSubscriptionId,
            },
            data: {
              status,
            },
          });

          await prisma.operatorAccount.updateMany({
            where: {
              stripeSubscriptionId: payload.data.stripeSubscriptionId,
            },
            data: {
              status,
            },
          });

          await prisma.restaurant.updateMany({
            where: {
              OR: [
                {
                  subscription: {
                    stripeSubscriptionId: payload.data.stripeSubscriptionId,
                  },
                },
                {
                  operatorAccount: {
                    stripeSubscriptionId: payload.data.stripeSubscriptionId,
                  },
                },
              ],
            },
            data: getRestaurantBillingState(status),
          });
          break;
        }
      }

      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
