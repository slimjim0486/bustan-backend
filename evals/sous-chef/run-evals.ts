/**
 * Sous Chef golden-prompt evals. Spends real Anthropic tokens — run manually:
 *   export EVAL_RESTAURANT_ID=<id from seed>   # or let it resolve the seeded slug
 *   npm run eval:sous-chef
 * Read tools execute for real against the eval restaurant; write tools are
 * NEVER executed — the first write tool_use block is captured and asserted.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAiUsageSummary } from "../../src/lib/ai-usage";
import { getRestaurantEntitlements } from "../../src/lib/entitlements";
import { env } from "../../src/lib/env";
import { buildOwnerSystemPrompt } from "../../src/lib/owner-chat-prompts";
import { prisma } from "../../src/lib/prisma";
import { createSousChefMessage } from "../../src/services/anthropic-models";
import {
  HAIKU_CAPS,
  PLANNER_CAPS,
  WRITE_TOOL_NAMES,
  findEscalationTrigger,
} from "../../src/services/owner-chat-routing";
import { getOwnerTools, executeTool } from "../../src/services/owner-chat-tools";

interface GoldenPrompt {
  id: string;
  prompt: string;
  expect: {
    // Optional: some single-item write prompts are legitimately nondeterministic
    // about whether they escalate (the model may emit the write tool — which
    // escalates — or present a prose preview and stop). Omit to skip the check.
    escalation?: boolean;
    read_tools_any?: string[];
    write_tool?: { name: string; args?: Record<string, unknown> };
    write_tool_any?: string[];
  };
}

interface TurnResult {
  escalated: boolean;
  readToolsCalled: string[];
  firstWrite: { name: string; args: Record<string, unknown> } | null;
}

function matchArgs(expected: Record<string, unknown>, actual: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(expected)) {
    if (key.endsWith("_count")) {
      const field = key.slice(0, -"_count".length);
      const arr = actual[field];
      if (!Array.isArray(arr) || arr.length !== value) {
        return `${field} length ${Array.isArray(arr) ? arr.length : "n/a"} != ${value}`;
      }
    } else if (actual[key] !== value) {
      return `${key} = ${JSON.stringify(actual[key])} != ${JSON.stringify(value)}`;
    }
  }
  return null;
}

async function runTurn(
  client: Anthropic,
  restaurantId: string,
  clerkId: string,
  entitlements: ReturnType<typeof getRestaurantEntitlements>,
  systemPrompt: string,
  prompt: string
): Promise<TurnResult> {
  const result: TurnResult = { escalated: false, readToolsCalled: [], firstWrite: null };

  const runLoop = async (tier: "default" | "planner") => {
    const caps = tier === "planner" ? PLANNER_CAPS : HAIKU_CAPS;
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: `<owner_message>${prompt}</owner_message>` },
    ];
    let iterations = 0;
    let executed = 0;

    while (iterations <= caps.maxIterations) {
      const response = await createSousChefMessage(
        client,
        { max_tokens: caps.maxTokens, system: systemPrompt, tools: getOwnerTools(true), messages },
        { route: "eval", iteration: iterations, tier },
        tier
      );

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (tier === "default" && toolUseBlocks.length > 0) {
        const trigger = findEscalationTrigger(toolUseBlocks.map((b) => b.name), executed);
        if (trigger) {
          result.escalated = true;
          return;
        }
      }

      if (
        toolUseBlocks.length === 0 ||
        response.stop_reason === "end_turn" ||
        response.stop_reason === "max_tokens"
      ) {
        return;
      }

      messages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        if (WRITE_TOOL_NAMES.has(block.name)) {
          // Capture, never execute.
          result.firstWrite = { name: block.name, args: block.input as Record<string, unknown> };
          return;
        }
        result.readToolsCalled.push(block.name);
        const toolResult = await executeTool(
          block.name,
          restaurantId,
          clerkId,
          entitlements,
          block.input as Record<string, unknown>
        );
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: toolResult.content });
      }

      executed += toolUseBlocks.length;
      messages.push({ role: "user", content: toolResults });
      iterations++;
    }
  };

  await runLoop("default");
  if (result.escalated) {
    await runLoop("planner");
  }
  return result;
}

async function main() {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY required");

  const restaurantId =
    process.env.EVAL_RESTAURANT_ID ??
    (await prisma.restaurant.findUnique({ where: { slug: "sous-chef-eval" } }))?.id;
  if (!restaurantId) throw new Error("Run eval:sous-chef:seed first or set EVAL_RESTAURANT_ID");

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: { subscription: true, _count: { select: { menuSections: true } } },
  });
  if (!restaurant) throw new Error(`Restaurant ${restaurantId} not found`);

  const entitlements = getRestaurantEntitlements(restaurant);
  const totalItems = await prisma.menuItem.count({ where: { restaurantId } });
  const [descUsage, tagUsage, analysisUsage, imageUsage] = await Promise.all([
    getAiUsageSummary(restaurantId, "description_enhance"),
    getAiUsageSummary(restaurantId, "tag_analysis"),
    getAiUsageSummary(restaurantId, "menu_analysis"),
    getAiUsageSummary(restaurantId, "image_enhancement"),
  ]);

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
      descriptions: { used: descUsage.used, limit: entitlements.aiDescriptionLimit },
      tags: { used: tagUsage.used, limit: entitlements.aiTagAnalysisLimit },
      analysis: { used: analysisUsage.used, limit: entitlements.analysisLimit },
      images: { used: imageUsage.used, limit: entitlements.imageEnhancementLimit },
    },
    []
  );

  const prompts = JSON.parse(
    readFileSync(join(__dirname, "golden-prompts.json"), "utf8")
  ) as GoldenPrompt[];

  // Targeted runs: EVAL_ONLY=id1,id2 runs only matching prompt ids (cheap spot-checks).
  const only = process.env.EVAL_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
  const selected = only?.length ? prompts.filter((p) => only.includes(p.id)) : prompts;
  if (only?.length) console.log(`EVAL_ONLY: running ${selected.length}/${prompts.length} prompts`);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  let failures = 0;
  for (const golden of selected) {
    const errors: string[] = [];
    let turnDebug: TurnResult | undefined;
    try {
      const turn = await runTurn(
        client,
        restaurantId,
        "eval-sous-chef-owner",
        entitlements,
        systemPrompt,
        golden.prompt
      );
      turnDebug = turn;

      if (golden.expect.escalation !== undefined && turn.escalated !== golden.expect.escalation) {
        errors.push(`escalation ${turn.escalated} != ${golden.expect.escalation}`);
      }
      if (golden.expect.read_tools_any) {
        const hit = golden.expect.read_tools_any.some((t) => turn.readToolsCalled.includes(t));
        if (!hit) errors.push(`no read tool in [${golden.expect.read_tools_any}]; called [${turn.readToolsCalled}]`);
      }
      if (golden.expect.write_tool) {
        if (!turn.firstWrite) {
          errors.push("no write tool captured");
        } else {
          if (turn.firstWrite.name !== golden.expect.write_tool.name) {
            errors.push(`write ${turn.firstWrite.name} != ${golden.expect.write_tool.name}`);
          }
          if (golden.expect.write_tool.args) {
            const mismatch = matchArgs(golden.expect.write_tool.args, turn.firstWrite.args);
            if (mismatch) errors.push(`args: ${mismatch}`);
          }
        }
      }
      if (golden.expect.write_tool_any) {
        const name = turn.firstWrite?.name;
        if (!name || !golden.expect.write_tool_any.includes(name)) {
          errors.push(`first write ${name ?? "none"} not in [${golden.expect.write_tool_any}]`);
        }
      }
    } catch (error) {
      errors.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (process.env.EVAL_DEBUG) {
      console.log(`DEBUG ${golden.id}: escalated=${turnDebug?.escalated} firstWrite=${turnDebug?.firstWrite ? turnDebug.firstWrite.name + " " + JSON.stringify(turnDebug.firstWrite.args) : "none"} reads=[${turnDebug?.readToolsCalled}]`);
    }
    if (errors.length > 0) {
      failures++;
      console.log(`FAIL ${golden.id}: ${errors.join("; ")}`);
    } else {
      console.log(`PASS ${golden.id}`);
    }
  }

  console.log(`\n${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
