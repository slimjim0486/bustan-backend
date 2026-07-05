import { ApiError } from "@/lib/errors";

/**
 * Autonomy tiers (spec §3) — enforced in code, never in the prompt.
 *  0 — act silently (reads/analyses; ledger-optional)
 *  1 — act + notify (reversible owner-asked changes; ledgered)
 *  2 — propose + approve (customer-facing sends, price/publish; DraftAction approval + grace)
 *  3 — never (route to human; executor refuses)
 *
 * Tool names below are reconciled against the real `OWNER_TOOLS` array in
 * `src/services/owner-chat-tools.ts` (47 tools) plus the three Tier-3 guard
 * names, which are aspirational policy entries — no such tools exist yet,
 * but the registry documents the refusal policy for when they do.
 */
export type AutonomyTier = 0 | 1 | 2 | 3;

export const TOOL_TIERS: Readonly<Record<string, AutonomyTier>> = {
  // Tier 0 — reads & analyses
  get_menu_overview: 0,
  search_menu_items: 0,
  get_analytics: 0,
  get_menu_health: 0,
  get_dietary_tag_status: 0,
  get_image_status: 0,
  get_promotion_list: 0,
  list_calendar_moments: 0,
  get_restaurant_info: 0,
  get_ai_usage: 0,
  get_portfolio_overview: 0,
  list_support_tickets: 0,
  get_support_ticket: 0,
  run_menu_analysis: 0,
  get_ad_projects_summary: 0,
  get_ad_campaign_performance: 0,
  get_ad_attributed_customers: 0,
  get_crm_summary: 0,
  get_recent_customers: 0,
  get_inactive_customers: 0,
  get_engagement_breakdown: 0,
  get_top_paths: 0,
  get_seo_analysis: 0,
  get_whatsapp_status: 0,
  list_whatsapp_templates: 0,
  get_broadcast_performance: 0,
  get_widget_status: 0,
  escalate_to_planner: 0,
  get_competitor_activity: 0,
  get_bustan_info: 0,

  // Tier 1 — reversible, owner-asked, act + notify
  enhance_descriptions: 1, // drafting is tier 1; publish gate handled in tool
  suggest_dietary_tags: 1,
  toggle_availability: 1,
  update_promotion: 1, // edit/end an existing promo is reversible
  draft_review_replies: 1, // drafts only; owner still copy-pastes manually
  plan_marketing_week: 1, // stages a bundle for review

  // Tier 2 — propose + approve (customer-facing / price / publish / destructive)
  update_menu_item: 2,
  update_menu_items_bulk: 2,
  create_promotion: 2,
  send_whatsapp_campaign: 2,
  create_ad_campaign: 2,
  generate_dish_images: 2, // spend-capped; ships on approval
  delete_menu_items: 2,
  create_menu_item: 2,
  create_menu_section: 2,
  update_restaurant: 2,
  publish_menu: 2,

  // Tier 3 — never (executor refuses, routes to human/dashboard)
  delete_restaurant: 3,
  change_billing: 3,
  disconnect_whatsapp: 3,
};

export function getToolTier(toolName: string): AutonomyTier {
  return TOOL_TIERS[toolName] ?? 3; // fail closed: unknown → treat as forbidden
}

export function assertToolAllowed(toolName: string): void {
  if (!(toolName in TOOL_TIERS)) {
    throw new ApiError(`Unknown tool "${toolName}" — not in the autonomy registry.`, 400);
  }
  if (TOOL_TIERS[toolName] === 3) {
    throw new ApiError(
      `"${toolName}" is not permitted for the agent. This needs a human in the dashboard.`,
      403,
    );
  }
}
