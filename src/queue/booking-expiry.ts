// Deposit lifecycle queue for the booking loop (Phase 4 / Task 5).
//
// scheduleDepositLifecycle() is called by whoever sends the DEPOSIT_SENT
// message (Task 4's caller / Task 11's confirm flow lives downstream of it).
// It schedules two independent jobs relative to depositSentAt:
//   - booking-deposit-nudge fires at +5h — a friendly "still holding your
//     slot" nudge with the pay link, in case the diner hasn't confirmed yet.
//   - booking-expiry fires at +6h — if the booking is still DEPOSIT_SENT,
//     expire it. The slot frees automatically: booking-availability only
//     counts DEPOSIT_SENT/CONFIRMED as held.
//
// Both handlers are no-ops unless the booking is still DEPOSIT_SENT at fire
// time (decideExpiryAction/decideNudgeAction). No boss.cancel() anywhere —
// if Task 11's confirm path wins the race, these jobs still fire later, see
// a non-DEPOSIT_SENT status, and silently no-op. The expiry write uses
// updateMany keyed on status so a concurrent confirm can't be clobbered.
//
// Pattern cloned from queue/draft-ship.ts (queue-ready memo, startAfter,
// fire-and-recheck).

import PgBoss from "pg-boss";
import { env } from "@/lib/env";
import { buildBookingTemplateParams, formatSlotGst, renderBookingTemplateBody } from "@/lib/booking-templates";
import { prisma } from "@/lib/prisma";
import { getBoss } from "@/queue/boss";
import { sendBookingTemplate, sendBookingText } from "@/services/booking-messaging";

export const BOOKING_NUDGE_JOB = "booking-deposit-nudge";
export const BOOKING_EXPIRY_JOB = "booking-expiry";

export const DEPOSIT_NUDGE_MS = 5 * 3600_000;
export const DEPOSIT_EXPIRY_MS = 6 * 3600_000;

export interface BookingLifecycleJobData {
  bookingId: string;
}

type LifecycleWorkerJob = PgBoss.JobWithMetadata<BookingLifecycleJobData>;

/** Pure decision: only a still-pending deposit should ever expire. */
export function decideExpiryAction(status: string): "expire" | "skip" {
  return status === "DEPOSIT_SENT" ? "expire" : "skip";
}

/** Pure decision: only a still-pending deposit should ever get the
 *  pre-expiry nudge. */
export function decideNudgeAction(status: string): "nudge" | "skip" {
  return status === "DEPOSIT_SENT" ? "nudge" : "skip";
}

let nudgeQueueReady: Promise<void> | null = null;
let expiryQueueReady: Promise<void> | null = null;

async function ensureNudgeQueue() {
  if (!nudgeQueueReady) {
    nudgeQueueReady = getBoss()
      .then((queue) => queue.createQueue(BOOKING_NUDGE_JOB))
      .catch((error) => {
        nudgeQueueReady = null;
        throw error;
      });
  }
  await nudgeQueueReady;
}

async function ensureExpiryQueue() {
  if (!expiryQueueReady) {
    expiryQueueReady = getBoss()
      .then((queue) => queue.createQueue(BOOKING_EXPIRY_JOB))
      .catch((error) => {
        expiryQueueReady = null;
        throw error;
      });
  }
  await expiryQueueReady;
}

/** Builds the diner-facing pay link for a booking. Duplicated (deliberately)
 *  as a one-liner here — a `payUrlFor` helper lands in `services/deposits`
 *  in a later task; this shape must match it exactly:
 *  `${FRONTEND_APP_URL}/pay/${bookingId}`. */
function payUrlFor(bookingId: string): string {
  return `${env.FRONTEND_APP_URL.replace(/\/$/, "")}/pay/${bookingId}`;
}

/** Schedules the pre-expiry nudge (+5h) and the hard expiry (+6h) relative
 *  to when the deposit request was sent. Called once per DEPOSIT_SENT
 *  transition. */
export async function scheduleDepositLifecycle(bookingId: string, depositSentAt: Date): Promise<void> {
  await Promise.all([ensureNudgeQueue(), ensureExpiryQueue()]);
  const queue = await getBoss();

  await queue.send(
    BOOKING_NUDGE_JOB,
    { bookingId },
    {
      retryLimit: 3,
      startAfter: new Date(depositSentAt.getTime() + DEPOSIT_NUDGE_MS),
    }
  );
  await queue.send(
    BOOKING_EXPIRY_JOB,
    { bookingId },
    {
      retryLimit: 3,
      startAfter: new Date(depositSentAt.getTime() + DEPOSIT_EXPIRY_MS),
    }
  );
}

async function processNudgeJob(job: LifecycleWorkerJob) {
  const { bookingId } = job.data;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { customer: true, service: true, restaurant: true },
  });
  if (!booking) return;
  if (decideNudgeAction(booking.status) === "skip") return;

  const language: "en" | "ar" = booking.customer.preferredLanguage === "ar" ? "ar" : "en";
  const ctx = {
    customerName: booking.customer.displayName,
    businessName: booking.restaurant.name,
    serviceName: booking.service.name,
    slotGstFormatted: formatSlotGst(booking.slotAt, language),
    depositAed: booking.depositAed,
    payUrl: payUrlFor(booking.id),
  };
  const parameters = buildBookingTemplateParams("booking_deposit_nudge", ctx);
  const idempotencyKey = `nudge:${booking.id}`;

  // The deposit-request message was sent in-chat at most 5h ago, so the 24h
  // customer-service window is almost certainly still open — try free-form
  // text first (cheaper, and doesn't require a pre-approved template match).
  const textResult = await sendBookingText({
    restaurantId: booking.restaurantId,
    conversationId: booking.conversationId,
    toPhone: booking.customer.normalizedPhone,
    body: renderBookingTemplateBody("booking_deposit_nudge", language, parameters),
    idempotencyKey,
  });
  if (textResult.sent) return;

  if (textResult.reason !== "window_closed") {
    console.warn(
      `[booking-expiry] nudge text send failed for booking=${booking.id}: ${textResult.reason ?? "unknown"}`
    );
    return;
  }

  const templateResult = await sendBookingTemplate({
    restaurantId: booking.restaurantId,
    conversationId: booking.conversationId,
    toPhone: booking.customer.normalizedPhone,
    templateName: "booking_deposit_nudge",
    language,
    parameters,
    idempotencyKey,
  });
  if (!templateResult.sent) {
    console.warn(
      `[booking-expiry] nudge template send failed for booking=${booking.id}: ${templateResult.reason ?? "unknown"}`
    );
  }
}

async function processExpiryJob(job: LifecycleWorkerJob) {
  const { bookingId } = job.data;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true },
  });
  if (!booking) return;
  if (decideExpiryAction(booking.status) === "skip") return;

  // Race-safe: only flips rows still DEPOSIT_SENT at fire time. If a
  // concurrent confirm already moved the booking to CONFIRMED, this is a
  // silent no-op rather than clobbering that write.
  await prisma.booking.updateMany({
    where: { id: bookingId, status: "DEPOSIT_SENT" },
    data: { status: "EXPIRED", resolvedAt: new Date() },
  });
}

export async function startBookingExpiryWorker() {
  await Promise.all([ensureNudgeQueue(), ensureExpiryQueue()]);
  const queue = await getBoss();

  await queue.work<BookingLifecycleJobData>(
    BOOKING_NUDGE_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as LifecycleWorkerJob[]) {
        try {
          await processNudgeJob(job);
        } catch (error) {
          console.error(
            `[booking-expiry] uncaught nudge failure for booking=${job.data.bookingId}:`,
            error
          );
          throw error;
        }
      }
    }
  );

  await queue.work<BookingLifecycleJobData>(
    BOOKING_EXPIRY_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as LifecycleWorkerJob[]) {
        try {
          await processExpiryJob(job);
        } catch (error) {
          console.error(
            `[booking-expiry] uncaught expiry failure for booking=${job.data.bookingId}:`,
            error
          );
          throw error;
        }
      }
    }
  );
}
