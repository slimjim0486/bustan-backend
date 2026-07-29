// Proactive event nudges for Bustan. The event-stager fan-out decides when a
// calendar moment is worth acting on; this worker turns a fresh staging into a
// report-moment card in the owner chat.

import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import PgBoss from "pg-boss";
import { estimateAiUsageCost, logAiUsage } from "@/lib/ai-usage";
import { env } from "@/lib/env";
import {
  buildEventNudgePrompt,
  parseEventNudgeResponse,
  type EventNudgeSnapshot,
  type MemoryItem,
} from "@/lib/owner-chat-prompts";
import { prisma } from "@/lib/prisma";
import { STANDING_INSTRUCTION_TYPE } from "@/lib/standing-instructions";
import { getBoss } from "@/queue/boss";
import { getMomentById } from "@/services/ad-studio/calendar";
import { createSousChefMessage } from "@/services/anthropic-models";

export const PROACTIVE_NUDGE_GENERATE_JOB = "proactive-nudge-generate";

const RETRY_LIMIT = 1;

let generateQueueReady: Promise<void> | null = null;

async function ensureGenerateQueue() {
  if (!generateQueueReady) {
    generateQueueReady = getBoss()
      .then((queue) => queue.createQueue(PROACTIVE_NUDGE_GENERATE_JOB))
      .catch((error) => {
        generateQueueReady = null;
        throw error;
      });
  }
  await generateQueueReady;
}

export interface ProactiveNudgeGenerateJobData {
  restaurantId: string;
  momentId: string;
  momentYear: number;
  adProjectId?: string | null;
}

type GenerateWorkerJob = PgBoss.JobWithMetadata<ProactiveNudgeGenerateJobData>;

let anthropic: Anthropic | null = null;
function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "" });
  }
  return anthropic;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function daysUntil(fromIso: string): number {
  const today = new Date();
  const start = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  const target = new Date(`${fromIso}T00:00:00Z`);
  return Math.max(0, Math.ceil((target.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}

function buildSnapshot(args: {
  restaurantName: string;
  momentId: string;
  momentYear: number;
  adProjectId: string | null;
}): EventNudgeSnapshot | null {
  const moment = getMomentById(args.momentId);
  const occurrence = moment?.dates.find((d) => d.year === args.momentYear);
  if (!moment || !occurrence) return null;

  return {
    restaurantName: args.restaurantName,
    adProjectId: args.adProjectId,
    moment: {
      id: moment.id,
      name: moment.name,
      kind: moment.kind,
      year: args.momentYear,
      from: occurrence.from,
      to: occurrence.to,
      daysOut: daysUntil(occurrence.from),
      spendPulse: moment.spendPulse,
      creativeAngles: moment.creativeAngles.slice(0, 5),
      doList: moment.doList.slice(0, 5),
      doNotList: moment.doNotList.slice(0, 5),
    },
  };
}

export async function startProactiveNudgeWorker() {
  await ensureGenerateQueue();
  const queue = await getBoss();

  await queue.work<ProactiveNudgeGenerateJobData>(
    PROACTIVE_NUDGE_GENERATE_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as GenerateWorkerJob[]) {
        try {
          await processGenerateJob(job);
        } catch (error) {
          console.warn(
            `[proactive-nudge] generate failed for ${job.data.restaurantId} ${job.data.momentId}:${job.data.momentYear}:`,
            error
          );
        }
      }
    }
  );
}

async function processGenerateJob(job: GenerateWorkerJob) {
  const { restaurantId, momentId, momentYear, adProjectId = null } = job.data;

  if (!env.ANTHROPIC_API_KEY) {
    console.warn(`[proactive-nudge] no ANTHROPIC_API_KEY; skipping ${restaurantId}`);
    return;
  }

  const placeholder = await prisma.proactiveNudge
    .create({
      data: {
        restaurantId,
        momentId,
        momentYear,
        adProjectId,
        narrative: "",
        actionsJson: [],
        status: "generating",
        costUsd: 0,
      },
      select: { id: true },
    })
    .catch((error) => {
      if (isUniqueConstraintError(error)) return null;
      throw error;
    });

  if (!placeholder) return;

  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true },
    });
    if (!restaurant) {
      await prisma.proactiveNudge.delete({ where: { id: placeholder.id } });
      return;
    }

    const [memoryRows] = await Promise.all([
      prisma.ownerChatMemory.findMany({
        where: {
          restaurantId,
          type: { not: STANDING_INSTRUCTION_TYPE },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: [{ lastReinforced: "desc" }, { confidence: "desc" }],
        take: 10,
        select: { type: true, content: true },
      }),
    ]);

    const snapshot = buildSnapshot({
      restaurantName: restaurant.name,
      momentId,
      momentYear,
      adProjectId,
    });
    if (!snapshot) {
      await prisma.proactiveNudge.delete({ where: { id: placeholder.id } });
      return;
    }

    const memories: MemoryItem[] = memoryRows.map((m) => ({ type: m.type, content: m.content }));
    const prompt = buildEventNudgePrompt(snapshot, memories);

    const client = getClient();
    const response = await createSousChefMessage(
      client,
      {
        max_tokens: 600,
        system:
          "You are Bustan writing a proactive event nudge. Output ONLY the JSON object described. No prose, no code fences.",
        messages: [{ role: "user", content: prompt }],
      },
      { route: "proactive-nudge", restaurantId, momentId, momentYear }
    );

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const parsed = parseEventNudgeResponse(text);
    if (!parsed) {
      console.warn(`[proactive-nudge] unparseable response for ${restaurantId} ${momentId}:${momentYear}`);
      await prisma.proactiveNudge.delete({ where: { id: placeholder.id } });
      await logAiUsage(
        restaurantId,
        "owner_chat_nudge",
        response.usage.input_tokens,
        response.usage.output_tokens
      );
      return;
    }

    const costUsd = estimateAiUsageCost(
      "owner_chat_nudge",
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    await prisma.$transaction(async (tx) => {
      await tx.proactiveNudge.update({
        where: { id: placeholder.id },
        data: {
          narrative: parsed.narrative,
          actionsJson: JSON.parse(JSON.stringify(parsed.actions)) as Prisma.InputJsonValue,
          status: "unread",
          generatedAt: new Date(),
          costUsd,
        },
      });

      await tx.ownerChatMessage.create({
        data: {
          restaurantId,
          role: "assistant",
          content: parsed.narrative,
          source: "event_nudge",
          nudgeId: placeholder.id,
        },
      });
    });

    await logAiUsage(
      restaurantId,
      "owner_chat_nudge",
      response.usage.input_tokens,
      response.usage.output_tokens
    );
  } catch (error) {
    await prisma.proactiveNudge.deleteMany({
      where: { id: placeholder.id, status: "generating" },
    });
    throw error;
  }

  console.log(`[proactive-nudge] ${restaurantId} ${momentId}:${momentYear} ok`);
}

export async function enqueueProactiveNudge(args: ProactiveNudgeGenerateJobData) {
  await ensureGenerateQueue();
  const queue = await getBoss();
  await queue.send(PROACTIVE_NUDGE_GENERATE_JOB, args, { retryLimit: RETRY_LIMIT });
}
