// 3-pass Claude orchestration for Ad Studio creative generation.
//
// Pass 1: Strategy selection (Sonnet) — picks archetypes/hooks/CTAs/framework + image direction
// Pass 2: Copy generation (Sonnet) — produces N variants of headline/primary/CTA
// Pass 3: Image prompt generation (Sonnet) — writes the hero image prompt
// Safety pass — runs deterministically over Pass-2 output (see safety.ts)

import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@/lib/errors";
import { getAnthropicClient } from "@/services/claude";
import {
  buildStrategySystemPrompt,
  buildStrategyUserPrompt,
  buildCopySystemPrompt,
  buildCopyUserPrompt,
  buildImagePromptSystemPrompt,
  buildImagePromptUserPrompt,
  STRATEGY_TOOL_NAME,
  STRATEGY_TOOL_SCHEMA,
  COPY_TOOL_NAME,
  COPY_TOOL_SCHEMA,
  IMAGE_PROMPT_TOOL_NAME,
  IMAGE_PROMPT_TOOL_SCHEMA,
} from "./prompts";
import { runSafetyPass } from "./safety";
import type {
  AdStudioBrief,
  CopyVariant,
  RestaurantBrandContext,
  SafetyVerdict,
  StrategyDecision,
} from "./types";

const STRATEGY_MODEL = "claude-sonnet-4-6";
const COPY_MODEL = "claude-sonnet-4-6";
const IMAGE_PROMPT_MODEL = "claude-sonnet-4-6";

const SONNET_INPUT_USD_PER_TOKEN = 0.000003;
const SONNET_OUTPUT_USD_PER_TOKEN = 0.000015;

interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

function addUsage(total: UsageTotals, response: Anthropic.Message) {
  const inputTokens = response.usage.input_tokens ?? 0;
  const outputTokens = response.usage.output_tokens ?? 0;
  total.tokensIn += inputTokens;
  total.tokensOut += outputTokens;
  total.costUsd += inputTokens * SONNET_INPUT_USD_PER_TOKEN + outputTokens * SONNET_OUTPUT_USD_PER_TOKEN;
}

function getToolInput<T>(response: Anthropic.Message, toolName: string): T {
  const block = response.content.find(
    (entry): entry is Anthropic.ToolUseBlock => entry.type === "tool_use" && entry.name === toolName
  );
  if (!block) {
    throw new ApiError(`Claude did not return a ${toolName} tool call`, 502);
  }
  return block.input as T;
}

// =============================================================================
// PASS 1 — Strategy
// =============================================================================

export async function runStrategyPass(args: {
  brief: AdStudioBrief;
  brand: RestaurantBrandContext;
  totals: UsageTotals;
}): Promise<StrategyDecision> {
  const client = getAnthropicClient();
  if (!client) {
    throw new ApiError("ANTHROPIC_API_KEY is not configured for the Ad Studio", 503);
  }

  const freeform = args.brief.campaignType === "freeform";
  const response = await client.messages.create({
    model: STRATEGY_MODEL,
    max_tokens: 1500,
    system: buildStrategySystemPrompt({ freeform }),
    tools: [STRATEGY_TOOL_SCHEMA as Anthropic.Tool],
    tool_choice: { type: "tool", name: STRATEGY_TOOL_NAME },
    messages: [
      {
        role: "user",
        content: buildStrategyUserPrompt({ brief: args.brief, brand: args.brand }),
      },
    ],
  });

  addUsage(args.totals, response);
  return getToolInput<StrategyDecision>(response, STRATEGY_TOOL_NAME);
}

// =============================================================================
// PASS 2 — Copy variants
// =============================================================================

export async function runCopyPass(args: {
  brief: AdStudioBrief;
  brand: RestaurantBrandContext;
  strategy: StrategyDecision;
  numberOfVariants: number;
  totals: UsageTotals;
}): Promise<CopyVariant[]> {
  const client = getAnthropicClient();
  if (!client) {
    throw new ApiError("ANTHROPIC_API_KEY is not configured for the Ad Studio", 503);
  }

  const response = await client.messages.create({
    model: COPY_MODEL,
    max_tokens: 4000,
    system: buildCopySystemPrompt(),
    tools: [COPY_TOOL_SCHEMA as Anthropic.Tool],
    tool_choice: { type: "tool", name: COPY_TOOL_NAME },
    messages: [
      {
        role: "user",
        content: buildCopyUserPrompt({
          brief: args.brief,
          brand: args.brand,
          strategy: args.strategy,
          numberOfVariants: args.numberOfVariants,
        }),
      },
    ],
  });

  addUsage(args.totals, response);

  const result = getToolInput<{ variants: CopyVariant[] }>(response, COPY_TOOL_NAME);
  if (!result.variants || result.variants.length === 0) {
    throw new ApiError("Claude returned an empty variant list", 502);
  }
  return result.variants;
}

// =============================================================================
// PASS 3 — Image prompt
// =============================================================================

export async function runImagePromptPass(args: {
  brief: AdStudioBrief;
  brand: RestaurantBrandContext;
  strategy: StrategyDecision;
  variant: CopyVariant;
  totals: UsageTotals;
}): Promise<string> {
  const client = getAnthropicClient();
  if (!client) {
    throw new ApiError("ANTHROPIC_API_KEY is not configured for the Ad Studio", 503);
  }

  const response = await client.messages.create({
    model: IMAGE_PROMPT_MODEL,
    max_tokens: 800,
    system: buildImagePromptSystemPrompt(),
    tools: [IMAGE_PROMPT_TOOL_SCHEMA as Anthropic.Tool],
    tool_choice: { type: "tool", name: IMAGE_PROMPT_TOOL_NAME },
    messages: [
      {
        role: "user",
        content: buildImagePromptUserPrompt({
          brand: args.brand,
          brief: args.brief,
          strategy: args.strategy,
          variantArchetypeId: args.variant.archetypeId,
          variant: args.variant,
        }),
      },
    ],
  });

  addUsage(args.totals, response);

  const result = getToolInput<{ prompt: string }>(response, IMAGE_PROMPT_TOOL_NAME);
  return result.prompt;
}

// =============================================================================
// Safety + variant validation helpers
// =============================================================================

/**
 * Per-variant safety pass — each variant gets its OWN flags, not a combined blob.
 * Returns a map keyed by variant number with verdict + flags for each.
 */
export function runPerVariantSafety(args: {
  variants: CopyVariant[];
  brief: AdStudioBrief;
  imagePromptByVariant?: Record<number, string>;
}): Map<number, SafetyVerdict> {
  const map = new Map<number, SafetyVerdict>();
  for (const variant of args.variants) {
    const verdict = runSafetyPass({
      countries: args.brief.countries,
      copy: variant,
      imagePrompt: args.imagePromptByVariant?.[variant.variant],
    });
    map.set(variant.variant, verdict);
  }
  return map;
}

export function aggregateSafety(map: Map<number, SafetyVerdict>): SafetyVerdict["verdict"] {
  let hasErr = false;
  let hasWarn = false;
  for (const v of map.values()) {
    if (v.verdict === "fail") hasErr = true;
    else if (v.verdict === "warn") hasWarn = true;
  }
  return hasErr ? "fail" : hasWarn ? "warn" : "pass";
}

export type { UsageTotals };
