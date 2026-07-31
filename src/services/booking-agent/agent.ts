// Turn loop for the customer-facing WhatsApp booking agent
// (Phase 4 / Task 11).
//
// Modelled on services/coworker/agent.ts — same shape (bounded tool loop, one
// final text per turn, usage logged once) with three deliberate divergences:
//
//   1. The counterparty is a member of the public, not the owner. Injection
//      hits ESCALATE (hand to a human) instead of returning a refusal line, and
//      every tool is restaurant-scoped.
//   2. History comes from the WhatsAppMessage rows on the conversation, not a
//      persisted agent thread — the WhatsApp thread IS the transcript, and
//      Task 12 persists the outbound reply after we return it.
//   3. The system prompt is rebuilt per turn but is byte-deterministic for
//      unchanged business data, so the cached tools+system prefix survives
//      across all iterations of the loop AND across turns.
//
// Never streams: WhatsApp takes one message per turn.

import Anthropic from "@anthropic-ai/sdk";
import { matchesInjection } from "@/lib/agent-guards";
import { logAiUsage } from "@/lib/ai-usage";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { createSousChefMessage, withPromptCaching } from "@/services/anthropic-models";
import {
  buildBookingAgentSystemPrompt,
  parseOperatingHoursJson,
  summarizeOperatingHours,
  type BookingAgentPromptContext,
  type BookingBusinessType,
} from "@/services/booking-agent/prompts";
import {
  BOOKING_AGENT_TOOLS,
  GUARD_PAUSE_MS,
  executeBookingAgentTool,
  pauseConversationForOwner,
  type BookingAgentToolContext,
} from "@/services/booking-agent/tools";

const MAX_TOOL_ITERATIONS = 6;
const HISTORY_LIMIT = 20;
const MAX_TOKENS = 1024;
/** WhatsApp's text body limit is 4096; leave headroom for emoji surrogate pairs. */
const WA_REPLY_MAX_CHARS = 3500;

/** Sent when we hand over without an LLM call (injection, missing customer). EN
 *  only — we have no model turn to mirror the customer's language with. */
const HANDOFF_REPLY = "Let me get someone from our team to help you with that — they'll reply here shortly.";

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ApiError("Booking agent is not configured (ANTHROPIC_API_KEY missing).", 503);
  }
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

export interface BookingAgentTurnInput {
  conversationId: string;
}

export interface BookingAgentTurnResult {
  /** The reply to send, or null when there is nothing to say (bot has handed
   *  over silently, or there was no customer message to answer). */
  text: string | null;
  escalated: boolean;
  inputTokens: number;
  outputTokens: number;
}

function clampReply(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= WA_REPLY_MAX_CHARS) return trimmed;
  return trimmed.slice(0, WA_REPLY_MAX_CHARS - 1) + "…";
}

/** Untrusted text is wrapped so the model can tell data from instructions —
 *  same defence the coworker agent uses with <owner_message>. */
function wrapCustomerMessage(text: string): string {
  return `<customer_message>${text}</customer_message>`;
}

function isBookingBusinessType(value: string): value is BookingBusinessType {
  return value === "SALON" || value === "HOME_SERVICES";
}

/** One persisted WhatsApp row, as far as history normalization cares. */
export interface BookingAgentHistoryRow {
  direction: string;
  body: string | null;
}

/**
 * Turns persisted WhatsApp rows into a message list the Messages API will
 * actually accept. Mirrors the normalization the archived concierge did in
 * `lib/concierge/index.ts` (`prepareMessages`), for the same three reasons:
 *
 *   1. The window MUST start on a `user` turn or the API 400s. A returning
 *      customer's last 20 rows very often open on an outbound row, because
 *      Phase 4's own lifecycle jobs write reminders, deposit nudges and
 *      confirmation templates into this same conversation.
 *   2. Adjacent same-role turns must be merged. WhatsApp customers send bursts
 *      ("hi" / "are you open" / "tomorrow?"), which would otherwise produce
 *      consecutive user turns.
 *   3. The window MUST NOT end on an `assistant` turn — the API reads a trailing
 *      assistant message as a prefill to continue, not as history.
 *
 * Pure and total: exported so the ordering rules are testable without a DB.
 */
export function prepareAgentMessages(
  rows: BookingAgentHistoryRow[]
): Anthropic.MessageParam[] {
  const normalized: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const row of rows) {
    const body = row.body?.trim();
    if (!body) continue;

    const role = row.direction === "inbound" ? "user" : "assistant";
    const content = role === "user" ? wrapCustomerMessage(body) : body;

    const previous = normalized.at(-1);
    if (previous?.role === role) {
      previous.content = `${previous.content}\n\n${content}`;
      continue;
    }
    normalized.push({ role, content });
  }

  // Order matters: merge first (above) so roles strictly alternate, then trim
  // both ends. After the leading strip the list starts on `user`, so the
  // trailing pop can remove at most the final assistant turn.
  while (normalized[0]?.role === "assistant") normalized.shift();
  while (normalized.at(-1)?.role === "assistant") normalized.pop();

  return normalized.map((message) => ({ role: message.role, content: message.content }));
}

function policiesOf(bookingPolicies: unknown): BookingAgentPromptContext["policies"] {
  if (!bookingPolicies || typeof bookingPolicies !== "object" || Array.isArray(bookingPolicies)) {
    return {};
  }
  const raw = bookingPolicies as { noShowPolicy?: unknown; slotGranularityMinutes?: unknown };
  return {
    noShowPolicy: typeof raw.noShowPolicy === "string" ? raw.noShowPolicy : undefined,
    slotGranularityMinutes:
      typeof raw.slotGranularityMinutes === "number" ? raw.slotGranularityMinutes : undefined,
  };
}

/**
 * Hands the thread to a human without an LLM call. Uses the SHORT guard pause,
 * not the 24h escalation pause: these paths fire on a heuristic (injection regex
 * tuned for owner-authored text) or on missing data, so a false positive must
 * not mute a paying customer for a full day.
 */
async function pauseForGuard(
  conversationId: string,
  restaurantId: string,
  reason: string
): Promise<void> {
  try {
    await pauseConversationForOwner({
      restaurantId,
      conversationId,
      reason,
      pauseMs: GUARD_PAUSE_MS,
      notifyOwner: true,
    });
  } catch (error) {
    // The handoff line still goes out; a failed pause write must not throw the
    // customer's turn away.
    console.error("[booking-agent] guard pause failed", error);
  }
}

/**
 * Runs one booking-agent turn against the conversation's persisted WhatsApp
 * history. The caller (Task 12) is responsible for having persisted the
 * inbound message first, for gating on botPausedUntil/botDisabled, and for
 * sending + persisting whatever text comes back.
 */
export async function runBookingAgentTurn(
  input: BookingAgentTurnInput
): Promise<BookingAgentTurnResult> {
  const conversation = await prisma.whatsAppConversation.findUnique({
    where: { id: input.conversationId },
    select: {
      id: true,
      restaurantId: true,
      customerId: true,
      customerPhone: true,
      restaurant: {
        select: {
          id: true,
          name: true,
          businessType: true,
          operatingHours: true,
          bookingPolicies: true,
          depositAed: true,
        },
      },
    },
  });
  if (!conversation) {
    throw new ApiError("Conversation not found for booking agent.", 404);
  }

  const { restaurant } = conversation;
  if (!isBookingBusinessType(restaurant.businessType)) {
    // RESTAURANT tenants have no services/bookings surface — refuse loudly
    // rather than answering a diner with an empty service list.
    throw new ApiError(
      `Booking agent is not available for businessType=${restaurant.businessType}.`,
      409
    );
  }

  const messageRows = await prisma.whatsAppMessage.findMany({
    where: { conversationId: conversation.id, body: { not: null } },
    orderBy: { seq: "desc" },
    take: HISTORY_LIMIT,
    select: { direction: true, body: true },
  });
  const history = messageRows.reverse();

  const latestInbound = [...history].reverse().find((row) => row.direction === "inbound");
  if (!latestInbound?.body?.trim()) {
    // Nothing from the customer to answer (e.g. the conversation only has
    // outbound template sends). Stay silent rather than inventing a turn.
    return { text: null, escalated: false, inputTokens: 0, outputTokens: 0 };
  }

  // Injection check runs BEFORE any model call: a hit costs zero tokens and
  // hands the thread to a human instead of arguing with the customer.
  if (matchesInjection(latestInbound.body)) {
    await pauseForGuard(
      conversation.id,
      conversation.restaurantId,
      "Possible prompt-injection attempt — bot paused briefly, please review this chat."
    );
    return { text: HANDOFF_REPLY, escalated: true, inputTokens: 0, outputTokens: 0 };
  }

  if (!conversation.customerId) {
    // Every tool (and the fee/newness math) is keyed on a Customer row. Without
    // one we can't book, so hand over rather than half-answer.
    await pauseForGuard(
      conversation.id,
      conversation.restaurantId,
      "No customer record on this conversation — bot paused, please reply manually."
    );
    return { text: HANDOFF_REPLY, escalated: true, inputTokens: 0, outputTokens: 0 };
  }

  const services = await prisma.service.findMany({
    where: { restaurantId: conversation.restaurantId, isActive: true },
    orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      nameAr: true,
      priceAed: true,
      durationMinutes: true,
      category: { select: { name: true } },
    },
  });

  const systemPrompt = buildBookingAgentSystemPrompt({
    businessType: restaurant.businessType,
    businessName: restaurant.name,
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      nameAr: service.nameAr,
      priceAed: service.priceAed,
      durationMinutes: service.durationMinutes,
      category: service.category?.name ?? "Other",
    })),
    policies: policiesOf(restaurant.bookingPolicies),
    hoursSummary: summarizeOperatingHours(parseOperatingHoursJson(restaurant.operatingHours)),
    depositAed: restaurant.depositAed ?? 0,
  });

  const messages = prepareAgentMessages(history);
  if (!messages.length) {
    return { text: null, escalated: false, inputTokens: 0, outputTokens: 0 };
  }

  const toolContext: BookingAgentToolContext = {
    restaurantId: conversation.restaurantId,
    conversationId: conversation.id,
    customerId: conversation.customerId,
    customerPhone: conversation.customerPhone,
  };

  const client = getClient();
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let assistantText = "";
  let escalated = false;
  let iterations = 0;

  while (iterations <= MAX_TOOL_ITERATIONS) {
    const response = await createSousChefMessage(
      client,
      // createSousChefMessage applies caching itself; calling it here is
      // idempotent and keeps the intent visible at the call site.
      withPromptCaching({
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: BOOKING_AGENT_TOOLS,
        messages,
      }),
      {
        route: "booking-agent",
        restaurantId: conversation.restaurantId,
        conversationId: conversation.id,
        iteration: iterations,
      }
    );

    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;
    totalCacheWrite += response.usage.cache_creation_input_tokens ?? 0;
    totalCacheRead += response.usage.cache_read_input_tokens ?? 0;

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        assistantText += block.text;
      }
    }

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") break;

    const toolBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    if (toolBlocks.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolBlocks) {
      const result = await executeBookingAgentTool(
        block.name,
        (block.input ?? {}) as Record<string, unknown>,
        toolContext
      );
      if (result.escalated) escalated = true;
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
      });
    }
    messages.push({ role: "user", content: toolResults });
    iterations++;
  }

  if (totalIn > 0 || totalOut > 0) {
    try {
      await logAiUsage(conversation.restaurantId, "booking_agent", totalIn, totalOut, 0, {
        cacheWriteTokens: totalCacheWrite,
        cacheReadTokens: totalCacheRead,
      });
    } catch (error) {
      console.error("[booking-agent] usage log failed", error);
    }
  }

  const finalText = clampReply(assistantText);

  return {
    // An escalation with no text still hands over — better silence than a
    // filler line the owner then has to talk around.
    text: finalText || (escalated ? HANDOFF_REPLY : null),
    escalated,
    inputTokens: totalIn,
    outputTokens: totalOut,
  };
}
