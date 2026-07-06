import type { PlanEntitlements } from "@/lib/entitlements";

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
