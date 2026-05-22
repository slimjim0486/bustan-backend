// Shared helper: picks a sensible default "hero dish" for an Ad Studio brief
// when none has been explicitly chosen.
//
// Used by:
//   - The event-calendar auto-stager (so cron-staged drafts arrive with a
//     featured dish, not null — Summer Slump, Mother's Day, weather-trigger
//     pulses, etc. don't have an owner-picked dish).
//   - The hero image generator's last-resort fallback (so a missing dish
//     doesn't take down all 6 variants with the same error).
//
// Selection priority — picks the dish most likely to produce a real, on-brand
// hero image with zero AI calls:
//   1. Available menu item whose primary image is owner-uploaded + ready.
//   2. Available menu item with any ready/generated image (legacy or AI).
//   3. Most-recently-updated available menu item (no photo, but at least the
//      dish name + description seed the AI image prompt sensibly).
//
// Returns null only when the restaurant has zero available menu items.
//
// Tenant isolation: every query is scoped by restaurantId. Callers must pass
// the project's restaurantId — never trust a brief field on its own.

import { prisma } from "@/lib/prisma";

export interface PickedHeroDish {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  imageUrl: string | null;
}

export async function pickHeroDishForRestaurant(
  restaurantId: string
): Promise<PickedHeroDish | null> {
  // 1. Owner-uploaded primary photo wins — highest trust per the KB.
  const ownerUpload = await prisma.menuItem.findFirst({
    where: {
      restaurantId,
      isAvailable: true,
      images: {
        some: {
          isPrimary: true,
          imageStatus: "ready",
          imageUrl: { not: null },
          originType: "owner_upload",
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    select: dishSelect,
  });
  if (ownerUpload) return toPickedDish(ownerUpload);

  // 2. Any ready/generated image (legacy imageUrl or generated primary).
  const anyPhoto = await prisma.menuItem.findFirst({
    where: {
      restaurantId,
      isAvailable: true,
      OR: [
        { imageStatus: "ready" },
        { imageStatus: "generated" },
        {
          images: {
            some: {
              isPrimary: true,
              imageStatus: "ready",
              imageUrl: { not: null },
            },
          },
        },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: dishSelect,
  });
  if (anyPhoto) return toPickedDish(anyPhoto);

  // 3. Any available menu item — no photo, but the name still anchors the
  //    AI prompt so generation produces something better than "generic food".
  const anyAvailable = await prisma.menuItem.findFirst({
    where: { restaurantId, isAvailable: true },
    orderBy: { updatedAt: "desc" },
    select: dishSelect,
  });
  if (anyAvailable) return toPickedDish(anyAvailable);

  return null;
}

const dishSelect = {
  id: true,
  name: true,
  description: true,
  price: true,
  currency: true,
  imageUrl: true,
} as const;

function toPickedDish(item: {
  id: string;
  name: string;
  description: string | null;
  price: { toString(): string } | number;
  currency: string;
  imageUrl: string | null;
}): PickedHeroDish {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    price: Number(item.price),
    currency: item.currency,
    imageUrl: item.imageUrl,
  };
}
