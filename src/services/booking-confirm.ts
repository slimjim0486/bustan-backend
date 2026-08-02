// Booking confirmation service (Phase 4 / Task 8) — the money-state
// transition of the whole booking loop. Called from the deposit webhook
// once Stripe reports `checkout.session.completed` with a "paid" status.
//
// The status transition (booking → CONFIRMED) and the weekly payout ledger
// write happen in a single transaction so a crash between the two can never
// leave a confirmed booking with no corresponding ledger entry (or vice
// versa). feeAed/isNewCustomer are FROZEN at booking-creation time (Task 3)
// and are never recomputed here — applyToLedger only reads them.
//
// The transition itself is race-safe via a status-gated updateMany (mirrors
// resolveBooking in booking-resolution.ts): if a concurrent delivery of the
// same webhook (or a retried one) already flipped the booking to CONFIRMED,
// the updateMany's count is 0 and we treat the whole call as already_done —
// critically, we do NOT write the ledger again in that case.
//
// Everything after the transaction (follow-up scheduling, customer/owner
// WhatsApp notifications) is best-effort: the money state is already
// committed, so a notification failure must be caught and logged, never
// thrown — the webhook always acks 200 once the DB transaction succeeds.
import { prisma } from "@/lib/prisma";
import { applyToLedger, weeklyPeriodFor } from "@/lib/booking-ledger";
import { assertPayoutAccrualAllowed } from "@/lib/payout-safety";
import { validateDepositSettlement } from "@/lib/deposit-settlement";
import {
  buildBookingTemplateParams,
  formatSlotGst,
  renderBookingTemplateBody,
} from "@/lib/booking-templates";
import { scheduleBookingFollowups } from "@/queue/booking-reminders";
import { sendBookingTemplate, sendBookingText } from "@/services/booking-messaging";
import { sendCoworkerText } from "@/services/coworker/sender";

export type ConfirmTransition = "confirm" | "already_done" | "reject";

const CONFIRMABLE_STATUSES = new Set(["INQUIRY", "DEPOSIT_SENT", "EXPIRED"]);
const ALREADY_DONE_STATUSES = new Set(["CONFIRMED", "COMPLETED", "NO_SHOW"]);

/** Pure decision fn: what does a paid deposit webhook do to a booking in
 *  this status? EXPIRED still confirms (the pay-after-expiry race — the
 *  deposit was actually taken, so we honor it; parallelCapacity absorbs any
 *  resulting slot conflict). CONFIRMED/COMPLETED/NO_SHOW are idempotent
 *  re-deliveries of a webhook we already processed. Only CANCELLED rejects. */
export function decideConfirmTransition(status: string): ConfirmTransition {
  if (CONFIRMABLE_STATUSES.has(status)) return "confirm";
  if (ALREADY_DONE_STATUSES.has(status)) return "already_done";
  return "reject";
}

interface ConfirmedBookingContext {
  id: string;
  restaurantId: string;
  conversationId: string | null;
  slotAt: Date;
  depositAed: number;
  customer: {
    displayName: string;
    normalizedPhone: string;
    preferredLanguage: string | null;
  };
  service: { name: string };
  restaurant: { name: string };
}

async function runTransition(input: {
  eventId: string;
  bookingId: string;
  restaurantId: string;
  stripeSessionId: string;
  paymentIntentId: string;
  amountTotal: number;
  currency: string;
}): Promise<
  | { outcome: "not_found" | "already_done" | "rejected" }
  | { outcome: "confirmed"; booking: ConfirmedBookingContext }
> {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findFirst({
      where: { id: input.bookingId, restaurantId: input.restaurantId },
      include: {
        customer: { select: { displayName: true, normalizedPhone: true, preferredLanguage: true } },
        service: { select: { name: true } },
        restaurant: { select: { name: true } },
      },
    });
    if (!booking) return { outcome: "not_found" as const };

    const settlementRejection = validateDepositSettlement({
      bookingRestaurantId: booking.restaurantId,
      relayedRestaurantId: input.restaurantId,
      expectedStripeSessionId: booking.stripeSessionId,
      relayedStripeSessionId: input.stripeSessionId,
      depositAed: booking.depositAed,
      amountTotalMinor: input.amountTotal,
      currency: input.currency,
      paymentIntentId: input.paymentIntentId,
    });
    if (settlementRejection) {
      console.error(
        `[booking-confirm] settlement rejected booking=${booking.id} event=${input.eventId} reason=${settlementRejection}`
      );
      return { outcome: "rejected" as const };
    }

    const decision = decideConfirmTransition(booking.status);
    if (decision === "reject") {
      // Minor review fix: a paid deposit landing on a CANCELLED booking is a
      // real anomaly (money moved on a booking the business explicitly
      // killed) — make it visible instead of a silent {outcome:"rejected"}
      // the caller may not surface anywhere.
      console.error(
        `[booking-confirm] rejected: paid deposit webhook for CANCELLED booking=${booking.id} stripeSessionId=${input.stripeSessionId}`
      );
      return { outcome: "rejected" as const };
    }
    if (decision === "already_done") return { outcome: "already_done" as const };

    const updateResult = await tx.booking.updateMany({
      where: { id: booking.id, status: { in: ["INQUIRY", "DEPOSIT_SENT", "EXPIRED"] } },
      data: {
        status: "CONFIRMED",
        confirmedAt: now,
        stripePaymentIntentId: input.paymentIntentId,
        stripeConfirmedEventId: input.eventId,
      },
    });
    if (updateResult.count === 0) {
      // Concurrent delivery already confirmed this booking — do NOT write
      // the ledger again.
      return { outcome: "already_done" as const };
    }

    const period = weeklyPeriodFor(now);
    const delta = applyToLedger({ depositAed: booking.depositAed, feeAed: booking.feeAed });
    const payout = await tx.payoutRecord.upsert({
      where: {
        restaurantId_periodStart_periodEnd: {
          restaurantId: booking.restaurantId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
        },
      },
      create: {
        restaurantId: booking.restaurantId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        depositsCollectedAed: delta.depositsDelta,
        feesKeptAed: delta.feesDelta,
        amountDueAed: delta.dueDelta,
      },
      update: {
        depositsCollectedAed: { increment: delta.depositsDelta },
        feesKeptAed: { increment: delta.feesDelta },
        amountDueAed: { increment: delta.dueDelta },
      },
      select: { id: true, status: true },
    });
    // The upsert is inside this same transaction. If an anomalous PAID row
    // already occupies the week, throwing here rolls back both its attempted
    // increments and the booking confirmation instead of hiding new merchant
    // funds inside a settlement that has already been transferred.
    assertPayoutAccrualAllowed(payout.status);
    await tx.payoutEvent.create({
      data: {
        payoutRecordId: payout.id,
        bookingId: booking.id,
        type: "BOOKING_CONFIRMED",
        depositsDeltaAed: delta.depositsDelta,
        feesDeltaAed: delta.feesDelta,
        amountDueDeltaAed: delta.dueDelta,
      },
    });

    return {
      outcome: "confirmed" as const,
      booking: {
        id: booking.id,
        restaurantId: booking.restaurantId,
        conversationId: booking.conversationId,
        slotAt: booking.slotAt,
        depositAed: booking.depositAed,
        customer: booking.customer,
        service: booking.service,
        restaurant: booking.restaurant,
      },
    };
  });
}

async function notifyCustomer(booking: ConfirmedBookingContext): Promise<void> {
  const language: "en" | "ar" = booking.customer.preferredLanguage === "ar" ? "ar" : "en";
  const parameters = buildBookingTemplateParams("booking_confirmation", {
    customerName: booking.customer.displayName,
    businessName: booking.restaurant.name,
    serviceName: booking.service.name,
    slotGstFormatted: formatSlotGst(booking.slotAt, language),
    depositAed: booking.depositAed,
    payUrl: "",
  });
  const idempotencyKey = `confirm:${booking.id}`;

  const textResult = await sendBookingText({
    restaurantId: booking.restaurantId,
    conversationId: booking.conversationId,
    toPhone: booking.customer.normalizedPhone,
    body: renderBookingTemplateBody("booking_confirmation", language, parameters),
    idempotencyKey,
  });

  if (!textResult.sent && textResult.reason === "window_closed") {
    const templateResult = await sendBookingTemplate({
      restaurantId: booking.restaurantId,
      conversationId: booking.conversationId,
      toPhone: booking.customer.normalizedPhone,
      templateName: "booking_confirmation",
      language,
      parameters,
      idempotencyKey,
    });
    if (!templateResult.sent) {
      console.warn(
        `[booking-confirm] confirmation template send failed for booking=${booking.id}: ${templateResult.reason ?? "unknown"}`
      );
    }
  } else if (!textResult.sent) {
    console.warn(
      `[booking-confirm] confirmation text send failed for booking=${booking.id}: ${textResult.reason ?? "unknown"}`
    );
  }
}

async function notifyOwner(booking: ConfirmedBookingContext): Promise<void> {
  const owner = await prisma.coworkerOwner.findUnique({ where: { restaurantId: booking.restaurantId } });
  if (owner) {
    const body = `✅ New confirmed booking: ${booking.customer.displayName} — ${booking.service.name}, ${formatSlotGst(booking.slotAt)}. Deposit AED ${booking.depositAed} received.`;
    const result = await sendCoworkerText({
      coworkerOwnerId: owner.id,
      restaurantId: booking.restaurantId,
      body,
    });
    if (result.status === "failed") {
      console.warn(
        `[booking-confirm] owner notify failed for booking=${booking.id}: ${result.errorMessage ?? "unknown"}`
      );
    }
  }

  if (booking.conversationId) {
    await prisma.whatsAppConversation.update({
      where: { id: booking.conversationId },
      data: { unreadCount: { increment: 1 } },
    });
  }
}

export async function confirmBookingFromDeposit(input: {
  eventId: string;
  bookingId: string;
  restaurantId: string;
  stripeSessionId: string;
  paymentIntentId: string;
  amountTotal: number;
  currency: string;
}): Promise<{ outcome: "confirmed" | "already_done" | "rejected" | "not_found" }> {
  const result = await runTransition(input);

  if (result.outcome !== "confirmed") {
    return { outcome: result.outcome };
  }

  const { booking } = result;

  // Money state is already committed — every failure below is caught and
  // logged, never thrown, so the webhook can still ack 200.
  try {
    await scheduleBookingFollowups({ id: booking.id, slotAt: booking.slotAt });
  } catch (error) {
    console.error(`[booking-confirm] scheduleBookingFollowups failed for booking=${booking.id}:`, error);
  }

  try {
    await notifyCustomer(booking);
  } catch (error) {
    console.error(`[booking-confirm] notifyCustomer failed for booking=${booking.id}:`, error);
  }

  try {
    await notifyOwner(booking);
  } catch (error) {
    console.error(`[booking-confirm] notifyOwner failed for booking=${booking.id}:`, error);
  }

  return { outcome: "confirmed" };
}
