// Shared booking-resolution service for the booking loop (Phase 4 / Task 6).
//
// resolveBooking() is the single place that transitions a booking out of
// CONFIRMED into a terminal COMPLETED/NO_SHOW state. Two callers use it:
//   - routes/bookings.ts PATCH /:restaurantId/:bookingId (owner clicks
//     Completed/No-show on the dashboard)
//   - queue/booking-reminders.ts' resolution-prompt worker, via the owner's
//     WhatsApp quick-reply buttons (buildResolutionPayload/parseResolutionPayload)
//
// The transition is race-safe: it uses updateMany keyed on status=CONFIRMED
// so a concurrent resolve (dashboard click racing a WhatsApp button tap)
// can't double-apply. feeAed and isNewCustomer are NEVER touched here — those
// are frozen at confirm time (see services/booking-fees.ts) and must survive
// resolution untouched.
import { prisma } from "@/lib/prisma";

export type ResolutionStatus = "COMPLETED" | "NO_SHOW";

const RESOLUTION_PAYLOAD_PREFIX = "bkres";

export function buildResolutionPayload(bookingId: string, status: ResolutionStatus): string {
  return `${RESOLUTION_PAYLOAD_PREFIX}:${bookingId}:${status}`;
}

export function parseResolutionPayload(
  payload: string
): { bookingId: string; status: ResolutionStatus } | null {
  const parts = payload.split(":");
  if (parts.length !== 3) return null;
  const [prefix, bookingId, status] = parts;
  if (prefix !== RESOLUTION_PAYLOAD_PREFIX) return null;
  if (!bookingId) return null;
  if (status !== "COMPLETED" && status !== "NO_SHOW") return null;
  return { bookingId, status };
}

export async function resolveBooking(input: {
  restaurantId: string;
  bookingId: string;
  status: ResolutionStatus;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await prisma.booking.updateMany({
    where: { id: input.bookingId, restaurantId: input.restaurantId, status: "CONFIRMED" },
    data: { status: input.status, resolvedAt: new Date() },
  });
  if (result.count === 0) {
    return { ok: false, reason: "not_confirmed" };
  }
  return { ok: true };
}
