// Phase 3.1: daily Google Search Console sync.
// Runs once a day at 05:00 UTC (09:00 GST). Pulls yesterday's data from the
// getbustan.com GSC property and writes per-restaurant rows into GscSnapshot,
// sliced by `page` URL filter. Mirrors the pg-boss pattern used by owner-whisper.

import PgBoss from "pg-boss";
import { Prisma } from "@prisma/client";
import { isGscConfigured, querySearchAnalytics } from "@/services/gsc/client";
import { prisma } from "@/lib/prisma";
import { captureException, captureMessage } from "@/lib/sentry";
import { getBoss } from "@/queue/boss";

export const GSC_SYNC_JOB = "gsc-sync";

const RESTAURANT_CONCURRENCY = 4;
const TOP_QUERIES_LIMIT = 10;
// Re-fetch the last N days every run. Idempotent via @@unique([restaurantId, date]).
// Buys natural backfill against transient failures + GSC's own 1-3 day lag.
const DAYS_TO_FETCH = 3;

let queueReady: Promise<void> | null = null;

async function ensureQueue() {
  if (!queueReady) {
    queueReady = getBoss()
      .then((queue) => queue.createQueue(GSC_SYNC_JOB))
      .catch((err) => {
        queueReady = null;
        throw err;
      });
  }
  await queueReady;
}

export async function startGscSyncWorker() {
  if (!isGscConfigured()) {
    console.log(
      "[gsc-sync] worker not started — GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN not configured."
    );
    return;
  }

  await ensureQueue();
  const queue = await getBoss();

  // Daily at 05:00 UTC. GSC backfills 1-3 days behind real-time, so yesterday's
  // data is usually present.
  await queue.schedule(GSC_SYNC_JOB, "0 5 * * *", undefined, { tz: "UTC" });
  await queue.work(GSC_SYNC_JOB, async () => {
    await runGscSync();
  });
}

/** Returns "YYYY-MM-DD" for `daysAgo` days before now in UTC. */
function isoUtcDaysAgo(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Targets for one cron run: yesterday + the prior DAYS_TO_FETCH-1 days. */
function targetDatesForRun(): string[] {
  const dates: string[] = [];
  for (let i = 1; i <= DAYS_TO_FETCH; i += 1) {
    dates.push(isoUtcDaysAgo(i));
  }
  return dates;
}

export async function runGscSync(targetDate?: string) {
  const dates = targetDate ? [targetDate] : targetDatesForRun();
  console.log(`[gsc-sync] starting sync for dates=${dates.join(",")}`);

  const restaurants = await prisma.restaurant.findMany({
    where: { isPublished: true },
    select: { id: true, slug: true },
  });

  let totalProcessed = 0;
  let totalWithData = 0;
  let totalFailed = 0;

  for (const date of dates) {
    let processed = 0;
    let withData = 0;
    let failed = 0;

    // Sequential batches keeps us safely under GSC rate limits (1200/min/project)
    // and is plenty fast for the current restaurant count.
    for (let i = 0; i < restaurants.length; i += RESTAURANT_CONCURRENCY) {
      const batch = restaurants.slice(i, i + RESTAURANT_CONCURRENCY);
      await Promise.all(
        batch.map(async (r) => {
          try {
            const had = await syncRestaurant(r.id, r.slug, date);
            if (had) withData += 1;
          } catch (err) {
            failed += 1;
            captureException(err, {
              tags: { job: "gsc-sync", scope: "restaurant" },
              extra: { restaurantId: r.id, slug: r.slug, date },
            });
          } finally {
            processed += 1;
          }
        })
      );
    }

    console.log(
      `[gsc-sync] day=${date} processed=${processed} withData=${withData} failed=${failed}`
    );

    totalProcessed += processed;
    totalWithData += withData;
    totalFailed += failed;
  }

  console.log(
    `[gsc-sync] done. dates=${dates.length} processed=${totalProcessed} withData=${totalWithData} failed=${totalFailed}`
  );

  // If every restaurant failed on every day, something systemic is wrong
  // (revoked token, GSC 403, network outage). Surface as a Sentry warning so
  // the on-call sees one summary alert instead of N individual ones.
  if (totalProcessed > 0 && totalFailed === totalProcessed) {
    captureMessage(
      "[gsc-sync] ALL restaurants failed — likely revoked refresh token or GSC outage",
      "error",
      { tags: { job: "gsc-sync" }, extra: { dates, totalFailed } }
    );
  }
}

async function syncRestaurant(
  restaurantId: string,
  slug: string,
  date: string
): Promise<boolean> {
  const pageUrl = `https://getbustan.com/${slug}`;
  const filterGroups = [
    {
      filters: [
        {
          dimension: "page" as const,
          operator: "equals" as const,
          expression: pageUrl,
        },
      ],
    },
  ];

  // Totals (no dimensions = aggregate over the date)
  const totalsRows = await querySearchAnalytics({
    startDate: date,
    endDate: date,
    rowLimit: 1,
    dimensionFilterGroups: filterGroups,
  });

  const totals = totalsRows[0];
  if (!totals || totals.impressions === 0) {
    return false;
  }

  // Top queries for context (display in dashboard)
  const queryRows = await querySearchAnalytics({
    startDate: date,
    endDate: date,
    dimensions: ["query"],
    rowLimit: TOP_QUERIES_LIMIT,
    dimensionFilterGroups: filterGroups,
  });

  const topQueries = queryRows.map((row) => ({
    query: row.keys[0] ?? "",
    impressions: row.impressions,
    clicks: row.clicks,
    position: Math.round(row.position * 10) / 10,
  }));

  await prisma.gscSnapshot.upsert({
    where: {
      restaurantId_date: {
        restaurantId,
        date: new Date(date),
      },
    },
    create: {
      restaurantId,
      date: new Date(date),
      impressions: totals.impressions,
      clicks: totals.clicks,
      ctr: new Prisma.Decimal(totals.ctr),
      position: new Prisma.Decimal(totals.position),
      topQueries,
    },
    update: {
      impressions: totals.impressions,
      clicks: totals.clicks,
      ctr: new Prisma.Decimal(totals.ctr),
      position: new Prisma.Decimal(totals.position),
      topQueries,
    },
  });

  return true;
}
