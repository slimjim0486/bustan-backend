// Deposit-confirmation webhook (Phase 4 / Task 8) — receives
// `checkout.session.completed` events (relayed via the shared backend
// webhook-sync HMAC signer, same as routes/subscriptions.ts) once a diner
// has paid their booking deposit, and hands off to confirmBookingFromDeposit
// for the actual money-state transition. No auth middleware — verification
// happens explicitly inside the handler, same convention as every other
// public webhook route (clerk-webhooks.ts, coworker-webhooks.ts).
import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { verifyWebhookSyncRequest } from "@/lib/webhook-sync";
import { confirmBookingFromDeposit } from "@/services/booking-confirm";

export const depositWebhookSchema = z.object({
  type: z.enum(["checkout.session.completed", "checkout.session.async_payment_succeeded"]),
  data: z.object({
    eventId: z.string().min(10),
    bookingId: z.string().min(10),
    restaurantId: z.string().min(10),
    stripeSessionId: z.string().min(10),
    paymentIntentId: z.string().min(5),
    paymentStatus: z.literal("paid"),
    amountTotal: z.number().int().nonnegative(),
    currency: z.string().length(3),
  }),
});

export const depositWebhooksRoute = new Hono();

depositWebhooksRoute.post("/deposit", async (c) => {
  try {
    const rawPayload = await c.req.text();
    verifyWebhookSyncRequest({
      payload: rawPayload,
      signatureHeader: c.req.header("x-webhook-signature"),
      timestampHeader: c.req.header("x-webhook-timestamp"),
    });

    let jsonPayload: unknown;
    try {
      jsonPayload = JSON.parse(rawPayload);
    } catch {
      throw new ApiError("Invalid JSON payload", 400);
    }

    const payload = depositWebhookSchema.parse(jsonPayload);

    const result = await confirmBookingFromDeposit({
      eventId: payload.data.eventId,
      bookingId: payload.data.bookingId,
      restaurantId: payload.data.restaurantId,
      stripeSessionId: payload.data.stripeSessionId,
      paymentIntentId: payload.data.paymentIntentId,
      amountTotal: payload.data.amountTotal,
      currency: payload.data.currency,
    });

    return c.json({ outcome: result.outcome });
  } catch (error) {
    return errorResponse(c, error);
  }
});
