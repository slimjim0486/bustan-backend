// Weekly Report job for Bustan (on-demand only). Generates an end-of-week
// management review for one restaurant when enqueued explicitly
// (enqueueWeeklyReportForRestaurant). The Monday 07:00 GST cron fanout was
// removed on 2026-09-06. Mirrors owner-whisper.ts.

import Anthropic from "@anthropic-ai/sdk";
import PgBoss from "pg-boss";
import { estimateAiUsageCost, logAiUsage } from "@/lib/ai-usage";
import { FEE_COUNTED_STATUSES, computeNoShowRate } from "@/lib/booking-metrics";
import { env } from "@/lib/env";
import {
  buildWeeklyReportPrompt,
  computeBookingWeeklyTiles,
  parseWeeklyReportResponse,
  type MemoryItem,
  type WeeklyReportSnapshot,
} from "@/lib/owner-chat-prompts";
import { prisma } from "@/lib/prisma";
import { STANDING_INSTRUCTION_TYPE } from "@/lib/standing-instructions";
import { getBoss } from "@/queue/boss";
import { createSousChefMessage } from "@/services/anthropic-models";

export const WEEKLY_REPORT_GENERATE_JOB = "weekly-report-generate";

export const WEEKLY_ELIGIBLE_PLANS = ["pro", "fulltime", "portfolio"] as const;

const RETRY_LIMIT = 1;

let generateQueueReady: Promise<void> | null = null;

async function ensureGenerateQueue() {
  if (!generateQueueReady) {
    generateQueueReady = getBoss()
      .then((queue) => queue.createQueue(WEEKLY_REPORT_GENERATE_JOB))
      .catch((error) => {
        generateQueueReady = null;
        throw error;
      });
  }
  await generateQueueReady;
}

export interface WeeklyReportGenerateJobData {
  restaurantId: string;
  /** ISO date "YYYY-MM-DD" — the Monday (Dubai) that begins the covered week. */
  weekStart: string;
}

type GenerateWorkerJob = PgBoss.JobWithMetadata<WeeklyReportGenerateJobData>;

let anthropic: Anthropic | null = null;
function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "" });
  }
  return anthropic;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/** "YYYY-MM-DD" of the Monday (Dubai) that began the most-recently-completed
 *  week. Dubai is UTC+4 year-round. */
export function lastCompletedWeekStartIso(nowUtcMs: number): string {
  const dubaiNow = new Date(nowUtcMs + 4 * 60 * 60 * 1000);
  const dow = dubaiNow.getUTCDay(); // 0=Sun..6=Sat (in Dubai local terms)
  const daysSinceMonday = (dow + 6) % 7; // Mon->0 .. Sun->6
  // Midnight of the current Dubai week's Monday, then step back a full week.
  const currentWeekMonday = new Date(
    Date.UTC(dubaiNow.getUTCFullYear(), dubaiNow.getUTCMonth(), dubaiNow.getUTCDate())
  );
  currentWeekMonday.setUTCDate(currentWeekMonday.getUTCDate() - daysSinceMonday - 7);
  return currentWeekMonday.toISOString().slice(0, 10);
}

/** The last day (Sunday, Dubai) of a Mon–Sun week that begins on `weekStartIso`,
 *  as "YYYY-MM-DD" = weekStart + 6 days. Pure string-date arithmetic; no TZ round-trip. */
export function weekEndLocalIso(weekStartIso: string): string {
  const d = new Date(`${weekStartIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/** UTC [start, end) covering a Dubai-local week that begins on `weekStartIso`. */
function dubaiWeekToUtcRange(weekStartIso: string): { start: Date; end: Date } {
  // 00:00 Dubai on weekStart = weekStartT00:00:00Z minus 4h.
  const start = new Date(`${weekStartIso}T00:00:00Z`);
  start.setUTCHours(start.getUTCHours() - 4);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

export async function startWeeklyReportWorker() {
  await ensureGenerateQueue();
  const queue = await getBoss();

  await queue.work<WeeklyReportGenerateJobData>(
    WEEKLY_REPORT_GENERATE_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as GenerateWorkerJob[]) {
        try {
          await processGenerateJob(job);
        } catch (error) {
          console.warn(
            `[weekly-report] generate failed for ${job.data.restaurantId} (${job.data.weekStart}):`,
            error
          );
        }
      }
    }
  );
}

async function buildWeeklySnapshot(
  restaurantId: string,
  weekStart: string,
  restaurantName: string
): Promise<WeeklyReportSnapshot> {
  const { start, end } = dubaiWeekToUtcRange(weekStart);
  const prevStart = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekEndIso = weekEndLocalIso(weekStart);

  const billableWhere = (from: Date, to: Date) => ({
    restaurantId,
    isNewCustomer: true,
    status: { in: FEE_COUNTED_STATUSES },
    confirmedAt: { gte: from, lt: to },
  });

  const [
    bookingsThis,
    bookingsLast,
    newAggThis,
    newAggLast,
    completedThis,
    completedLast,
    noShowThis,
    noShowLast,
    pendingReplies,
    topServiceRows,
  ] = await Promise.all([
    prisma.booking.count({ where: { restaurantId, confirmedAt: { gte: start, lt: end } } }),
    prisma.booking.count({ where: { restaurantId, confirmedAt: { gte: prevStart, lt: start } } }),
    prisma.booking.aggregate({
      where: billableWhere(start, end),
      _sum: { feeAed: true },
      _count: true,
    }),
    prisma.booking.aggregate({
      where: billableWhere(prevStart, start),
      _sum: { feeAed: true },
      _count: true,
    }),
    prisma.booking.count({
      where: { restaurantId, status: "COMPLETED", resolvedAt: { gte: start, lt: end } },
    }),
    prisma.booking.count({
      where: { restaurantId, status: "COMPLETED", resolvedAt: { gte: prevStart, lt: start } },
    }),
    prisma.booking.count({
      where: { restaurantId, status: "NO_SHOW", resolvedAt: { gte: start, lt: end } },
    }),
    prisma.booking.count({
      where: { restaurantId, status: "NO_SHOW", resolvedAt: { gte: prevStart, lt: start } },
    }),
    prisma.whatsAppConversation.count({
      where: { restaurantId, unreadCount: { gt: 0 } },
    }),
    prisma.booking.groupBy({
      by: ["serviceId"],
      where: { restaurantId, createdAt: { gte: start, lt: end } },
      _count: { _all: true },
      orderBy: { _count: { serviceId: "desc" } },
      take: 1,
    }),
  ]);

  const topService =
    topServiceRows.length > 0
      ? await prisma.service
          .findUnique({ where: { id: topServiceRows[0].serviceId }, select: { name: true } })
          .then((svc) =>
            svc ? { name: svc.name, bookings: topServiceRows[0]._count._all } : null
          )
      : null;

  const tiles = computeBookingWeeklyTiles({
    newCustomers: { thisWeek: newAggThis._count, lastWeek: newAggLast._count },
    bookings: { thisWeek: bookingsThis, lastWeek: bookingsLast },
    feesAed: { thisWeek: newAggThis._sum.feeAed ?? 0, lastWeek: newAggLast._sum.feeAed ?? 0 },
    noShowRatePct: {
      thisWeek: computeNoShowRate(completedThis, noShowThis) ?? 0,
      lastWeek: computeNoShowRate(completedLast, noShowLast) ?? 0,
    },
  });

  return {
    weekStartLocal: weekStart,
    weekEndLocal: weekEndIso,
    restaurantName,
    tiles,
    topService,
    pendingReplies,
    noShowCount: noShowThis,
    hadActivity: bookingsThis > 0 || newAggThis._count > 0,
  };
}

async function processGenerateJob(job: GenerateWorkerJob) {
  const { restaurantId, weekStart } = job.data;
  const weekStartDate = new Date(weekStart);

  if (!env.ANTHROPIC_API_KEY) {
    console.warn(`[weekly-report] no ANTHROPIC_API_KEY; skipping ${restaurantId}`);
    return;
  }

  const placeholder = await prisma.weeklyReport
    .create({
      data: {
        restaurantId,
        weekStart: weekStartDate,
        narrative: "",
        metricsJson: {},
        actionsJson: [],
        status: "generating",
        costUsd: 0,
      },
      select: { id: true },
    })
    .catch((error) => {
      if (isUniqueConstraintError(error)) return null;
      throw error;
    });

  if (!placeholder) return;

  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true },
    });
    if (!restaurant) {
      await prisma.weeklyReport.delete({ where: { id: placeholder.id } });
      return;
    }

    const [snapshot, memoryRows] = await Promise.all([
      buildWeeklySnapshot(restaurantId, weekStart, restaurant.name),
      prisma.ownerChatMemory.findMany({
        where: {
          restaurantId,
          type: { not: STANDING_INSTRUCTION_TYPE },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: [{ lastReinforced: "desc" }, { confidence: "desc" }],
        take: 10,
        select: { type: true, content: true },
      }),
    ]);

    const memories: MemoryItem[] = memoryRows.map((m) => ({ type: m.type, content: m.content }));
    const prompt = buildWeeklyReportPrompt(snapshot, memories);

    const client = getClient();
    const response = await createSousChefMessage(
      client,
      {
        max_tokens: 700,
        system:
          "You are Bustan writing the Weekly Report. Output ONLY the JSON object described. No prose, no code fences.",
        messages: [{ role: "user", content: prompt }],
      },
      { route: "weekly-report", restaurantId, weekStart }
    );

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const parsed = parseWeeklyReportResponse(text);
    if (!parsed) {
      console.warn(`[weekly-report] unparseable response for ${restaurantId} (${weekStart})`);
      await prisma.weeklyReport.delete({ where: { id: placeholder.id } });
      await logAiUsage(
        restaurantId,
        "owner_chat_weekly",
        response.usage.input_tokens,
        response.usage.output_tokens
      );
      return;
    }

    const costUsd = estimateAiUsageCost(
      "owner_chat_weekly",
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    await prisma.$transaction(async (tx) => {
      await tx.weeklyReport.update({
        where: { id: placeholder.id },
        data: {
          narrative: parsed.narrative,
          metricsJson: JSON.parse(JSON.stringify({ tiles: snapshot.tiles })) as object,
          actionsJson: JSON.parse(JSON.stringify(parsed.actions)) as object,
          status: "unread",
          generatedAt: new Date(),
          costUsd,
        },
      });

      await tx.ownerChatMessage.create({
        data: {
          restaurantId,
          role: "assistant",
          content: parsed.narrative,
          source: "weekly_report",
          weeklyReportId: placeholder.id,
        },
      });
    });

    await logAiUsage(
      restaurantId,
      "owner_chat_weekly",
      response.usage.input_tokens,
      response.usage.output_tokens
    );
  } catch (error) {
    await prisma.weeklyReport.deleteMany({
      where: { id: placeholder.id, status: "generating" },
    });
    throw error;
  }

  console.log(`[weekly-report] ${restaurantId} weekStart=${weekStart} ok`);
}

/** Manual trigger for testing — used by the admin endpoint. */
export async function enqueueWeeklyReportForRestaurant(restaurantId: string, weekStart?: string) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { businessType: true },
  });
  if (!restaurant || !["SALON", "HOME_SERVICES"].includes(restaurant.businessType)) {
    console.warn(
      `[weekly-report] skipping manual enqueue for ${restaurantId}: not a booking-era tenant`
    );
    return;
  }

  await ensureGenerateQueue();
  const queue = await getBoss();
  await queue.send(
    WEEKLY_REPORT_GENERATE_JOB,
    { restaurantId, weekStart: weekStart ?? lastCompletedWeekStartIso(Date.now()) },
    { retryLimit: RETRY_LIMIT }
  );
}
