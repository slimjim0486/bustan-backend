// Reminder + post-slot resolution-prompt queue for the booking loop
// (Phase 4 / Task 6).
//
// scheduleBookingFollowups() is called once a booking is CONFIRMED (Task 9's
// confirm flow). It enqueues up to three jobs relative to the booking's
// slotAt:
//   - booking-reminder {kind:"T24H"} at slotAt-24h — skipped if already past
//   - booking-reminder {kind:"T2H"} at slotAt-2h — skipped if already past
//   - booking-resolution-prompt at slotAt+90min — asks the owner (via
//     WhatsApp quick-reply buttons on Bustan's coworker WABA) whether the
//     diner showed, so the booking can move out of CONFIRMED without the
//     owner having to open the dashboard.
//
// Every handler re-checks the booking at fire time and no-ops unless it is
// still CONFIRMED AND booking.slotAt still matches the slotAtIso the job was
// scheduled against — if the booking got rescheduled (slotAt changed) after
// this job was enqueued, the stale job silently skips; the reschedule flow
// (a later task) is responsible for calling scheduleBookingFollowups() again
// against the new slot.
//
// Pattern cloned from queue/booking-expiry.ts (queue-ready memo per queue,
// fire-and-recheck, no boss.cancel() anywhere).
import PgBoss from "pg-boss";
import { buildBookingTemplateParams, formatSlotGst } from "@/lib/booking-templates";
import { prisma } from "@/lib/prisma";
import { getBoss } from "@/queue/boss";
import { sendBookingTemplate } from "@/services/booking-messaging";
import { buildResolutionPayload } from "@/services/booking-resolution";
import { sendCoworkerButtons } from "@/services/coworker/sender";

export const BOOKING_REMINDER_JOB = "booking-reminder";
export const BOOKING_RESOLUTION_PROMPT_JOB = "booking-resolution-prompt";

/** Post-slot delay before the owner is asked to resolve the booking. */
export const RESOLUTION_PROMPT_DELAY_MS = 90 * 60_000;

const REMINDER_24H_MS = 24 * 3600_000;
const REMINDER_2H_MS = 2 * 3600_000;

export type ReminderKind = "T24H" | "T2H";

export interface BookingReminderJobData {
  bookingId: string;
  kind: ReminderKind;
  slotAtIso: string;
}

export interface BookingResolutionPromptJobData {
  bookingId: string;
  slotAtIso: string;
}

type ReminderWorkerJob = PgBoss.JobWithMetadata<BookingReminderJobData>;
type ResolutionPromptWorkerJob = PgBoss.JobWithMetadata<BookingResolutionPromptJobData>;

/** Pure: which reminders are still ahead of `now`, and when they fire.
 *  A reminder whose fire time has already passed is dropped rather than
 *  fired late (e.g. a booking confirmed inside its own 24h/2h window). */
export function computeReminderSchedule(
  slotAt: Date,
  now: Date
): Array<{ kind: ReminderKind; at: Date }> {
  return [
    { kind: "T24H" as const, at: new Date(slotAt.getTime() - REMINDER_24H_MS) },
    { kind: "T2H" as const, at: new Date(slotAt.getTime() - REMINDER_2H_MS) },
  ].filter((x) => x.at > now);
}

let reminderQueueReady: Promise<void> | null = null;
let resolutionPromptQueueReady: Promise<void> | null = null;

async function ensureReminderQueue() {
  if (!reminderQueueReady) {
    reminderQueueReady = getBoss()
      .then((queue) => queue.createQueue(BOOKING_REMINDER_JOB))
      .catch((error) => {
        reminderQueueReady = null;
        throw error;
      });
  }
  await reminderQueueReady;
}

async function ensureResolutionPromptQueue() {
  if (!resolutionPromptQueueReady) {
    resolutionPromptQueueReady = getBoss()
      .then((queue) => queue.createQueue(BOOKING_RESOLUTION_PROMPT_JOB))
      .catch((error) => {
        resolutionPromptQueueReady = null;
        throw error;
      });
  }
  await resolutionPromptQueueReady;
}

/** Schedules T-24h/T-2h reminders (whichever are still ahead of `now`) and
 *  the post-slot resolution prompt for a freshly-confirmed booking. */
export async function scheduleBookingFollowups(
  booking: { id: string; slotAt: Date },
  now: Date = new Date()
): Promise<void> {
  await Promise.all([ensureReminderQueue(), ensureResolutionPromptQueue()]);
  const queue = await getBoss();

  const slotAtIso = booking.slotAt.toISOString();
  const reminders = computeReminderSchedule(booking.slotAt, now);
  for (const reminder of reminders) {
    await queue.send(
      BOOKING_REMINDER_JOB,
      { bookingId: booking.id, kind: reminder.kind, slotAtIso },
      { retryLimit: 3, startAfter: reminder.at }
    );
  }

  await queue.send(
    BOOKING_RESOLUTION_PROMPT_JOB,
    { bookingId: booking.id, slotAtIso },
    {
      retryLimit: 3,
      startAfter: new Date(booking.slotAt.getTime() + RESOLUTION_PROMPT_DELAY_MS),
    }
  );
}

async function processReminderJob(job: ReminderWorkerJob) {
  const { bookingId, kind, slotAtIso } = job.data;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { customer: true, service: true, restaurant: true },
  });
  if (!booking) return;
  if (booking.status !== "CONFIRMED") return;
  if (booking.slotAt.toISOString() !== slotAtIso) return; // rescheduled since this job was enqueued

  const language: "en" | "ar" = booking.customer.preferredLanguage === "ar" ? "ar" : "en";
  const templateName = kind === "T24H" ? "booking_reminder_24h" : "booking_reminder_2h";
  const parameters = buildBookingTemplateParams(templateName, {
    customerName: booking.customer.displayName,
    businessName: booking.restaurant.name,
    serviceName: booking.service.name,
    slotGstFormatted: formatSlotGst(booking.slotAt, language),
    depositAed: booking.depositAed,
    payUrl: "",
  });

  const result = await sendBookingTemplate({
    restaurantId: booking.restaurantId,
    conversationId: booking.conversationId,
    toPhone: booking.customer.normalizedPhone,
    templateName,
    language,
    parameters,
    idempotencyKey: `rem:${kind}:${booking.id}`,
  });
  if (!result.sent) {
    console.warn(
      `[booking-reminders] ${kind} reminder send failed for booking=${booking.id}: ${result.reason ?? "unknown"}`
    );
  }
}

async function processResolutionPromptJob(job: ResolutionPromptWorkerJob) {
  const { bookingId, slotAtIso } = job.data;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { customer: true, service: true, restaurant: true },
  });
  if (!booking) return;
  if (booking.status !== "CONFIRMED") return;
  if (booking.slotAt.toISOString() !== slotAtIso) return; // rescheduled since this job was enqueued

  const owner = await prisma.coworkerOwner.findUnique({
    where: { restaurantId: booking.restaurantId },
  });
  // No CoworkerOwner row (owner never onboarded to the coworker WABA) or an
  // expired 24h window means we can't send a free-form buttons message —
  // skip silently. The dashboard's Complete/No-show buttons are the fallback.
  if (!owner) return;
  if (!owner.windowExpiresAt || owner.windowExpiresAt < new Date()) return;

  const body = `Did ${booking.customer.displayName} show for ${booking.service.name} at ${formatSlotGst(booking.slotAt)}?`;
  const result = await sendCoworkerButtons({
    coworkerOwnerId: owner.id,
    restaurantId: booking.restaurantId,
    body,
    buttons: [
      { id: buildResolutionPayload(booking.id, "COMPLETED"), title: "Showed ✓" },
      { id: buildResolutionPayload(booking.id, "NO_SHOW"), title: "No-show" },
    ],
  });
  if (result.status === "failed") {
    console.warn(
      `[booking-reminders] resolution prompt failed for booking=${booking.id}: ${result.errorMessage ?? "unknown"}`
    );
  }
}

export async function startBookingRemindersWorker() {
  await Promise.all([ensureReminderQueue(), ensureResolutionPromptQueue()]);
  const queue = await getBoss();

  // Review fix (Important 3b): batchSize:1, not 4. pg-boss's Manager#watch
  // calls the handler once with the whole fetched batch and, on a rejected
  // promise, fails EVERY jobId in that batch (see manager.js's onFetch) — not
  // just the one whose iteration threw. With batchSize 4 and this throwing
  // per-job loop, a reminder that already sent successfully in slot 1 could
  // be marked failed and retried (re-sending the customer's reminder) purely
  // because slot 2's job threw. batchSize:1 makes each fetch/complete/fail
  // cycle cover exactly one job. sendBookingTemplate's idempotencyKey
  // pre-check (Important 3a) is the second, independent backstop.
  await queue.work<BookingReminderJobData>(
    BOOKING_REMINDER_JOB,
    { batchSize: 1, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as ReminderWorkerJob[]) {
        try {
          await processReminderJob(job);
        } catch (error) {
          console.error(
            `[booking-reminders] uncaught reminder failure for booking=${job.data.bookingId}:`,
            error
          );
          throw error;
        }
      }
    }
  );

  // Same reasoning as above — sendCoworkerButtons is a customer/owner-facing
  // send that must not be replayed just because a batch-sibling job failed.
  await queue.work<BookingResolutionPromptJobData>(
    BOOKING_RESOLUTION_PROMPT_JOB,
    { batchSize: 1, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as ResolutionPromptWorkerJob[]) {
        try {
          await processResolutionPromptJob(job);
        } catch (error) {
          console.error(
            `[booking-reminders] uncaught resolution-prompt failure for booking=${job.data.bookingId}:`,
            error
          );
          throw error;
        }
      }
    }
  );
}
