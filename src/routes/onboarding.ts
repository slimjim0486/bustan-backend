import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import {
  buildOnboardingProgress,
  completeOnboardingStep,
  validateFeeAndDeposit,
} from "@/lib/onboarding";
import { prisma } from "@/lib/prisma";
import { normalizeUaePhone } from "@/lib/uae-phone";
import { requireAuth } from "@/middleware/auth";

const businessProfileSchema = z.object({
  name: z.string().trim().min(2).max(160),
  businessType: z.enum(["SALON", "HOME_SERVICES"]),
  location: z.string().trim().min(2).max(160),
  address: z.string().trim().max(300).nullable().optional(),
  operatingHours: z.record(z.string(), z.unknown()),
  noShowPolicy: z.string().trim().min(5).max(1000),
  slotGranularityMinutes: z.number().int().min(5).max(240).default(30),
});

const feeSchema = z.object({
  newCustomerFeeAed: z.number().int().min(0).max(10_000),
  depositAed: z.number().int().min(0).max(10_000),
});

const progressSchema = z.object({
  currentStep: z.number().int().min(1).max(7).optional(),
  completedStep: z.number().int().min(1).max(7).optional(),
});

const agentSchema = z.object({
  goLive: z.boolean(),
});

const customerImportSchema = z.object({
  customers: z.array(
    z.object({
      name: z.string().trim().min(1).max(160),
      phone: z.string().trim().min(5).max(40),
      consent: z.boolean().default(false),
      preferredLanguage: z.enum(["en", "ar"]).nullable().optional(),
    })
  ).min(1).max(2000),
});

async function getOwnedBusiness(restaurantId: string, clerkId: string) {
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, owner: { clerkId } },
    include: {
      whatsappIntegration: {
        select: {
          status: true,
          displayPhoneNumber: true,
        },
      },
      gbpConnection: {
        select: {
          status: true,
          gbpUrl: true,
        },
      },
      _count: {
        select: {
          services: true,
          customers: true,
          bookings: true,
        },
      },
    },
  });
  if (!restaurant) throw new ApiError("Business not found", 404);
  return restaurant;
}

function serializeOnboarding(restaurant: Awaited<ReturnType<typeof getOwnedBusiness>>) {
  return {
    business: {
      id: restaurant.id,
      name: restaurant.name,
      businessType: restaurant.businessType,
      location: restaurant.location,
      address: restaurant.address,
      operatingHours: restaurant.operatingHours,
      bookingPolicies: restaurant.bookingPolicies,
      newCustomerFeeAed: restaurant.newCustomerFeeAed,
      depositAed: restaurant.depositAed,
      agentAutonomyOptIn: restaurant.agentAutonomyOptIn,
    },
    progress: buildOnboardingProgress({
      currentStep: restaurant.onboardingStep,
      completedSteps: restaurant.onboardingCompleted,
    }),
    connections: {
      whatsapp: restaurant.whatsappIntegration,
      google: restaurant.gbpConnection,
    },
    counts: restaurant._count,
  };
}

const onboardingRouteBase = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
    };
  };
}>();

onboardingRouteBase.use("*", requireAuth);

export const onboardingRoute = onboardingRouteBase
  .get("/:restaurantId", async (c) => {
    try {
      const restaurant = await getOwnedBusiness(
        c.req.param("restaurantId"),
        c.get("auth").clerkId
      );
      return c.json(serializeOnboarding(restaurant));
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .patch("/:restaurantId/progress", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const current = await getOwnedBusiness(
        restaurantId,
        c.get("auth").clerkId
      );
      const input = progressSchema.parse(await c.req.json());
      const progress = input.completedStep
        ? completeOnboardingStep({
            currentStep: current.onboardingStep,
            completedSteps: current.onboardingCompleted,
            completedStep: input.completedStep,
          })
        : buildOnboardingProgress({
            currentStep: input.currentStep ?? current.onboardingStep,
            completedSteps: current.onboardingCompleted,
          });

      const updated = await prisma.restaurant.update({
        where: { id: restaurantId },
        data: {
          onboardingStep: progress.currentStep,
          onboardingCompleted: progress.completedSteps,
        },
      });

      return c.json({
        progress: buildOnboardingProgress({
          currentStep: updated.onboardingStep,
          completedSteps: updated.onboardingCompleted,
        }),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .put("/:restaurantId/profile", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const current = await getOwnedBusiness(
        restaurantId,
        c.get("auth").clerkId
      );
      const input = businessProfileSchema.parse(await c.req.json());
      const existingPolicies =
        current.bookingPolicies &&
        typeof current.bookingPolicies === "object" &&
        !Array.isArray(current.bookingPolicies)
          ? (current.bookingPolicies as Prisma.JsonObject)
          : {};

      const restaurant = await prisma.restaurant.update({
        where: { id: restaurantId },
        data: {
          name: input.name,
          businessType: input.businessType,
          location: input.location,
          address: input.address ?? null,
          operatingHours: input.operatingHours as Prisma.InputJsonValue,
          bookingPolicies: {
            ...existingPolicies,
            noShowPolicy: input.noShowPolicy,
            slotGranularityMinutes: input.slotGranularityMinutes,
          },
        },
      });
      return c.json({ business: restaurant });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .put("/:restaurantId/fees", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      await getOwnedBusiness(restaurantId, c.get("auth").clerkId);
      const input = feeSchema.parse(await c.req.json());
      const validated = validateFeeAndDeposit({
        feeAed: input.newCustomerFeeAed,
        depositAed: input.depositAed,
      });
      const restaurant = await prisma.restaurant.update({
        where: { id: restaurantId },
        data: {
          newCustomerFeeAed: validated.feeAed,
          depositAed: validated.depositAed,
        },
      });
      return c.json({ business: restaurant });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .put("/:restaurantId/agent", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      await getOwnedBusiness(restaurantId, c.get("auth").clerkId);
      const input = agentSchema.parse(await c.req.json());
      const restaurant = await prisma.restaurant.update({
        where: { id: restaurantId },
        data: {
          agentAutonomyOptIn: input.goLive,
          autonomyResumedAt: input.goLive ? new Date() : null,
        },
      });
      return c.json({
        agentAutonomyOptIn: restaurant.agentAutonomyOptIn,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/:restaurantId/customers/import", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      await getOwnedBusiness(restaurantId, c.get("auth").clerkId);
      const input = customerImportSchema.parse(await c.req.json());
      const rows = input.customers.map((customer, index) => ({
        ...customer,
        index,
        normalizedPhone: normalizeUaePhone(customer.phone),
      }));
      const invalid = rows.filter((row) => !row.normalizedPhone);
      if (invalid.length) {
        throw new ApiError(
          `Invalid UAE phone number on row ${invalid[0].index + 1}`,
          400
        );
      }

      let eligible = 0;
      await prisma.$transaction(async (tx) => {
        for (const row of rows) {
          const normalizedPhone = row.normalizedPhone!;
          const existing = await tx.customer.findUnique({
            where: {
              restaurantId_normalizedPhone: {
                restaurantId,
                normalizedPhone,
              },
            },
            include: {
              consents: {
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          });
          const latest = existing?.consents[0];
          const protectedOptOut =
            row.consent &&
            latest?.status === "opt_out" &&
            ["whatsapp", "whatsapp_keyword"].includes(latest.source);
          const marketingOptIn = row.consent && !protectedOptOut;
          if (marketingOptIn) eligible += 1;
          const now = new Date();

          const customer = await tx.customer.upsert({
            where: {
              restaurantId_normalizedPhone: {
                restaurantId,
                normalizedPhone,
              },
            },
            create: {
              restaurantId,
              normalizedPhone,
              phoneNumber: row.phone,
              displayName: row.name,
              marketingOptIn,
              marketingOptInAt: marketingOptIn ? now : null,
              marketingOptOutAt: marketingOptIn ? null : now,
              preferredLanguage: row.preferredLanguage ?? null,
            },
            update: {
              displayName: row.name,
              phoneNumber: row.phone,
              preferredLanguage: row.preferredLanguage ?? undefined,
              ...(protectedOptOut
                ? {}
                : {
                    marketingOptIn,
                    marketingOptInAt: marketingOptIn ? now : null,
                    marketingOptOutAt: marketingOptIn ? null : now,
                  }),
            },
          });

          if (!protectedOptOut) {
            await tx.customerConsent.create({
              data: {
                restaurantId,
                customerId: customer.id,
                status: marketingOptIn ? "opt_in" : "opt_out",
                source: "onboarding_csv",
              },
            });
          }
        }
      });

      return c.json({
        imported: rows.length,
        marketingEligible: eligible,
        protectedOptOuts: rows.filter((row) => row.consent).length - eligible,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
