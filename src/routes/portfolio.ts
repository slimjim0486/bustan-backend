import { Hono } from "hono";
import { z } from "zod";
import { env } from "@/lib/env";
import { getPortfolioActivationState } from "@/lib/entitlements";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/slug";
import { requireAuth, getCurrentUser } from "@/middleware/auth";
import { generatePortfolioQrCode } from "@/services/qr-generator";
import { updatePortfolioSubscriptionQuantity } from "@/services/stripe";

const updatePortfolioSchema = z.object({
  name: z.string().min(2).max(100),
});

const createBrandSchema = z.object({
  name: z.string().min(2),
  description: z.string().nullable().optional(),
  cuisineType: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  logoUrl: z.string().url().nullable().optional(),
  coverImageUrl: z.string().url().nullable().optional(),
  cloneFromRestaurantId: z.string().cuid().nullable().optional(),
});

const qrQuerySchema = z.object({
  format: z.enum(["svg", "png"]).default("svg"),
  size: z.enum(["600", "1200"]).default("1200"),
  preset: z.enum(["50mm", "70mm", "100mm"]).default("70mm"),
  includeBranding: z.enum(["true", "false"]).default("true"),
});

async function generateUniqueSlug(name: string, excludeRestaurantId?: string) {
  const baseSlug = slugify(name);
  let slug = baseSlug;
  let count = 1;

  while (true) {
    const [restaurantMatch, aliasMatch] = await Promise.all([
      prisma.restaurant.findUnique({
        where: { slug },
        select: { id: true },
      }),
      prisma.restaurantSlugAlias.findUnique({
        where: { slug },
        select: { restaurantId: true },
      }),
    ]);

    const slugTakenByRestaurant =
      restaurantMatch && restaurantMatch.id !== excludeRestaurantId;
    const slugTakenByAlias =
      aliasMatch && aliasMatch.restaurantId !== excludeRestaurantId;

    if (!slugTakenByRestaurant && !slugTakenByAlias) {
      return slug;
    }

    count += 1;
    slug = `${baseSlug}-${count}`;
  }
}

async function getOperatorAccountForClerk(clerkId: string) {
  const operator = await prisma.operatorAccount.findFirst({
    where: {
      owner: {
        clerkId,
      },
    },
    include: {
      brands: {
        orderBy: [{ createdAt: "asc" }],
        include: {
          subscription: true,
          menuSections: {
            include: {
              items: true,
            },
          },
        },
      },
    },
  });

  if (!operator) {
    throw new ApiError("Portfolio account not found", 404);
  }

  return operator;
}

function withActivationState<T extends { status: "trial" | "active" | "paused" | "cancelled"; brands: unknown[] }>(
  operator: T
) {
  return {
    ...operator,
    activationState: getPortfolioActivationState({
      operatorAccount: {
        status: operator.status,
        brands: operator.brands,
      },
    }),
  };
}

function assertPortfolioReady(operator: {
  status: "trial" | "active" | "paused" | "cancelled";
  brands: unknown[];
}) {
  const activationState = getPortfolioActivationState({
    operatorAccount: {
      status: operator.status,
      brands: operator.brands,
    },
  });

  if (activationState !== "active") {
    const remaining = Math.max(3 - operator.brands.length, 0);
    throw new ApiError(
      remaining > 0
        ? `Portfolio setup incomplete. Add ${remaining} more brand${remaining === 1 ? "" : "s"} to unlock full portfolio features.`
        : "Portfolio is not active.",
      403
    );
  }
}

async function syncPortfolioBrandQuantity(operatorAccount: {
  stripeSubscriptionId: string | null;
  brands: Array<{ id: string }>;
}) {
  if (!operatorAccount.stripeSubscriptionId) {
    return;
  }

  await updatePortfolioSubscriptionQuantity({
    stripeSubscriptionId: operatorAccount.stripeSubscriptionId,
    quantity: operatorAccount.brands.length,
  });
}

export const portfolioRoute = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
      fullName: string | null;
    };
  };
}>()
  .patch("/", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const operator = await getOperatorAccountForClerk(auth.clerkId);
      const data = updatePortfolioSchema.parse(await c.req.json());

      const updated = await prisma.operatorAccount.update({
        where: { id: operator.id },
        data: { name: data.name },
        include: {
          brands: {
            orderBy: [{ createdAt: "asc" }],
          },
        },
      });

      return c.json({ operatorAccount: withActivationState(updated) });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/brands", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const operator = await getOperatorAccountForClerk(auth.clerkId);
      const data = createBrandSchema.parse(await c.req.json());

      if (operator.brands.length >= operator.brandLimit) {
        throw new ApiError(`Portfolio limit reached (${operator.brandLimit} brands).`, 403);
      }

      const slug = await generateUniqueSlug(data.name);
      const restaurant = await prisma.restaurant.create({
        data: {
          slug,
          ownerId: operator.ownerId,
          operatorAccountId: operator.id,
          name: data.name,
          description: data.description ?? null,
          cuisineType: data.cuisineType ?? null,
          location: data.location ?? null,
          address: data.address ?? null,
          phone: data.phone ?? null,
          website: data.website ?? null,
          logoUrl: data.logoUrl ?? null,
          coverImageUrl: data.coverImageUrl ?? null,
          isPublished: false,
          subscriptionStatus: operator.status,
          trialEndsAt: operator.currentPeriodEnd,
        },
        include: {
          subscription: true,
          menuSections: {
            include: {
              items: true,
            },
          },
        },
      });

      const refreshedOperator = await getOperatorAccountForClerk(auth.clerkId);
      await syncPortfolioBrandQuantity(refreshedOperator);

      return c.json({
        restaurant,
        operatorAccount: withActivationState(refreshedOperator),
      }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .delete("/brands/:id", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const operator = await getOperatorAccountForClerk(auth.clerkId);
      const restaurantId = c.req.param("id");

      const brand = operator.brands.find((entry) => entry.id === restaurantId);
      if (!brand) {
        throw new ApiError("Brand not found", 404);
      }

      await prisma.restaurant.update({
        where: { id: restaurantId },
        data: {
          operatorAccountId: null,
          isPublished: false,
          subscriptionStatus: "cancelled",
        },
      });

      const refreshedOperator = await getOperatorAccountForClerk(auth.clerkId);
      await syncPortfolioBrandQuantity(refreshedOperator);

      return c.json({
        ok: true,
        operatorAccount: withActivationState(refreshedOperator),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/analytics", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const operator = await getOperatorAccountForClerk(auth.clerkId);
      assertPortfolioReady(operator);
      const brandIds = operator.brands.map((brand) => brand.id);

      if (brandIds.length === 0) {
        return c.json({
          overview: {
            totalBrands: 0,
            totalViews: 0,
            viewsThisWeek: 0,
            totalLikes: 0,
            totalWhatsappClicks: 0,
            averageQualityScore: null,
            brandsNeedingAttention: 0,
          },
          brands: [],
          topItems: [],
        });
      }

      const weekCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [
        pageViews,
        likesByBrand,
        whatsappByBrand,
        latestAnalyses,
        topLikedGroups,
      ] = await Promise.all([
        prisma.pageView.groupBy({
          by: ["restaurantId"],
          where: { restaurantId: { in: brandIds } },
          _count: { restaurantId: true },
        }),
        prisma.menuItemLike.groupBy({
          by: ["restaurantId"],
          where: { restaurantId: { in: brandIds } },
          _count: { restaurantId: true },
        }),
        prisma.whatsAppClick.groupBy({
          by: ["restaurantId"],
          where: { restaurantId: { in: brandIds } },
          _count: { restaurantId: true },
        }),
        prisma.menuAnalysis.findMany({
          where: {
            restaurantId: { in: brandIds },
          },
          orderBy: { createdAt: "desc" },
        }),
        prisma.menuItemLike.groupBy({
          by: ["menuItemId"],
          where: { restaurantId: { in: brandIds } },
          _count: { menuItemId: true },
          orderBy: {
            _count: {
              menuItemId: "desc",
            },
          },
          take: 8,
        }),
      ]);

      const [viewsThisWeekByBrand, topItems] = await Promise.all([
        prisma.pageView.groupBy({
          by: ["restaurantId"],
          where: {
            restaurantId: { in: brandIds },
            createdAt: { gte: weekCutoff },
          },
          _count: { restaurantId: true },
        }),
        topLikedGroups.length === 0
          ? Promise.resolve([])
          : prisma.menuItem.findMany({
              where: {
                id: { in: topLikedGroups.map((entry) => entry.menuItemId) },
              },
              select: {
                id: true,
                name: true,
                restaurant: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            }).then((items) => {
              const itemsById = new Map(items.map((item) => [item.id, item]));
              return topLikedGroups.flatMap((group) => {
                const item = itemsById.get(group.menuItemId);
                if (!item) {
                  return [];
                }

                return [{
                  menuItemId: item.id,
                  name: item.name,
                  restaurantId: item.restaurant.id,
                  restaurantName: item.restaurant.name,
                  likes: group._count.menuItemId,
                }];
              });
            }),
      ]);

      const viewsMap = new Map(pageViews.map((entry) => [entry.restaurantId, entry._count.restaurantId]));
      const weeklyViewsMap = new Map(viewsThisWeekByBrand.map((entry) => [entry.restaurantId, entry._count.restaurantId]));
      const likesMap = new Map(likesByBrand.map((entry) => [entry.restaurantId, entry._count.restaurantId]));
      const whatsappMap = new Map(whatsappByBrand.map((entry) => [entry.restaurantId, entry._count.restaurantId]));
      const latestAnalysisMap = new Map<string, { score: number | null; createdAt: Date | null }>();

      for (const analysis of latestAnalyses) {
        if (latestAnalysisMap.has(analysis.restaurantId)) {
          continue;
        }

        const result = analysis.result as { overallScore?: number } | null;
        latestAnalysisMap.set(analysis.restaurantId, {
          score: result?.overallScore ?? null,
          createdAt: analysis.createdAt,
        });
      }

      const brands = operator.brands.map((brand) => {
        const totalItems = brand.menuSections.reduce((sum, section) => sum + section.items.length, 0);
        const latestAnalysis = latestAnalysisMap.get(brand.id);
        const qualityScore = latestAnalysis?.score ?? null;
        const viewsThisWeek = weeklyViewsMap.get(brand.id) ?? 0;

        return {
          id: brand.id,
          slug: brand.slug,
          name: brand.name,
          cuisineType: brand.cuisineType,
          logoUrl: brand.logoUrl,
          location: brand.location,
          isPublished: brand.isPublished,
          totalItems,
          totalViews: viewsMap.get(brand.id) ?? 0,
          viewsThisWeek,
          totalLikes: likesMap.get(brand.id) ?? 0,
          whatsappClicks: whatsappMap.get(brand.id) ?? 0,
          qualityScore,
          qualityScoreUpdatedAt: latestAnalysis?.createdAt ?? null,
          lastUpdated: brand.updatedAt,
          needsAttention: !brand.isPublished || (qualityScore !== null && qualityScore < 70) || totalItems < 5,
        };
      }).sort((left, right) => right.viewsThisWeek - left.viewsThisWeek);

      const analyzedBrands = brands.filter((brand) => brand.qualityScore !== null);
      const averageQualityScore =
        analyzedBrands.length === 0
          ? null
          : Math.round(
              analyzedBrands.reduce((sum, brand) => sum + (brand.qualityScore ?? 0), 0) /
                analyzedBrands.length
            );

      return c.json({
        overview: {
          totalBrands: brands.length,
          totalViews: brands.reduce((sum, brand) => sum + brand.totalViews, 0),
          viewsThisWeek: brands.reduce((sum, brand) => sum + brand.viewsThisWeek, 0),
          totalLikes: brands.reduce((sum, brand) => sum + brand.totalLikes, 0),
          totalWhatsappClicks: brands.reduce((sum, brand) => sum + brand.whatsappClicks, 0),
          averageQualityScore,
          brandsNeedingAttention: brands.filter((brand) => brand.needsAttention).length,
        },
        brands,
        topItems,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/brands/:id/qr", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const operator = await getOperatorAccountForClerk(auth.clerkId);
      assertPortfolioReady(operator);
      const restaurantId = c.req.param("id");
      const query = qrQuerySchema.parse(c.req.query());
      const brand = operator.brands.find((entry) => entry.id === restaurantId);

      if (!brand) {
        throw new ApiError("Brand not found", 404);
      }

      const urlBase = env.FRONTEND_APP_URL.replace(/\/$/, "");
      const qr = await generatePortfolioQrCode({
        url: `${urlBase}/${brand.slug}`,
        brandName: brand.name,
        format: query.format,
        size: Number(query.size) as 600 | 1200,
        preset: query.preset,
        includeBranding: query.includeBranding === "true",
      });

      return new Response(new Uint8Array(qr.buffer), {
        headers: {
          "Content-Type": qr.contentType,
          "Content-Disposition": `attachment; filename="${qr.filename}"`,
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
