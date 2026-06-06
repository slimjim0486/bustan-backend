import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export type EscalationTrigger = "write_tool" | "breadth" | "handoff";

export const ESCALATE_TOOL = "escalate_to_planner";

// Every tool that stages a draft, mutates data, or spends AI quota. A call to
// any of these on the default tier is the escalation signal — the call is NOT
// executed there, so every draft reaching the Inbox is planner-authored.
export const WRITE_TOOL_NAMES = new Set([
  "enhance_descriptions",
  "suggest_dietary_tags",
  "update_menu_item",
  "update_menu_items_bulk",
  "create_promotion",
  "update_promotion",
  "send_whatsapp_campaign",
  "create_ad_campaign",
  "generate_dish_images",
  "delete_menu_items",
  "toggle_availability",
  "create_menu_item",
  "create_menu_section",
  "update_restaurant",
  "publish_menu",
  "run_menu_analysis",
  "draft_review_replies",
  "plan_marketing_week",
]);

export const HAIKU_CAPS = { maxIterations: 8, maxTokens: 1024 } as const;
export const PLANNER_CAPS = { maxIterations: 24, maxTokens: 4096 } as const;

export const STICKINESS_WINDOW_MS = 10 * 60_000;
export const BREADTH_ESCALATION_THRESHOLD = 3;

export function findEscalationTrigger(
  batchToolNames: string[],
  executedToolCalls: number
): EscalationTrigger | null {
  if (batchToolNames.includes(ESCALATE_TOOL)) {
    return "handoff";
  }
  if (batchToolNames.some((name) => WRITE_TOOL_NAMES.has(name))) {
    return "write_tool";
  }
  if (executedToolCalls + batchToolNames.length >= BREADTH_ESCALATION_THRESHOLD) {
    return "breadth";
  }
  return null;
}

// "Yes, do it" follow-ups during an execution flow should not bounce back to
// the default tier — if the previous assistant turn was planner-authored and
// fresh, start the new turn on the planner directly.
export function shouldStartOnPlanner(
  lastAssistant: { model: string | null; createdAt: Date } | null,
  now: Date
): boolean {
  if (!lastAssistant?.model || !lastAssistant.model.includes("sonnet")) {
    return false;
  }
  return now.getTime() - lastAssistant.createdAt.getTime() < STICKINESS_WINDOW_MS;
}

// Circuit breaker: bound a single restaurant's daily planner spend. UTC day
// bucket — this is a runaway-loop guard, not billing, so coarse is fine.
export async function isEscalationBudgetExhausted(restaurantId: string): Promise<boolean> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const agg = await prisma.aiUsageLog.aggregate({
    where: {
      restaurantId,
      feature: "owner_chat_planner",
      createdAt: { gte: dayStart },
    },
    _sum: { costUsd: true },
  });

  return (agg._sum.costUsd ?? 0) >= env.SOUS_CHEF_ESCALATION_DAILY_LIMIT_USD;
}
