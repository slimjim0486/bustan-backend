// Market Pulse / Competitor Intelligence weekly worker.
//
// Mirrors backend/src/queue/sabt-pack.ts in shape: a fanout job (cron-
// scheduled) that enumerates entitled restaurants and enqueues a per-
// restaurant run job. Each run job invokes the orchestrator which handles
// proximity, Exa fetches, caching, and persistence.
//
// Cron timing:
//   • Fanout fires Sunday at 02:00 UTC = 06:00 GST. One hour BEFORE the
//     Sabt Pack cron at 03:00 UTC so Market Pulse snapshots are ready for
//     Sabt Pack's content prompts to reference (Phase 3 will wire that).
//
// Concurrency:
//   • batchSize: 2 — each run job hits Exa (~$0.04/competitor × 5-10) and
//     Apify (~$0.18/run). Keeping batchSize small avoids hammering Exa's
//     rate limit on the busiest run of the week.
//
// Idempotency:
//   • The orchestrator's upsert on (placeId, weekBucket, restaurantId)
//     makes re-runs of the same week safe. Re-running on the same Sunday
//     a second time after a partial failure will cache-hit existing rows
//     and only re-fetch competitors that weren't completed.

import PgBoss from "pg-boss";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { getBoss } from "@/queue/boss";
import { runCompetitorIntelForRestaurant } from "@/services/competitor-intel";
import { getOrgMonthlyExaSpend } from "@/services/competitor-intel/budget";
import { sendLifecycleEmail } from "@/services/email";

export const COMPETITOR_INTEL_FANOUT_JOB = "competitor-intel-fanout";
export const COMPETITOR_INTEL_RUN_JOB = "competitor-intel-run";

const RETRY_LIMIT = 1;
const FANOUT_RESTAURANT_CAP = 1000;

let fanoutQueueReady: Promise<void> | null = null;
let runQueueReady: Promise<void> | null = null;

async function ensureFanoutQueue() {
  if (!fanoutQueueReady) {
    fanoutQueueReady = getBoss()
      .then((queue) => queue.createQueue(COMPETITOR_INTEL_FANOUT_JOB))
      .catch((error) => {
        fanoutQueueReady = null;
        throw error;
      });
  }
  await fanoutQueueReady;
}

async function ensureRunQueue() {
  if (!runQueueReady) {
    runQueueReady = getBoss()
      .then((queue) => queue.createQueue(COMPETITOR_INTEL_RUN_JOB))
      .catch((error) => {
        runQueueReady = null;
        throw error;
      });
  }
  await runQueueReady;
}

export interface CompetitorIntelRunJobData {
  restaurantId: string;
  /** Optional override; defaults to sundayOfThisWeekUae() in the orchestrator. */
  weekBucket?: string;
}

type RunWorkerJob = PgBoss.JobWithMetadata<CompetitorIntelRunJobData>;

export async function startCompetitorIntelWorker() {
  await ensureFanoutQueue();
  await ensureRunQueue();
  const queue = await getBoss();

  await queue.work<CompetitorIntelRunJobData>(
    COMPETITOR_INTEL_RUN_JOB,
    { batchSize: 2, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as RunWorkerJob[]) {
        try {
          await runCompetitorIntelForRestaurant({
            restaurantId: job.data.restaurantId,
            weekBucket: job.data.weekBucket,
            source: "cron",
          });
        } catch (error) {
          console.warn(
            `[market-pulse] run failed for ${job.data.restaurantId}:`,
            error
          );
          // One bad restaurant must not cascade across the batch.
        }
      }
    }
  );

  // Sunday 02:00 UTC = 06:00 GST.
  await queue.schedule(COMPETITOR_INTEL_FANOUT_JOB, "0 2 * * 0", undefined, {
    tz: "UTC",
  });
  await queue.work(COMPETITOR_INTEL_FANOUT_JOB, async () => {
    await fanOutCompetitorIntelJobs();
  });
}

async function fanOutCompetitorIntelJobs() {
  if (!env.EXA_ENABLED || !env.EXA_API_KEY) {
    console.log(
      "[market-pulse] EXA_ENABLED=false or no key — skipping fanout"
    );
    return;
  }

  // Mirror the Pro/Portfolio filter used by sabt-pack and event-stager.
  // The entitlement check inside the orchestrator is the source of truth
  // — this where clause is just a coarse pre-filter to avoid enqueuing
  // jobs that will short-circuit immediately.
  const candidates = await prisma.restaurant.findMany({
    where: {
      subscriptionStatus: { in: ["active", "trial"] },
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
            is: { status: { in: ["active", "trial"] } },
          },
        },
      ],
    },
    select: { id: true },
    take: FANOUT_RESTAURANT_CAP,
  });

  await ensureRunQueue();
  const queue = await getBoss();

  let enqueued = 0;
  for (const r of candidates) {
    await queue.send(
      COMPETITOR_INTEL_RUN_JOB,
      { restaurantId: r.id },
      { retryLimit: RETRY_LIMIT }
    );
    enqueued++;
  }

  console.log(`[market-pulse] fanout enqueued=${enqueued}`);
  if (candidates.length === FANOUT_RESTAURANT_CAP) {
    console.warn(
      `[market-pulse] fanout hit cap of ${FANOUT_RESTAURANT_CAP} — consider raising`
    );
  }

  await maybeAlertOnOrgSpend();
}

/** Fire a Resend warning to support@ when org-wide monthly Exa spend
 *  approaches the alert threshold. Idempotent within a single fanout run;
 *  cron firing only once per week limits noise. */
async function maybeAlertOnOrgSpend() {
  const threshold = env.EXA_ORG_MONTHLY_USD_ALERT;
  if (threshold <= 0) return;

  const spent = await getOrgMonthlyExaSpend();
  if (spent < threshold) return;

  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    console.warn(
      `[market-pulse] org spend $${spent.toFixed(2)} >= alert $${threshold} but Resend not configured`
    );
    return;
  }

  try {
    await sendLifecycleEmail({
      to: env.RESEND_FROM_EMAIL,
      subject: `Market Pulse Exa spend alert: $${spent.toFixed(2)} this month`,
      html: `<p>Org-wide Exa spend for feature='competitor-intel' has reached <strong>$${spent.toFixed(2)}</strong> this calendar month (alert threshold $${threshold.toFixed(2)}).</p><p>Inspect <code>ai_usage_logs</code> to identify the top spenders, or set <code>EXA_ENABLED=false</code> to pause Market Pulse globally.</p>`,
    });
    console.log(`[market-pulse] alert email sent at spend $${spent.toFixed(2)}`);
  } catch (error) {
    console.warn(`[market-pulse] alert email failed:`, error);
  }
}

/** Manual trigger — used by the admin endpoint + CLI. */
export async function enqueueCompetitorIntelForRestaurant(
  restaurantId: string,
  weekBucket?: string
) {
  await ensureRunQueue();
  const queue = await getBoss();
  await queue.send(
    COMPETITOR_INTEL_RUN_JOB,
    { restaurantId, weekBucket },
    { retryLimit: RETRY_LIMIT }
  );
}
