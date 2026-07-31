// Evening booking day-summary for the owner-side loop (Phase 4 / Task 13).
//
// Cron: 14:00 UTC = 18:00 GST. Fans out over SALON/HOME_SERVICES restaurants
// that have opted into agent autonomy AND have a CoworkerOwner row (i.e. are
// enrolled in Bustan on WhatsApp). Per-tenant job computes today's (GST)
// booking stats with a single `Booking` query and `computeDaySummary`, then
// sends the `booking_owner_day_summary` template — mirroring
// queue/coworker-daily-brief.ts's send shape (always via sendCoworkerTemplate;
// no free-form-text fallback, since this is an unsolicited evening report,
// not a reply inside an open 24h window).
//
// Pattern cloned from queue/weekly-report.ts and queue/coworker-daily-brief.ts
// (fanout job + per-tenant send job, idempotent on a `day-summary:{ownerId}:
// {forDate}` key).

import PgBoss from "pg-boss";
import { findTemplate } from "@/lib/coworker/templates";
import { prisma } from "@/lib/prisma";
import { getBoss } from "@/queue/boss";
import { sendCoworkerTemplate } from "@/services/coworker/sender";

export const BOOKING_DAY_SUMMARY_FANOUT_JOB = "booking-day-summary-fanout";
export const BOOKING_DAY_SUMMARY_SEND_JOB = "booking-day-summary-send";

const RETRY_LIMIT = 1;
const FANOUT_CAP = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
// GST is UTC+4 year-round — same idiom as weeklyPeriodFor in lib/booking-ledger.ts.
const GST_OFFSET_MS = 4 * 60 * 60 * 1000;

const BOOKINGS_TODAY_STATUSES = new Set(["CONFIRMED", "COMPLETED", "NO_SHOW"]);

export interface DaySummaryBookingInput {
  status: string;
  isNewCustomer: boolean;
  depositAed: number;
  slotAt: Date;
  confirmedAt: Date | null;
}

export interface DaySummary {
  bookingsToday: number;
  newCustomers: number;
  depositsAed: number;
  tomorrowConfirmed: number;
}

/** Pure: today's (GST) booking stats + tomorrow's confirmed count.
 *
 *  `dayStartUtc` is today's GST midnight expressed as a UTC instant (see
 *  `gstDayStartUtc`). bookingsToday counts bookings CONFIRMED (confirmedAt
 *  falls in today's GST day) whose CURRENT status is CONFIRMED/COMPLETED/
 *  NO_SHOW (i.e. it isn't counting cancellations); tomorrowConfirmed counts
 *  bookings still CONFIRMED whose slot falls in tomorrow's GST day. */
export function computeDaySummary(
  bookings: DaySummaryBookingInput[],
  dayStartUtc: Date
): DaySummary {
  const dayStartMs = dayStartUtc.getTime();
  const dayEndMs = dayStartMs + DAY_MS;
  const tomorrowStartMs = dayEndMs;
  const tomorrowEndMs = tomorrowStartMs + DAY_MS;

  let bookingsToday = 0;
  let newCustomers = 0;
  let depositsAed = 0;
  let tomorrowConfirmed = 0;

  for (const booking of bookings) {
    const confirmedAtMs = booking.confirmedAt ? booking.confirmedAt.getTime() : null;
    if (
      confirmedAtMs !== null &&
      confirmedAtMs >= dayStartMs &&
      confirmedAtMs < dayEndMs &&
      BOOKINGS_TODAY_STATUSES.has(booking.status)
    ) {
      bookingsToday++;
      if (booking.isNewCustomer) newCustomers++;
      depositsAed += booking.depositAed;
    }

    const slotAtMs = booking.slotAt.getTime();
    if (booking.status === "CONFIRMED" && slotAtMs >= tomorrowStartMs && slotAtMs < tomorrowEndMs) {
      tomorrowConfirmed++;
    }
  }

  return { bookingsToday, newCustomers, depositsAed, tomorrowConfirmed };
}

/** Today's GST midnight, expressed as a UTC instant. Same idiom as
 *  weeklyPeriodFor's dayStart calc in lib/booking-ledger.ts. */
export function gstDayStartUtc(instant: Date): Date {
  const gst = instant.getTime() + GST_OFFSET_MS;
  const dayStartGst = Math.floor(gst / DAY_MS) * DAY_MS;
  return new Date(dayStartGst - GST_OFFSET_MS);
}

/** ISO "YYYY-MM-DD" for today, Dubai-local — used as the idempotency date. */
function gstTodayIso(now: Date = new Date()): string {
  const dubaiNow = new Date(now.getTime() + GST_OFFSET_MS);
  return dubaiNow.toISOString().slice(0, 10);
}

interface SendJobData {
  restaurantId: string;
  /** ISO Asia/Dubai local date this summary covers (always "today" at enqueue time). */
  forDate: string;
}

let fanoutQueueReady: Promise<void> | null = null;
let sendQueueReady: Promise<void> | null = null;

async function ensureFanoutQueue() {
  if (!fanoutQueueReady) {
    fanoutQueueReady = getBoss()
      .then((queue) => queue.createQueue(BOOKING_DAY_SUMMARY_FANOUT_JOB))
      .catch((error) => {
        fanoutQueueReady = null;
        throw error;
      });
  }
  await fanoutQueueReady;
}

async function ensureSendQueue() {
  if (!sendQueueReady) {
    sendQueueReady = getBoss()
      .then((queue) => queue.createQueue(BOOKING_DAY_SUMMARY_SEND_JOB))
      .catch((error) => {
        sendQueueReady = null;
        throw error;
      });
  }
  await sendQueueReady;
}

async function fanOut() {
  const forDate = gstTodayIso();

  const restaurants = await prisma.restaurant.findMany({
    where: {
      businessType: { in: ["SALON", "HOME_SERVICES"] },
      agentAutonomyOptIn: true,
      coworkerOwner: { isNot: null },
    },
    select: { id: true },
    take: FANOUT_CAP,
  });

  await ensureSendQueue();
  const queue = await getBoss();
  let enqueued = 0;
  for (const restaurant of restaurants) {
    await queue.send(
      BOOKING_DAY_SUMMARY_SEND_JOB,
      { restaurantId: restaurant.id, forDate } satisfies SendJobData,
      { retryLimit: RETRY_LIMIT }
    );
    enqueued++;
  }

  console.log(`[booking-day-summary] forDate=${forDate} enqueued=${enqueued}`);
  if (restaurants.length === FANOUT_CAP) {
    console.warn(`[booking-day-summary] fan-out hit cap of ${FANOUT_CAP}`);
  }
}

async function processSendJob(data: SendJobData) {
  const owner = await prisma.coworkerOwner.findUnique({
    where: { restaurantId: data.restaurantId },
    include: {
      restaurant: { select: { id: true, name: true, businessType: true, agentAutonomyOptIn: true } },
    },
  });
  if (!owner) return;
  if (owner.status !== "active") return;
  // Re-check the fanout invariant at fire time — the restaurant may have
  // toggled autonomy off or changed business type since the job was enqueued
  // (same re-check pattern as queue/booking-reminders.ts).
  if (!owner.restaurant.agentAutonomyOptIn) return;
  if (owner.restaurant.businessType !== "SALON" && owner.restaurant.businessType !== "HOME_SERVICES") return;

  const dayStart = gstDayStartUtc(new Date());
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const tomorrowEnd = new Date(dayEnd.getTime() + DAY_MS);

  const bookings = await prisma.booking.findMany({
    where: {
      restaurantId: data.restaurantId,
      OR: [
        {
          confirmedAt: { gte: dayStart, lt: dayEnd },
          status: { in: ["CONFIRMED", "COMPLETED", "NO_SHOW"] },
        },
        { status: "CONFIRMED", slotAt: { gte: dayEnd, lt: tomorrowEnd } },
      ],
    },
    select: { status: true, isNewCustomer: true, depositAed: true, slotAt: true, confirmedAt: true },
  });

  const summary = computeDaySummary(bookings, dayStart);
  if (
    summary.bookingsToday === 0 &&
    summary.newCustomers === 0 &&
    summary.depositsAed === 0 &&
    summary.tomorrowConfirmed === 0
  ) {
    console.log(`[booking-day-summary] ${data.restaurantId} (${data.forDate}) → skipped (all-zero)`);
    return;
  }

  const template = findTemplate("booking_owner_day_summary", owner.locale === "ar" ? "ar" : "en");
  if (!template) {
    console.warn(`[booking-day-summary] no template for locale=${owner.locale}; skipping ${data.restaurantId}`);
    return;
  }

  const variables = [
    owner.restaurant.name,
    String(summary.bookingsToday),
    String(summary.newCustomers),
    String(summary.depositsAed),
    String(summary.tomorrowConfirmed),
  ];

  const outcome = await sendCoworkerTemplate({
    coworkerOwnerId: owner.id,
    restaurantId: data.restaurantId,
    template,
    variables,
    idempotencyKey: `day-summary:${owner.id}:${data.forDate}`,
  });

  console.log(
    `[booking-day-summary] ${data.restaurantId} (${data.forDate}) → ${outcome.status}` +
      (outcome.dryRun ? " [DRY-RUN]" : "") +
      (outcome.errorMessage ? ` — ${outcome.errorMessage}` : "")
  );
}

export async function startBookingDaySummaryWorker() {
  await ensureFanoutQueue();
  await ensureSendQueue();
  const queue = await getBoss();

  await queue.work<SendJobData>(
    BOOKING_DAY_SUMMARY_SEND_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as PgBoss.JobWithMetadata<SendJobData>[]) {
        try {
          await processSendJob(job.data);
        } catch (error) {
          console.warn(
            `[booking-day-summary] send failed for ${job.data.restaurantId} (${job.data.forDate}):`,
            error
          );
        }
      }
    }
  );

  // 14:00 UTC = 18:00 GST.
  await queue.schedule(BOOKING_DAY_SUMMARY_FANOUT_JOB, "0 14 * * *", undefined, { tz: "UTC" });
  await queue.work(BOOKING_DAY_SUMMARY_FANOUT_JOB, async () => {
    await fanOut();
  });
}
