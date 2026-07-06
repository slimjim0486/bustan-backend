// Nightly memory-extraction job for Sous Chef.
// Distills durable facts from the last 24h of owner chat into OwnerChatMemory.
// Pattern mirrors ad-studio-jobs.ts.

import Anthropic from "@anthropic-ai/sdk";
import PgBoss from "pg-boss";
import { logAiUsage } from "@/lib/ai-usage";
import { env } from "@/lib/env";
import {
  buildMemoryExtractionPrompt,
  isUnsafeMemoryContent,
  type ExtractionMessage,
  type MemoryItem,
} from "@/lib/owner-chat-prompts";
import { prisma } from "@/lib/prisma";
import { getBoss } from "@/queue/image-generation";
import { createSousChefMessage } from "@/services/anthropic-models";

export const OWNER_CHAT_MEMORY_FANOUT_JOB = "owner-chat-memory-fanout";
export const OWNER_CHAT_MEMORY_EXTRACT_JOB = "owner-chat-memory-extract";

const RETRY_LIMIT = 1;
const MAX_NEW_MEMORIES_PER_NIGHT = 5;
const LOOKBACK_HOURS = 24;
const FANOUT_RESTAURANT_CAP = 500;

let fanoutQueueReady: Promise<void> | null = null;
let extractQueueReady: Promise<void> | null = null;

async function ensureFanoutQueue() {
  if (!fanoutQueueReady) {
    fanoutQueueReady = getBoss()
      .then((queue) => queue.createQueue(OWNER_CHAT_MEMORY_FANOUT_JOB))
      .catch((error) => {
        fanoutQueueReady = null;
        throw error;
      });
  }
  await fanoutQueueReady;
}

async function ensureExtractQueue() {
  if (!extractQueueReady) {
    extractQueueReady = getBoss()
      .then((queue) => queue.createQueue(OWNER_CHAT_MEMORY_EXTRACT_JOB))
      .catch((error) => {
        extractQueueReady = null;
        throw error;
      });
  }
  await extractQueueReady;
}

export interface OwnerChatMemoryExtractJobData {
  restaurantId: string;
}

type ExtractWorkerJob = PgBoss.JobWithMetadata<OwnerChatMemoryExtractJobData>;

let anthropic: Anthropic | null = null;
function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "" });
  }
  return anthropic;
}

export async function startOwnerChatMemoryWorker() {
  await ensureFanoutQueue();
  await ensureExtractQueue();
  const queue = await getBoss();

  await queue.work<OwnerChatMemoryExtractJobData>(
    OWNER_CHAT_MEMORY_EXTRACT_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as ExtractWorkerJob[]) {
        try {
          await processExtractJob(job);
        } catch (error) {
          console.warn(
            `[owner-chat-memory] extract failed for ${job.data.restaurantId}:`,
            error
          );
          // Don't re-throw — one bad restaurant must not cascade
        }
      }
    }
  );

  // Daily at 01:00 UTC (= 05:00 GST). Runs before the 07:00 GST Whisper so
  // extracted memories are fresh when the briefing is generated.
  await queue.schedule(OWNER_CHAT_MEMORY_FANOUT_JOB, "0 1 * * *", undefined, {
    tz: "UTC",
  });
  await queue.work(OWNER_CHAT_MEMORY_FANOUT_JOB, async () => {
    await fanOutMemoryJobs();
  });
}

async function fanOutMemoryJobs() {
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  // Find restaurants with new owner-authored messages in the last LOOKBACK_HOURS.
  // (Assistant-only or whisper-only days produce nothing to extract.)
  const distinctRows = await prisma.ownerChatMessage.findMany({
    where: {
      role: "user",
      source: "chat",
      createdAt: { gte: cutoff },
    },
    distinct: ["restaurantId"],
    orderBy: { createdAt: "desc" },
    select: { restaurantId: true },
    take: FANOUT_RESTAURANT_CAP,
  });

  await ensureExtractQueue();
  const queue = await getBoss();
  for (const r of distinctRows) {
    await queue.send(
      OWNER_CHAT_MEMORY_EXTRACT_JOB,
      { restaurantId: r.restaurantId },
      { retryLimit: RETRY_LIMIT }
    );
  }
  const rows = distinctRows;
  if (rows.length === FANOUT_RESTAURANT_CAP) {
    console.warn(
      `[owner-chat-memory] fan-out hit cap of ${FANOUT_RESTAURANT_CAP} — consider raising`
    );
  }
  console.log(`[owner-chat-memory] fanned out ${rows.length} extract jobs`);
}

interface ExtractedMemory {
  type: string;
  content: string;
  confidence?: number;
  tags?: string[];
}

function safeParseExtraction(raw: string): ExtractedMemory[] {
  // Strip code fences if model wrapped JSON in ```json ... ```
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  const memories =
    typeof parsed === "object" &&
    parsed !== null &&
    "memories" in parsed &&
    Array.isArray((parsed as { memories?: unknown }).memories)
      ? ((parsed as { memories: unknown[] }).memories)
      : [];

  const allowedTypes = new Set(["preference", "fact", "goal", "concern"]);
  return memories
    .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
    .map((m) => ({
      type: String(m.type ?? "").toLowerCase(),
      content: String(m.content ?? "").trim(),
      confidence:
        typeof m.confidence === "number" ? Math.max(0, Math.min(1, m.confidence)) : 0.7,
      tags: Array.isArray(m.tags)
        ? (m.tags as unknown[])
            .map((t) => String(t).trim().toLowerCase())
            .filter((t) => t.length > 0)
            .slice(0, 3)
        : [],
    }))
    .filter(
      (m) =>
        allowedTypes.has(m.type) &&
        m.content.length > 0 &&
        m.content.length <= 400 &&
        !isUnsafeMemoryContent(m.content)
    );
}

async function processExtractJob(job: ExtractWorkerJob) {
  const { restaurantId } = job.data;

  if (!env.ANTHROPIC_API_KEY) {
    console.warn(`[owner-chat-memory] no ANTHROPIC_API_KEY; skipping ${restaurantId}`);
    return;
  }

  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  // Pull recent user + assistant messages (skip system/whisper noise)
  const recent = await prisma.ownerChatMessage.findMany({
    where: {
      restaurantId,
      role: { in: ["user", "assistant"] },
      source: "chat",
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "asc" },
    take: 60,
    select: { role: true, content: true },
  });

  if (recent.length === 0) {
    return;
  }

  // Fetch restaurant name + existing memories for the prompt
  const [restaurant, existingMemoriesRows] = await Promise.all([
    prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true },
    }),
    prisma.ownerChatMemory.findMany({
      where: { restaurantId, type: { not: "standing_instruction" } },
      orderBy: { lastReinforced: "desc" },
      take: 30,
      select: { id: true, type: true, content: true },
    }),
  ]);

  if (!restaurant) return;

  const existingForPrompt: MemoryItem[] = existingMemoriesRows.map((m) => ({
    type: m.type,
    content: m.content,
  }));

  const recentForPrompt: ExtractionMessage[] = recent.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const prompt = buildMemoryExtractionPrompt(
    restaurant.name,
    recentForPrompt,
    existingForPrompt
  );

  const client = getClient();
  const response = await createSousChefMessage(client, {
    max_tokens: 800,
    system:
      "You are a memory-extraction utility. Output ONLY strict JSON matching the schema in the user prompt. No prose, no markdown fences.",
    messages: [{ role: "user", content: prompt }],
  }, {
    route: "owner-chat-memory",
    restaurantId,
  });

  const rawText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((b) => b.text)
    .join("\n");

  const extracted = safeParseExtraction(rawText).slice(0, MAX_NEW_MEMORIES_PER_NIGHT);

  if (extracted.length === 0) {
    await logAiUsage(
      restaurantId,
      "owner_chat_extraction",
      response.usage.input_tokens,
      response.usage.output_tokens
    );
    return;
  }

  // Dedup: case-insensitive substring overlap against existing memories.
  // If overlap, reinforce instead of inserting a near-duplicate.
  const existingLowered = existingMemoriesRows.map((m) => ({
    id: m.id,
    content: m.content.toLowerCase(),
  }));

  const inserts: Array<{
    type: string;
    content: string;
    confidence: number;
    tags: string[];
  }> = [];
  const reinforceIds: string[] = [];

  for (const m of extracted) {
    const lower = m.content.toLowerCase();
    const match = existingLowered.find(
      (e) => e.content.includes(lower) || lower.includes(e.content)
    );
    if (match) {
      reinforceIds.push(match.id);
    } else {
      inserts.push({
        type: m.type,
        content: m.content,
        confidence: m.confidence ?? 0.7,
        tags: m.tags ?? [],
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    if (reinforceIds.length > 0) {
      await tx.ownerChatMemory.updateMany({
        where: { id: { in: reinforceIds } },
        data: {
          lastReinforced: new Date(),
          reinforceCount: { increment: 1 },
        },
      });
    }

    if (inserts.length > 0) {
      await tx.ownerChatMemory.createMany({
        data: inserts.map((m) => ({
          restaurantId,
          type: m.type,
          content: m.content,
          confidence: m.confidence,
          tags: m.tags,
        })),
      });
    }
  });

  await logAiUsage(
    restaurantId,
    "owner_chat_extraction",
    response.usage.input_tokens,
    response.usage.output_tokens
  );

  console.log(
    `[owner-chat-memory] ${restaurantId}: ${inserts.length} new, ${reinforceIds.length} reinforced`
  );
}

// Exported for the admin/test endpoint so we can trigger extraction on demand
export async function enqueueExtractionForRestaurant(restaurantId: string) {
  await ensureExtractQueue();
  const queue = await getBoss();
  await queue.send(
    OWNER_CHAT_MEMORY_EXTRACT_JOB,
    { restaurantId },
    { retryLimit: RETRY_LIMIT }
  );
}
