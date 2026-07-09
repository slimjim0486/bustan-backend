import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, TextBlock, ToolResultBlockParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import { ApiError } from "@/lib/errors";
import { env } from "@/lib/env";
import {
  checkInputGuardrails,
  handoffMessage,
  parseConciergeAction,
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

function prepareMessages(options: ConciergeTurnOptions): MessageParam[] {
  return [
    ...(options.history ?? []).map((msg) => ({
      role: msg.role,
      content: msg.role === "user" ? wrapDinerMessage(msg.content) : msg.content,
    })),
    { role: "user" as const, content: wrapDinerMessage(options.message) },
  ];
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
  let iterations = 0;
  let finalText = "";

  while (iterations <= MAX_TOOL_ITERATIONS) {
    const response = await createSousChefMessage(
      getClient(),
      {
        max_tokens: 512,
        system,
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
  const reply = parsed.action === "escalate" && !parsed.reply
    ? handoffMessage(options.language)
    : parsed.reply;

  return {
    action: parsed.action,
    reply,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}

export * from "@/lib/concierge/guards";
export * from "@/lib/concierge/types";
