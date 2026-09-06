// Daily Brief per-owner send (on-demand only).
//
// The 08:00 GST cron fanout was removed on 2026-09-06; briefs are now sent
// only via the admin "send now" trigger (enqueueBriefSendNow).
//
// Per-owner job is idempotent on `daily-brief:{restaurantId}:{forDate}`.

import PgBoss from "pg-boss";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { getBoss } from "@/queue/boss";
import {
  loadDailyBriefInputs,
  planDailyBrief,
} from "@/services/coworker/daily-brief";
import { sendCoworkerTemplate } from "@/services/coworker/sender";

export const COWORKER_DAILY_BRIEF_SEND_JOB = "coworker-daily-brief-send";

const RETRY_LIMIT = 1;

let sendQueueReady: Promise<void> | null = null;

async function ensureSendQueue() {
  if (!sendQueueReady) {
    sendQueueReady = getBoss()
      .then((q) => q.createQueue(COWORKER_DAILY_BRIEF_SEND_JOB))
      .catch((e) => {
        sendQueueReady = null;
        throw e;
      });
  }
  await sendQueueReady;
}

interface SendJobData {
  coworkerOwnerId: string;
  /** ISO Asia/Dubai local date the brief covers (usually yesterday). */
  forDate: string;
}

function uaeYesterdayIso(): string {
  // Same logic as owner-whisper.ts — Dubai is UTC+4 year-round.
  const nowUtcMs = Date.now();
  const dubaiNow = new Date(nowUtcMs + 4 * 60 * 60 * 1000);
  const yesterday = new Date(dubaiNow.getTime() - 24 * 60 * 60 * 1000);
  return yesterday.toISOString().slice(0, 10);
}

export async function startCoworkerDailyBriefWorker() {
  if (!env.COWORKER_ENABLED) {
    console.log("[coworker-daily-brief] disabled (COWORKER_ENABLED=false)");
    return;
  }

  await ensureSendQueue();
  const queue = await getBoss();

  await queue.work<SendJobData>(
    COWORKER_DAILY_BRIEF_SEND_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as PgBoss.JobWithMetadata<SendJobData>[]) {
        try {
          await processSendJob(job.data);
        } catch (error) {
          console.warn(
            `[coworker-daily-brief] send failed for ${job.data.coworkerOwnerId} (${job.data.forDate}):`,
            error
          );
        }
      }
    }
  );
}

async function processSendJob(data: SendJobData) {
  const owner = await prisma.coworkerOwner.findUnique({
    where: { id: data.coworkerOwnerId },
    include: {
      restaurant: { select: { id: true, name: true } },
      owner: { select: { fullName: true, email: true } },
    },
  });
  if (!owner) return;
  if (owner.status !== "active") return;

  const ownerFirstName =
    (owner.owner.fullName ?? owner.owner.email ?? "there").split(/\s+/)[0] || "there";

  const inputs = await loadDailyBriefInputs({
    restaurantId: owner.restaurantId,
    locale: owner.locale === "ar" ? "ar" : "en",
    forDate: data.forDate,
    ownerFirstName,
  });

  if (!inputs) {
    console.log(
      `[coworker-daily-brief] no snapshot yet for ${owner.restaurantId} (${data.forDate}); skipping`
    );
    return;
  }

  const plan = planDailyBrief(inputs);
  if (!plan) {
    console.warn(
      `[coworker-daily-brief] no template for locale=${inputs.locale}; skipping ${owner.restaurantId}`
    );
    return;
  }

  const outcome = await sendCoworkerTemplate({
    coworkerOwnerId: owner.id,
    restaurantId: owner.restaurantId,
    template: plan.template,
    variables: plan.variables,
    idempotencyKey: `daily-brief:${owner.id}:${data.forDate}`,
  });

  console.log(
    `[coworker-daily-brief] ${owner.restaurantId} (${data.forDate}) → ${outcome.status}` +
      (outcome.dryRun ? " [DRY-RUN]" : "") +
      (outcome.errorMessage ? ` — ${outcome.errorMessage}` : "")
  );
}

/** Manual trigger for the admin "send now" button. */
export async function enqueueBriefSendNow(input: {
  coworkerOwnerId: string;
  forDate?: string;
}) {
  await ensureSendQueue();
  const queue = await getBoss();
  await queue.send(
    COWORKER_DAILY_BRIEF_SEND_JOB,
    {
      coworkerOwnerId: input.coworkerOwnerId,
      forDate: input.forDate ?? uaeYesterdayIso(),
    } satisfies SendJobData,
    { retryLimit: RETRY_LIMIT }
  );
}
