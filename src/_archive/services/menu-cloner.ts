import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Tx = Prisma.TransactionClient;

async function assertOperatorRestaurant(
  tx: Tx,
  restaurantId: string,
  operatorAccountId: string
) {
  const restaurant = await tx.restaurant.findFirst({
    where: {
      id: restaurantId,
      operatorAccountId,
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!restaurant) {
    throw new Error("Restaurant is not part of this portfolio.");
  }

  return restaurant;
}

async function cloneLoadedSection(
  tx: Tx,
  input: {
    targetRestaurantId: string;
    section: Awaited<
      ReturnType<typeof tx.menuSection.findUnique>
    > & {
      items: Array<{
        name: string;
        description: string | null;
        aiNotes: string | null;
        price: Prisma.Decimal;
        currency: string;
        imageUrl: string | null;
        imageStatus: string;
        isAvailable: boolean;
        soldOutDate: Date | null;
        specialStartsAt: Date | null;
        specialEndsAt: Date | null;
        displayOrder: number;
        aiDescriptionStatus: string | null;
        originalDescription: string | null;
        dietaryTags: Array<{ tagId: string; source: string; confidence: number | null }>;
        badges: Array<{ badgeId: string }>;
        images: Array<{
          slot: number;
          imageUrl: string | null;
          imageStatus: string;
          promptModifier: string | null;
          isPrimary: boolean;
          originType: "legacy_unspecified" | "bustan_ai" | "owner_upload" | "menu_source_upload";
          derivationType: "original" | "truth_preserving_edit" | "synthetic_generation";
          parentImageId: string | null;
        }>;
      }>;
    };
    displayOrder: number;
  }
) {
  const newSection = await tx.menuSection.create({
    data: {
      restaurantId: input.targetRestaurantId,
      name: input.section.name,
      displayOrder: input.displayOrder,
    },
  });

  let itemsCopied = 0;

  for (const sourceItem of input.section.items) {
    const createdItem = await tx.menuItem.create({
      data: {
        sectionId: newSection.id,
        restaurantId: input.targetRestaurantId,
        name: sourceItem.name,
        description: sourceItem.description,
        aiNotes: sourceItem.aiNotes,
        price: sourceItem.price,
        currency: sourceItem.currency,
        imageUrl: sourceItem.imageUrl,
        imageStatus: sourceItem.imageStatus,
        isAvailable: sourceItem.isAvailable,
        soldOutDate: sourceItem.soldOutDate,
        specialStartsAt: sourceItem.specialStartsAt,
        specialEndsAt: sourceItem.specialEndsAt,
        displayOrder: sourceItem.displayOrder,
        aiDescriptionStatus: sourceItem.aiDescriptionStatus,
        originalDescription: sourceItem.originalDescription,
      },
    });

    const imageIdMap = new Map<string, string>();

    for (const sourceImage of sourceItem.images) {
      const createdImage = await tx.menuItemImage.create({
        data: {
          menuItemId: createdItem.id,
          slot: sourceImage.slot,
          imageUrl: sourceImage.imageUrl,
          imageStatus: sourceImage.imageStatus,
          promptModifier: sourceImage.promptModifier,
          isPrimary: sourceImage.isPrimary,
          originType: sourceImage.originType,
          derivationType: sourceImage.derivationType,
          parentImageId: null,
        },
      });

      if (sourceImage.parentImageId) {
        imageIdMap.set(sourceImage.parentImageId, createdImage.id);
      }
    }

    for (const sourceImage of sourceItem.images) {
      if (!sourceImage.parentImageId) {
        continue;
      }

      const createdImageId = imageIdMap.get(sourceImage.parentImageId);
      const clonedImage = await tx.menuItemImage.findFirst({
        where: {
          menuItemId: createdItem.id,
          slot: sourceImage.slot,
        },
        select: { id: true },
      });

      if (createdImageId && clonedImage) {
        await tx.menuItemImage.update({
          where: { id: clonedImage.id },
          data: {
            parentImageId: createdImageId,
          },
        });
      }
    }

    if (sourceItem.dietaryTags.length > 0) {
      await tx.menuItemDietaryTag.createMany({
        data: sourceItem.dietaryTags.map((tag) => ({
          menuItemId: createdItem.id,
          tagId: tag.tagId,
          source: tag.source,
          confidence: tag.confidence,
        })),
      });
    }

    if (sourceItem.badges.length > 0) {
      await tx.menuItemBadge.createMany({
        data: sourceItem.badges.map((badge) => ({
          menuItemId: createdItem.id,
          badgeId: badge.badgeId,
        })),
      });
    }

    itemsCopied += 1;
  }

  return {
    sectionId: newSection.id,
    itemsCopied,
    sectionsCopied: 1,
  };
}

export async function cloneSection(
  sourceSectionId: string,
  targetRestaurantId: string,
  operatorAccountId: string
) {
  return prisma.$transaction(async (tx) => {
    const sourceSection = await tx.menuSection.findUnique({
      where: { id: sourceSectionId },
      include: {
        restaurant: {
          select: {
            id: true,
            operatorAccountId: true,
          },
        },
        items: {
          orderBy: { displayOrder: "asc" },
          include: {
            dietaryTags: true,
            badges: true,
            images: {
              orderBy: { slot: "asc" },
            },
          },
        },
      },
    });

    if (!sourceSection || sourceSection.restaurant.operatorAccountId !== operatorAccountId) {
      throw new Error("Source section is not part of this portfolio.");
    }

    await assertOperatorRestaurant(tx, targetRestaurantId, operatorAccountId);

    const currentMax = await tx.menuSection.aggregate({
      where: { restaurantId: targetRestaurantId },
      _max: { displayOrder: true },
    });

    const result = await cloneLoadedSection(tx, {
      targetRestaurantId,
      section: sourceSection,
      displayOrder: (currentMax._max.displayOrder ?? -1) + 1,
    });

    await tx.menuCloneLog.create({
      data: {
        sourceRestaurantId: sourceSection.restaurant.id,
        targetRestaurantId,
        cloneType: "section",
        sourceSectionId,
        itemsCopied: result.itemsCopied,
        sectionsCopied: result.sectionsCopied,
      },
    });

    return result;
  });
}

export async function cloneMenu(
  sourceRestaurantId: string,
  targetRestaurantId: string,
  operatorAccountId: string,
  replaceExisting = false
) {
  if (sourceRestaurantId === targetRestaurantId) {
    throw new Error("Source and target brands must be different.");
  }

  return prisma.$transaction(async (tx) => {
    const [sourceRestaurant, targetRestaurant] = await Promise.all([
      tx.restaurant.findFirst({
        where: {
          id: sourceRestaurantId,
          operatorAccountId,
        },
        include: {
          menuSections: {
            orderBy: { displayOrder: "asc" },
            include: {
              items: {
                orderBy: { displayOrder: "asc" },
                include: {
                  dietaryTags: true,
                  badges: true,
                  images: {
                    orderBy: { slot: "asc" },
                  },
                },
              },
            },
          },
        },
      }),
      assertOperatorRestaurant(tx, targetRestaurantId, operatorAccountId),
    ]);

    if (!sourceRestaurant) {
      throw new Error("Source brand is not part of this portfolio.");
    }

    if (replaceExisting) {
      await tx.promotion.deleteMany({
        where: { restaurantId: targetRestaurant.id },
      });
      await tx.menuSection.deleteMany({
        where: { restaurantId: targetRestaurant.id },
      });
    }

    let itemsCopied = 0;
    let sectionsCopied = 0;
    const startingOrder = replaceExisting
      ? 0
      : ((await tx.menuSection.aggregate({
          where: { restaurantId: targetRestaurant.id },
          _max: { displayOrder: true },
        }))._max.displayOrder ?? -1) + 1;

    for (const [index, section] of sourceRestaurant.menuSections.entries()) {
      const result = await cloneLoadedSection(tx, {
        targetRestaurantId: targetRestaurant.id,
        section,
        displayOrder: startingOrder + index,
      });
      itemsCopied += result.itemsCopied;
      sectionsCopied += result.sectionsCopied;
    }

    await tx.menuCloneLog.create({
      data: {
        sourceRestaurantId,
        targetRestaurantId: targetRestaurant.id,
        cloneType: "full_menu",
        itemsCopied,
        sectionsCopied,
      },
    });

    return {
      itemsCopied,
      sectionsCopied,
      replaceExisting,
    };
  });
}
