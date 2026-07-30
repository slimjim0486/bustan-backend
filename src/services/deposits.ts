import type Stripe from "stripe";
import { ApiError } from "@/lib/errors";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/services/stripe";

export interface DepositSessionInput {
  bookingId: string; restaurantId: string; businessName: string; serviceName: string;
  depositAed: number; successUrl: string; cancelUrl: string; nowUnix: number;
}

export function payUrlFor(bookingId: string): string {
  return `${env.FRONTEND_APP_URL.replace(/\/$/, "")}/pay/${bookingId}`;
}

export function buildDepositSessionParams(input: DepositSessionInput): Stripe.Checkout.SessionCreateParams {
  const metadata = { kind: "booking_deposit", bookingId: input.bookingId, restaurantId: input.restaurantId };
  return {
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "aed",
        unit_amount: input.depositAed * 100,
        product_data: { name: `Booking deposit — ${input.serviceName}`, description: input.businessName },
      },
    }],
    metadata,
    payment_intent_data: { metadata },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_at: input.nowUnix + 3600, // 1h; revisiting /pay mints a fresh session
  };
}

export async function getOrCreateDepositCheckout(bookingId: string): Promise<{ checkoutUrl: string }> {
  const stripe = getStripe();
  if (!stripe) throw new ApiError("Payments not configured", 503);
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { restaurant: { select: { name: true } }, service: { select: { name: true } } },
  });
  if (!booking) throw new ApiError("Booking not found", 404);
  if (booking.status !== "INQUIRY" && booking.status !== "DEPOSIT_SENT") {
    throw new ApiError(`Booking is ${booking.status.toLowerCase()}`, 409);
  }
  if (booking.stripeSessionId) {
    const existing = await stripe.checkout.sessions.retrieve(booking.stripeSessionId).catch(() => null);
    if (existing?.status === "open" && existing.url) return { checkoutUrl: existing.url };
  }
  const base = env.FRONTEND_APP_URL.replace(/\/$/, "");
  const session = await stripe.checkout.sessions.create(buildDepositSessionParams({
    bookingId: booking.id, restaurantId: booking.restaurantId,
    businessName: booking.restaurant.name, serviceName: booking.service.name,
    depositAed: booking.depositAed,
    successUrl: `${base}/booking/${booking.id}?paid=1`,
    cancelUrl: `${base}/pay/${booking.id}?cancelled=1`,
    nowUnix: Math.floor(Date.now() / 1000),
  }));
  if (!session.url) throw new ApiError("Stripe session has no URL", 502);
  await prisma.booking.update({ where: { id: booking.id }, data: { stripeSessionId: session.id } });
  return { checkoutUrl: session.url };
}
