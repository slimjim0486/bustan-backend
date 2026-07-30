import type { BookingStatus, Prisma } from "@prisma/client";
import { ApiError } from "@/lib/errors";

// Billable fee = isNewCustomer && status in this set. A confirmed booking's
// fee stands even on a later no-show (the forfeited deposit compensates the
// owner — contractual, see build-spec §4.4).
export const FEE_COUNTED_STATUSES: BookingStatus[] = [
  "CONFIRMED",
  "COMPLETED",
  "NO_SHOW",
];

export type ResolveTarget = "COMPLETED" | "NO_SHOW";

export function assertStatusTransition(
  current: BookingStatus,
  next: ResolveTarget
): void {
  if (current !== "CONFIRMED") {
    throw new ApiError(`Cannot mark a ${current} booking as ${next}`, 400);
  }
}

export function computeNoShowRate(
  completed: number,
  noShows: number
): number | null {
  const resolved = completed + noShows;
  if (resolved === 0) return null;
  return Math.round((noShows / resolved) * 100);
}

export function buildBookingListWhere(
  restaurantId: string,
  filters: { from?: Date; to?: Date; statuses?: BookingStatus[] }
): Prisma.BookingWhereInput {
  return {
    restaurantId,
    ...(filters.from || filters.to
      ? {
          slotAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lt: filters.to } : {}),
          },
        }
      : {}),
    ...(filters.statuses?.length ? { status: { in: filters.statuses } } : {}),
  };
}
