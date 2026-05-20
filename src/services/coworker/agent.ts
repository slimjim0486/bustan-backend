// Coworker LLM agent — the non-streaming sibling of routes/owner-chat.ts.
//
// Reuses everything the dashboard chat uses (OWNER_TOOLS + executeTool +
// buildOwnerSystemPrompt + OwnerChatMessage thread + OwnerChatMemory) so the
// owner gets the same Sous Chef whether they tap from the dashboard or DM
// from WhatsApp. Persisted history is the single source of truth — a
// WhatsApp reply on Tuesday morning sees the questions the owner asked from
// the dashboard on Monday afternoon.
//
// One important divergence from the SSE route: WhatsApp expects ONE final
// text per turn. We collect the full assistant text across tool iterations
// and send it as a single message at the end. We deliberately do NOT stream
// partial fragments to WhatsApp (no chunking) — that would cost a
// service-conversation per fragment and read terribly in WhatsApp UI.

import Anthropic from "@anthropic-ai/sdk";
import { estimateAiUsageCost, logAiUsage } from "@/lib/ai-usage";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { buildOwnerSystemPrompt } from "@/lib/owner-chat-prompts";
import { prisma } from "@/lib/prisma";
import { createSousChefMessage } from "@/services/anthropic-models";
import { OWNER_TOOLS, executeTool } from "@/services/owner-chat-tools";

const MAX_TOOL_ITERATIONS = 6;
const THREAD_HISTORY_LIMIT = 20;
// Hard cap so a runaway response never exceeds WhatsApp's 4096-char text body limit.
const WA_REPLY_MAX_CHARS = 3500;

// Same injection patterns the dashboard route uses, so a WhatsApp owner who
// tries the same trick gets the same refusal.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /forget\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions|rules|prompts?)/i,
  /new\s+(system\s+)?(instructions?|rules?|prompt)/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /<<\s*SYS\s*>>/i,
  /jailbreak/i,
];

const INJECTION_REFUSAL =
  "I'm Sous Chef, your restaurant assistant! How can I help you manage your restaurant today?";

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ApiError("Sous Chef is not configured (ANTHROPIC_API_KEY missing).", 503);
  }
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

function checkInjection(message: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) return INJECTION_REFUSAL;
  }
  return null;
}

function clampReply(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= WA_REPLY_MAX_CHARS) return trimmed;
  return trimmed.slice(0, WA_REPLY_MAX_CHARS - 1) + "…";
}

export interface AgentInput {
  /** The restaurant the owner is talking about. Comes from CoworkerOwner. */
  restaurantId: string;
  /** Clerk user id, used by the existing tools for ownership/audit checks. */
  clerkId: string;
  /** Raw message text from WhatsApp (already stripped of @mentions etc). */
  message: string;
}

export interface AgentReply {
  text: string;
  /** Inclusive token counts across all tool iterations, for ai_usage logging. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True if the LLM refused due to injection — caller can choose to skip
   *  persisting the user turn in that case. */
  refused: boolean;
}

/** Run the Sous Chef loop synchronously, return the final assistant text.
 *  Persists the user + assistant turn to OwnerChatMessage (source="whisper"
 *  per the existing schema's enum-ish convention — we use "whatsapp" so it's
 *  distinguishable in the dashboard thread). */
export async function runAgentTurn(input: AgentInput): Promise<AgentReply> {
  const refusal = checkInjection(input.message);
  if (refusal) {
    return { text: refusal, inputTokens: 0, outputTokens: 0, costUsd: 0, refused: true };
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: input.restaurantId },
    include: {
      subscription: true,
      operatorAccount: { include: { _count: { select: { brands: true } } } },
      _count: { select: { menuSections: true } },
    },
  });
  if (!restaurant) {
    throw new ApiError("Restaurant not found for Coworker reply.", 404);
  }

  const entitlements = getRestaurantEntitlements(restaurant);

  const totalItems = await prisma.menuItem.count({ where: { restaurantId: input.restaurantId } });

  const memoryRows = await prisma.ownerChatMemory.findMany({
    where: {
      restaurantId: input.restaurantId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ lastReinforced: "desc" }, { confidence: "desc" }],
    take: 20,
    select: { type: true, content: true },
  });

  // Usage summaries for the system prompt. We pass zeros for any value we
  // don't readily have — keeps the prompt builder happy without an extra
  // DB call.
  const systemPrompt = buildOwnerSystemPrompt(
    {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
      cuisineType: restaurant.cuisineType,
      location: restaurant.location,
      isPublished: restaurant.isPublished,
      description: restaurant.description,
      plan: entitlements.plan,
      totalSections: restaurant._count.menuSections,
      totalItems,
    },
    entitlements,
    {
      descriptions: { used: 0, limit: entitlements.aiDescriptionLimit },
      tags: { used: 0, limit: entitlements.aiTagAnalysisLimit },
      analysis: { used: 0, limit: entitlements.analysisLimit },
      images: { used: 0, limit: entitlements.imageEnhancementLimit },
    },
    memoryRows
  );

  const persistedRows = await prisma.ownerChatMessage.findMany({
    where: { restaurantId: input.restaurantId, role: { in: ["user", "assistant"] } },
    orderBy: { createdAt: "desc" },
    take: THREAD_HISTORY_LIMIT,
    select: { role: true, content: true },
  });
  const persistedHistory = persistedRows.reverse();

  const wrapOwnerMessage = (text: string) => `<owner_message>${text}</owner_message>`;

  const messages: Anthropic.MessageParam[] = [
    ...persistedHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.role === "user" ? wrapOwnerMessage(m.content) : m.content,
    })),
    { role: "user" as const, content: wrapOwnerMessage(input.message) },
  ];

  const client = getClient();
  let totalIn = 0;
  let totalOut = 0;
  let assistantText = "";
  let iterations = 0;

  while (iterations <= MAX_TOOL_ITERATIONS) {
    const response = await createSousChefMessage(
      client,
      {
        max_tokens: 1024,
        system: systemPrompt,
        tools: OWNER_TOOLS,
        messages,
      },
      { route: "coworker-whatsapp", restaurantId: input.restaurantId, iteration: iterations }
    );

    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        assistantText += block.text;
      }
    }

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") break;

    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (toolBlocks.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolBlocks) {
      const result = await executeTool(
        block.name,
        input.restaurantId,
        input.clerkId,
        entitlements,
        block.input as Record<string, unknown>
      );
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
      });
    }
    messages.push({ role: "user", content: toolResults });
    iterations++;
  }

  const finalText = clampReply(assistantText) ||
    "I'm here — but didn't catch that. Try asking me something specific, like 'how did Karama do yesterday?'";

  const costUsd = estimateAiUsageCost("owner_chat", totalIn, totalOut);

  // Persist into the SAME owner chat thread so the dashboard sees this turn
  // too. source="whisper" is the existing schema value used for non-chat
  // surfaces; we tag the WhatsApp origin in content metadata by prefix.
  try {
    await prisma.$transaction([
      prisma.ownerChatMessage.create({
        data: {
          restaurantId: input.restaurantId,
          role: "user",
          content: input.message,
          authorUserId: input.clerkId,
          source: "whisper",
        },
      }),
      prisma.ownerChatMessage.create({
        data: {
          restaurantId: input.restaurantId,
          role: "assistant",
          content: finalText,
          source: "whisper",
        },
      }),
    ]);
  } catch (e) {
    console.error("[coworker-agent] persist failed", e);
  }

  if (totalIn > 0 || totalOut > 0) {
    try {
      await logAiUsage(input.restaurantId, "owner_chat", totalIn, totalOut);
    } catch (e) {
      console.error("[coworker-agent] usage log failed", e);
    }
  }

  return { text: finalText, inputTokens: totalIn, outputTokens: totalOut, costUsd, refused: false };
}

// ── Quick-reply button payload router ─────────────────────────

export interface ButtonAction {
  /** What to send back. Each button maps to either:
   *  - a `prompt` (sent into the agent as if the owner typed it), or
   *  - a literal `text` reply with optional follow-up buttons. */
  kind: "prompt" | "reply";
  prompt?: string;
  text?: string;
  buttons?: Array<{ id: string; title: string }>;
}

/** Translate a button id ("brief:full_report") into either a synthetic
 *  prompt for the agent or a canned reply. Keeping this OFF the LLM means
 *  buttons are deterministic and instant — owners don't wait for inference
 *  for a button they tapped. */
export function routeButtonPayload(payload: string): ButtonAction | null {
  switch (payload) {
    case "brief:full_report":
      return {
        kind: "prompt",
        prompt:
          "Give me a full report of yesterday's performance — revenue, orders, top items, what changed vs the same day last week, what needs attention.",
      };
    case "brief:reply_reviews":
      return {
        kind: "prompt",
        prompt:
          "Draft a reply for each unanswered Google review from the last 7 days. Keep them warm and on-brand. Show me the drafts so I can approve.",
      };
    case "brief:winback_vip":
      return {
        kind: "prompt",
        prompt:
          "Show me my top 5 customers who haven't ordered in the last 30 days and draft a personalised win-back message I can send each one via WhatsApp.",
      };
    case "brief:ask_anything":
      return {
        kind: "reply",
        text:
          "👋 Just send a message — anything about your restaurant. I can pull numbers, draft replies, suggest fixes, edit your menu, and more.",
      };
    default:
      return null;
  }
}
