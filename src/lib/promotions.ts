import { buildPublicMenuItemWhere } from "@/lib/dormant-menu-query";

export function buildPromotionInclude(options?: {
  availableOnly?: boolean;
}) {
  return {
    promotions: {
      orderBy: { displayOrder: "asc" as const },
      include: {
        items: {
          orderBy: { displayOrder: "asc" as const },
          ...(options?.availableOnly
            ? {
                where: {
                  menuItem: buildPublicMenuItemWhere(),
                },
              }
            : {}),
          include: {
            menuItem: {
              include: {
                images: {
                  orderBy: { slot: "asc" as const },
                },
                dietaryTags: {
                  include: { tag: true },
                },
              },
            },
          },
        },
      },
    },
  };
}

export function buildLivePromotionWhere(now: Date) {
  return {
    isActive: true,
    AND: [
      {
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      },
      {
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
      },
    ],
  };
}
