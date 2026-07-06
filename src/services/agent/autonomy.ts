import type { PlanEntitlements } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";

export type EffectiveAutonomy = "draft_only" | "guarded_auto";

/**
 * The ONLY place the account-level autonomy decision is computed.
 * guarded_auto ⟺ plan entitlement allows it AND owner flipped the master toggle.
 * The velocity circuit-breaker is a SEPARATE per-action gate (see isHighImpactPaused).
 */
export function resolveEffectiveAutonomy(
  restaurant: { agentAutonomyOptIn: boolean },
  entitlements: PlanEntitlements,
): EffectiveAutonomy {
  if (entitlements.agentAutonomy === "guarded_auto" && restaurant.agentAutonomyOptIn) {
    return "guarded_auto";
  }
  return "draft_only";
}

/**
 * DraftAction.actionType values (from draft-actions.ts dispatchShip) that are
 * hard to reverse after ship: customer-facing sends, destructive deletes, and
 * money-spending generation. These earn the longer grace window and count
 * toward the velocity breaker.
 */
export const HIGH_IMPACT_ACTION_TYPES: ReadonlySet<string> = new Set([
  "whatsapp_campaign_send",
  "menu_items_delete",
  "dish_images_generate",
  "ad_campaign_create",
  "ad_campaign_create_and_generate",
]);

export function isHighImpactActionType(actionType: string): boolean {
  return HIGH_IMPACT_ACTION_TYPES.has(actionType);
}

const REVERSIBLE_GRACE_MS = 60 * 1000;
const HIGH_IMPACT_GRACE_MS = 5 * 60 * 1000;

/** Grace window before an AUTO-EXECUTED draft ships. Tiered by reversibility. */
export function graceMsForAutoExecute(actionType: string): number {
  return isHighImpactActionType(actionType) ? HIGH_IMPACT_GRACE_MS : REVERSIBLE_GRACE_MS;
}

/** Max high-impact auto-executed actions per rolling hour before auto-pause. */
export const HIGH_IMPACT_HOURLY_LIMIT = 3;
const ROLLING_WINDOW_MS = 60 * 60 * 1000;

/**
 * Pure: lower bound of the rolling burst window. A more-recent autonomyResumedAt
 * shrinks the window so tapping Resume zeroes prior actions.
 */
export function resolveWindowStart(now: Date, resumedAt: Date | null, windowMs: number): Date {
  const windowStart = new Date(now.getTime() - windowMs);
  return resumedAt && resumedAt > windowStart ? resumedAt : windowStart;
}

/** Pure: has the restaurant hit its high-impact burst ceiling? */
export function hasHitBurstLimit(recentCount: number, limit: number): boolean {
  return recentCount >= limit;
}

/**
 * Velocity circuit-breaker. Thin glue around the two pure helpers + one count.
 * Pause state is DERIVED from the count — no separate boolean to desync.
 */
export async function isHighImpactPaused(
  restaurantId: string,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId },
    select: { autonomyResumedAt: true },
  });
  const since = resolveWindowStart(now, restaurant?.autonomyResumedAt ?? null, ROLLING_WINDOW_MS);
  const recent = await prisma.draftAction.count({
    where: {
      restaurantId,
      autoExecuted: true,
      actionType: { in: [...HIGH_IMPACT_ACTION_TYPES] },
      createdAt: { gte: since },
    },
  });
  return hasHitBurstLimit(recent, HIGH_IMPACT_HOURLY_LIMIT);
}
