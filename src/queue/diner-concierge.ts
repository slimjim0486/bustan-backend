import { Prisma } from "@prisma/client";
import PgBoss from "pg-boss";
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
  IGNORED_TYPES,
  MEDIA_TYPES,
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
  triggerMessageId: string;
  triggerMessageAt: string;
  language?: ConciergeLanguage;
  escalateOnly?: boolean;
}

type ConciergeWorkerJob = PgBoss.JobWithMetadata<DinerConciergeJobData>;

function isActivePause(conversation: { botPausedUntil: Date | null }) {
  return Boolean(conversation.botPausedUntil && conversation.botPausedUntil.getTime() > Date.now());
}

type StoredConciergeMessage = {
  id: string;
  direction: "inbound" | "outbound";
  source: string;
  type: string;
  body: string | null;
  createdAt: Date;
};

export function deriveUnansweredBatch(messages: StoredConciergeMessage[]) {
  const lastAnsweredAt = messages
    .filter(
      (message) =>
        message.direction === "outbound" &&
        (message.source === "bot" || message.source === "owner")
    )
    .reduce<Date | null>(
      (latest, message) =>
        !latest || message.createdAt > latest ? message.createdAt : latest,
      null
    );

  return messages
    .filter(
      (message) =>
        message.direction === "inbound" &&
        message.source === "diner" &&
        (!lastAnsweredAt || message.createdAt > lastAnsweredAt)
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

function isSyntheticMediaBody(message: StoredConciergeMessage) {
  const body = message.body?.trim();
  return !body || body === `[${message.type} message]` || body === "[message]";
}

function messageBodyForConcierge(message: StoredConciergeMessage) {
  const body = message.body?.trim();
  if (!body || IGNORED_TYPES.has(message.type)) return null;
  if (MEDIA_TYPES.has(message.type) && isSyntheticMediaBody(message)) return null;
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

function replyIdempotencyKey(messageId: string, kind: "reply" | "fallback" = "reply") {
  return `dc:${messageId}:${kind}`;
}

async function hasOutboundClaim(idempotencyKey: string) {
  const existing = await prisma.whatsAppMessage.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  });
  return Boolean(existing);
}

export async function sendAndRecord(input: {
  restaurantId: string;
  integrationId: string;
  accessTokenCipher: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  conversationId: string;
  customerId: string | null;
  customerPhone: string;
  body: string;
  source: "bot" | "system";
  idempotencyKey: string;
  pauseReason?: string | null;
  pauseUntil?: Date | null;
}) {
  const sentAt = new Date();
  let claimId = "";

  try {
    const claim = await prisma.whatsAppMessage.create({
      data: {
        restaurantId: input.restaurantId,
        integrationId: input.integrationId,
        conversationId: input.conversationId,
        customerId: input.customerId,
        idempotencyKey: input.idempotencyKey,
        direction: "outbound",
        type: "text",
        status: "queued",
        source: input.source,
        fromPhone: input.displayPhoneNumber,
        toPhone: input.customerPhone,
        body: input.body,
      },
      select: { id: true },
    });
    claimId = claim.id;
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      return;
    }
    throw error;
  }

  let providerMessageId: string;
  try {
    providerMessageId = await sendWhatsAppText({
      accessToken: decryptAccessToken(input.accessTokenCipher),
      phoneNumberId: input.phoneNumberId,
      to: input.customerPhone,
      body: input.body,
    });
  } catch (error) {
    await prisma.whatsAppMessage
      .delete({ where: { id: claimId } })
      .catch((deleteError) => {
        captureException(deleteError, {
          tags: { job: DINER_CONCIERGE_JOB, phase: "delete_failed_send_claim" },
          extra: { idempotencyKey: input.idempotencyKey, claimId },
        });
      });
    throw error;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.whatsAppMessage.update({
        where: { id: claimId },
        data: {
          providerMessageId,
          status: "sent",
          sentAt,
        },
      });

      await tx.whatsAppConversation.update({
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
      });
    });
  } catch (error) {
    captureException(error, {
      tags: { job: DINER_CONCIERGE_JOB, phase: "post_send_bookkeeping" },
      extra: {
        idempotencyKey: input.idempotencyKey,
        claimId,
        providerMessageId,
      },
    });
  }

  try {
    await incrementConciergeUsage(input.restaurantId);
  } catch (error) {
    captureException(error, {
      tags: { job: DINER_CONCIERGE_JOB, phase: "usage_increment" },
      extra: { idempotencyKey: input.idempotencyKey, claimId },
    });
  }
}

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
      },
      customer: {
        select: {
          preferredLanguage: true,
        },
      },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 25,
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

async function processConciergeJob(job: ConciergeWorkerJob) {
  const data = job.data;
  const conversation = await loadConversationForJob(data);

  if (!conversation || !conversation.integration || conversation.integration.status !== "connected") {
    return;
  }

  if (!conversation.restaurant.dinerAutoReplyEnabled) {
    return;
  }
  if (conversation.botDisabled || isActivePause(conversation)) {
    return;
  }

  const cap = getConciergeMonthlyCap(conversation.restaurant);
  const usage = await getConciergeUsageState(conversation.restaurantId, cap);
  if (!usage.allowed) {
    return;
  }

  const unanswered = deriveUnansweredBatch(conversation.messages);
  if (unanswered.length === 0) {
    return;
  }

  const firstUnanswered = unanswered[0];
  const lastUnanswered = unanswered[unanswered.length - 1];
  const idempotencyKey = replyIdempotencyKey(lastUnanswered.id);
  if (await hasOutboundClaim(idempotencyKey)) {
    return;
  }

  const ownerAfterFirstUnanswered = conversation.messages.some(
    (message) => message.source === "owner" && message.createdAt > firstUnanswered.createdAt
  );
  if (ownerAfterFirstUnanswered) {
    return;
  }

  const mediaMessages = unanswered.filter((message) => MEDIA_TYPES.has(message.type));
  const textBodies = unanswered
    .map(messageBodyForConcierge)
    .filter((body): body is string => Boolean(body));
  const language = conversation.customer?.preferredLanguage ?? data.language;

  if (mediaMessages.length > 0 && textBodies.length === 0) {
    await sendAndRecord({
      restaurantId: conversation.restaurantId,
      integrationId: conversation.integration.id,
      accessTokenCipher: conversation.integration.accessTokenCipher,
      phoneNumberId: conversation.integration.phoneNumberId,
      displayPhoneNumber: conversation.integration.displayPhoneNumber,
      conversationId: conversation.id,
      customerId: conversation.customerId,
      customerPhone: conversation.customerPhone,
      body: handoffMessage(language),
      source: "bot",
      idempotencyKey,
      pauseUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      pauseReason: "agent_escalated",
    });
    return;
  }

  if (textBodies.length === 0) {
    return;
  }

  const unansweredIds = new Set(unanswered.map((message) => message.id));
  const recentMessages = conversation.messages
    .slice()
    .reverse()
    .filter((message) => !unansweredIds.has(message.id))
    .filter((message) => messageBodyForConcierge(message))
    .slice(-20)
    .map((message) => ({
      role: message.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: messageBodyForConcierge(message) as string,
    }));

  const messageText = [
    textBodies.join("\n"),
    mediaMessages.length > 0
      ? "The diner also sent an attachment that cannot be inspected here."
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const restaurant = {
    ...conversation.restaurant,
    recentOrders: await recentOrdersForPhone(conversation.restaurantId, conversation.customerPhone),
  };
  const turn = await runConciergeTurn({
    restaurant,
    channel: "whatsapp",
    message: messageText,
    history: recentMessages,
    language,
    customerPhone: conversation.customerPhone,
  });

  const shouldEscalate = turn.action === "escalate";
  await sendAndRecord({
    restaurantId: conversation.restaurantId,
    integrationId: conversation.integration.id,
    accessTokenCipher: conversation.integration.accessTokenCipher,
    phoneNumberId: conversation.integration.phoneNumberId,
    displayPhoneNumber: conversation.integration.displayPhoneNumber,
    conversationId: conversation.id,
    customerId: conversation.customerId,
    customerPhone: conversation.customerPhone,
    body: shouldEscalate ? turn.reply || handoffMessage(language) : turn.reply,
    source: "bot",
    idempotencyKey,
    pauseUntil: shouldEscalate ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
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
    unansweredCount: unanswered.length,
  });
}

async function sendFinalFallback(job: ConciergeWorkerJob, error: unknown) {
  captureException(error, {
    tags: { job: DINER_CONCIERGE_JOB, final: true },
    extra: { data: job.data },
  });

  const conversation = await loadConversationForJob(job.data);
  if (!conversation?.integration || conversation.integration.status !== "connected") {
    return;
  }

  const unanswered = deriveUnansweredBatch(conversation.messages);
  const anchorMessageId = unanswered.at(-1)?.id ?? job.data.triggerMessageId;
  const replyKey = replyIdempotencyKey(anchorMessageId);
  if (await hasOutboundClaim(replyKey)) {
    return;
  }

  try {
    await sendAndRecord({
      restaurantId: conversation.restaurantId,
      integrationId: conversation.integration.id,
      accessTokenCipher: conversation.integration.accessTokenCipher,
      phoneNumberId: conversation.integration.phoneNumberId,
      displayPhoneNumber: conversation.integration.displayPhoneNumber,
      conversationId: conversation.id,
      customerId: conversation.customerId,
      customerPhone: conversation.customerPhone,
      body: fallbackMessage(conversation.customer?.preferredLanguage ?? job.data.language),
      source: "bot",
      idempotencyKey: replyIdempotencyKey(anchorMessageId, "fallback"),
      pauseUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
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

  await queue.work<DinerConciergeJobData>(
    DINER_CONCIERGE_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
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
