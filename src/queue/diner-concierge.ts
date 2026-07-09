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
    } as PgBoss.SendOptions
  );
}

async function sendAndRecord(input: {
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
  pauseReason?: string | null;
  pauseUntil?: Date | null;
}) {
  const sentAt = new Date();
  const providerMessageId = await sendWhatsAppText({
    accessToken: decryptAccessToken(input.accessTokenCipher),
    phoneNumberId: input.phoneNumberId,
    to: input.customerPhone,
    body: input.body,
  });

  await prisma.$transaction(async (tx) => {
    await tx.whatsAppMessage.create({
      data: {
        restaurantId: input.restaurantId,
        integrationId: input.integrationId,
        conversationId: input.conversationId,
        customerId: input.customerId,
        providerMessageId,
        direction: "outbound",
        type: "text",
        status: "sent",
        source: input.source,
        fromPhone: input.displayPhoneNumber,
        toPhone: input.customerPhone,
        body: input.body,
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

  await incrementConciergeUsage(input.restaurantId);
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

  const triggerAt = new Date(data.triggerMessageAt);
  const ownerAfterTrigger = conversation.messages.some(
    (message) => message.source === "owner" && message.createdAt > triggerAt
  );
  if (ownerAfterTrigger) {
    return;
  }

  const latestInbound = conversation.messages.find(
    (message) => message.direction === "inbound" && message.source === "diner"
  );
  if (!latestInbound) {
    return;
  }

  const botAfterLatestInbound = conversation.messages.some(
    (message) =>
      message.source === "bot" &&
      message.createdAt > latestInbound.createdAt
  );
  if (botAfterLatestInbound) {
    return;
  }

  if (data.escalateOnly) {
    await sendAndRecord({
      restaurantId: conversation.restaurantId,
      integrationId: conversation.integration.id,
      accessTokenCipher: conversation.integration.accessTokenCipher,
      phoneNumberId: conversation.integration.phoneNumberId,
      displayPhoneNumber: conversation.integration.displayPhoneNumber,
      conversationId: conversation.id,
      customerId: conversation.customerId,
      customerPhone: conversation.customerPhone,
      body: handoffMessage(data.language),
      source: "bot",
      pauseUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      pauseReason: "agent_escalated",
    });
    return;
  }

  const recentMessages = conversation.messages
    .slice()
    .reverse()
    .slice(-20)
    .filter((message) => message.body?.trim())
    .map((message) => ({
      role: message.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: message.body as string,
    }));

  const restaurant = {
    ...conversation.restaurant,
    recentOrders: await recentOrdersForPhone(conversation.restaurantId, conversation.customerPhone),
  };
  const latestText = latestInbound.body ?? "";
  const turn = await runConciergeTurn({
    restaurant,
    channel: "whatsapp",
    message: latestText,
    history: recentMessages,
    language: data.language,
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
    body: shouldEscalate ? turn.reply || handoffMessage(data.language) : turn.reply,
    source: "bot",
    pauseUntil: shouldEscalate ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
    pauseReason: shouldEscalate ? "agent_escalated" : null,
  });

  console.log("[diner-concierge] turn", {
    restaurantId: conversation.restaurantId,
    conversationId: conversation.id,
    outcome: turn.action,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
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
      body: fallbackMessage(job.data.language),
      source: "bot",
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
