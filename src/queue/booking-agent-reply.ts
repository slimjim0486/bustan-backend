// Booking-agent reply queue (Phase 4 / Task 12).
//
// The webhook enqueues one job per gate-passing inbound text message; this
// worker is where the actual model turn happens, off the webhook's hot path
// (Meta expects a fast 200, and a model call can take seconds).
//
// Two defences against out-of-order / duplicate replies:
//   - staleness check: if a newer inbound message already landed on this
//     conversation by the time the job runs, skip — that message's own job
//     will answer everything, including this one, in one turn (agent.ts reads
//     the full history, not just the triggering message).
//   - idempotencyKey `agent:${conversationId}:${inboundSeq}` on the outbound
//     send: a pg-boss retry of the same job can't double-send.
//
// Pattern cloned from queue/booking-expiry.ts (queue-ready memo, fire, retry).

import PgBoss from "pg-boss";
import { prisma } from "@/lib/prisma";
import { getBoss } from "@/queue/boss";
import { runBookingAgentTurn } from "@/services/booking-agent/agent";
import { shouldDispatchBookingAgent } from "@/services/booking-agent/gate";
import { sendBookingText } from "@/services/booking-messaging";

export const BOOKING_AGENT_REPLY_JOB = "booking-agent-reply";

/** Fixed handoff line for the (currently unreachable via agent.ts, but
 *  interface-legal) case: `escalated: true` with no text. Kept distinct from
 *  agent.ts's own HANDOFF_REPLY constant since this is a queue-level
 *  defensive fallback, not the agent's own copy. */
const QUEUE_HANDOFF_REPLY =
  "Let me get the owner to help you with that — they'll reply here shortly.";

export interface BookingAgentReplyJobData {
  conversationId: string;
  inboundSeq: string;
}

type ReplyWorkerJob = PgBoss.JobWithMetadata<BookingAgentReplyJobData>;

let queueReady: Promise<void> | null = null;

async function ensureQueue() {
  if (!queueReady) {
    queueReady = getBoss()
      .then((queue) => queue.createQueue(BOOKING_AGENT_REPLY_JOB))
      .catch((error) => {
        queueReady = null;
        throw error;
      });
  }
  await queueReady;
}

/** Called from the webhook right after a gate-passing inbound message is
 *  persisted. Never let a failure here fail the webhook response — the
 *  caller is responsible for catching. */
export async function enqueueBookingAgentReply(input: BookingAgentReplyJobData): Promise<void> {
  await ensureQueue();
  const queue = await getBoss();
  await queue.send(BOOKING_AGENT_REPLY_JOB, input, { retryLimit: 2 });
}

async function processReplyJob(job: ReplyWorkerJob) {
  const { conversationId, inboundSeq } = job.data;
  const jobSeq = BigInt(inboundSeq);

  const conversation = await prisma.whatsAppConversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      restaurantId: true,
      customerPhone: true,
      botPausedUntil: true,
      botDisabled: true,
      restaurant: { select: { businessType: true, agentAutonomyOptIn: true } },
    },
  });
  if (!conversation) return;

  // Staleness check: a newer inbound message already landed on this
  // conversation. That message's own job will answer everything (agent.ts
  // reads the full persisted history each turn), so answering here too would
  // either duplicate or race it out of order.
  const newestInbound = await prisma.whatsAppMessage.findFirst({
    where: { conversationId, direction: "inbound" },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (newestInbound && newestInbound.seq > jobSeq) return;

  // Re-check the gate against fresh conversation/restaurant state: the owner
  // may have paused or disabled the bot, or turned autonomy off, in the time
  // between enqueue and this job running. messageType/duplicate/consentCommand
  // are immutable facts about the specific message that triggered this job,
  // already true when the webhook enqueued it — only the mutable owner-side
  // fields need re-fetching.
  const dispatch = shouldDispatchBookingAgent({
    businessType: conversation.restaurant.businessType,
    agentAutonomyOptIn: conversation.restaurant.agentAutonomyOptIn,
    botDisabled: conversation.botDisabled,
    botPausedUntil: conversation.botPausedUntil,
    messageType: "text",
    duplicate: false,
    consentCommand: null,
    now: new Date(),
  });
  if (!dispatch) return;

  const result = await runBookingAgentTurn({ conversationId });

  const textToSend = result.text ?? (result.escalated ? QUEUE_HANDOFF_REPLY : null);
  if (!textToSend) return;

  await sendBookingText({
    restaurantId: conversation.restaurantId,
    conversationId,
    toPhone: conversation.customerPhone,
    body: textToSend,
    idempotencyKey: `agent:${conversationId}:${inboundSeq}`,
    answersUpToSeq: jobSeq,
  });
}

export async function startBookingAgentReplyWorker() {
  await ensureQueue();
  const queue = await getBoss();

  await queue.work<BookingAgentReplyJobData>(
    BOOKING_AGENT_REPLY_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as ReplyWorkerJob[]) {
        try {
          await processReplyJob(job);
        } catch (error) {
          console.error(
            `[booking-agent-reply] uncaught failure for conversation=${job.data.conversationId}:`,
            error
          );
          // Re-throw so pg-boss honors retryLimit instead of acking a failed job.
          throw error;
        }
      }
    }
  );
}
