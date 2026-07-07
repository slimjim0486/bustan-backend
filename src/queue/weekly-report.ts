// Weekly Report job for Bustan. Generates an end-of-week management review for
// every active paid-role restaurant every Monday. Cron: 03:00 UTC Monday = 07:00 GST.
// Mirrors owner-whisper.ts.

import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import PgBoss from "pg-boss";
import { estimateAiUsageCost, logAiUsage } from "@/lib/ai-usage";
import { env } from "@/lib/env";
import {
  buildWeeklyReportPrompt,
  computeWeeklyTiles,
  parseWeeklyReportResponse,
  type MemoryItem,
  type WeeklyReportSnapshot,
} from "@/lib/owner-chat-prompts";
import { prisma } from "@/lib/prisma";
import { STANDING_INSTRUCTION_TYPE } from "@/lib/standing-instructions";
import { getBoss } from "@/queue/image-generation";
import { createSousChefMessage } from "@/services/anthropic-models";

export const WEEKLY_REPORT_FANOUT_JOB = "weekly-report-fanout";
export const WEEKLY_REPORT_GENERATE_JOB = "weekly-report-generate";

export const WEEKLY_ELIGIBLE_PLANS = ["pro", "fulltime", "portfolio"] as const;

const RETRY_LIMIT = 1;
const FANOUT_RESTAURANT_CAP = 1000;

let fanoutQueueReady: Promise<void> | null = null;
let generateQueueReady: Promise<void> | null = null;

async function ensureFanoutQueue() {
  if (!fanoutQueueReady) {
    fanoutQueueReady = getBoss()
      .then((queue) => queue.createQueue(WEEKLY_REPORT_FANOUT_JOB))
      .catch((error) => {
        fanoutQueueReady = null;
        throw error;
      });
  }
  await fanoutQueueReady;
}

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
  await ensureFanoutQueue();
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

  // Monday 03:00 UTC (= 07:00 GST).
  await queue.schedule(WEEKLY_REPORT_FANOUT_JOB, "0 3 * * 1", undefined, { tz: "UTC" });
  await queue.work(WEEKLY_REPORT_FANOUT_JOB, async () => {
    await fanOutWeeklyReportJobs();
  });
}

async function fanOutWeeklyReportJobs() {
  const weekStart = lastCompletedWeekStartIso(Date.now());
  const weekStartDate = new Date(weekStart);

  const candidates = await prisma.restaurant.findMany({
    where: {
      subscriptionStatus: { in: ["active", "trial"] },
      weeklyReports: { none: { weekStart: weekStartDate } },
      OR: [
        {
          subscription: {
            is: {
              plan: { in: [...WEEKLY_ELIGIBLE_PLANS] },
              status: { in: ["active", "trial"] },
            },
          },
        },
        { operatorAccount: { is: { status: { in: ["active", "trial"] } } } },
      ],
    },
    select: { id: true },
    take: FANOUT_RESTAURANT_CAP,
  });

  await ensureGenerateQueue();
  const queue = await getBoss();
  let enqueued = 0;
  for (const r of candidates) {
    await queue.send(
      WEEKLY_REPORT_GENERATE_JOB,
      { restaurantId: r.id, weekStart },
      { retryLimit: RETRY_LIMIT }
    );
    enqueued++;
  }
  console.log(`[weekly-report] weekStart=${weekStart} enqueued=${enqueued}`);
  if (candidates.length === FANOUT_RESTAURANT_CAP) {
    console.warn(`[weekly-report] fan-out hit cap of ${FANOUT_RESTAURANT_CAP} — consider raising`);
  }
}

async function buildWeeklySnapshot(
  restaurantId: string,
  weekStart: string,
  restaurantName: string
): Promise<WeeklyReportSnapshot> {
  const { start, end } = dubaiWeekToUtcRange(weekStart);
  const prevStart = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekEndIso = weekEndLocalIso(weekStart);

  const scanCount = (from: Date, to: Date) =>
    prisma.pageView.count({ where: { restaurantId, createdAt: { gte: from, lt: to } } });
  const orderAgg = (from: Date, to: Date) =>
    prisma.orderIntent.aggregate({
      where: { restaurantId, createdAt: { gte: from, lt: to } },
      _sum: { totalPrice: true },
      _count: true,
    });
  const waClicks = (from: Date, to: Date) =>
    prisma.whatsAppClick.count({ where: { restaurantId, createdAt: { gte: from, lt: to } } });

  const [
    scansThis,
    scansLast,
    ordersThis,
    ordersLast,
    waThis,
    waLast,
    pendingReplies,
    topLikedRows,
    topViewed,
    itemsMissingImages,
    itemsMissingDescriptions,
  ] = await Promise.all([
    scanCount(start, end),
    scanCount(prevStart, start),
    orderAgg(start, end),
    orderAgg(prevStart, start),
    waClicks(start, end),
    waClicks(prevStart, start),
    prisma.whatsAppConversation.count({
      where: { restaurantId, unreadCount: { gt: 0 } },
    }),
    prisma.menuItemLike.groupBy({
      by: ["menuItemId"],
      where: { menuItem: { restaurantId }, createdAt: { gte: start, lt: end } },
      _count: true,
      orderBy: { _count: { menuItemId: "desc" } },
      take: 1,
    }),
    prisma.pageView
      .groupBy({
        by: ["path"],
        where: { restaurantId, createdAt: { gte: start, lt: end } },
        _count: { _all: true },
        orderBy: { _count: { path: "desc" } },
        take: 1,
      })
      .then((rows) =>
        rows.length > 0 ? { path: rows[0].path, views: rows[0]._count._all } : null
      ),
    prisma.menuItem.count({ where: { restaurantId, imageUrl: null } }),
    prisma.menuItem.count({
      where: { restaurantId, OR: [{ description: null }, { description: "" }] },
    }),
  ]);

  const topLikedItem =
    topLikedRows.length > 0
      ? await prisma.menuItem
          .findUnique({ where: { id: topLikedRows[0].menuItemId }, select: { name: true } })
          .then((item) => (item ? { name: item.name, likes: topLikedRows[0]._count } : null))
      : null;

  const revenueThis = Number((ordersThis._sum.totalPrice as Prisma.Decimal | null) ?? 0);
  const revenueLast = Number((ordersLast._sum.totalPrice as Prisma.Decimal | null) ?? 0);

  const tiles = computeWeeklyTiles({
    scans: { thisWeek: scansThis, lastWeek: scansLast },
    revenueAed: { thisWeek: Math.round(revenueThis), lastWeek: Math.round(revenueLast) },
    orders: { thisWeek: ordersThis._count, lastWeek: ordersLast._count },
    whatsappClicks: { thisWeek: waThis, lastWeek: waLast },
  });

  return {
    weekStartLocal: weekStart,
    weekEndLocal: weekEndIso,
    restaurantName,
    tiles,
    topLikedItem,
    topViewedPath: topViewed,
    pendingReplies,
    menuHealth: { itemsMissingImages, itemsMissingDescriptions },
    hadTraffic: scansThis > 0 || ordersThis._count > 0,
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
  await ensureGenerateQueue();
  const queue = await getBoss();
  await queue.send(
    WEEKLY_REPORT_GENERATE_JOB,
    { restaurantId, weekStart: weekStart ?? lastCompletedWeekStartIso(Date.now()) },
    { retryLimit: RETRY_LIMIT }
  );
}
