import type { Prisma } from "@prisma/client";

function getTodayDateOnly(now: Date) {
  const dateOnly = now.toISOString().split("T")[0];
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

export function buildPublicMenuItemWhere(now = new Date()): Prisma.MenuItemWhereInput {
  const today = getTodayDateOnly(now);

  return {
    isAvailable: true,
    OR: [{ soldOutDate: null }, { soldOutDate: { not: today } }],
    AND: [
      {
        OR: [{ specialStartsAt: null }, { specialStartsAt: { lte: now } }],
      },
      {
        OR: [{ specialEndsAt: null }, { specialEndsAt: { gte: now } }],
      },
    ],
  };
}
