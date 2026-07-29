import { Hono } from "hono";
import { z } from "zod";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { checkAiLimit, logAiUsage } from "@/lib/ai-usage";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import {
  ensurePrimaryImageRecord,
  getNextImageSlot,
  syncMenuItemImageSummary,
} from "@/lib/menu-item-images";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { enqueueMenuItemImage } from "@/queue/image-generation";
import { extractMenuFromSource } from "@/services/claude";
import { detectMenuSourceImages } from "@/services/menu-source-image-detector";

const extractSchema = z.object({
  restaurantId: z.string().cuid(),
  sourceText: z.string().optional(),
  fileName: z.string().optional(),
  contentType: z.string().optional(),
  base64: z.string().optional(),
});

const imageSchema = z.object({
  menuItemId: z.string().cuid(),
  promptModifier: z.string().trim().max(240).optional(),
  allowFallback: z.boolean().optional(),
  replaceImageId: z.string().cuid().optional(),
});

const detectSourceImagesSchema = z.object({
  restaurantId: z.string().cuid(),
  pages: z.array(
    z.object({
      pageNumber: z.number().int().positive(),
      base64: z.string().min(1).max(4_000_000),
      contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    })
  ).min(1).max(8),
});

export const aiRoute = new Hono<{
  Variables: {
    auth: {
      clerkId: string;
      email: string | null;
    };
  };
}>()
  .post("/extract", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = extractSchema.parse(await c.req.json());
      const ownsRestaurant = await prisma.restaurant.count({
        where: {
          id: data.restaurantId,
          owner: {
            clerkId: auth.clerkId,
          },
        },
      });

      if (!ownsRestaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      const draft = await extractMenuFromSource(data);
      return c.json(draft);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/generate-image", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = imageSchema.parse(await c.req.json());
      const item = await prisma.menuItem.findUnique({
        where: { id: data.menuItemId },
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

      const entitlements = getRestaurantEntitlements(item.restaurant);
      const usageLimit = await checkAiLimit(
        item.restaurantId,
        "dish_image_generation",
        entitlements.dishImageGenerationLimit
      );
      if (!usageLimit.allowed) {
        throw new ApiError(
          `Image generation limit reached (${usageLimit.used}/${entitlements.dishImageGenerationLimit} this month).`,
          403
        );
      }

      const promptModifier = data.promptModifier?.trim() || null;
      const image = await prisma.$transaction(async (tx) => {
        const prepared = await ensurePrimaryImageRecord(tx, item.id);
        const images = prepared?.images ?? [];
        const hasPendingImage = images.some((image) =>
          image.id === data.replaceImageId
            ? false
            : image.imageStatus === "none" || image.imageStatus === "generating"
        );

        if (hasPendingImage) {
          throw new ApiError("Image generation is already in progress for this dish", 409);
        }

        if (data.replaceImageId) {
          const existing = images.find((image) => image.id === data.replaceImageId);

          if (!existing) {
            throw new ApiError("Image variant not found", 404);
          }

          if (existing.imageUrl && existing.imageStatus !== "failed") {
            throw new ApiError("Only failed image variants can be retried", 400);
          }

          return tx.menuItemImage.update({
            where: { id: existing.id },
            data: {
              promptModifier,
              imageUrl: null,
              imageStatus: "none",
              originType: "bustan_ai",
              derivationType: "synthetic_generation",
              parentImageId: null,
            },
          });
        }

        const nextSlot = getNextImageSlot(images);

        if (nextSlot === null) {
          throw new ApiError("This dish has reached the saved image variant limit", 400);
        }

        return tx.menuItemImage.create({
          data: {
            menuItemId: item.id,
            slot: nextSlot,
            promptModifier,
            imageStatus: "none",
            isPrimary: images.length === 0,
            originType: "bustan_ai",
            derivationType: "synthetic_generation",
            parentImageId: null,
          },
        });
      });

      try {
        await enqueueMenuItemImage({
          menuItemId: item.id,
          imageId: image.id,
          priority: entitlements.imageGenerationPriority,
          allowFallback: data.allowFallback,
        });
      } catch (error) {
        await prisma.$transaction(async (tx) => {
          await tx.menuItemImage.delete({
            where: { id: image.id },
          });
          await syncMenuItemImageSummary(tx, item.id);
        });
        throw error;
      }

      await prisma.$transaction(async (tx) => {
        await tx.menuItemImage.update({
          where: { id: image.id },
          data: { imageStatus: "generating" },
        });
        await syncMenuItemImageSummary(tx, item.id);
      });
      await logAiUsage(item.restaurantId, "dish_image_generation", 0, 0, 0.04);

      return c.json({
        queued: true,
        menuItemId: item.id,
        imageId: image.id,
        priority: entitlements.imageGenerationPriority,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .post("/detect-source-images", requireAuth, async (c) => {
    try {
      const auth = c.get("auth");
      const data = detectSourceImagesSchema.parse(await c.req.json());

      const restaurant = await prisma.restaurant.findFirst({
        where: {
          id: data.restaurantId,
          owner: {
            clerkId: auth.clerkId,
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
          menuSections: {
            orderBy: { displayOrder: "asc" },
            include: {
              items: {
                orderBy: { displayOrder: "asc" },
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      });

      if (!restaurant) {
        throw new ApiError("Restaurant not found", 404);
      }

      const entitlements = getRestaurantEntitlements(restaurant);
      if (!entitlements.sourcePhotoImportEnabled || !entitlements.sourcePhotoReviewEnabled) {
        throw new ApiError("Imported menu photo review is not enabled for this plan", 403);
      }

      const menuItems = restaurant.menuSections.flatMap((section) =>
        section.items.map((item) => ({
          id: item.id,
          name: item.name,
          sectionName: section.name,
        }))
      );

      const detection = await detectMenuSourceImages({
        restaurantName: restaurant.name,
        menuItems,
        pages: data.pages,
      });

      return c.json(detection);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
