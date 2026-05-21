// Spend guardrails for Market Pulse Exa usage.
//
// Two enforcement layers:
//   1. Per-restaurant monthly cap (env.EXA_MONTHLY_USD_CAP_PER_RESTAURANT,
//      default $5). Computed by summing ai_usage_logs.cost_usd rows tagged
//      feature='competitor-intel' for the current calendar month.
//   2. Org-wide kill switch (env.EXA_ENABLED). When false, the Exa client
//      itself short-circuits — this module's checks become moot, but the
//      org-wide alert threshold helps us know when to flip the switch.
//
// Why ai_usage_logs and not a new table:
//   The existing logs table already aggregates LLM + image-gen spend per
//   restaurant. Reusing it keeps "what does this restaurant cost us?" a
//   single SUM, which is what the COO dashboard reads.

import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export const COMPETITOR_INTEL_FEATURE = "competitor-intel";

function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Total Exa spend (USD) for this restaurant in the current calendar month. */
export async function getRestaurantMonthlyExaSpend(
  restaurantId: string
): Promise<number> {
  const result = await prisma.aiUsageLog.aggregate({
    where: {
      restaurantId,
      feature: COMPETITOR_INTEL_FEATURE,
      createdAt: { gte: startOfMonthUtc() },
    },
    _sum: { costUsd: true },
  });
  return result._sum.costUsd ?? 0;
}

export interface BudgetCheckResult {
  allowed: boolean;
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
}

/** Decide whether we can spend up to `plannedSpendUsd` more on this
 *  restaurant in the current month. Returns false when the cap would be
 *  exceeded — the orchestrator must skip the call in that case. */
export async function checkRestaurantExaBudget(
  restaurantId: string,
  plannedSpendUsd: number
): Promise<BudgetCheckResult> {
  const capUsd = env.EXA_MONTHLY_USD_CAP_PER_RESTAURANT;
  const spentUsd = await getRestaurantMonthlyExaSpend(restaurantId);
  const remainingUsd = Math.max(0, capUsd - spentUsd);
  return {
    allowed: spentUsd + plannedSpendUsd <= capUsd,
    spentUsd,
    capUsd,
    remainingUsd,
  };
}

/** Record actual Exa spend after a call completes. Idempotent: each call
 *  writes a row, never an update. Persisting on every collector keeps the
 *  granularity high enough that the cap check is accurate within one
 *  collector's worth of spend (~$0.007-0.014). */
export async function recordExaSpend(
  restaurantId: string,
  costUsd: number
): Promise<void> {
  if (costUsd <= 0) return;
  await prisma.aiUsageLog.create({
    data: {
      restaurantId,
      feature: COMPETITOR_INTEL_FEATURE,
      tokensIn: 0,
      tokensOut: 0,
      costUsd,
    },
  });
}

/** Org-wide total Exa spend (USD) for the current calendar month. Used by
 *  the cron to fire a Resend alert when we approach env.EXA_ORG_MONTHLY_USD_ALERT. */
export async function getOrgMonthlyExaSpend(): Promise<number> {
  const result = await prisma.aiUsageLog.aggregate({
    where: {
      feature: COMPETITOR_INTEL_FEATURE,
      createdAt: { gte: startOfMonthUtc() },
    },
    _sum: { costUsd: true },
  });
  return result._sum.costUsd ?? 0;
}
