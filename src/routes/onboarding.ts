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
import { agentReadinessFailures } from "@/lib/onboarding-readiness";
import { canonicalizeCustomerImportRows } from "@/lib/customer-import";
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

const sandboxSchema = z.object({
  message: z.string().trim().min(1).max(500),
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
          services: { where: { isActive: true } },
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
      onboardingSandboxTestCount: restaurant.onboardingSandboxTestCount,
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
  .post("/:restaurantId/agent/sandbox", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const current = await getOwnedBusiness(restaurantId, c.get("auth").clerkId);
      const { message } = sandboxSchema.parse(await c.req.json());
      const services = await prisma.service.findMany({
        where: { restaurantId, isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        take: 3,
        select: { name: true, priceAed: true, durationMinutes: true },
      });
      if (!services.length) throw new ApiError("Add an active service before testing the agent", 409);

      const normalized = message.toLowerCase();
      const policies = current.bookingPolicies && typeof current.bookingPolicies === "object" && !Array.isArray(current.bookingPolicies)
        ? current.bookingPolicies as { noShowPolicy?: unknown }
        : null;
      const reply = normalized.includes("cancel") || normalized.includes("deposit") || normalized.includes("policy")
        ? typeof policies?.noShowPolicy === "string" && policies.noShowPolicy.trim()
          ? `The business policy is: ${policies.noShowPolicy.trim()}`
          : "The cancellation policy has not been configured yet."
        : normalized.includes("price") || normalized.includes("much")
          ? services.map((service) => `${service.name}: AED ${service.priceAed}, ${service.durationMinutes} min`).join(" · ")
          : `I found ${services.length} configured service${services.length === 1 ? "" : "s"}. I would check the live availability grid before offering a time.`;

      const updated = await prisma.restaurant.update({
        where: { id: restaurantId },
        data: { onboardingSandboxTestCount: { increment: 1 } },
        select: { onboardingSandboxTestCount: true },
      });
      return c.json({ reply, sandboxTestCount: updated.onboardingSandboxTestCount });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .put("/:restaurantId/agent", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const current = await getOwnedBusiness(restaurantId, c.get("auth").clerkId);
      const input = agentSchema.parse(await c.req.json());
      if (input.goLive) {
        const failures = agentReadinessFailures({
          businessType: current.businessType,
          whatsappStatus: current.whatsappIntegration?.status ?? null,
          serviceCount: current._count.services,
          operatingHours: current.operatingHours,
          bookingPolicies: current.bookingPolicies,
          feeAed: current.newCustomerFeeAed,
          depositAed: current.depositAed,
          sandboxTestCount: current.onboardingSandboxTestCount,
        });
        if (failures.length) throw new ApiError("Booking agent is not ready to go live", 409, { failures });
      }
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
      const normalizedRows = input.customers.map((customer, index) => ({
        ...customer,
        index,
        normalizedPhone: normalizeUaePhone(customer.phone),
      }));
      const invalid = normalizedRows.filter((row) => !row.normalizedPhone);
      if (invalid.length) {
        throw new ApiError(
          `Invalid UAE phone number on row ${invalid[0].index + 1}`,
          400
        );
      }
      const rows = canonicalizeCustomerImportRows(
        normalizedRows.map((row) => ({ ...row, normalizedPhone: row.normalizedPhone! }))
      );

      let eligible = 0;
      let protectedOptOuts = 0;
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
            latest?.status === "opt_out";
          const marketingOptIn = row.consent && !protectedOptOut;
          if (protectedOptOut) protectedOptOuts += 1;
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

          const targetConsentStatus = marketingOptIn ? "opt_in" : "opt_out";
          if (!protectedOptOut && latest?.status !== targetConsentStatus) {
            await tx.customerConsent.create({
              data: {
                restaurantId,
                customerId: customer.id,
                status: targetConsentStatus,
                source: "onboarding_csv",
              },
            });
          }
        }
      });

      return c.json({
        imported: rows.length,
        marketingEligible: eligible,
        protectedOptOuts,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
