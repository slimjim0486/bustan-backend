import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

export const DEFAULT_SOUS_CHEF_MODEL = "claude-haiku-4-5-20251001";

const LEGACY_SOUS_CHEF_MODELS = new Set([
  "claude-3-5-haiku-20241022",
  "claude-3-5-haiku-latest",
]);

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function getSousChefModelCandidates() {
  const configured = env.SOUS_CHEF_MODEL.trim() || DEFAULT_SOUS_CHEF_MODEL;
  const fallbackModels = LEGACY_SOUS_CHEF_MODELS.has(configured)
    ? [DEFAULT_SOUS_CHEF_MODEL, "claude-haiku-4-5", "claude-3-haiku-20240307"]
    : [DEFAULT_SOUS_CHEF_MODEL, "claude-haiku-4-5"];

  return unique([configured, ...fallbackModels]);
}

export const DEFAULT_SOUS_CHEF_PLANNER_MODEL = "claude-sonnet-4-6";

export function getSousChefPlannerCandidates() {
  const configured = env.SOUS_CHEF_PLANNER_MODEL.trim() || DEFAULT_SOUS_CHEF_PLANNER_MODEL;
  // Planner falls back through Sonnet to the default-tier chain so a model
  // outage degrades quality, never availability.
  return unique([configured, DEFAULT_SOUS_CHEF_PLANNER_MODEL, ...getSousChefModelCandidates()]);
}

export type SousChefModelTier = "default" | "planner";

type SousChefMessageParams = Omit<Anthropic.MessageCreateParamsNonStreaming, "model">;

// Prompt caching: tools render first, then system, then messages. Marking the
// last tool caches every tool definition (shared across restaurants per model);
// marking the system block caches tools+system per restaurant. Reads ~0.1x
// input price, writes 1.25x, 5-min TTL — break-even on the second call, and
// the tool loop makes 2-9 calls per turn with an identical prefix.
// No-tools calls (whisper, memory extraction) are left untouched: their
// prompts are unique per run, so a cache write would be pure premium.
export function withPromptCaching(params: SousChefMessageParams): SousChefMessageParams {
  if (!params.tools || params.tools.length === 0) {
    return params;
  }

  const tools = params.tools.map((tool, index) =>
    index === params.tools!.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" as const } }
      : tool
  );

  const system =
    typeof params.system === "string"
      ? [{ type: "text" as const, text: params.system, cache_control: { type: "ephemeral" as const } }]
      : params.system;

  return { ...params, tools, system };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isAnthropicModelNotFound(error: unknown) {
  const status = typeof error === "object" && error && "status" in error
    ? (error as { status?: unknown }).status
    : null;
  const message = getErrorMessage(error);

  return (
    status === 404 &&
    (message.includes("not_found_error") || /model:\s*/i.test(message))
  );
}

export async function createSousChefMessage(
  client: Anthropic,
  params: SousChefMessageParams,
  context: Record<string, unknown> = {},
  tier: SousChefModelTier = "default"
) {
  const candidates =
    tier === "planner" ? getSousChefPlannerCandidates() : getSousChefModelCandidates();
  const cachedParams = withPromptCaching(params);

  for (let index = 0; index < candidates.length; index += 1) {
    const model = candidates[index];

    try {
      return await client.messages.create({ ...cachedParams, model });
    } catch (error) {
      const fallbackModel = candidates[index + 1];
      if (fallbackModel && isAnthropicModelNotFound(error)) {
        console.warn("[anthropic] model unavailable; retrying fallback", {
          ...context,
          requestedModel: model,
          fallbackModel,
          message: getErrorMessage(error),
        });
        continue;
      }

      throw error;
    }
  }

  throw new Error("No Anthropic model candidate returned a response");
}
