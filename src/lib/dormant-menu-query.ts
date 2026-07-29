import type { Prisma } from "@prisma/client";

// Compatibility query for tenant/profile endpoints that still read dormant
// restaurant-era records. New booking features must not build on this.
export function buildPublicMenuItemWhere(now = new Date()): Prisma.MenuItemWhereInput {
  const dateOnly = now.toISOString().split("T")[0];
  const today = new Date(`${dateOnly}T00:00:00.000Z`);

  return {
    isAvailable: true,
    OR: [{ soldOutDate: null }, { soldOutDate: { not: today } }],
    AND: [
      { OR: [{ specialStartsAt: null }, { specialStartsAt: { lte: now } }] },
      { OR: [{ specialEndsAt: null }, { specialEndsAt: { gte: now } }] },
    ],
  };
}
