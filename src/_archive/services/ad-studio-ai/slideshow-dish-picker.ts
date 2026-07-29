// Shared dish picker for slideshow generation (Sabt Pack slot 1 + ad-hoc
// slideshow campaigns). Picks N menu items with ready images, preferring a
// hinted dish first, then highest-price available items.

import { prisma } from "@/lib/prisma";

export const SLIDESHOW_FRAME_COUNT = 5;

export interface PickSlideshowDishesOptions {
  restaurantId: string;
  /** Ordered list of dish IDs the owner explicitly picked. Frame 1 = index 0,
   *  frame 2 = index 1, etc. IDs that don't match a ready-image menu item
   *  for this restaurant are dropped silently. Empty / undefined = full auto. */
  preferDishIds?: string[];
  /** How many frames to pick. Defaults to SLIDESHOW_FRAME_COUNT. */
  count?: number;
}

/**
 * Pick up to `count` menu items with ready images for the slideshow.
 *
 * Order of preference:
 *   1. Owner-picked dish IDs (in the order they were picked) — these are
 *      validated against the restaurant's ready-image set and dropped if
 *      not eligible.
 *   2. Auto-fill the remaining slots from highest-priced photographed
 *      dishes, skipping any already chosen.
 *
 * Returns fewer than `count` when the restaurant doesn't have enough
 * photographed dishes — caller decides whether that's a degraded path
 * or a hard fail.
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
    take: count + 8,
  });
  const readyIds = new Set(ready.map((r) => r.id));

  const chosen: string[] = [];

  // Honor owner-picked IDs first, in order, dropping any that aren't
  // eligible (deleted, no photo, archived, etc.) or are duplicates.
  for (const id of options.preferDishIds ?? []) {
    if (chosen.length >= count) break;
    if (readyIds.has(id) && !chosen.includes(id)) {
      chosen.push(id);
    }
  }

  // Auto-fill remaining slots from the ready pool, highest-price first.
  for (const r of ready) {
    if (chosen.length >= count) break;
    if (!chosen.includes(r.id)) chosen.push(r.id);
  }
  return chosen;
}
