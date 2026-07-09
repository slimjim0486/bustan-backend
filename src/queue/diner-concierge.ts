import { Prisma } from "@prisma/client";
import PgBoss from "pg-boss";
import { ApiError } from "@/lib/errors";
import { buildPublicMenuItemWhere } from "@/lib/menu-visibility";
import { prisma } from "@/lib/prisma";
import { captureException } from "@/lib/sentry";
import {
  decryptAccessToken,
  sendWhatsAppText,
} from "@/lib/whatsapp-business";
import {
  fallbackMessage,
  handoffMessage,
  runConciergeTurn,
  type ConciergeLanguage,
} from "@/lib/concierge";
import {
  getConciergeMonthlyCap,
  getConciergeUsageState,
  incrementConciergeUsage,
} from "@/lib/concierge/usage";
import { getBoss } from "@/queue/image-generation";

export const DINER_CONCIERGE_JOB = "diner-concierge-reply";

const RETRY_LIMIT = 2;
const RETRY_DELAY_SECONDS = 30;
const DEBOUNCE_SECONDS = 10;
// A claim that never reached "sent" within this window is treated as orphaned
// (crash mid-send or mid-model-call): it stops anchoring the watermark and the
// thread is flagged unread so a human looks at it. Must comfortably exceed
// worst-case model latency (SDK timeout x retries x tool iterations during an
// API brownout); sendClaimedReply also re-checks claim liveness before the
// Meta send so a job that DOES outlive the TTL aborts instead of double-sending.
const ORPHAN_CLAIM_TTL_MS = 30 * 60 * 1000;
const HISTORY_LOAD_LIMIT = 50;
const HISTORY_MODEL_LIMIT = 20;
const PAUSE_24H_MS = 24 * 60 * 60 * 1000;

let queueReady: Promise<void> | null = null;

async function ensureQueue() {
  if (!queueReady) {
    queueReady = getBoss()
      .then((queue) => queue.createQueue(DINER_CONCIERGE_JOB))
      .catch((error) => {
        queueReady = null;
        throw error;
      });
  }
  await queueReady;
}

export interface DinerConciergeJobData {
  restaurantId: string;
  conversationId: string;
  // Wake-up metadata only. The worker derives what to answer from the DB at
  // execution time; these fields are never trusted for batch content.
  triggerMessageId?: string;
  triggerMessageAt?: string;
  language?: ConciergeLanguage;
}

type ConciergeWorkerJob = PgBoss.JobWithMetadata<DinerConciergeJobData>;

function isActivePause(conversation: { botPausedUntil: Date | null }) {
  return Boolean(conversation.botPausedUntil && conversation.botPausedUntil.getTime() > Date.now());
}

export type StoredConciergeMessage = {
  id: string;
  seq: bigint;
  direction: "inbound" | "outbound";
  source: string;
  type: string;
  status: string;
  body: string | null;
  answersUpToSeq: bigint | null;
  createdAt: Date;
};

// Watermark: the highest diner-message seq already answered. Bot claim rows
// anchor at answersUpToSeq (their own seq is later than messages that arrived
// while they were composing); owner replies and legacy bot rows anchor at
// their own seq. Failed/orphaned claims anchor nothing, so their batch
// reopens for a future job.
export function deriveUnansweredBatch(messages: StoredConciergeMessage[]) {
  let watermark = 0n;
  for (const message of messages) {
    if (message.direction !== "outbound") continue;
    // A failed send never reached the diner — it answers nothing, whether it
    // came from the bot or the owner.
    if (message.status === "failed") continue;
    if (message.source === "owner") {
      if (message.seq > watermark) watermark = message.seq;
    } else if (message.source === "bot") {
      const anchor = message.answersUpToSeq ?? message.seq;
      if (anchor > watermark) watermark = anchor;
    }
  }

  return messages
    .filter(
      (message) =>
        message.direction === "inbound" &&
        message.source === "diner" &&
        message.seq > watermark
    )
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

// Meta's body extractor emits "[image message]", "[location message]" etc. for
// payloads with no text/caption. Those placeholders are not diner text.
const SYNTHETIC_BODY = /^\[(?:[a-z_-]+ )?message\]$/i;

export function messageBodyForConcierge(message: Pick<StoredConciergeMessage, "body">) {
  const body = message.body?.trim();
  if (!body || SYNTHETIC_BODY.test(body)) return null;
  return body;
}

export async function enqueueDinerConciergeReply(data: DinerConciergeJobData) {
  await ensureQueue();
  const queue = await getBoss();
  await queue.send(
    DINER_CONCIERGE_JOB,
    data,
    {
      retryLimit: RETRY_LIMIT,
      retryDelay: RETRY_DELAY_SECONDS,
      startAfter: new Date(Date.now() + DEBOUNCE_SECONDS * 1000),
      singletonKey: data.conversationId,
      singletonSeconds: DEBOUNCE_SECONDS,
      singletonNextSlot: true,
    } as PgBoss.SendOptions
  );
}

function isPrismaUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function withRetries<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

type ClaimedBatch = {
  claimId: string;
  idempotencyKey: string;
  batch: StoredConciergeMessage[];
  history: StoredConciergeMessage[];
};

// Serialize per-conversation derivation + claim under a Postgres advisory
// lock (same pattern as campaign-send). Everything that decides WHAT the bot
// owes happens inside the lock; the model call and the Meta send happen
// after commit, protected by the claim row's unique idempotency key.
async function claimUnansweredBatch(input: {
  restaurantId: string;
  integrationId: string;
  conversationId: string;
  customerId: string | null;
  customerPhone: string;
  displayPhoneNumber: string;
}): Promise<ClaimedBatch | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`diner-concierge:${input.conversationId}`}, 0))`;

    const orphaned = await tx.whatsAppMessage.updateMany({
      where: {
        conversationId: input.conversationId,
        direction: "outbound",
        source: "bot",
        status: "queued",
        providerMessageId: null,
        createdAt: { lt: new Date(Date.now() - ORPHAN_CLAIM_TTL_MS) },
      },
      data: { status: "failed", failedAt: new Date() },
    });
    if (orphaned.count > 0) {
      // The diner may never have received this reply. Surface the thread to
      // the owner instead of pretending it was handled.
      await tx.whatsAppConversation.update({
        where: { id: input.conversationId },
        data: { unreadCount: { increment: 1 } },
      });
    }

    const rows = await tx.whatsAppMessage.findMany({
      where: { conversationId: input.conversationId },
      orderBy: { seq: "desc" },
      take: HISTORY_LOAD_LIMIT,
      select: {
        id: true,
        seq: true,
        direction: true,
        source: true,
        type: true,
        status: true,
        body: true,
        answersUpToSeq: true,
        createdAt: true,
      },
    });
    const messages = rows.slice().reverse() as StoredConciergeMessage[];

    const batch = deriveUnansweredBatch(messages);
    if (batch.length === 0) {
      return null;
    }

    const lastSeq = batch[batch.length - 1].seq;
    const idempotencyKey = `dc:${input.conversationId}:${lastSeq.toString()}`;

    // Check-then-create is race-free here: every claim writer holds the
    // advisory lock for this conversation.
    const existingClaim = await tx.whatsAppMessage.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });
    if (existingClaim) {
      return null;
    }

    const batchIds = new Set(batch.map((message) => message.id));
    const claim = await tx.whatsAppMessage.create({
      data: {
        restaurantId: input.restaurantId,
        integrationId: input.integrationId,
        conversationId: input.conversationId,
        customerId: input.customerId,
        idempotencyKey,
        answersUpToSeq: lastSeq,
        direction: "outbound",
        type: "text",
        status: "queued",
        source: "bot",
        fromPhone: input.displayPhoneNumber,
        toPhone: input.customerPhone,
      },
      select: { id: true },
    });

    return {
      claimId: claim.id,
      idempotencyKey,
      batch,
      history: messages.filter((message) => !batchIds.has(message.id)),
    };
  });
}

async function releaseClaim(claimId: string, idempotencyKey: string) {
  await prisma.whatsAppMessage
    .delete({ where: { id: claimId } })
    .catch((deleteError) => {
      captureException(deleteError, {
        tags: { job: DINER_CONCIERGE_JOB, phase: "release_claim" },
        extra: { idempotencyKey, claimId },
      });
    });
}

// Meta responded with a 4xx: the message was definitively rejected, so the
// claim can be released and the retry can safely re-send. Anything else —
// network error, timeout, Meta 5xx, ok-response-without-id — is AMBIGUOUS:
// the message may have been delivered, so the claim must survive.
function isDefinitiveSendRejection(error: unknown) {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

// Send the claimed reply and finalize bookkeeping.
// - Definitive Meta rejection: release the claim + rethrow (retry re-claims).
// - Ambiguous send failure: KEEP the claim and swallow — deleting it would
//   let the retry re-send a message the diner may already have received.
//   The orphan reconciler surfaces the thread to the owner.
// - Bookkeeping after a successful send is retried but never rethrown: a
//   job retry after the diner received the message would double-send.
async function sendClaimedReply(input: {
  claimId: string;
  idempotencyKey: string;
  restaurantId: string;
  conversationId: string;
  accessTokenCipher: string;
  phoneNumberId: string;
  customerPhone: string;
  body: string;
  pauseReason?: string | null;
  pauseUntil?: Date | null;
}) {
  // Liveness check: if this job stalled past ORPHAN_CLAIM_TTL_MS, another
  // job has already failed this claim (and may have re-answered the batch).
  // A stale reply on top of that would be a duplicate.
  const liveClaim = await prisma.whatsAppMessage.findUnique({
    where: { id: input.claimId },
    select: { status: true },
  });
  if (!liveClaim || liveClaim.status !== "queued") {
    return;
  }

  const sentAt = new Date();
  let providerMessageId: string;
  try {
    providerMessageId = await sendWhatsAppText({
      accessToken: decryptAccessToken(input.accessTokenCipher),
      phoneNumberId: input.phoneNumberId,
      to: input.customerPhone,
      body: input.body,
    });
  } catch (error) {
    if (isDefinitiveSendRejection(error)) {
      await releaseClaim(input.claimId, input.idempotencyKey);
      throw error;
    }
    captureException(error, {
      tags: { job: DINER_CONCIERGE_JOB, phase: "ambiguous_send_failure" },
      extra: { idempotencyKey: input.idempotencyKey, claimId: input.claimId },
    });
    return;
  }

  // Critical bookkeeping first, on its own: marking the claim "sent" is what
  // prevents the orphan reconciler from reopening an already-delivered batch.
  try {
    await withRetries(3, () =>
      prisma.whatsAppMessage.update({
        where: { id: input.claimId },
        data: {
          providerMessageId,
          status: "sent",
          body: input.body,
          sentAt,
        },
      })
    );
  } catch (error) {
    captureException(error, {
      tags: { job: DINER_CONCIERGE_JOB, phase: "mark_sent" },
      extra: {
        idempotencyKey: input.idempotencyKey,
        claimId: input.claimId,
        providerMessageId,
      },
    });
  }

  try {
    await withRetries(3, () =>
      prisma.whatsAppConversation.update({
        where: { id: input.conversationId },
        data: {
          lastMessageAt: sentAt,
          ...(input.pauseUntil
            ? {
                botPausedUntil: input.pauseUntil,
                botPausedReason: input.pauseReason,
              }
            : {}),
        },
      })
    );
  } catch (error) {
    // Worst case here: an escalation pause is lost and the bot keeps
    // answering. Logged loudly; the claim itself is already marked sent.
    captureException(error, {
      tags: { job: DINER_CONCIERGE_JOB, phase: "conversation_bookkeeping" },
      extra: {
        idempotencyKey: input.idempotencyKey,
        claimId: input.claimId,
        pauseLost: Boolean(input.pauseUntil),
      },
    });
  }

  try {
    await withRetries(3, () => incrementConciergeUsage(input.restaurantId));
  } catch (error) {
    captureException(error, {
      tags: { job: DINER_CONCIERGE_JOB, phase: "usage_increment" },
      extra: { idempotencyKey: input.idempotencyKey, claimId: input.claimId },
    });
  }
}

// Light load for eligibility + claiming: no menu. Every debounced wake-up
// (including the common already-claimed no-op) and the fallback path run
// this; the heavy menu context loads only when a claim succeeds and the
// model actually runs.
async function loadConversationForJob(job: DinerConciergeJobData) {
  return prisma.whatsAppConversation.findFirst({
    where: {
      id: job.conversationId,
      restaurantId: job.restaurantId,
    },
    include: {
      integration: true,
      restaurant: {
        include: {
          subscription: true,
          operatorAccount: { include: { _count: { select: { brands: true } } } },
        },
      },
      customer: {
        select: {
          preferredLanguage: true,
        },
      },
    },
  });
}

async function loadRestaurantMenuContext(restaurantId: string) {
  return prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: {
      subscription: true,
      operatorAccount: { include: { _count: { select: { brands: true } } } },
      menuSections: {
        orderBy: { displayOrder: "asc" },
        include: {
          items: {
            where: buildPublicMenuItemWhere(),
            orderBy: { displayOrder: "asc" },
            select: {
              name: true,
              description: true,
              price: true,
              dietaryTags: {
                select: {
                  source: true,
                  confidence: true,
                  tag: {
                    select: {
                      key: true,
                      label: true,
                      icon: true,
                      category: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}

async function recentOrdersForPhone(restaurantId: string, customerPhone: string) {
  return prisma.orderIntent.findMany({
    where: {
      restaurantId,
      OR: [
        { normalizedPhone: customerPhone },
        { phoneNumber: customerPhone },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      orderNumber: true,
      status: true,
      fulfillmentMethod: true,
      totalPrice: true,
      currency: true,
      itemCount: true,
      createdAt: true,
      acceptedAt: true,
      readyAt: true,
      completedAt: true,
      rejectedAt: true,
      estimatedPrepMinutes: true,
    },
  });
}

type LoadedConversation = NonNullable<Awaited<ReturnType<typeof loadConversationForJob>>>;

async function checkEligibility(job: DinerConciergeJobData): Promise<LoadedConversation | null> {
  const conversation = await loadConversationForJob(job);

  if (!conversation || !conversation.integration || conversation.integration.status !== "connected") {
    return null;
  }
  if (!conversation.restaurant.dinerAutoReplyEnabled) {
    return null;
  }
  if (conversation.botDisabled || isActivePause(conversation)) {
    return null;
  }

  const cap = getConciergeMonthlyCap(conversation.restaurant);
  const usage = await getConciergeUsageState(conversation.restaurantId, cap);
  if (!usage.allowed) {
    return null;
  }

  return conversation;
}

async function processConciergeJob(job: ConciergeWorkerJob) {
  const data = job.data;
  const conversation = await checkEligibility(data);
  if (!conversation?.integration) {
    return;
  }

  const claimed = await claimUnansweredBatch({
    restaurantId: conversation.restaurantId,
    integrationId: conversation.integration.id,
    conversationId: conversation.id,
    customerId: conversation.customerId,
    customerPhone: conversation.customerPhone,
    displayPhoneNumber: conversation.integration.displayPhoneNumber,
  });
  if (!claimed) {
    return;
  }

  const language = (conversation.customer?.preferredLanguage ?? data.language) as
    | ConciergeLanguage
    | undefined;
  const textBodies = claimed.batch
    .map(messageBodyForConcierge)
    .filter((body): body is string => Boolean(body));
  const hasNonText = claimed.batch.some((message) => !messageBodyForConcierge(message));

  const sendInput = {
    claimId: claimed.claimId,
    idempotencyKey: claimed.idempotencyKey,
    restaurantId: conversation.restaurantId,
    conversationId: conversation.id,
    accessTokenCipher: conversation.integration.accessTokenCipher,
    phoneNumberId: conversation.integration.phoneNumberId,
    customerPhone: conversation.customerPhone,
  };

  // No readable text at all (media, location pins, stickers, unknown types):
  // hand off to the owner and pause, like a media-only batch.
  if (textBodies.length === 0) {
    await sendClaimedReply({
      ...sendInput,
      body: handoffMessage(language),
      pauseUntil: new Date(Date.now() + PAUSE_24H_MS),
      pauseReason: "agent_escalated",
    });
    return;
  }

  const history = claimed.history
    .filter((message) => messageBodyForConcierge(message))
    .slice(-HISTORY_MODEL_LIMIT)
    .map((message) => ({
      role: message.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: messageBodyForConcierge(message) as string,
    }));

  const messageText = [
    textBodies.join("\n"),
    hasNonText
      ? "The diner also sent an attachment that cannot be inspected here."
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const restaurantContext = await loadRestaurantMenuContext(conversation.restaurantId);
  if (!restaurantContext) {
    await releaseClaim(claimed.claimId, claimed.idempotencyKey);
    return;
  }
  const restaurant = {
    ...restaurantContext,
    recentOrders: await recentOrdersForPhone(conversation.restaurantId, conversation.customerPhone),
  };

  let turn;
  try {
    turn = await runConciergeTurn({
      restaurant,
      channel: "whatsapp",
      message: messageText,
      history,
      language,
      customerPhone: conversation.customerPhone,
    });
  } catch (error) {
    // Model failure: release the claim so the retry (or the final fallback)
    // can re-derive and re-claim this batch.
    await releaseClaim(claimed.claimId, claimed.idempotencyKey);
    throw error;
  }

  const shouldEscalate = turn.action === "escalate";
  await sendClaimedReply({
    ...sendInput,
    body: shouldEscalate ? turn.reply || handoffMessage(language) : turn.reply,
    pauseUntil: shouldEscalate ? new Date(Date.now() + PAUSE_24H_MS) : null,
    pauseReason: shouldEscalate ? "agent_escalated" : null,
  });

  console.log("[diner-concierge] turn", {
    restaurantId: conversation.restaurantId,
    conversationId: conversation.id,
    outcome: turn.action,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadInputTokens: turn.cacheReadInputTokens,
    cacheCreationInputTokens: turn.cacheCreationInputTokens,
    unansweredCount: claimed.batch.length,
  });
}

// The final fallback runs the SAME eligibility gates and the SAME locked
// claim as a normal reply. If the owner answered during the retry window,
// the bot was paused/disabled, the cap ran out, or the batch was already
// claimed, it stays silent.
async function sendFinalFallback(job: ConciergeWorkerJob, error: unknown) {
  captureException(error, {
    tags: { job: DINER_CONCIERGE_JOB, final: true },
    extra: { data: job.data },
  });

  const conversation = await checkEligibility(job.data);
  if (!conversation?.integration) {
    return;
  }

  const claimed = await claimUnansweredBatch({
    restaurantId: conversation.restaurantId,
    integrationId: conversation.integration.id,
    conversationId: conversation.id,
    customerId: conversation.customerId,
    customerPhone: conversation.customerPhone,
    displayPhoneNumber: conversation.integration.displayPhoneNumber,
  });
  if (!claimed) {
    return;
  }

  try {
    await sendClaimedReply({
      claimId: claimed.claimId,
      idempotencyKey: claimed.idempotencyKey,
      restaurantId: conversation.restaurantId,
      conversationId: conversation.id,
      accessTokenCipher: conversation.integration.accessTokenCipher,
      phoneNumberId: conversation.integration.phoneNumberId,
      customerPhone: conversation.customerPhone,
      body: fallbackMessage(
        (conversation.customer?.preferredLanguage ?? job.data.language) as
          | ConciergeLanguage
          | undefined
      ),
      pauseUntil: new Date(Date.now() + PAUSE_24H_MS),
      pauseReason: "agent_escalated",
    });
  } catch (fallbackError) {
    captureException(fallbackError, {
      tags: { job: DINER_CONCIERGE_JOB, fallback: true },
      extra: { data: job.data },
    });
  }
}

export async function startDinerConciergeWorker() {
  await ensureQueue();
  const queue = await getBoss();

  // batchSize MUST stay 1: pg-boss fails a whole batch when the handler
  // throws, which would fail innocent co-batched jobs and burn their
  // retries without running them.
  await queue.work<DinerConciergeJobData>(
    DINER_CONCIERGE_JOB,
    { batchSize: 1, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as ConciergeWorkerJob[]) {
        try {
          await processConciergeJob(job);
        } catch (error) {
          const finalAttempt = job.retryCount >= job.retryLimit;
          if (finalAttempt) {
            await sendFinalFallback(job, error);
            continue;
          }
          captureException(error, {
            tags: { job: DINER_CONCIERGE_JOB },
            extra: { data: job.data, retryCount: job.retryCount },
          });
          throw error;
        }
      }
    }
  );
}
