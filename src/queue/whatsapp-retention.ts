// Phase 3A H4: scheduled retention job that nulls `rawPayload` on
// WhatsApp message + status event rows older than 30 days. Meta's
// `signed_request` and webhook envelopes contain user identifiers
// (display names, profile names, recipient_id) we don't need long-term;
// PDPL/GDPR data minimization requires we drop them once the dashboard
// has the cleaned, columnar fields it needs.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBoss } from "@/queue/boss";

export const WHATSAPP_RETENTION_JOB = "whatsapp-retention-sweep";
const RETENTION_DAYS = 30;
const BATCH_SIZE = 500;

let retentionQueueReady: Promise<void> | null = null;

async function ensureRetentionQueue() {
  if (!retentionQueueReady) {
    retentionQueueReady = getBoss()
      .then((queue) => queue.createQueue(WHATSAPP_RETENTION_JOB))
      .catch((error) => {
        retentionQueueReady = null;
        throw error;
      });
  }
  await retentionQueueReady;
}

async function runWhatsAppRetentionSweep() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let totalMessages = 0;
  let totalEvents = 0;

  // Two separate updates so a long-running sweep doesn't take a wide
  // table lock. We loop in batches because Postgres optimizes UPDATE
  // best when row counts are bounded.
  while (true) {
    const stale = await prisma.whatsAppMessage.findMany({
      where: {
        createdAt: { lt: cutoff },
        rawPayload: { not: Prisma.JsonNull },
      },
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (stale.length === 0) break;
    const result = await prisma.whatsAppMessage.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      data: { rawPayload: Prisma.JsonNull },
    });
    totalMessages += result.count;
    if (stale.length < BATCH_SIZE) break;
  }

  while (true) {
    const stale = await prisma.whatsAppMessageStatusEvent.findMany({
      where: {
        createdAt: { lt: cutoff },
        rawPayload: { not: Prisma.JsonNull },
      },
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (stale.length === 0) break;
    const result = await prisma.whatsAppMessageStatusEvent.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      data: { rawPayload: Prisma.JsonNull },
    });
    totalEvents += result.count;
    if (stale.length < BATCH_SIZE) break;
  }

  console.log(
    `[whatsapp-retention] cleared rawPayload on ${totalMessages} messages + ${totalEvents} status events older than ${RETENTION_DAYS}d`
  );
}

export async function startWhatsAppRetentionWorker() {
  await ensureRetentionQueue();
  const queue = await getBoss();
  // Daily at 02:30 UTC (06:30 GST) — runs after the meta-sync fanout so
  // the two crons don't fight for DB connections.
  await queue.schedule(WHATSAPP_RETENTION_JOB, "30 2 * * *", undefined, { tz: "UTC" });
  await queue.work(WHATSAPP_RETENTION_JOB, async () => {
    try {
      await runWhatsAppRetentionSweep();
    } catch (error) {
      console.error("[whatsapp-retention] sweep failed", error);
      throw error;
    }
  });
}

