// Market Pulse / Competitor Intelligence worker (on-demand only).
//
// Runs are enqueued manually (admin endpoint / scripts/competitor-intel-trigger.ts).
// The weekly cron fanout was removed on 2026-09-06. Each run job invokes the
// orchestrator which handles proximity, Exa fetches, caching, and persistence.
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
import { getBoss } from "@/queue/boss";
import { runCompetitorIntelForRestaurant } from "@/services/competitor-intel";

export const COMPETITOR_INTEL_RUN_JOB = "competitor-intel-run";

const RETRY_LIMIT = 1;

let runQueueReady: Promise<void> | null = null;

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
            source: "manual",
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
