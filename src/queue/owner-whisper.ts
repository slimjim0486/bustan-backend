// Daily Owner's Whisper job for Sous Chef.
// Generates a 5-line morning briefing for every active paid-role restaurant.
// Cron: 03:00 UTC = 07:00 GST. Mirrors ad-studio-jobs.ts pattern.

import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import PgBoss from "pg-boss";
import { estimateAiUsageCost, logAiUsage } from "@/lib/ai-usage";
import { env } from "@/lib/env";
import {
  buildWhisperPrompt,
  type MemoryItem,
  type WhisperSnapshot,
} from "@/lib/owner-chat-prompts";
import { prisma } from "@/lib/prisma";
import { STANDING_INSTRUCTION_TYPE } from "@/lib/standing-instructions";
import { getBoss } from "@/queue/boss";
import { WEEKLY_ELIGIBLE_PLANS } from "@/queue/weekly-report";
import { createSousChefMessage } from "@/services/anthropic-models";

export const OWNER_WHISPER_FANOUT_JOB = "owner-whisper-fanout";
export const OWNER_WHISPER_GENERATE_JOB = "owner-whisper-generate";

const RETRY_LIMIT = 1;
const FANOUT_RESTAURANT_CAP = 1000;

let fanoutQueueReady: Promise<void> | null = null;
let generateQueueReady: Promise<void> | null = null;

async function ensureFanoutQueue() {
  if (!fanoutQueueReady) {
    fanoutQueueReady = getBoss()
      .then((queue) => queue.createQueue(OWNER_WHISPER_FANOUT_JOB))
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
      .then((queue) => queue.createQueue(OWNER_WHISPER_GENERATE_JOB))
      .catch((error) => {
        generateQueueReady = null;
        throw error;
      });
  }
  await generateQueueReady;
}

export interface OwnerWhisperGenerateJobData {
  restaurantId: string;
  /** ISO date string "YYYY-MM-DD" — the UAE local date the briefing covers
   *  (typically yesterday). Provided so the cron and the manual test endpoint
   *  agree on the target date. */
  forDate: string;
}

type GenerateWorkerJob = PgBoss.JobWithMetadata<OwnerWhisperGenerateJobData>;

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

export async function startOwnerWhisperWorker() {
  await ensureFanoutQueue();
  await ensureGenerateQueue();
  const queue = await getBoss();

  await queue.work<OwnerWhisperGenerateJobData>(
    OWNER_WHISPER_GENERATE_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as GenerateWorkerJob[]) {
        try {
          await processGenerateJob(job);
        } catch (error) {
          console.warn(
            `[owner-whisper] generate failed for ${job.data.restaurantId} (${job.data.forDate}):`,
            error
          );
          // One bad restaurant must not cascade
        }
      }
    }
  );

  // Daily at 03:00 UTC (= 07:00 GST). Land before UAE morning shift starts.
  await queue.schedule(OWNER_WHISPER_FANOUT_JOB, "0 3 * * *", undefined, {
    tz: "UTC",
  });
  await queue.work(OWNER_WHISPER_FANOUT_JOB, async () => {
    await fanOutWhisperJobs();
  });
}

/** Returns "YYYY-MM-DD" for "yesterday" in Asia/Dubai (UTC+4, no DST). */
function uaeYesterdayIso(): string {
  // Dubai is UTC+4 year-round. We construct "now in Dubai", subtract a day,
  // then read the date part. Robust against DST issues elsewhere.
  const nowUtcMs = Date.now();
  const dubaiNow = new Date(nowUtcMs + 4 * 60 * 60 * 1000);
  const yesterday = new Date(dubaiNow.getTime() - 24 * 60 * 60 * 1000);
  return yesterday.toISOString().slice(0, 10);
}

/** True when the current instant is a Monday in Asia/Dubai (UTC+4). Weekly
 *  reports fire Monday and replace that morning's daily whisper for
 *  weekly-eligible restaurants. */
export function isDubaiMonday(nowUtcMs: number): boolean {
  return new Date(nowUtcMs + 4 * 60 * 60 * 1000).getUTCDay() === 1;
}

/** Convert a "YYYY-MM-DD" Dubai-local date into the UTC [start, end) range
 *  that covers that day in Dubai (UTC+4). */
function dubaiDateToUtcRange(isoDate: string): { start: Date; end: Date } {
  // 00:00 Dubai = (date)T00:00:00+04:00 = (date)T-04:00 UTC the previous day
  // Easier: subtract 4 hours from "isoDate 00:00:00Z" to get the UTC moment.
  const startUtc = new Date(`${isoDate}T00:00:00Z`);
  startUtc.setUTCHours(startUtc.getUTCHours() - 4);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { start: startUtc, end: endUtc };
}

async function fanOutWhisperJobs() {
  const forDate = uaeYesterdayIso();
  const whisperDate = new Date(forDate);
  const suppressForWeekly = isDubaiMonday(Date.now());

  // Find every restaurant on Pro/Portfolio that doesn't already have a whisper
  // for this date. We don't filter for "had traffic" — quiet-day whispers are
  // still useful (menu-health nudge).
  const candidates = await prisma.restaurant.findMany({
    where: {
      subscriptionStatus: { in: ["active", "trial"] },
      ownerWhispers: { none: { forDate: whisperDate } },
      // On Mondays, weekly-eligible restaurants get the weekly report instead
      // of the daily whisper — exclude them so there is exactly one morning
      // moment. (Known edge: operator-account restaurants have no
      // subscription.plan, so this NOT clause doesn't exclude them — see
      // commit body.)
      ...(suppressForWeekly
        ? {
            NOT: {
              subscription: {
                is: {
                  plan: { in: [...WEEKLY_ELIGIBLE_PLANS] },
                  status: { in: ["active", "trial"] },
                },
              },
            },
          }
        : {}),
      OR: [
        {
          subscription: {
            is: {
              plan: { in: ["pro", "fulltime", "portfolio"] },
              status: { in: ["active", "trial"] },
            },
          },
        },
        {
          operatorAccount: {
            is: {
              status: { in: ["active", "trial"] },
            },
          },
        },
      ],
    },
    select: { id: true },
    take: FANOUT_RESTAURANT_CAP,
  });

  let enqueued = 0;

  await ensureGenerateQueue();
  const queue = await getBoss();

  for (const r of candidates) {
    await queue.send(
      OWNER_WHISPER_GENERATE_JOB,
      { restaurantId: r.id, forDate },
      { retryLimit: RETRY_LIMIT }
    );
    enqueued++;
  }

  console.log(`[owner-whisper] forDate=${forDate} enqueued=${enqueued}`);
  if (candidates.length === FANOUT_RESTAURANT_CAP) {
    console.warn(
      `[owner-whisper] fan-out hit cap of ${FANOUT_RESTAURANT_CAP} — consider raising`
    );
  }
}

async function buildSnapshot(restaurantId: string, forDate: string): Promise<WhisperSnapshot> {
  const { start, end } = dubaiDateToUtcRange(forDate);
  const sevenDaysAgo = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);

  const sameWeekdayCutoff = new Date(start.getTime() - 28 * 24 * 60 * 60 * 1000);
  const dubaiWeekday = (date: Date) => {
    const dubai = new Date(date.getTime() + 4 * 60 * 60 * 1000);
    return dubai.getUTCDay();
  };
  const targetWeekday = dubaiWeekday(start);

  const [
    scansYesterday,
    revenueYesterday,
    ordersYesterday,
    waClicksYesterday,
    waCartOrdersYesterday,
    pendingReplies,
    topLiked,
    topViewed,
    menuItems,
    itemsMissingImages,
    itemsMissingDescriptions,
    totalDietaryTaggedItems,
    sameWeekdayScanRows,
    sameWeekdayRevenueRows,
  ] = await Promise.all([
    prisma.pageView.count({ where: { restaurantId, createdAt: { gte: start, lt: end } } }),
    prisma.orderIntent.aggregate({
      where: { restaurantId, createdAt: { gte: start, lt: end } },
      _sum: { totalPrice: true },
    }),
    prisma.orderIntent.count({ where: { restaurantId, createdAt: { gte: start, lt: end } } }),
    prisma.whatsAppClick.count({
      where: { restaurantId, createdAt: { gte: start, lt: end } },
    }),
    prisma.whatsAppCartOrder.count({
      where: { restaurantId, createdAt: { gte: start, lt: end } },
    }),
    prisma.whatsAppConversation.count({
      where: {
        restaurantId,
        unreadCount: { gt: 0 },
        lastMessageAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.menuItemLike
      .groupBy({
        by: ["menuItemId"],
        where: { menuItem: { restaurantId }, createdAt: { gte: sevenDaysAgo } },
        _count: true,
        orderBy: { _count: { menuItemId: "desc" } },
        take: 1,
      })
      .then(async (rows) => {
        if (rows.length === 0) return null;
        const item = await prisma.menuItem.findUnique({
          where: { id: rows[0].menuItemId },
          select: { name: true },
        });
        return item ? { name: item.name, likes: rows[0]._count } : null;
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
    prisma.menuItem.count({ where: { restaurantId } }),
    prisma.menuItem.count({ where: { restaurantId, imageUrl: null } }),
    prisma.menuItem.count({
      where: {
        restaurantId,
        OR: [{ description: null }, { description: "" }],
      },
    }),
    prisma.menuItem.count({
      where: {
        restaurantId,
        dietaryTags: { some: {} },
      },
    }),
    prisma.$queryRaw<Array<{ local_day: Date; scans: bigint }>>`
      SELECT
        date_trunc('day', "created_at" + interval '4 hours') AS local_day,
        count(*)::bigint AS scans
      FROM "page_views"
      WHERE "restaurant_id" = ${restaurantId}
        AND "created_at" >= ${sameWeekdayCutoff}
        AND "created_at" < ${start}
        AND EXTRACT(DOW FROM ("created_at" + interval '4 hours')) = ${targetWeekday}
      GROUP BY local_day
    `,
    prisma.$queryRaw<Array<{ local_day: Date; revenue: Prisma.Decimal | number | string }>>`
      SELECT
        date_trunc('day', "created_at" + interval '4 hours') AS local_day,
        COALESCE(sum("total_price"), 0) AS revenue
      FROM "order_intents"
      WHERE "restaurant_id" = ${restaurantId}
        AND "created_at" >= ${sameWeekdayCutoff}
        AND "created_at" < ${start}
        AND EXTRACT(DOW FROM ("created_at" + interval '4 hours')) = ${targetWeekday}
      GROUP BY local_day
    `,
  ]);

  const weekdayScanAvg =
    sameWeekdayScanRows.length > 0
      ? Math.round(
          sameWeekdayScanRows.reduce((sum, row) => sum + Number(row.scans), 0) /
            sameWeekdayScanRows.length
        )
      : null;

  const weekdayRevenueAvg =
    sameWeekdayRevenueRows.length > 0
      ? sameWeekdayRevenueRows.reduce((sum, row) => sum + Number(row.revenue), 0) /
        sameWeekdayRevenueRows.length
      : null;

  const hadTraffic = scansYesterday > 0 || ordersYesterday > 0;

  return {
    forDateLocal: forDate,
    scans: { yesterday: scansYesterday, weekdayAvg: weekdayScanAvg },
    revenue: {
      yesterdayAed: Number(revenueYesterday._sum.totalPrice ?? 0),
      weekdayAvgAed: weekdayRevenueAvg,
    },
    orders: { count: ordersYesterday },
    whatsapp: {
      clicks: waClicksYesterday,
      cartOrders: waCartOrdersYesterday,
      pendingReplies24h: pendingReplies,
    },
    topLikedItem: topLiked,
    topViewedPath: topViewed,
    menuHealth: {
      itemsMissingImages,
      itemsMissingDescriptions,
      dietaryTagCoverage:
        menuItems > 0 ? Number((totalDietaryTaggedItems / menuItems).toFixed(2)) : 0,
    },
    hadTrafficYesterday: hadTraffic,
  };
}

async function processGenerateJob(job: GenerateWorkerJob) {
  const { restaurantId, forDate } = job.data;
  const whisperDate = new Date(forDate);

  if (!env.ANTHROPIC_API_KEY) {
    console.warn(`[owner-whisper] no ANTHROPIC_API_KEY; skipping ${restaurantId}`);
    return;
  }

  // Claim the unique restaurant/date row before spending tokens. If another
  // worker already claimed it, this job is a duplicate.
  const placeholder = await prisma.ownerWhisper
    .create({
      data: {
        restaurantId,
        forDate: whisperDate,
        content: "",
        metricsJson: {},
        status: "generating",
        costUsd: 0,
      },
      select: { id: true },
    })
    .catch((error) => {
      if (isUniqueConstraintError(error)) {
        return null;
      }
      throw error;
    });

  if (!placeholder) {
    return;
  }

  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true, cuisineType: true },
    });
    if (!restaurant) {
      await prisma.ownerWhisper.delete({ where: { id: placeholder.id } });
      return;
    }

    const [snapshot, memoryRows] = await Promise.all([
      buildSnapshot(restaurantId, forDate),
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

    const memories: MemoryItem[] = memoryRows.map((m) => ({
      type: m.type,
      content: m.content,
    }));

    const prompt = buildWhisperPrompt(
      restaurant.name,
      restaurant.cuisineType,
      snapshot,
      memories
    );

    const client = getClient();
    const response = await createSousChefMessage(client, {
      max_tokens: 400,
      system:
        "You are Sous Chef writing the Owner's Whisper. Output exactly 5 lines in the strict format. No prose, no greeting, no sign-off.",
      messages: [{ role: "user", content: prompt }],
    }, {
      route: "owner-whisper",
      restaurantId,
      forDate,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      console.warn(`[owner-whisper] empty response for ${restaurantId} (${forDate})`);
      await prisma.ownerWhisper.delete({ where: { id: placeholder.id } });
      await logAiUsage(
        restaurantId,
        "owner_chat_whisper",
        response.usage.input_tokens,
        response.usage.output_tokens
      );
      return;
    }

    const costUsd = estimateAiUsageCost(
      "owner_chat_whisper",
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    // Persist whisper + mirror into chat thread in a single transaction
    await prisma.$transaction(async (tx) => {
      await tx.ownerWhisper.update({
        where: { id: placeholder.id },
        data: {
          content: text,
          metricsJson: JSON.parse(JSON.stringify(snapshot)) as object,
          status: "unread",
          generatedAt: new Date(),
          costUsd,
        },
      });

      await tx.ownerChatMessage.create({
        data: {
          restaurantId,
          role: "assistant",
          content: text,
          source: "whisper",
          whisperId: placeholder.id,
        },
      });
    });

    await logAiUsage(
      restaurantId,
      "owner_chat_whisper",
      response.usage.input_tokens,
      response.usage.output_tokens
    );
  } catch (error) {
    await prisma.ownerWhisper.deleteMany({
      where: { id: placeholder.id, status: "generating" },
    });
    throw error;
  }

  console.log(`[owner-whisper] ${restaurantId} forDate=${forDate} ok`);
}

/** Manual trigger for testing — used by the admin endpoint. */
export async function enqueueWhisperForRestaurant(
  restaurantId: string,
  forDate?: string
) {
  await ensureGenerateQueue();
  const queue = await getBoss();
  await queue.send(
    OWNER_WHISPER_GENERATE_JOB,
    { restaurantId, forDate: forDate ?? uaeYesterdayIso() },
    { retryLimit: RETRY_LIMIT }
  );
}
