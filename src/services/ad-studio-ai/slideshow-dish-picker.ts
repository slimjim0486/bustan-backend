// Shared dish picker for slideshow generation (Sabt Pack slot 1 + ad-hoc
// slideshow campaigns). Picks N menu items with ready images, preferring a
// hinted dish first, then highest-price available items.

import { prisma } from "@/lib/prisma";

export const SLIDESHOW_FRAME_COUNT = 5;

export interface PickSlideshowDishesOptions {
  restaurantId: string;
  /** Optional dish to anchor as frame 1 when it has a ready image. */
  preferDishId?: string | null;
  /** How many frames to pick. Defaults to SLIDESHOW_FRAME_COUNT. */
  count?: number;
}

/**
 * Pick up to `count` menu items with ready images for the slideshow. Returns
 * fewer than requested when the restaurant doesn't have enough photographed
 * dishes — caller decides whether that's a degraded path or a hard fail.
 */
export async function pickSlideshowDishes(
  options: PickSlideshowDishesOptions
): Promise<string[]> {
  const count = options.count ?? SLIDESHOW_FRAME_COUNT;
  const ready = await prisma.menuItem.findMany({
    where: {
      restaurantId: options.restaurantId,
      isAvailable: true,
      OR: [{ imageStatus: "ready" }, { imageStatus: "generated" }],
    },
    select: { id: true },
    orderBy: [{ price: "desc" }, { displayOrder: "asc" }],
    take: count + 3,
  });

  const chosen: string[] = [];
  const preferDishId = options.preferDishId ?? null;
  if (preferDishId && ready.some((r) => r.id === preferDishId)) {
    chosen.push(preferDishId);
  }
  for (const r of ready) {
    if (chosen.length >= count) break;
    if (!chosen.includes(r.id)) chosen.push(r.id);
  }
  return chosen;
}
