// Sous Chef draft-ship worker.
//
// When the owner approves a draft, the inbox route enqueues a job here with a
// startAfter equal to the 60s grace window (or a future shipAt for scheduled
// drafts). When the job fires, we hand off to shipDraft() which dispatches by
// actionType.

import PgBoss from "pg-boss";
import { getBoss } from "@/queue/boss";
import { shipDraft } from "@/services/draft-actions";

export const DRAFT_SHIP_JOB = "draft-ship";

let queueReady: Promise<void> | null = null;

async function ensureQueue() {
  if (!queueReady) {
    queueReady = getBoss()
      .then((queue) => queue.createQueue(DRAFT_SHIP_JOB))
      .catch((error) => {
        queueReady = null;
        throw error;
      });
  }
  await queueReady;
}

export interface DraftShipJobData {
  draftId: string;
}

type ShipWorkerJob = PgBoss.JobWithMetadata<DraftShipJobData>;

export async function enqueueDraftShip(draftId: string, shipAt: Date) {
  await ensureQueue();
  const queue = await getBoss();
  await queue.send(
    DRAFT_SHIP_JOB,
    { draftId },
    {
      retryLimit: 2,
      retryDelay: 30,
      // startAfter accepts a Date — pg-boss will not pick the job up until then.
      startAfter: shipAt,
    }
  );
}

export async function startDraftShipWorker() {
  await ensureQueue();
  const queue = await getBoss();

  await queue.work<DraftShipJobData>(
    DRAFT_SHIP_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as ShipWorkerJob[]) {
        try {
          const result = await shipDraft(job.data.draftId);
          if (!result.ok) {
            console.warn(
              `[draft-ship] draft=${job.data.draftId} ship returned not-ok: ${result.message ?? "(no message)"}`
            );
          }
        } catch (error) {
          console.error(`[draft-ship] uncaught failure for draft=${job.data.draftId}:`, error);
          // Re-throw so pg-boss honors the retryLimit instead of acking a failed job.
          throw error;
        }
      }
    }
  );
}
