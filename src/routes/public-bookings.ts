// Public booking status + checkout endpoints (Phase 4, Task 9).
//
// No auth middleware — access is gated by an unguessable booking ID
// (cuid, 20-32 alphanumeric chars) per spec §4.2, the same shape used for
// the Ad Studio share-token endpoint. Bad-format IDs 404 rather than 400
// so a scanner can't distinguish "wrong shape" from "doesn't exist".
//
// PRIVACY IS THE POINT of serializePublicBooking: the public payload is
// deliberately a strict allow-list. It must never include feeAed (the
// restaurant's commission — none of the customer's business), the
// customer's full name, or their phone number.
//
// Guard note: adStudioPublicRoute does NOT actually use
// `@/lib/public-request-guards` — it hand-rolls its own inline IP rate
// limiter. The genuinely reusable shared helper is `assertRateLimit`
// (also used by owner-chat.ts, support.ts, admin.ts), so that's what we
// apply here. We deliberately skip `assertAllowedPublicOrigin`: this
// booking-status page is opened directly from a WhatsApp link and/or
// server-side rendered by the frontend, so requests legitimately arrive
// with no (or a non-frontend) Origin/Referer header. Enforcing an origin
// allowlist would break that access path without adding real protection,
// since the ID itself is already the unguessable secret.
//
// Two separate rate-limit buckets, each guarding a different threat:
//   1. `public-bookings:<ip>:<bookingId>` (tight, 30/min) — throttles
//      hammering of one already-known booking ID (e.g. a broken poller).
//   2. `public-bookings:ip:<ip>` (loose, 120/min) — the actual defence
//      against ID enumeration/scraping: every guessed ID gets its own
//      bucket-1 key, so bucket 1 alone never engages across many distinct
//      IDs from the same IP. Bucket 2 is IP-wide (no bookingId in the
//      key) so it accumulates across every guess and trips before an
//      enumeration sweep gets far, while staying well above what a single
//      legitimate customer polling status every ~3s (or hitting checkout
//      once) would ever produce.
import { Hono } from "hono";
import { errorResponse } from "@/lib/http";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { assertRateLimit, getClientIp } from "@/lib/public-request-guards";
import { getOrCreateDepositCheckout } from "@/services/deposits";

export const publicBookingsRoute = new Hono();

export const BOOKING_ID_RE = /^[a-z0-9]{20,32}$/i;

const bookingInclude = {
  service: { select: { name: true, durationMinutes: true } },
  restaurant: {
    select: {
      name: true,
      whatsappIntegration: { select: { displayPhoneNumber: true } },
    },
  },
  customer: { select: { displayName: true } },
} as const;

type PublicBookingSource = {
  id: string;
  status: string;
  slotAt: Date;
  depositAed: number;
  service: { name: string; durationMinutes: number };
  restaurant: {
    name: string;
    whatsappIntegration: { displayPhoneNumber: string } | null;
  };
  customer: { displayName: string };
};

export interface PublicBookingPayload {
  id: string;
  status: string;
  slotAt: Date;
  depositAed: number;
  serviceName: string;
  durationMinutes: number;
  businessName: string;
  businessWhatsApp: string | null;
  customerFirstName: string | null;
}

export function serializePublicBooking(booking: PublicBookingSource): PublicBookingPayload {
  const firstName = booking.customer.displayName.trim().split(/\s+/)[0] || null;

  return {
    id: booking.id,
    status: booking.status,
    slotAt: booking.slotAt,
    depositAed: booking.depositAed,
    serviceName: booking.service.name,
    durationMinutes: booking.service.durationMinutes,
    businessName: booking.restaurant.name,
    businessWhatsApp: booking.restaurant.whatsappIntegration?.displayPhoneNumber ?? null,
    customerFirstName: firstName,
  };
}

export function rateLimitKeys(ip: string, bookingId: string) {
  return {
    perBookingKey: `public-bookings:${ip}:${bookingId}`,
    perIpKey: `public-bookings:ip:${ip}`,
  };
}

function rateLimitBookingRequest(c: import("hono").Context, bookingId: string) {
  const { perBookingKey, perIpKey } = rateLimitKeys(getClientIp(c), bookingId);

  // Bucket 1: single-ID hammering guard.
  assertRateLimit({ key: perBookingKey, limit: 30, windowMs: 60_000 });

  // Bucket 2: IP-wide guard — this is the one that actually engages
  // against enumeration, since it has no bookingId in its key.
  assertRateLimit({ key: perIpKey, limit: 120, windowMs: 60_000 });
}

publicBookingsRoute.get("/:bookingId", async (c) => {
  try {
    const bookingId = c.req.param("bookingId");
    if (!BOOKING_ID_RE.test(bookingId)) {
      throw new ApiError("Booking not found", 404);
    }

    rateLimitBookingRequest(c, bookingId);

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: bookingInclude,
    });

    if (!booking) {
      throw new ApiError("Booking not found", 404);
    }

    return c.json(serializePublicBooking(booking));
  } catch (error) {
    return errorResponse(c, error);
  }
});

publicBookingsRoute.post("/:bookingId/checkout", async (c) => {
  try {
    const bookingId = c.req.param("bookingId");
    if (!BOOKING_ID_RE.test(bookingId)) {
      throw new ApiError("Booking not found", 404);
    }

    rateLimitBookingRequest(c, bookingId);

    const result = await getOrCreateDepositCheckout(bookingId);
    return c.json(result);
  } catch (error) {
    return errorResponse(c, error);
  }
});
