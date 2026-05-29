import { Hono } from "hono";
import { z } from "zod";
import {
  getEffectiveRestaurantBillingState,
  getMenuAssistantUpgradeMessage,
  getMenuItemLimitMessage,
  getRestaurantEntitlements,
} from "@/lib/entitlements";
import { checkAiLimit, getAiUsageSummary, logAiUsage } from "@/lib/ai-usage";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import {
  buildMenuItemImageSummary,
  ensurePrimaryImageRecord,
  getNextHiddenImageSlot,
  getNextImageSlot,
  syncMenuItemImageSummary,
} from "@/lib/menu-item-images";
import { buildPromotionInclude } from "@/lib/promotions";
import { prisma } from "@/lib/prisma";
import { requireAuth, resolveAuthHeader } from "@/middleware/auth";
import { uploadBuffer } from "@/services/r2";
import { enhanceUploadedDishImage } from "@/services/google-image";
import { type TruthPreservingEditPreset } from "@/services/truth-preserving-image";

const sectionSchema = z.object({
  restaurantId: z.string().cuid(),
  name: z.string().min(1),
  nameAr: z.string().nullable().optional(),
  displayOrder: z.number().int().nonnegative().optional(),
});

const itemSchema = z.object({
  restaurantId: z.string().cuid(),
  sectionId: z.string().cuid(),
  name: z.string().min(1),
  nameAr: z.string().nullable().optional(),
  descriptionAr: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  aiNotes: z.string().max(2000).nullable().optional(),
  price: z.coerce.number().nonnegative(),
  currency: z.string().default("AED"),
  imageUrl: z.string().url().nullable().optional(),
  imageStatus: z.string().optional(),
  isAvailable: z.boolean().optional(),
  soldOutDate: z.string().min(1).nullable().optional(),
  specialStartsAt: z.string().datetime().nullable().optional(),
  specialEndsAt: z.string().datetime().nullable().optional(),
  displayOrder: z.number().int().nonnegative().optional(),
});

const importSchema = z.object({
  restaurantId: z.string().cuid(),
  sections: z.array(
    z.object({
      name: z.string().min(1),
      items: z.array(
        z.object({
          name: z.string().min(1),
          description: z.string().nullable().optional(),
          price: z.coerce.number().nonnegative(),
        })
      ),
    })
  ),
});

const reorderSchema = z.object({
  restaurantId: z.string().cuid(),
  sections: z.array(
    z.object({
      id: z.string().cuid(),
      displayOrder: z.number().int().nonnegative(),
      items: z.array(
        z.object({
          id: z.string().cuid(),
          displayOrder: z.number().int().nonnegative(),
          sectionId: z.string().cuid(),
        })
      ),
    })
  ),
});

const selectImageSchema = z.object({
  itemId: z.string().cuid(),
  imageId: z.string().cuid(),
});

const uploadImageSchema = z.object({
  itemId: z.string().cuid(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  base64: z.string().min(1),
  makePrimary: z.boolean().optional(),
  originType: z.enum(["owner_upload", "menu_source_upload"]).optional(),
});

const enhanceImageSchema = z.object({
  itemId: z.string().cuid(),
  imageId: z.string().cuid(),
  preset: z
    .enum(["clean_studio", "warm_natural", "lighter_background"] satisfies [TruthPreservingEditPreset, ...TruthPreservingEditPreset[]])
    .optional(),
});

const batchEnhanceImagesSchema = z.object({
  restaurantId: z.string().cuid(),
  preset: z
    .enum(["clean_studio", "warm_natural", "lighter_background"] satisfies [TruthPreservingEditPreset, ...TruthPreservingEditPreset[]])
    .optional(),
  targets: z
    .array(
      z.object({
        itemId: z.string().cuid(),
        imageId: z.string().cuid(),
      })
    )
    .min(1)
    .max(50),
});

const promotionTypeSchema = z.enum(["discounted_item", "deal", "combo"]);

const promotionItemSchema = z.object({
  menuItemId: z.string().cuid(),
  role: z.string().max(40).optional(),
  displayOrder: z.number().int().nonnegative().optional(),
});

const promotionSchema = z.object({
  restaurantId: z.string().cuid(),
  type: promotionTypeSchema,
  title: z.string().min(2).max(120),
  subtitle: z.string().max(120).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  badgeLabel: z.string().max(40).nullable().optional(),
  terms: z.string().max(280).nullable().optional(),
  promoPrice: z.coerce.number().positive().nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  displayOrder: z.number().int().nonnegative().optional(),
  items: z.array(promotionItemSchema).min(1),
});

const promotionInclude = buildPromotionInclude().promotions.include;

async function getOwnedRestaurantSummary(restaurantId: string, clerkId: string) {
  const restaurant = await prisma.restaurant.findFirst({
    where: {
      id: restaurantId,
      owner: {
        clerkId,
      },
    },
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
      _count: {
        select: {
          menuItems: true,
        },
      },
    },
  });

  if (!restaurant) {
    throw new ApiError("Restaurant not found", 404);
  }

  return restaurant;
}

async function assertOwnership(restaurantId: string, clerkId: string) {
  await getOwnedRestaurantSummary(restaurantId, clerkId);
}

function assertWithinMenuItemLimit(itemLimit: number | null, totalItems: number) {
  if (itemLimit !== null && totalItems > itemLimit) {
    throw new ApiError(getMenuItemLimitMessage(itemLimit), 403);
  }
}

function hasArabicInput(data: { nameAr?: string | null; descriptionAr?: string | null }) {
  return hasMeaningfulText(data.nameAr) || hasMeaningfulText(data.descriptionAr);
}

function assertArabicAllowed(
  entitlements: { arabicMenuEnabled: boolean },
  data: { nameAr?: string | null; descriptionAr?: string | null }
) {
  if (hasArabicInput(data) && !entitlements.arabicMenuEnabled) {
    throw new ApiError("Arabic menus are available on Pro. Upgrade to add Arabic content.", 403);
  }
}

function normalizeOptionalText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function parseOptionalDate(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  return new Date(value);
}

function getTodayDateOnly() {
  const today = new Date();
  const dateOnly = today.toISOString().split("T")[0];
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

async function enhanceMenuItemImageForOwner(input: {
  clerkId: string;
  itemId: string;
  imageId: string;
  preset: TruthPreservingEditPreset;
}) {
  const item = await prisma.menuItem.findUnique({
    where: { id: input.itemId },
    include: {
      restaurant: {
        include: {
          owner: true,
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
      },
      images: {
        orderBy: { slot: "asc" },
      },
    },
  });

  if (!item || item.restaurant.owner.clerkId !== input.clerkId) {
    throw new ApiError("Menu item not found", 404);
  }

  const target = item.images.find((image) => image.id === input.imageId);
  if (!target || target.slot < 0 || !target.imageUrl) {
    throw new ApiError("Enhanceable image not found", 404);
  }

  if (target.originType !== "owner_upload" && target.originType !== "menu_source_upload") {
    throw new ApiError("Only uploaded owner or menu images can be enhanced", 400);
  }

  const entitlements = getRestaurantEntitlements(item.restaurant);
  const limit = await checkAiLimit(
    item.restaurantId,
    "image_enhancement",
    entitlements.imageEnhancementLimit
  );

  if (!limit.allowed) {
    throw new ApiError(
      `Photo enhancement limit reached (${limit.used}/${entitlements.imageEnhancementLimit} this month). Upgrade for more.`,
      403
    );
  }

  const sourceImage =
    target.derivationType === "truth_preserving_edit" && target.parentImageId
      ? item.images.find((image) => image.id === target.parentImageId) ?? target
      : target;

  if (!sourceImage.imageUrl) {
    throw new ApiError("Source image not found", 404);
  }

  const enhanced = await enhanceUploadedDishImage({
    imageUrl: sourceImage.imageUrl,
    preset: input.preset,
    allowFallback: true,
  });
  const upload = await uploadBuffer({
    buffer: enhanced.buffer,
    contentType: enhanced.contentType,
    folder: `restaurants/${item.restaurantId}/menu-items/enhanced`,
    key: `restaurants/${item.restaurantId}/menu-items/enhanced/${Date.now()}-${target.id}.${enhanced.extension}`,
  });

  const updatedImage = await prisma.$transaction(async (tx) => {
    let parentImageId = target.parentImageId;

    if (target.derivationType !== "truth_preserving_edit") {
      const hiddenOriginal = await tx.menuItemImage.create({
        data: {
          menuItemId: item.id,
          slot: getNextHiddenImageSlot(item.images),
          imageUrl: target.imageUrl,
          imageStatus: target.imageStatus,
          promptModifier: target.promptModifier,
          isPrimary: false,
          originType: target.originType,
          derivationType: "original",
          parentImageId: null,
        },
        select: { id: true },
      });

      parentImageId = hiddenOriginal.id;
    }

    const updated = await tx.menuItemImage.update({
      where: { id: target.id },
      data: {
        imageUrl: upload.url,
        imageStatus: "generated",
        derivationType: "truth_preserving_edit",
        parentImageId,
        promptModifier: input.preset,
      },
      select: {
        id: true,
        slot: true,
        imageUrl: true,
        imageStatus: true,
        promptModifier: true,
        isPrimary: true,
        originType: true,
        derivationType: true,
        parentImageId: true,
      },
    });

    await syncMenuItemImageSummary(tx, item.id);
    return updated;
  });

  await logAiUsage(item.restaurantId, "image_enhancement", 0, 0);
  const usage = await getAiUsageSummary(item.restaurantId, "image_enhancement");

  return {
    image: updatedImage,
    itemId: item.id,
    itemName: item.name,
    restaurantId: item.restaurantId,
    usage: {
      used: usage.used,
      limit: entitlements.imageEnhancementLimit,
      remaining:
        entitlements.imageEnhancementLimit === null
          ? null
          : Math.max(entitlements.imageEnhancementLimit - usage.used, 0),
    },
  };
}

function hasMeaningfulText(value: string | null | undefined) {
  return Boolean(normalizeOptionalText(value));
}

function normalizeOptionalDateTime(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError("Invalid promotion schedule", 400);
  }

  return parsed;
}

async function deleteEmptyPromotions(
  tx: Pick<typeof prisma, "promotion">,
  restaurantId: string
) {
  await tx.promotion.deleteMany({
    where: {
      restaurantId,
      items: {
        none: {},
      },
    },
  });
}

async function assertDiscountedPriceIntegrity(
  menuItemId: string,
  nextPrice: number
) {
  const conflictingPromotion = await prisma.promotionItem.findFirst({
    where: {
      menuItemId,
      promotion: {
        type: "discounted_item",
      },
    },
    include: {
      promotion: {
        select: {
          title: true,
          promoPrice: true,
        },
      },
    },
  });

  if (
    conflictingPromotion?.promotion.promoPrice !== null &&
    conflictingPromotion?.promotion.promoPrice !== undefined &&
    Number(conflictingPromotion.promotion.promoPrice) >= nextPrice
  ) {
    throw new ApiError(
      `Update the "${conflictingPromotion.promotion.title}" offer before lowering this dish price.`,
      400
    );
  }
}

async function validatePromotionPayload(
  restaurantId: string,
  data: z.infer<typeof promotionSchema>
) {
  const uniqueItemIds = [...new Set(data.items.map((item) => item.menuItemId))];
  const menuItems = await prisma.menuItem.findMany({
    where: {
      restaurantId,
      id: {
        in: uniqueItemIds,
      },
    },
    select: {
      id: true,
      name: true,
      price: true,
    },
  });

  if (menuItems.length !== uniqueItemIds.length) {
    throw new ApiError("One or more linked dishes were not found", 404);
  }

  const startsAt = normalizeOptionalDateTime(data.startsAt);
  const endsAt = normalizeOptionalDateTime(data.endsAt);

  if (startsAt && endsAt && startsAt > endsAt) {
    throw new ApiError("Offer end time must be after the start time", 400);
  }

  if (data.type === "discounted_item") {
    if (uniqueItemIds.length !== 1) {
      throw new ApiError("Discounted item offers must target exactly one dish", 400);
    }

    if (data.promoPrice === null || data.promoPrice === undefined) {
      throw new ApiError("Discounted item offers need a promo price", 400);
    }

    const baseItem = menuItems[0];
    if (data.promoPrice >= Number(baseItem.price)) {
      throw new ApiError(
        `Promo price must be lower than ${baseItem.name}'s regular price`,
        400
      );
    }
  }

  if (data.type === "combo") {
    if (uniqueItemIds.length < 2) {
      throw new ApiError("Combos must include at least two dishes", 400);
    }

    if (data.promoPrice === null || data.promoPrice === undefined) {
      throw new ApiError("Combos need a combo price", 400);
    }
  }

  return {
    menuItems,
    startsAt,
    endsAt,
  };
}

export const menuRoute = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
    };
  };
}>()
  .get("/:restaurantId", async (c) => {
    try {
      const restaurantId = c.req.param("restaurantId");
      const authHeader = c.req.header("authorization");
      const auth = authHeader ? await resolveAuthHeader(authHeader).catch(() => null) : null;
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        include: {
          subscription: true,
          menuSections: {
            orderBy: { displayOrder: "asc" },
            include: {
              items: {
                orderBy: { displayOrder: "asc" },
                include: {
                  dietaryTags: {
                    include: { tag: true },
                  },
                  badges: {
                    include: { badge: true },
                  },
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
        const ownsRestaurant = auth
          ? await prisma.restaurant.count({
              where: {
                id: restaurant.id,
                owner: {
                  clerkId: auth.clerkId,
                },
              },
            })
          : 0;

        if (!ownsRestaurant) {
          throw new ApiError("Restaurant not found", 404);
        }
      }

      return c.json(restaurant.menuSections);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/:restaurantId/image-statuses", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const restaurantId = c.req.param("restaurantId");
      await assertOwnership(restaurantId, auth.clerkId);

      const items = await prisma.menuItem.findMany({
        where: { restaurantId },
        select: {
          id: true,
          imageStatus: true,
          imageUrl: true,
          images: {
            orderBy: { slot: "asc" },
            select: {
              id: true,
              slot: true,
              imageUrl: true,
              imageStatus: true,
              promptModifier: true,
              isPrimary: true,
              originType: true,
              derivationType: true,
              parentImageId: true,
            },
          },
        },
      });

      return c.json(
        items.map((item) => ({
          id: item.id,
          ...buildMenuItemImageSummary(item),
          images: item.images,
        }))
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/promotions", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = promotionSchema.parse(await c.req.json());
      await assertOwnership(data.restaurantId, auth.clerkId);
      const { startsAt, endsAt } = await validatePromotionPayload(data.restaurantId, data);

      const promotionCount = await prisma.promotion.count({
        where: { restaurantId: data.restaurantId },
      });

      const promotion = await prisma.promotion.create({
        data: {
          restaurantId: data.restaurantId,
          type: data.type,
          title: data.title.trim(),
          subtitle: normalizeOptionalText(data.subtitle),
          description: normalizeOptionalText(data.description),
          badgeLabel: normalizeOptionalText(data.badgeLabel),
          terms: normalizeOptionalText(data.terms),
          promoPrice: data.promoPrice ?? null,
          startsAt,
          endsAt,
          isActive: data.isActive ?? true,
          isFeatured: data.isFeatured ?? true,
          displayOrder: data.displayOrder ?? promotionCount,
          items: {
            create: data.items.map((item, index) => ({
              menuItemId: item.menuItemId,
              role: normalizeOptionalText(item.role) ?? "included",
              displayOrder: item.displayOrder ?? index,
            })),
          },
        },
        include: promotionInclude,
      });

      return c.json(promotion, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .put("/promotions/:id", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const promotionId = c.req.param("id");
      const current = await prisma.promotion.findUnique({
        where: { id: promotionId },
        include: {
          restaurant: {
            include: {
              owner: true,
              subscription: true,
            },
          },
        },
      });

      if (!current || current.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Offer not found", 404);
      }

      const data = promotionSchema.parse(await c.req.json());
      if (data.restaurantId !== current.restaurantId) {
        throw new ApiError("Offer restaurant mismatch", 400);
      }

      const { startsAt, endsAt } = await validatePromotionPayload(data.restaurantId, data);

      const updated = await prisma.$transaction(async (tx) => {
        await tx.promotionItem.deleteMany({
          where: { promotionId: current.id },
        });

        return tx.promotion.update({
          where: { id: current.id },
          data: {
            type: data.type,
            title: data.title.trim(),
            subtitle: normalizeOptionalText(data.subtitle),
            description: normalizeOptionalText(data.description),
            badgeLabel: normalizeOptionalText(data.badgeLabel),
            terms: normalizeOptionalText(data.terms),
            promoPrice: data.promoPrice ?? null,
            startsAt,
            endsAt,
            isActive: data.isActive ?? true,
            isFeatured: data.isFeatured ?? true,
            displayOrder: data.displayOrder ?? current.displayOrder,
            items: {
              create: data.items.map((item, index) => ({
                menuItemId: item.menuItemId,
                role: normalizeOptionalText(item.role) ?? "included",
                displayOrder: item.displayOrder ?? index,
              })),
            },
          },
          include: promotionInclude,
        });
      });

      return c.json(updated);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .delete("/promotions/:id", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const promotion = await prisma.promotion.findUnique({
        where: { id: c.req.param("id") },
        include: {
          restaurant: {
            include: {
              owner: true,
            },
          },
        },
      });

      if (!promotion || promotion.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Offer not found", 404);
      }

      await prisma.promotion.delete({
        where: { id: promotion.id },
      });
      return c.body(null, 204);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/sections", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = sectionSchema.parse(await c.req.json());
      const restaurant = await getOwnedRestaurantSummary(data.restaurantId, auth.clerkId);
      assertArabicAllowed(getRestaurantEntitlements(restaurant), data);

      const section = await prisma.menuSection.create({
        data: {
          restaurantId: data.restaurantId,
          name: data.name,
          nameAr: normalizeOptionalText(data.nameAr),
          displayOrder: data.displayOrder ?? 0,
        },
      });

      if (hasArabicInput(data)) {
        await prisma.restaurant.update({
          where: { id: data.restaurantId },
          data: { arabicEnabled: true },
        });
      }

      return c.json(section, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .put("/sections/:id", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const section = await prisma.menuSection.findUnique({
        where: { id: c.req.param("id") },
        include: {
          restaurant: {
            include: {
              owner: true,
              subscription: true,
              operatorAccount: { include: { _count: { select: { brands: true } } } },
            },
          },
        },
      });

      if (!section || section.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Section not found", 404);
      }

      const data = sectionSchema.partial().parse(await c.req.json());
      assertArabicAllowed(getRestaurantEntitlements(section.restaurant), data);
      const updated = await prisma.menuSection.update({
        where: { id: section.id },
        data: {
          ...data,
          nameAr: data.nameAr === undefined ? undefined : normalizeOptionalText(data.nameAr),
        },
      });

      if (hasArabicInput(data)) {
        await prisma.restaurant.update({
          where: { id: section.restaurantId },
          data: { arabicEnabled: true },
        });
      }

      return c.json(updated);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .delete("/sections/:id", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const section = await prisma.menuSection.findUnique({
        where: { id: c.req.param("id") },
        include: { restaurant: { include: { owner: true } } },
      });

      if (!section || section.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Section not found", 404);
      }

      await prisma.$transaction(async (tx) => {
        await tx.menuSection.delete({ where: { id: section.id } });
        await deleteEmptyPromotions(tx, section.restaurantId);
      });
      return c.body(null, 204);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/items", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = itemSchema.parse(await c.req.json());
      const restaurant = await getOwnedRestaurantSummary(data.restaurantId, auth.clerkId);
      const entitlements = getRestaurantEntitlements(restaurant);

      assertWithinMenuItemLimit(
        entitlements.menuItemLimit,
        restaurant._count.menuItems + 1
      );
      assertArabicAllowed(entitlements, data);
      if (hasMeaningfulText(data.aiNotes) && !entitlements.menuAssistantEnabled) {
        throw new ApiError(getMenuAssistantUpgradeMessage(), 403);
      }

      const item = await prisma.menuItem.create({
        data: {
          ...data,
          price: data.price,
          description: normalizeOptionalText(data.description),
          nameAr: normalizeOptionalText(data.nameAr),
          descriptionAr: normalizeOptionalText(data.descriptionAr),
          aiNotes: normalizeOptionalText(data.aiNotes),
          soldOutDate: parseOptionalDate(data.soldOutDate),
          specialStartsAt: parseOptionalDate(data.specialStartsAt),
          specialEndsAt: parseOptionalDate(data.specialEndsAt),
          imageUrl: data.imageUrl ?? null,
          imageStatus: data.imageStatus ?? "none",
          isAvailable: data.isAvailable ?? true,
          displayOrder: data.displayOrder ?? 0,
        },
      });

      if (hasArabicInput(data)) {
        await prisma.restaurant.update({
          where: { id: data.restaurantId },
          data: { arabicEnabled: true },
        });
      }

      return c.json(item, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .put("/items/:id", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const item = await prisma.menuItem.findUnique({
        where: { id: c.req.param("id") },
        include: {
          restaurant: {
            include: {
              owner: true,
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
          },
        },
      });

      if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Menu item not found", 404);
      }

      const data = itemSchema.partial().parse(await c.req.json());
      const entitlements = getRestaurantEntitlements(item.restaurant);
      assertArabicAllowed(entitlements, data);
      if (hasMeaningfulText(data.aiNotes) && !entitlements.menuAssistantEnabled) {
        throw new ApiError(getMenuAssistantUpgradeMessage(), 403);
      }
      if (data.price !== undefined) {
        await assertDiscountedPriceIntegrity(item.id, data.price);
      }

      const updated = await prisma.menuItem.update({
        where: { id: item.id },
        data: {
          ...data,
          description:
            data.description === undefined ? undefined : normalizeOptionalText(data.description),
          nameAr: data.nameAr === undefined ? undefined : normalizeOptionalText(data.nameAr),
          descriptionAr:
            data.descriptionAr === undefined ? undefined : normalizeOptionalText(data.descriptionAr),
          aiNotes: data.aiNotes === undefined ? undefined : normalizeOptionalText(data.aiNotes),
          soldOutDate: parseOptionalDate(data.soldOutDate),
          specialStartsAt: parseOptionalDate(data.specialStartsAt),
          specialEndsAt: parseOptionalDate(data.specialEndsAt),
          price: data.price,
        },
      });

      if (hasArabicInput(data)) {
        await prisma.restaurant.update({
          where: { id: item.restaurantId },
          data: { arabicEnabled: true },
        });
      }

      return c.json(updated);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .delete("/items/:id", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const item = await prisma.menuItem.findUnique({
        where: { id: c.req.param("id") },
        include: { restaurant: { include: { owner: true } } },
      });

      if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Menu item not found", 404);
      }

      await prisma.$transaction(async (tx) => {
        await tx.menuItem.delete({ where: { id: item.id } });
        await deleteEmptyPromotions(tx, item.restaurantId);
      });
      return c.body(null, 204);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/items/:id/sold-out", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const item = await prisma.menuItem.findUnique({
        where: { id: c.req.param("id") },
        include: { restaurant: { include: { owner: true } } },
      });

      if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Menu item not found", 404);
      }

      const updated = await prisma.menuItem.update({
        where: { id: item.id },
        data: {
          soldOutDate: getTodayDateOnly(),
        },
      });

      return c.json(updated);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .delete("/items/:id/sold-out", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const item = await prisma.menuItem.findUnique({
        where: { id: c.req.param("id") },
        include: { restaurant: { include: { owner: true } } },
      });

      if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Menu item not found", 404);
      }

      const updated = await prisma.menuItem.update({
        where: { id: item.id },
        data: {
          soldOutDate: null,
        },
      });

      return c.json(updated);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/items/:itemId/images/:imageId/select", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = selectImageSchema.parse({
        itemId: c.req.param("itemId"),
        imageId: c.req.param("imageId"),
      });

      const item = await prisma.menuItem.findUnique({
        where: { id: data.itemId },
        include: {
          restaurant: {
            include: {
              owner: true,
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
          },
          images: {
            orderBy: { slot: "asc" },
          },
        },
      });

      if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Menu item not found", 404);
      }

      const prepared = await prisma.$transaction((tx) => ensurePrimaryImageRecord(tx, item.id));
      const images = prepared?.images ?? item.images;
      const target = images.find((image) => image.id === data.imageId);

      if (!target || !target.imageUrl) {
        throw new ApiError("Image not found", 404);
      }

      await prisma.$transaction(async (tx) => {
        await tx.menuItemImage.updateMany({
          where: { menuItemId: item.id },
          data: { isPrimary: false },
        });
        await tx.menuItemImage.update({
          where: { id: target.id },
          data: { isPrimary: true },
        });
        await syncMenuItemImageSummary(tx, item.id);
      });

      return c.json({ ok: true, imageId: target.id });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/items/:itemId/images/upload", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = uploadImageSchema.parse({
        itemId: c.req.param("itemId"),
        ...(await c.req.json()),
      });

      const item = await prisma.menuItem.findUnique({
        where: { id: data.itemId },
        include: {
          restaurant: {
            include: {
              owner: true,
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
          },
          images: {
            orderBy: { slot: "asc" },
          },
        },
      });

      if (!item || item.restaurant.owner.clerkId !== auth.clerkId) {
        throw new ApiError("Menu item not found", 404);
      }

      const entitlements = getRestaurantEntitlements(item.restaurant);

      if (!data.contentType.startsWith("image/")) {
        throw new ApiError("Only image uploads are supported for menu item photos", 400);
      }

      if (data.originType === "menu_source_upload" && !entitlements.sourcePhotoReviewEnabled) {
        throw new ApiError("Imported menu photo review is not enabled for this plan", 403);
      }

      if ((data.originType === undefined || data.originType === "owner_upload") && !entitlements.sourcePhotoImportEnabled) {
        throw new ApiError("Owner photo uploads are not enabled for this plan", 403);
      }

      const prepared = await prisma.$transaction((tx) => ensurePrimaryImageRecord(tx, item.id));
      const images = prepared?.images ?? item.images;
      const nextSlot = getNextImageSlot(images);

      if (nextSlot === null) {
        throw new ApiError("You can store up to 10 images per menu item", 400);
      }

      const upload = await uploadBuffer({
        buffer: Buffer.from(data.base64, "base64"),
        contentType: data.contentType,
        folder: `restaurants/${item.restaurantId}/menu-items/originals`,
        key: `restaurants/${item.restaurantId}/menu-items/originals/${Date.now()}-${data.filename.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
      });

      const makePrimary = data.makePrimary ?? images.length === 0;
      const originType = data.originType ?? "owner_upload";
      const createdImage = await prisma.$transaction(async (tx) => {
        if (makePrimary) {
          await tx.menuItemImage.updateMany({
            where: { menuItemId: item.id },
            data: { isPrimary: false },
          });
        }

        const created = await tx.menuItemImage.create({
          data: {
            menuItemId: item.id,
            slot: nextSlot,
            imageUrl: upload.url,
            imageStatus: "uploaded",
            isPrimary: makePrimary,
            originType,
            derivationType: "original",
            parentImageId: null,
          },
          select: {
            id: true,
            slot: true,
            imageUrl: true,
            imageStatus: true,
            promptModifier: true,
            isPrimary: true,
            originType: true,
            derivationType: true,
            parentImageId: true,
          },
        });

        await syncMenuItemImageSummary(tx, item.id);

        return created;
      });

      return c.json({ ok: true, image: createdImage }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/items/:itemId/images/:imageId/enhance", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = enhanceImageSchema.parse({
        itemId: c.req.param("itemId"),
        imageId: c.req.param("imageId"),
        ...(await c.req.json().catch(() => ({}))),
      });

      const result = await enhanceMenuItemImageForOwner({
        clerkId: auth.clerkId,
        itemId: data.itemId,
        imageId: data.imageId,
        preset: data.preset ?? "clean_studio",
      });

      return c.json({
        ok: true,
        image: result.image,
        usage: result.usage,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/images/batch-enhance", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = batchEnhanceImagesSchema.parse(await c.req.json());
      const restaurant = await getOwnedRestaurantSummary(data.restaurantId, auth.clerkId);
      const entitlements = getRestaurantEntitlements(restaurant);

      if (!entitlements.batchImageEnhancementEnabled) {
        throw new ApiError("Batch photo enhancement is available on Pro.", 403);
      }

      const targets = data.targets.filter(
        (target, index, list) =>
          list.findIndex(
            (candidate) =>
              candidate.itemId === target.itemId && candidate.imageId === target.imageId
          ) === index
      );

      const preset = data.preset ?? "clean_studio";
      const successes: Array<{
        itemId: string;
        itemName: string;
        image: {
          id: string;
          slot: number;
          imageUrl: string | null;
          imageStatus: string;
          promptModifier: string | null;
          isPrimary: boolean;
          originType: string;
          derivationType: string;
          parentImageId: string | null;
        };
      }> = [];
      const failures: Array<{
        itemId: string;
        imageId: string;
        message: string;
      }> = [];
      let latestUsage = {
        used: 0,
        limit: entitlements.imageEnhancementLimit,
        remaining: entitlements.imageEnhancementLimit,
      };

      for (const target of targets) {
        try {
          const result = await enhanceMenuItemImageForOwner({
            clerkId: auth.clerkId,
            itemId: target.itemId,
            imageId: target.imageId,
            preset,
          });

          latestUsage = result.usage;
          successes.push({
            itemId: result.itemId,
            itemName: result.itemName,
            image: result.image,
          });
        } catch (error) {
          failures.push({
            itemId: target.itemId,
            imageId: target.imageId,
            message: error instanceof Error ? error.message : "Failed to enhance image.",
          });
        }
      }

      return c.json({
        ok: true,
        results: {
          requested: targets.length,
          succeeded: successes.length,
          failed: failures.length,
          images: successes,
          failures,
        },
        usage: latestUsage,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/import", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = importSchema.parse(await c.req.json());
      const restaurant = await getOwnedRestaurantSummary(data.restaurantId, auth.clerkId);
      const entitlements = getRestaurantEntitlements(restaurant);
      const totalImportedItems = data.sections.reduce(
        (total, section) => total + section.items.length,
        0
      );

      assertWithinMenuItemLimit(entitlements.menuItemLimit, totalImportedItems);

      await prisma.$transaction(async (tx) => {
        await tx.promotion.deleteMany({
          where: { restaurantId: data.restaurantId },
        });
        await tx.menuItem.deleteMany({
          where: { restaurantId: data.restaurantId },
        });
        await tx.menuSection.deleteMany({
          where: { restaurantId: data.restaurantId },
        });

        for (const [sectionIndex, section] of data.sections.entries()) {
          const createdSection = await tx.menuSection.create({
            data: {
              restaurantId: data.restaurantId,
              name: section.name,
              displayOrder: sectionIndex,
            },
          });

          for (const [itemIndex, item] of section.items.entries()) {
            await tx.menuItem.create({
              data: {
                restaurantId: data.restaurantId,
                sectionId: createdSection.id,
                name: item.name,
                description: item.description ?? null,
                price: item.price,
                displayOrder: itemIndex,
              },
            });
          }
        }
      });

      const sections = await prisma.menuSection.findMany({
        where: { restaurantId: data.restaurantId },
        orderBy: { displayOrder: "asc" },
        include: {
          items: {
            orderBy: { displayOrder: "asc" },
          },
        },
      });

      return c.json(sections, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .put("/reorder", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = reorderSchema.parse(await c.req.json());
      await assertOwnership(data.restaurantId, auth.clerkId);

      await prisma.$transaction(async (tx) => {
        for (const section of data.sections) {
          await tx.menuSection.update({
            where: { id: section.id },
            data: { displayOrder: section.displayOrder },
          });

          for (const item of section.items) {
            await tx.menuItem.update({
              where: { id: item.id },
              data: {
                displayOrder: item.displayOrder,
                sectionId: item.sectionId,
              },
            });
          }
        }
      });

      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
