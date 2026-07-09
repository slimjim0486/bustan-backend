import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, TextBlock, ToolResultBlockParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { ApiError } from "@/lib/errors";
import { env } from "@/lib/env";
import {
  checkInputGuardrails,
  handoffMessage,
  parseConciergeAction,
  webEscalationMessage,
  wrapDinerMessage,
} from "@/lib/concierge/guards";
import { buildConciergeSystemPrompt } from "@/lib/concierge/system-prompt";
import { buildConciergeTools, executeConciergeTool } from "@/lib/concierge/tools";
import type { ConciergeTurnOptions, ConciergeTurnResult } from "@/lib/concierge/types";
import { createSousChefMessage } from "@/services/anthropic-models";

const MAX_TOOL_ITERATIONS = 5;

let anthropic: Anthropic | null = null;

function getClient() {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ApiError("AI assistant is not configured", 503);
  }

  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  return anthropic;
}

export function prepareMessages(options: ConciergeTurnOptions): MessageParam[] {
  const rawMessages = [
    ...(options.history ?? []).map((msg) => ({
      role: msg.role,
      content: msg.role === "user" ? wrapDinerMessage(msg.content) : msg.content,
    })),
    { role: "user" as const, content: wrapDinerMessage(options.message) },
  ];

  const normalized: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of rawMessages) {
    const content = message.content.trim();
    if (!content) continue;

    const previous = normalized.at(-1);
    if (previous?.role === message.role) {
      previous.content = `${previous.content}\n\n${content}`;
      continue;
    }

    normalized.push({ role: message.role, content });
  }

  while (normalized[0]?.role === "assistant") {
    normalized.shift();
  }

  return normalized;
}

export async function runConciergeTurn(
  options: ConciergeTurnOptions
): Promise<ConciergeTurnResult> {
  const guard = checkInputGuardrails(options.message, options.language, options.channel);
  if (!guard.allowed) {
    return {
      action: guard.action,
      reply: guard.refusal,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
  }

  const messages = prepareMessages(options);
  const tools = buildConciergeTools(options.channel, Boolean(options.customerPhone));
  const system = buildConciergeSystemPrompt({
    restaurant: options.restaurant,
    channel: options.channel,
    language: options.language,
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let iterations = 0;
  let finalText = "";

  while (iterations <= MAX_TOOL_ITERATIONS) {
    const response = await createSousChefMessage(
      getClient(),
      {
        max_tokens: 512,
        system: [
          {
            type: "text",
            text: system,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools,
        messages,
      },
      {
        route: `concierge-${options.channel}`,
        restaurantId: options.restaurant.id,
        iteration: iterations,
      }
    );

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    const usage = response.usage as Anthropic.Messages.Usage & {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    totalCacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
    totalCacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;

    const textParts = response.content
      .filter((block): block is TextBlock => block.type === "text")
      .map((block) => block.text.trim())
      .filter(Boolean);

    if (textParts.length > 0) {
      finalText = textParts.join("\n").trim();
    }

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      break;
    }

    const toolUseBlocks = response.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
      type: "tool_result",
      tool_use_id: block.id,
      content: executeConciergeTool(
        {
          restaurant: options.restaurant,
          channel: options.channel,
          customerPhone: options.customerPhone,
        },
        block.name,
        block.input
      ),
    }));

    messages.push({ role: "user", content: toolResults });
    iterations += 1;
  }

  if (!finalText) {
    throw new ApiError("AI assistant returned an empty reply", 502);
  }

  const parsed = parseConciergeAction(finalText);
  const escalationFallback =
    options.channel === "whatsapp"
      ? handoffMessage(options.language)
      : webEscalationMessage(options.language);
  const reply = parsed.action === "escalate" && !parsed.reply
    ? escalationFallback
    : parsed.reply;

  return {
    action: parsed.action,
    reply,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadInputTokens: totalCacheReadInputTokens,
    cacheCreationInputTokens: totalCacheCreationInputTokens,
  };
}

export * from "@/lib/concierge/guards";
export * from "@/lib/concierge/types";
