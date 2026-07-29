/**
 * WhatsApp Ordering v1 — expiry sweep.
 *
 * Runs every minute. Finds OrderIntent rows where status='pending' AND
 * expires_at < now, transitions them to 'expired', sends an order_cancelled
 * template to the customer, and (if Telr was used) auto-refunds.
 *
 * Critical correctness property: without this cron, a restaurant that
 * misses a WhatsApp notification leaves the customer with no signal that
 * their order won't be fulfilled. The status page would show "pending"
 * forever.
 */

import { prisma } from "@/lib/prisma";
import { transitionOrder } from "@/lib/order-state-machine";
import { getBoss } from "@/queue/image-generation";

export const ORDER_INTENT_EXPIRY_JOB = "order-intent-expiry-sweep";
const BATCH_SIZE = 100;

let queueReady: Promise<void> | null = null;

async function ensureQueue() {
  if (!queueReady) {
    queueReady = getBoss()
      .then((queue) => queue.createQueue(ORDER_INTENT_EXPIRY_JOB))
      .catch((error) => {
        queueReady = null;
        throw error;
      });
  }
  await queueReady;
}

async function runOrderIntentExpirySweep() {
  const now = new Date();

  // Snapshot the IDs first so a fast-growing pending set doesn't keep us
  // looping forever. One sweep handles up to BATCH_SIZE; the next minute
  // picks up the rest.
  const expired = await prisma.orderIntent.findMany({
    where: {
      status: "pending",
      expiresAt: { lt: now },
    },
    select: { id: true, orderNumber: true },
    take: BATCH_SIZE,
    orderBy: { expiresAt: "asc" },
  });

  if (expired.length === 0) {
    return;
  }

  // M4: process in parallel with a small concurrency cap so a slow Meta
  // doesn't serialize ~100 expiries behind one stuck call. Cap of 8 keeps
  // pg-boss + DB connection use bounded.
  const CONCURRENCY = 8;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < expired.length; i += CONCURRENCY) {
    const batch = expired.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((order) =>
        transitionOrder({
          orderIntentId: order.id,
          action: { type: "expire" },
          actor: "system",
          source: "expiry_cron",
          metadata: { sweepAt: now.toISOString() },
        })
      )
    );
    for (let j = 0; j < results.length; j++) {
      const order = batch[j];
      const settled = results[j];
      if (settled.status === "fulfilled" && settled.value.ok) {
        succeeded++;
      } else {
        failed++;
        const reason =
          settled.status === "rejected"
            ? settled.reason instanceof Error
              ? settled.reason.message
              : String(settled.reason)
            : settled.value.ok
            ? "unknown"
            : settled.value.reason;
        console.error("[order-intent-expiry] transition failed", {
          orderNumber: order.orderNumber,
          reason,
        });
      }
    }
  }

  console.log(
    `[order-intent-expiry] expired ${succeeded} order(s)${failed ? `, ${failed} failed` : ""}`
  );
}

export async function startOrderIntentExpiryWorker() {
  await ensureQueue();
  const queue = await getBoss();
  // pg-boss cron min granularity is one minute. Acceptable: the customer-
  // facing impact of waiting up to 60s past the 15-min window for the
  // cancellation message to fire is negligible.
  await queue.schedule(ORDER_INTENT_EXPIRY_JOB, "* * * * *", undefined, { tz: "UTC" });
  await queue.work(ORDER_INTENT_EXPIRY_JOB, async () => {
    try {
      await runOrderIntentExpirySweep();
    } catch (error) {
      console.error("[order-intent-expiry] sweep failed", error);
      throw error;
    }
  });
}
