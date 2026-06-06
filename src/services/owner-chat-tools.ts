import type Anthropic from "@anthropic-ai/sdk";
import {
  type BustanKbTopic,
  getAllBustanTopics,
  getBustanKbEntry,
  resolveBustanTopic,
} from "@/lib/bustan-kb";
import { getRestaurantEntitlements, type PlanEntitlements } from "@/lib/entitlements";
import {
  createPendingAction,
  consumePendingAction,
} from "@/lib/pending-actions";
import { createDraft, type CreateDraftParams } from "@/services/draft-actions";
import { resolveCampaignAudience } from "@/services/campaign-send";
import { DraftActionKind, DraftActionSource } from "@prisma/client";
import { pullGoogleReviews, listUnansweredReviews } from "@/services/reviews/pull-reviews";
import { draftReplies } from "@/services/reviews/reply-drafter";
import { checkAiLimit, getAiUsageSummary, logAiUsage } from "@/lib/ai-usage";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import {
  enhanceSingleDescription,
  enhanceBulkDescriptions,
  suggestPromotionContent,
} from "@/services/description-writer";
import { suggestDietaryTags } from "@/services/dietary-tagger";
import { analyzeMenu } from "@/services/menu-analyzer";
import { sundayOfThisWeekUae } from "@/services/sabt-pack";
import {
  calendarMoments,
  resolveUpcomingMomentOccurrence,
} from "@/services/ad-studio/calendar";
import { briefInputSchema } from "@/services/ad-studio-ai";
import type {
  CompetitorChanges,
  MenuItemSignal,
  PressMentionSignal,
  PromoSignal,
  WebReviewSignal,
} from "@/services/competitor-intel";

// ── Tool Result Types ──────────────────────────────────────────

export interface ToolResult {
  content: string;
  preview?: {
    pendingActionId: string;
    description: string;
    changes: Array<{
      label: string;
      before: string | null;
      after: string;
    }>;
  };
  /**
   * Sous Chef Inbox draft id. When present, the chat client should render a
   * compact "Drafted — view in Inbox" pill instead of inline approve/reject
   * buttons; ownership of the decision moves from the chat bubble to the
   * persistent inbox card.
   */
  draftId?: string;
}

// Structured, self-correctable lookup error: gives the model the found/missing
// split plus real candidates so it can retry inside the loop instead of giving up.
async function buildItemNotFoundResult(
  restaurantId: string,
  requestedIds: string[],
  foundItems: Array<{ id: string; name: string }>
): Promise<ToolResult> {
  const missing = requestedIds.filter((id) => !foundItems.some((item) => item.id === id));
  const suggestions = await prisma.menuItem.findMany({
    where: { restaurantId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 10,
  });
  return {
    content: JSON.stringify({
      error: "item_not_found",
      missing_item_ids: missing,
      found: foundItems.map((i) => ({ id: i.id, name: i.name })),
      did_you_mean: suggestions,
      hint: "Re-check the IDs with search_menu_items, or pick the intended items from did_you_mean and retry.",
    }),
  };
}

// ── Tool Definitions ───────────────────────────────────────────

export const OWNER_TOOLS: Anthropic.Tool[] = [
  // ── READ TOOLS ──────────────────────────────────────────────

  {
    name: "get_menu_overview",
    description:
      "Get an overview of a restaurant's menu: section names, item counts, price ranges, description coverage, and image coverage stats. For portfolio owners, pass restaurant_id to query a different brand.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only). Defaults to the current restaurant." },
      },
      required: [],
    },
  },
  {
    name: "search_menu_items",
    description:
      "Search and filter menu items by name, section, price range, dietary tag, image status, or description quality. For portfolio owners, pass restaurant_id to query a different brand.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
        query: { type: "string", description: "Search in item names and descriptions" },
        section: { type: "string", description: "Filter by section name" },
        min_price: { type: "number", description: "Minimum price in AED" },
        max_price: { type: "number", description: "Maximum price in AED" },
        has_image: { type: "boolean", description: "Filter by image presence" },
        has_description: { type: "boolean", description: "Filter by description presence" },
        dietary_tag: { type: "string", description: "Filter by dietary tag key" },
      },
      required: [],
    },
  },
  {
    name: "get_analytics",
    description:
      "Get restaurant analytics: page views, WhatsApp clicks, likes, top items, and estimated cart order revenue. For portfolio owners, pass restaurant_id to query a different brand.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
      },
      required: [],
    },
  },
  {
    name: "get_menu_health",
    description:
      "Get the menu health analysis scores across 5 categories: pricing, descriptions, structure, gaps, and seasonal. Uses cached analysis if available.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_dietary_tag_status",
    description:
      "Get dietary tag coverage: how many items are tagged vs untagged, and the distribution of tags. For portfolio owners, pass restaurant_id to query a different brand.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
      },
      required: [],
    },
  },
  {
    name: "get_image_status",
    description:
      "Get image coverage: items with images, without images, generating, or failed. For portfolio owners, pass restaurant_id to query a different brand.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
      },
      required: [],
    },
  },
  {
    name: "get_promotion_list",
    description:
      "Get all promotions with their items, status, and pricing details.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_calendar_moments",
    description:
      "List MENA marketing calendar moments (Ramadan, Eid, National Day, Mother's Day, etc.) with their canonical IDs and next-upcoming date range. Call this when the owner mentions an event by name and you need the moment_id to pass into create_promotion or to confirm the dates with the owner.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Optional fuzzy name match (e.g., \"eid\", \"national\"). Returns all moments if omitted." },
        within_days: { type: "number", description: "Optional. Only return moments whose next occurrence starts within this many days from today. Useful for \"what's coming up next month?\"." },
      },
      required: [],
    },
  },
  {
    name: "get_restaurant_info",
    description:
      "Get restaurant profile details: name, description, hours, WhatsApp number, publish status, theme, and subscription info.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_ai_usage",
    description:
      "Get this month's AI feature usage across all features vs plan limits.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_portfolio_overview",
    description:
      "Get an overview of all brands in the portfolio with key stats including item counts, image coverage, and description coverage per brand. Portfolio tier only.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "list_support_tickets",
    description:
      "List this restaurant's support tickets with status, priority, severity, latest timeline activity, and resolution summary. Only returns tickets for the authenticated restaurant.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["open", "in_progress", "waiting_on_customer", "resolved", "closed"],
          description: "Optional status filter.",
        },
        limit: { type: "number", description: "Max tickets to return. Default 5, max 20." },
      },
      required: [],
    },
  },
  {
    name: "get_support_ticket",
    description:
      "Get details and visible timeline for a specific support ticket owned by this restaurant. Does not expose internal admin notes.",
    input_schema: {
      type: "object" as const,
      properties: {
        ticket_id: { type: "string", description: "Support ticket ID." },
      },
      required: ["ticket_id"],
    },
  },

  // ── WRITE TOOLS ─────────────────────────────────────────────

  {
    name: "enhance_descriptions",
    description:
      "Enhance menu item descriptions using AI. Can target a single item by ID or bulk enhance items with missing/weak descriptions.",
    input_schema: {
      type: "object" as const,
      properties: {
        menu_item_id: {
          type: "string",
          description: "Single item ID to enhance. Omit for bulk mode.",
        },
        bulk_mode: {
          type: "string",
          enum: ["missing", "weak", "all"],
          description:
            "Bulk mode: 'missing' = items without descriptions, 'weak' = missing or under 30 chars, 'all' = every item. Ignored if menu_item_id is set.",
        },
        tone: {
          type: "string",
          enum: ["casual", "upscale", "playful", "formal"],
          description: "Writing tone for the descriptions.",
        },
        execute: {
          type: "boolean",
          description: "If false (default), returns a preview. If true, applies changes using pendingActionId.",
        },
        pending_action_id: {
          type: "string",
          description: "Required when execute=true. The pending action ID from the preview step.",
        },
      },
      required: [],
    },
  },
  {
    name: "suggest_dietary_tags",
    description:
      "AI-analyze menu items and suggest dietary/allergen tags for untagged items.",
    input_schema: {
      type: "object" as const,
      properties: {
        execute: { type: "boolean", description: "If false (default), returns preview. If true, applies using pendingActionId." },
        pending_action_id: { type: "string", description: "Required when execute=true." },
      },
      required: [],
    },
  },
  {
    name: "update_menu_item",
    description:
      "Update a single menu item's name, description, price, or availability.",
    input_schema: {
      type: "object" as const,
      properties: {
        menu_item_id: { type: "string", description: "The item ID to update." },
        name: { type: "string", description: "New name." },
        description: { type: "string", description: "New description." },
        price: { type: "number", description: "New price in AED." },
        is_available: { type: "boolean", description: "Set availability." },
        execute: { type: "boolean" },
        pending_action_id: { type: "string" },
      },
      required: ["menu_item_id"],
    },
  },
  {
    name: "update_menu_items_bulk",
    description:
      "Batch update multiple menu items at once. Each update can modify name, description, price, or availability.",
    input_schema: {
      type: "object" as const,
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              menu_item_id: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              price: { type: "number" },
              is_available: { type: "boolean" },
            },
            required: ["menu_item_id"],
          },
          description: "Array of item updates.",
        },
        execute: { type: "boolean" },
        pending_action_id: { type: "string" },
      },
      required: ["updates"],
    },
  },
  {
    name: "create_promotion",
    description:
      "Create a new promotion (discounted item, deal, or combo) with optional AI-generated copy. When the owner names a calendar event (Ramadan, Eid, National Day, Mother's Day, etc.), pass moment_id to tie the promo to that moment — starts_at/ends_at will auto-fill from the moment's date range. When the owner states a percentage off (\"15% off\", \"20%\"), prefer discount_percent over promo_price; the server computes the absolute promo price from the item's current price. For \"X% off item A and item B\" as ONE combined offer, create a single deal promotion with both item_ids — the promo price is computed off the summed item prices. If the owner wants each item discounted separately, create one discounted_item promotion per item and confirm that interpretation first.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: ["discounted_item", "deal", "combo"] },
        item_ids: { type: "array", items: { type: "string" }, description: "Menu item IDs for the promotion." },
        title: { type: "string" },
        subtitle: { type: "string" },
        description: { type: "string" },
        badge_label: { type: "string" },
        terms: { type: "string" },
        promo_price: { type: "number", description: "Absolute promo price in AED. Use this OR discount_percent, not both. If both are passed, discount_percent wins." },
        discount_percent: { type: "number", description: "Percentage off the current item price, e.g. 15 for 15% off. Server computes promo_price as round(currentPrice * (1 - discount_percent/100)). For deal/combo types with multiple items, applies to the sum of item prices." },
        starts_at: { type: "string", description: "ISO date string. Optional if moment_id is supplied." },
        ends_at: { type: "string", description: "ISO date string. Optional if moment_id is supplied." },
        moment_id: { type: "string", description: "Optional calendar moment ID (e.g. \"eid_al_fitr\", \"ramadan\", \"uae_national_day\"). When supplied, the promo is linked to that moment and date defaults are taken from its next-upcoming occurrence. Use list_calendar_moments to discover valid IDs." },
        use_ai_copy: { type: "boolean", description: "Generate AI copy for the promotion." },
        tone: { type: "string", enum: ["casual", "upscale", "playful", "formal"] },
        execute: { type: "boolean" },
        pending_action_id: { type: "string" },
      },
      required: ["type", "item_ids"],
    },
  },
  {
    name: "update_promotion",
    description:
      "Edit or end an existing promotion. Call when the owner wants to change a promotion's price/discount, dates, title/copy, items, or to end/deactivate it (\"end the Eid offer\", \"extend it through Sunday\", \"make it 15% instead\"). To END a promotion pass is_active=false (or an ends_at in the past). Use get_promotion_list first to find the promotion_id. Only pass the fields being changed.",
    input_schema: {
      type: "object" as const,
      properties: {
        promotion_id: { type: "string" },
        title: { type: "string" },
        subtitle: { type: "string" },
        description: { type: "string" },
        badge_label: { type: "string" },
        terms: { type: "string" },
        promo_price: { type: "number", description: "New absolute promo price in AED. Use this OR discount_percent." },
        discount_percent: { type: "number", description: "New percentage off; server recomputes promo price from the CURRENT linked items' summed price." },
        starts_at: { type: "string", description: "ISO date string." },
        ends_at: { type: "string", description: "ISO date string. \"End it tonight\" = today 23:59 local (UTC+4)." },
        is_active: { type: "boolean", description: "false = end/deactivate the promotion immediately." },
        item_ids: { type: "array", items: { type: "string" }, description: "ONLY when changing which items are included; replaces the full item list." },
      },
      required: ["promotion_id"],
    },
  },
  {
    name: "send_whatsapp_campaign",
    description:
      "Draft a WhatsApp marketing broadcast to a customer segment. Owner approval in the Inbox SENDS IT (after a 5-minute undo window) — say so when presenting the draft. Segments: inactive customers (optionally a custom day threshold), weekend_special, or new_promotion (pass promotion_id to feature one). Only opted-in customers with provable consent receive it. Call get_whatsapp_status / list_whatsapp_templates first if unsure of template availability.",
    input_schema: {
      type: "object" as const,
      properties: {
        segment: { type: "string", enum: ["inactive", "weekend_special", "new_promotion"] },
        inactive_days: { type: "number", description: "For segment=inactive: days since last order (7-365). Default 30." },
        template_name: { type: "string", description: "WhatsApp template to use. Omit to use the default for the segment." },
        body: { type: "string", description: "Custom message body (used in link mode or when no approved template). Supports {{name}}." },
        name: { type: "string", description: "Campaign name for the CRM list." },
        promotion_id: { type: "string", description: "Promotion to feature (required for new_promotion segment)." },
      },
      required: ["segment"],
    },
  },
  {
    name: "create_ad_campaign",
    description:
      "Create an Ad Studio campaign project and generate ad creatives for it. Call when the owner wants ads made (\"set up a Ramadan campaign\", \"make ads for my new burger\"). Approval creates the project AND starts generating ad variants the owner reviews in Ad Studio. Counts against the monthly ad project quota. If the owner names a calendar event, you may pass moment_id (see list_calendar_moments).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Campaign name, e.g. \"Ramadan Iftar Push\"." },
        campaign_brief: { type: "string", description: "1-3 sentences on what the campaign should achieve and feature." },
        goal: { type: "string", enum: ["tofu", "mofu", "bofu", "retention"], description: "tofu=awareness, mofu=consideration, bofu=orders now, retention=repeat customers. Default bofu." },
        budget_aed: { type: "number", description: "Total budget in AED (500-500000). Default 1500." },
        budget_tier: { type: "string", enum: ["lean", "standard", "aggressive"], description: "Default lean." },
        countries: { type: "array", items: { type: "string" }, description: "ISO codes. Default [\"AE\"]." },
        primary_dish_id: { type: "string", description: "Menu item to feature, if any." },
        moment_id: { type: "string", description: "Calendar moment to tie the campaign to." },
      },
      required: ["name", "campaign_brief"],
    },
  },
  {
    name: "generate_dish_images",
    description:
      "Generate AI photos for menu items (max 15 per request). Call when the owner wants dish photos created (\"generate photos for items missing images\"). Pass specific menu_item_ids, or missing_only=true to target items with no usable image. Counts against the monthly image generation quota. Each approved image generates in the background (~1 min each).",
    input_schema: {
      type: "object" as const,
      properties: {
        menu_item_ids: { type: "array", items: { type: "string" }, description: "Specific items. Max 15." },
        missing_only: { type: "boolean", description: "Target items with no usable image instead of naming ids." },
        limit: { type: "number", description: "With missing_only: cap how many (default 10, max 15)." },
        prompt_modifier: { type: "string", description: "Optional style hint, e.g. \"dark moody lighting\"." },
      },
      required: [],
    },
  },
  {
    name: "delete_menu_items",
    description:
      "PERMANENTLY delete menu items and/or whole sections. Destructive and final after the approval grace window — always restate what will be deleted (including items inside sections and any promotions affected) before the owner approves. For temporarily unavailable dishes use toggle_availability instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        menu_item_ids: { type: "array", items: { type: "string" } },
        section_ids: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
  },
  {
    name: "toggle_availability",
    description:
      "Mark menu items as sold out or available.",
    input_schema: {
      type: "object" as const,
      properties: {
        menu_item_ids: { type: "array", items: { type: "string" }, description: "Item IDs to toggle." },
        available: { type: "boolean", description: "true = mark available, false = mark sold out." },
        execute: { type: "boolean" },
        pending_action_id: { type: "string" },
      },
      required: ["menu_item_ids", "available"],
    },
  },
  {
    name: "create_menu_item",
    description:
      "Add a new menu item to a section.",
    input_schema: {
      type: "object" as const,
      properties: {
        section_id: { type: "string", description: "Section ID to add the item to." },
        name: { type: "string" },
        description: { type: "string" },
        price: { type: "number" },
        execute: { type: "boolean" },
        pending_action_id: { type: "string" },
      },
      required: ["section_id", "name", "price"],
    },
  },
  {
    name: "create_menu_section",
    description:
      "Create a new menu section.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Section name." },
        execute: { type: "boolean" },
        pending_action_id: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_restaurant",
    description:
      "Update restaurant profile fields like description, WhatsApp number, location, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        description: { type: "string" },
        whatsapp_number: { type: "string" },
        location: { type: "string" },
        address: { type: "string" },
        phone: { type: "string" },
        website: { type: "string" },
        execute: { type: "boolean" },
        pending_action_id: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "publish_menu",
    description:
      "Publish or unpublish the restaurant's menu page.",
    input_schema: {
      type: "object" as const,
      properties: {
        publish: { type: "boolean", description: "true to publish, false to unpublish." },
        execute: { type: "boolean" },
        pending_action_id: { type: "string" },
      },
      required: ["publish"],
    },
  },
  {
    name: "run_menu_analysis",
    description:
      "Trigger a fresh AI menu health analysis. Returns scores across 5 categories with actionable recommendations.",
    input_schema: {
      type: "object" as const,
      properties: {
        execute: { type: "boolean" },
        pending_action_id: { type: "string" },
      },
      required: [],
    },
  },

  // ── AD STUDIO READ TOOLS ──────────────────────────────────────
  {
    name: "get_ad_projects_summary",
    description:
      "List the restaurant's Ad Studio projects with status, budget, variant count, and live-campaign link state. For portfolio owners, pass restaurant_id to query a different brand.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
      },
      required: [],
    },
  },
  {
    name: "get_ad_campaign_performance",
    description:
      "Aggregate performance for a single ad project's live campaign: spend, impressions, clicks, CTR, CPC, conversions, attributed revenue over the last N days.",
    input_schema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string", description: "The Ad Studio project ID." },
        days: { type: "number", description: "Lookback window in days. Default 7." },
      },
      required: ["project_id"],
    },
  },
  {
    name: "get_ad_attributed_customers",
    description:
      "List customers attributed to an Ad Studio project via the CTWA referral bridge, ordered by total spend.",
    input_schema: {
      type: "object" as const,
      properties: {
        project_id: { type: "string", description: "The Ad Studio project ID." },
        limit: { type: "number", description: "Max rows (default 10, max 50)." },
      },
      required: ["project_id"],
    },
  },

  // ── CRM / CUSTOMER READ TOOLS ─────────────────────────────────
  {
    name: "get_crm_summary",
    description:
      "Customer-level summary: total customers, repeat customers, opt-in count, average order value, recent 30d active count, last broadcast date.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
      },
      required: [],
    },
  },
  {
    name: "get_recent_customers",
    description:
      "List the most recently active customers with total spend, order count, opt-in status, and referral source.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
        limit: { type: "number", description: "Max rows (default 10, max 50)." },
      },
      required: [],
    },
  },
  {
    name: "get_inactive_customers",
    description:
      "Find marketing-opted-in customers whose last order was more than N days ago — the 'winback list'.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
        days: { type: "number", description: "Days since last order (default 30)." },
        limit: { type: "number", description: "Max rows (default 20, max 100)." },
      },
      required: [],
    },
  },

  // ── ANALYTICS EXPANSION ───────────────────────────────────────
  {
    name: "get_engagement_breakdown",
    description:
      "Engagement metrics broken out by type over the last N days: menu item likes, branding clicks, WhatsApp clicks, cart orders.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
        days: { type: "number", description: "Lookback window in days (default 7)." },
      },
      required: [],
    },
  },
  {
    name: "get_top_paths",
    description:
      "List the most-viewed paths (URLs) on the restaurant's menu site over the last N days.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
        days: { type: "number", description: "Lookback window in days (default 7)." },
        limit: { type: "number", description: "Max paths (default 10, max 50)." },
      },
      required: [],
    },
  },

  // ── SEO READ TOOLS ────────────────────────────────────────────
  {
    name: "get_seo_analysis",
    description:
      "Latest SEO analysis for the restaurant: overall score, sub-scores (GBP, on-page, rank grid, citations, reviews), status, top recommendations, last run date. Returns 'not_run' if no analysis has been started.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
      },
      required: [],
    },
  },

  // ── WHATSAPP READ TOOLS ───────────────────────────────────────
  {
    name: "get_whatsapp_status",
    description:
      "WhatsApp Business API integration status: connected/disconnected, registered phone number, template count, pending replies in 24h service window, last error.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
      },
      required: [],
    },
  },
  {
    name: "list_whatsapp_templates",
    description:
      "List WhatsApp Business API message templates with name, language, category, approval status (draft/pending/approved/rejected), and last sync.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
      },
      required: [],
    },
  },
  {
    name: "get_broadcast_performance",
    description:
      "Recent broadcast campaigns: type, status, target count vs logged count, sent date. Defaults to last 30 days.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
        days: { type: "number", description: "Lookback window in days (default 30)." },
        limit: { type: "number", description: "Max campaigns (default 10, max 50)." },
      },
      required: [],
    },
  },

  // ── WIDGET READ TOOLS ─────────────────────────────────────────
  {
    name: "get_widget_status",
    description:
      "Embeddable menu widget status: whether the entitlement is enabled, the embed iframe code, and the public menu URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
      },
      required: [],
    },
  },

  // ── REVIEWS ──────────────────────────────────────────────────
  {
    name: "draft_review_replies",
    description:
      "Pull recent Google reviews and draft an owner-voiced reply for each one that hasn't been answered. Tone-aware (warm for 5-stars, deferential for 1-2 stars) and language-aware (replies in the review's language). Returns a bulk inbox card with all drafts — the owner copies each reply and pastes it into their Google Business Profile (Bustan can't post replies for you yet). Use when the owner asks 'reply to my reviews', 'draft Google replies', 'help with bad reviews'. Skips reviews you've already replied to.",
    input_schema: {
      type: "object" as const,
      properties: {
        force_refresh: {
          type: "boolean",
          description:
            "If true, pull fresh reviews from Apify even within the 6h refresh throttle. Use sparingly — costs ~$0.50 per pull.",
        },
        limit: {
          type: "number",
          description:
            "Max reviews to draft replies for in this batch. Default 8, max 15. Larger batches risk Claude truncation.",
        },
      },
      required: [],
    },
  },

  // ── MACRO TOOLS ──────────────────────────────────────────────
  // High-leverage "plan this for me" macros that bundle several drafts into
  // one parent DraftAction. The owner approves the bundle and every child
  // ships atomically at the same shipAt.
  {
    name: "escalate_to_planner",
    description:
      "Hand off to deeper planning. Call this FIRST — alone, before any other tool — when the owner's request needs multiple coordinated changes in one go (e.g. \"set up my Eid push: discount the platters, rewrite their descriptions, and feature them\"). Do not call it for single actions or pure questions. Calling it restarts the turn with a larger tool budget.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "One sentence on why this needs multi-step planning.",
        },
      },
      required: [],
    },
  },
  {
    name: "plan_marketing_week",
    description:
      "Plan a coordinated marketing bundle for the next 7 days. Reads upcoming event-calendar moments, recent menu performance, and customer segments. Drafts a parent 'marketing_bundle' with child drafts for an ad campaign (if a moment is in the prep window), a WhatsApp blast (if there are lapsed regulars), and a featured promotion. Owner reviews the bundle and Ships All — every child fires at the same time. Use when the owner asks 'plan my week', 'set up weekend marketing', or anything about coordinated multi-channel campaigns.",
    input_schema: {
      type: "object" as const,
      properties: {
        theme_hint: {
          type: "string",
          description:
            "Optional theme the owner wants to anchor the week on (e.g. 'biryani heroes', 'weekend brunch'). If omitted, we infer from upcoming events + top menu items.",
        },
      },
      required: [],
    },
  },

  // ── MARKET PULSE (Competitor Intelligence) ────────────────────
  {
    name: "get_competitor_activity",
    description:
      "Read what nearby competitors have done recently — new menu items + prices, promos/offers, press mentions, and deep-web reviews (Reddit, TripAdvisor, Zomato, Time Out). Snapshots are refreshed weekly by the Market Pulse cron (Sunday morning). Always include the week-over-week diff (`changes`) when answering 'what's changed' or 'who launched X' questions — that's the most actionable signal. If `status` is 'not_eligible', the restaurant is on Starter; suggest upgrading to Pro. If `status` is 'no_data_yet', tell the owner the first weekly pull lands Sunday and offer to check back. For portfolio owners, pass restaurant_id to query a different brand.",
    input_schema: {
      type: "object" as const,
      properties: {
        restaurant_id: { type: "string", description: "Optional. Query a different brand (portfolio only)." },
        week_bucket: {
          type: "string",
          description:
            "Optional ISO date 'YYYY-MM-DD' for the Sunday of the week to read. Defaults to the current UAE week.",
        },
        limit: {
          type: "number",
          description:
            "Max competitors to return (default 10, max 10). Useful to cap context for quick summaries.",
        },
      },
      required: [],
    },
  },

  // ── BUSTAN PLATFORM KB ────────────────────────────────────────
  {
    name: "get_bustan_info",
    description:
      "Look up an accurate, current fact about Bustan itself — pricing, plans, the free trial, AI feature limits, signup flow, WhatsApp (integration, onboarding, templates, compliance), Google integrations, Portfolio multi-brand, growth tools, data privacy, refunds, support, languages, or how the platform works. ALWAYS call this tool first when the owner asks anything about Bustan as a product (pricing, what's included on another tier, refunds, deletion, Arabic support, how to connect WhatsApp, troubleshooting onboarding, etc.). Never guess Bustan facts from memory.",
    input_schema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string",
          enum: getAllBustanTopics(),
          description:
            "Topic key. Pick the closest match. WhatsApp-specific topics: whatsapp (general what-is), whatsapp_onboarding (connecting, Embedded Signup, prerequisites, troubleshooting setup), whatsapp_templates (transactional vs marketing, what auto-fires, customising copy, submission and rejection), whatsapp_compliance (rules to not get blocked, quality rating, tiers, frequency, opt-in). Other topics: overview, pricing, trial, signup, ai_features, menu_import, public_page, google_integrations, portfolio, growth_tools, languages, data_privacy, refunds, support, for_owners.",
        },
        query: {
          type: "string",
          description:
            "Optional: the owner's original question. If you're unsure which topic fits, leave topic empty and pass the question here — we auto-resolve.",
        },
      },
      required: [],
    },
  },
];

// Phase 2 write tools stay dark until the restaurant's routing flag is on —
// otherwise they'd activate for every Pro customer at deploy, executed by the
// un-escalated default tier. Two FROZEN arrays (not rebuilt per request) keep
// the prompt-cache prefix byte-stable per variant.
export const PHASE2_TOOL_NAMES = new Set([
  "update_promotion",
  "send_whatsapp_campaign",
  "create_ad_campaign",
  "generate_dish_images",
  "delete_menu_items",
]);

const BASE_OWNER_TOOLS = OWNER_TOOLS.filter((tool) => !PHASE2_TOOL_NAMES.has(tool.name));

export function getOwnerTools(phase2Enabled: boolean): Anthropic.Tool[] {
  return phase2Enabled ? OWNER_TOOLS : BASE_OWNER_TOOLS;
}

// ── Execution ──────────────────────────────────────────────────

type Input = Record<string, unknown>;

function formatPrice(value: number | string | { toString(): string }): string {
  return `AED ${Number(value.toString()).toFixed(2)}`;
}

/**
 * For portfolio users, read tools can target a different brand by passing
 * `restaurant_id`. This validates the target brand belongs to the same
 * operator account as the current restaurant.
 */
async function resolveTargetRestaurantId(
  currentRestaurantId: string,
  clerkId: string,
  input: Input
): Promise<string> {
  const targetId = input.restaurant_id ? String(input.restaurant_id) : null;
  if (!targetId || targetId === currentRestaurantId) {
    return currentRestaurantId;
  }

  // Verify the target brand belongs to the same owner
  const target = await prisma.restaurant.findFirst({
    where: {
      id: targetId,
      owner: { clerkId },
    },
    select: { id: true },
  });

  if (!target) {
    throw new Error("Restaurant not found or not owned by you.");
  }

  return target.id;
}

export async function executeTool(
  toolName: string,
  restaurantId: string,
  clerkId: string,
  entitlements: PlanEntitlements,
  input: Input
): Promise<ToolResult> {
  try {
    // For read tools that support cross-brand queries, resolve the target
    const crossBrandTools = new Set([
      "get_menu_overview",
      "search_menu_items",
      "get_analytics",
      "get_dietary_tag_status",
      "get_image_status",
      "get_ad_projects_summary",
      "get_crm_summary",
      "get_recent_customers",
      "get_inactive_customers",
      "get_engagement_breakdown",
      "get_top_paths",
      "get_seo_analysis",
      "get_whatsapp_status",
      "list_whatsapp_templates",
      "get_broadcast_performance",
      "get_widget_status",
      "get_competitor_activity",
    ]);
    const targetId = crossBrandTools.has(toolName)
      ? await resolveTargetRestaurantId(restaurantId, clerkId, input)
      : restaurantId;

    switch (toolName) {
      case "get_menu_overview":
        return await execGetMenuOverview(targetId);
      case "search_menu_items":
        return await execSearchMenuItems(targetId, input);
      case "get_analytics":
        return await execGetAnalytics(targetId);
      case "get_menu_health":
        return await execGetMenuHealth(restaurantId, entitlements);
      case "get_dietary_tag_status":
        return await execGetDietaryTagStatus(targetId);
      case "get_image_status":
        return await execGetImageStatus(targetId);
      case "get_promotion_list":
        return await execGetPromotionList(restaurantId);
      case "list_calendar_moments":
        return await execListCalendarMoments(input);
      case "get_restaurant_info":
        return await execGetRestaurantInfo(restaurantId);
      case "get_ai_usage":
        return await execGetAiUsage(restaurantId, entitlements);
      case "get_portfolio_overview":
        return await execGetPortfolioOverview(restaurantId, clerkId, entitlements);
      case "list_support_tickets":
        return await execListSupportTickets(restaurantId, input);
      case "get_support_ticket":
        return await execGetSupportTicket(restaurantId, input);
      case "enhance_descriptions":
        return await execEnhanceDescriptions(restaurantId, clerkId, entitlements, input);
      case "suggest_dietary_tags":
        return await execSuggestDietaryTags(restaurantId, clerkId, entitlements, input);
      case "update_menu_item":
        return await execUpdateMenuItem(restaurantId, clerkId, input);
      case "update_menu_items_bulk":
        return await execUpdateMenuItemsBulk(restaurantId, clerkId, input);
      case "create_promotion":
        return await execCreatePromotion(restaurantId, clerkId, entitlements, input);
      case "update_promotion":
        return await execUpdatePromotion(restaurantId, clerkId, input);
      case "send_whatsapp_campaign":
        return await execSendWhatsappCampaign(restaurantId, clerkId, input);
      case "create_ad_campaign":
        return await execCreateAdCampaign(restaurantId, clerkId, entitlements, input);
      case "generate_dish_images":
        return await execGenerateDishImages(restaurantId, clerkId, entitlements, input);
      case "delete_menu_items":
        return await execDeleteMenuItems(restaurantId, clerkId, input);
      case "toggle_availability":
        return await execToggleAvailability(restaurantId, clerkId, input);
      case "create_menu_item":
        return await execCreateMenuItem(restaurantId, clerkId, input);
      case "create_menu_section":
        return await execCreateMenuSection(restaurantId, clerkId, input);
      case "update_restaurant":
        return await execUpdateRestaurant(restaurantId, clerkId, input);
      case "publish_menu":
        return await execPublishMenu(restaurantId, clerkId, input);
      case "run_menu_analysis":
        return await execRunMenuAnalysis(restaurantId, clerkId, entitlements, input);

      // Ad Studio
      case "get_ad_projects_summary":
        return await execGetAdProjectsSummary(targetId);
      case "get_ad_campaign_performance":
        return await execGetAdCampaignPerformance(restaurantId, clerkId, input);
      case "get_ad_attributed_customers":
        return await execGetAdAttributedCustomers(restaurantId, clerkId, input);

      // CRM
      case "get_crm_summary":
        return await execGetCrmSummary(targetId);
      case "get_recent_customers":
        return await execGetRecentCustomers(targetId, input);
      case "get_inactive_customers":
        return await execGetInactiveCustomers(targetId, input);

      // Analytics expansion
      case "get_engagement_breakdown":
        return await execGetEngagementBreakdown(targetId, input);
      case "get_top_paths":
        return await execGetTopPaths(targetId, input);

      // SEO
      case "get_seo_analysis":
        return await execGetSeoAnalysis(targetId);

      // WhatsApp
      case "get_whatsapp_status":
        return await execGetWhatsAppStatus(targetId);
      case "list_whatsapp_templates":
        return await execListWhatsAppTemplates(targetId);
      case "get_broadcast_performance":
        return await execGetBroadcastPerformance(targetId, input);

      // Widget
      case "get_widget_status":
        return await execGetWidgetStatus(targetId);

      // Market Pulse
      case "get_competitor_activity":
        return await execGetCompetitorActivity(targetId, entitlements, input);

      // Bustan platform KB
      case "get_bustan_info":
        return execGetBustanInfo(input);

      // Reviews
      case "draft_review_replies":
        return await execDraftReviewReplies(restaurantId, clerkId, input);

      // Macro tools — produce bundles
      case "plan_marketing_week":
        return await execPlanMarketingWeek(restaurantId, clerkId, input);

      case "escalate_to_planner":
        return {
          content: JSON.stringify({
            acknowledged: true,
            note: "Planning mode is already active. Proceed with the owner's request step by step; do not call escalate_to_planner again.",
          }),
        };

      default:
        return { content: JSON.stringify({ error: `Unknown tool: ${toolName}` }) };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed";
    return { content: JSON.stringify({ error: message }) };
  }
}

// ── READ Tool Implementations ──────────────────────────────────

function execGetBustanInfo(input: Input): ToolResult {
  const allTopics = getAllBustanTopics();
  const requestedTopic =
    typeof input.topic === "string" ? input.topic : undefined;
  const query = typeof input.query === "string" ? input.query : undefined;

  let topic: BustanKbTopic | null = null;
  if (requestedTopic && (allTopics as string[]).includes(requestedTopic)) {
    topic = requestedTopic as BustanKbTopic;
  }
  if (!topic && query) {
    topic = resolveBustanTopic(query);
  }
  if (!topic) {
    topic = "overview";
  }

  const entry = getBustanKbEntry(topic);
  return {
    content: JSON.stringify({
      topic: entry.topic,
      summary: entry.summary,
      links: entry.links ?? [],
      note: "Verbatim Bustan platform fact for this topic. Use this in your reply rather than guessing. Cite the most relevant link when it helps the owner take action.",
    }),
  };
}

async function execGetMenuOverview(restaurantId: string): Promise<ToolResult> {
  const sections = await prisma.menuSection.findMany({
    where: { restaurantId },
    orderBy: { displayOrder: "asc" },
    include: {
      items: {
        orderBy: { displayOrder: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          imageUrl: true,
          isAvailable: true,
        },
      },
    },
  });

  const allItems = sections.flatMap((s) => s.items);
  const prices = allItems.map((i) => Number(i.price));
  const withDescription = allItems.filter((i) => i.description && i.description.length > 0);
  const withImage = allItems.filter((i) => i.imageUrl);
  const soldOut = allItems.filter((i) => !i.isAvailable);

  const overview = {
    totalSections: sections.length,
    totalItems: allItems.length,
    priceRange: prices.length
      ? { min: formatPrice(Math.min(...prices)), max: formatPrice(Math.max(...prices)) }
      : null,
    descriptionCoverage: `${withDescription.length}/${allItems.length} items have descriptions (${allItems.length ? Math.round((withDescription.length / allItems.length) * 100) : 0}%)`,
    imageCoverage: `${withImage.length}/${allItems.length} items have images (${allItems.length ? Math.round((withImage.length / allItems.length) * 100) : 0}%)`,
    soldOutItems: soldOut.length,
    sections: sections.map((s) => ({
      name: s.name,
      itemCount: s.items.length,
    })),
  };

  return { content: JSON.stringify(overview) };
}

async function execSearchMenuItems(restaurantId: string, input: Input): Promise<ToolResult> {
  const where: Record<string, unknown> = { restaurantId };

  if (input.section) {
    const section = await prisma.menuSection.findFirst({
      where: {
        restaurantId,
        name: { contains: String(input.section), mode: "insensitive" },
      },
    });
    if (section) where.sectionId = section.id;
  }

  if (input.min_price !== undefined || input.max_price !== undefined) {
    const priceFilter: Record<string, unknown> = {};
    if (input.min_price !== undefined) priceFilter.gte = Number(input.min_price);
    if (input.max_price !== undefined) priceFilter.lte = Number(input.max_price);
    where.price = priceFilter;
  }

  if (input.has_image === true) where.imageUrl = { not: null };
  if (input.has_image === false) where.imageUrl = null;
  if (input.has_description === true) {
    where.description = { not: null };
  }
  if (input.has_description === false) where.description = null;

  if (input.query) {
    where.OR = [
      { name: { contains: String(input.query), mode: "insensitive" } },
      { description: { contains: String(input.query), mode: "insensitive" } },
    ];
  }

  const items = await prisma.menuItem.findMany({
    where,
    include: {
      section: { select: { name: true } },
      dietaryTags: {
        include: { tag: { select: { key: true, label: true } } },
      },
    },
    orderBy: { displayOrder: "asc" },
    take: 50,
  });

  if (input.dietary_tag) {
    const tagKey = String(input.dietary_tag).toLowerCase();
    const filtered = items.filter((item) =>
      item.dietaryTags.some((dt) => dt.tag.key.toLowerCase().includes(tagKey))
    );
    return {
      content: JSON.stringify({
        count: filtered.length,
        items: filtered.map((i) => ({
          id: i.id,
          section: i.section.name,
          name: i.name,
          price: formatPrice(i.price),
          description: i.description,
          available: i.isAvailable,
          tags: i.dietaryTags.map((dt) => dt.tag.label),
        })),
      }),
    };
  }

  return {
    content: JSON.stringify({
      count: items.length,
      items: items.map((i) => ({
        id: i.id,
        section: i.section.name,
        name: i.name,
        price: formatPrice(i.price),
        description: i.description,
        available: i.isAvailable,
        tags: i.dietaryTags.map((dt) => dt.tag.label),
      })),
    }),
  };
}

async function execGetAnalytics(restaurantId: string): Promise<ToolResult> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  const [totalViews, viewsToday, viewsThisWeek, totalLikes, likesThisWeek, totalWhatsAppClicks, whatsAppClicksThisWeek, topLikedItems, cartOrders] =
    await Promise.all([
      prisma.pageView.count({ where: { restaurantId } }),
      prisma.pageView.count({ where: { restaurantId, createdAt: { gte: todayStart } } }),
      prisma.pageView.count({ where: { restaurantId, createdAt: { gte: weekStart } } }),
      prisma.menuItemLike.count({ where: { menuItem: { restaurantId } } }),
      prisma.menuItemLike.count({ where: { menuItem: { restaurantId }, createdAt: { gte: weekStart } } }),
      prisma.whatsAppClick.count({ where: { restaurantId } }),
      prisma.whatsAppClick.count({ where: { restaurantId, createdAt: { gte: weekStart } } }),
      prisma.menuItemLike.groupBy({
        by: ["menuItemId"],
        where: { menuItem: { restaurantId } },
        _count: true,
        orderBy: { _count: { menuItemId: "desc" } },
        take: 5,
      }),
      prisma.whatsAppCartOrder.aggregate({
        where: { restaurantId },
        _sum: { totalPrice: true },
        _count: true,
      }),
    ]);

  // Get names for top liked items
  const topItemIds = topLikedItems.map((i) => i.menuItemId);
  const topItems = topItemIds.length
    ? await prisma.menuItem.findMany({
        where: { id: { in: topItemIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameMap = new Map(topItems.map((i) => [i.id, i.name]));

  return {
    content: JSON.stringify({
      views: { total: totalViews, today: viewsToday, thisWeek: viewsThisWeek },
      likes: {
        total: totalLikes,
        thisWeek: likesThisWeek,
        topItems: topLikedItems.map((i) => ({
          name: nameMap.get(i.menuItemId) ?? "Unknown",
          likes: i._count,
        })),
      },
      whatsapp: {
        totalClicks: totalWhatsAppClicks,
        clicksThisWeek: whatsAppClicksThisWeek,
      },
      orders: {
        total: cartOrders._count,
        estimatedRevenue: cartOrders._sum.totalPrice
          ? formatPrice(cartOrders._sum.totalPrice)
          : "AED 0.00",
      },
    }),
  };
}

async function execGetMenuHealth(
  restaurantId: string,
  entitlements: PlanEntitlements
): Promise<ToolResult> {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true, cuisineType: true, location: true },
    });

    const result = await analyzeMenu(
      {
        id: restaurantId,
        name: restaurant?.name ?? "",
        cuisineType: restaurant?.cuisineType ?? null,
        location: restaurant?.location ?? null,
      },
      entitlements.menuAnalysisLevel
    );

    if (result.cached) {
      return { content: JSON.stringify({ cached: true, analysis: result.result }) };
    }

    await logAiUsage(restaurantId, "menu_analysis", result.tokensIn, result.tokensOut);
    return { content: JSON.stringify({ cached: false, analysis: result.result }) };
  } catch (error) {
    // If no cached analysis and we can't run one, return a message
    return {
      content: JSON.stringify({
        error: error instanceof Error ? error.message : "Could not retrieve menu health analysis",
      }),
    };
  }
}

async function execGetDietaryTagStatus(restaurantId: string): Promise<ToolResult> {
  const items = await prisma.menuItem.findMany({
    where: { restaurantId },
    select: {
      id: true,
      name: true,
      dietaryTags: {
        include: { tag: { select: { key: true, label: true, category: true } } },
      },
    },
  });

  const tagged = items.filter((i) => i.dietaryTags.length > 0);
  const untagged = items.filter((i) => i.dietaryTags.length === 0);

  // Tag distribution
  const tagCounts: Record<string, number> = {};
  for (const item of items) {
    for (const dt of item.dietaryTags) {
      tagCounts[dt.tag.label] = (tagCounts[dt.tag.label] ?? 0) + 1;
    }
  }

  return {
    content: JSON.stringify({
      totalItems: items.length,
      taggedItems: tagged.length,
      untaggedItems: untagged.length,
      coverage: `${items.length ? Math.round((tagged.length / items.length) * 100) : 0}%`,
      tagDistribution: Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ tag: label, count })),
      untaggedItemNames: untagged.slice(0, 10).map((i) => i.name),
    }),
  };
}

async function execGetImageStatus(restaurantId: string): Promise<ToolResult> {
  const items = await prisma.menuItem.findMany({
    where: { restaurantId },
    select: {
      id: true,
      name: true,
      imageUrl: true,
      imageStatus: true,
    },
  });

  const withImage = items.filter((i) => i.imageUrl);
  const generating = items.filter((i) => i.imageStatus === "generating");
  const failed = items.filter((i) => i.imageStatus === "failed");
  const noImage = items.filter((i) => !i.imageUrl && i.imageStatus !== "generating");

  return {
    content: JSON.stringify({
      totalItems: items.length,
      withImage: withImage.length,
      generating: generating.length,
      failed: failed.length,
      noImage: noImage.length,
      coverage: `${items.length ? Math.round((withImage.length / items.length) * 100) : 0}%`,
      itemsWithoutImages: noImage.slice(0, 10).map((i) => ({ id: i.id, name: i.name })),
    }),
  };
}

async function execGetPromotionList(restaurantId: string): Promise<ToolResult> {
  const promotions = await prisma.promotion.findMany({
    where: { restaurantId },
    include: {
      items: {
        include: {
          menuItem: { select: { id: true, name: true, price: true } },
        },
        orderBy: { displayOrder: "asc" },
      },
    },
    orderBy: { displayOrder: "asc" },
  });

  return {
    content: JSON.stringify({
      count: promotions.length,
      promotions: promotions.map((p) => ({
        id: p.id,
        type: p.type,
        title: p.title,
        subtitle: p.subtitle,
        description: p.description,
        badgeLabel: p.badgeLabel,
        promoPrice: p.promoPrice ? formatPrice(p.promoPrice) : null,
        isActive: p.isActive,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        items: p.items.map((pi) => ({
          name: pi.menuItem.name,
          price: formatPrice(pi.menuItem.price),
        })),
      })),
    }),
  };
}

async function execListCalendarMoments(input: Input): Promise<ToolResult> {
  const query = input.query ? String(input.query).trim().toLowerCase() : null;
  const withinDays =
    input.within_days != null && Number.isFinite(Number(input.within_days))
      ? Number(input.within_days)
      : null;

  const now = new Date();
  const horizon = withinDays != null ? new Date(now.getTime() + withinDays * 86400000) : null;

  const rows = calendarMoments
    .map((m) => {
      const next = resolveUpcomingMomentOccurrence(m.id, now.toISOString());
      return next
        ? {
            id: m.id,
            name: m.name,
            kind: m.kind,
            year: next.year,
            from: next.from,
            to: next.to,
            spendPulse: m.spendPulse,
            countries: m.countries,
            notes: next.notes ?? null,
          }
        : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .filter((row) => {
      if (!query) return true;
      return (
        row.id.toLowerCase().includes(query) ||
        row.name.toLowerCase().includes(query) ||
        // Match common aliases ("eid" → eid_al_fitr / eid_al_adha).
        row.id.replace(/_/g, " ").toLowerCase().includes(query)
      );
    })
    .filter((row) => {
      if (!horizon) return true;
      return new Date(row.from) <= horizon;
    })
    .sort((a, b) => (a.from < b.from ? -1 : 1));

  return {
    content: JSON.stringify({
      count: rows.length,
      moments: rows,
      note:
        rows.length === 0 && query
          ? `No calendar moments match "${query}". Try broader terms like "eid", "national", or "ramadan".`
          : undefined,
    }),
  };
}

async function execGetRestaurantInfo(restaurantId: string): Promise<ToolResult> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: {
      subscription: true,
    },
  });

  if (!restaurant) {
    return { content: JSON.stringify({ error: "Restaurant not found" }) };
  }

  return {
    content: JSON.stringify({
      name: restaurant.name,
      slug: restaurant.slug,
      description: restaurant.description,
      cuisineType: restaurant.cuisineType,
      location: restaurant.location,
      address: restaurant.address,
      phone: restaurant.phone,
      website: restaurant.website,
      whatsappNumber: restaurant.whatsappNumber,
      isPublished: restaurant.isPublished,
      themeKey: restaurant.themeKey,
      logoUrl: restaurant.logoUrl,
      subscription: restaurant.subscription
        ? {
            plan: restaurant.subscription.plan,
            status: restaurant.subscription.status,
          }
        : null,
    }),
  };
}

async function execGetAiUsage(
  restaurantId: string,
  entitlements: PlanEntitlements
): Promise<ToolResult> {
  const [descriptions, tags, analysis, images] = await Promise.all([
    getAiUsageSummary(restaurantId, "description_enhance"),
    getAiUsageSummary(restaurantId, "tag_analysis"),
    getAiUsageSummary(restaurantId, "menu_analysis"),
    getAiUsageSummary(restaurantId, "image_enhancement"),
  ]);

  return {
    content: JSON.stringify({
      descriptions: {
        used: descriptions.used,
        limit: entitlements.aiDescriptionLimit,
        unlimited: entitlements.aiDescriptionLimit === null,
      },
      tags: {
        used: tags.used,
        limit: entitlements.aiTagAnalysisLimit,
        unlimited: entitlements.aiTagAnalysisLimit === null,
      },
      analysis: {
        used: analysis.used,
        limit: entitlements.analysisLimit,
        unlimited: entitlements.analysisLimit === null,
      },
      images: {
        used: images.used,
        limit: entitlements.imageEnhancementLimit,
        unlimited: entitlements.imageEnhancementLimit === null,
      },
      bulkDescriptionsEnabled: entitlements.bulkDescriptionEnabled,
    }),
  };
}

async function execGetPortfolioOverview(
  restaurantId: string,
  clerkId: string,
  entitlements: PlanEntitlements
): Promise<ToolResult> {
  if (!entitlements.multiBrandEnable) {
    return {
      content: JSON.stringify({
        error: "Portfolio features require the Portfolio plan.",
      }),
    };
  }

  const user = await prisma.user.findUnique({
    where: { clerkId },
    include: {
      operatorAccount: {
        include: {
          brands: {
            select: {
              id: true,
              name: true,
              slug: true,
              cuisineType: true,
              location: true,
              isPublished: true,
            },
          },
        },
      },
    },
  });

  if (!user?.operatorAccount) {
    return { content: JSON.stringify({ error: "No portfolio account found." }) };
  }

  // Fetch per-brand item stats in parallel
  const brandStats = await Promise.all(
    user.operatorAccount.brands.map(async (brand) => {
      const items = await prisma.menuItem.findMany({
        where: { restaurantId: brand.id },
        select: {
          imageUrl: true,
          description: true,
        },
      });

      const totalItems = items.length;
      const withImage = items.filter((i) => i.imageUrl).length;
      const withDescription = items.filter((i) => i.description && i.description.length > 0).length;
      const sections = await prisma.menuSection.count({ where: { restaurantId: brand.id } });

      return {
        id: brand.id,
        name: brand.name,
        slug: brand.slug,
        cuisine: brand.cuisineType,
        location: brand.location,
        published: brand.isPublished,
        sectionCount: sections,
        totalItems,
        itemsWithImages: withImage,
        itemsWithoutImages: totalItems - withImage,
        imageCoverage: totalItems ? `${Math.round((withImage / totalItems) * 100)}%` : "N/A",
        itemsWithDescriptions: withDescription,
        itemsWithoutDescriptions: totalItems - withDescription,
        descriptionCoverage: totalItems ? `${Math.round((withDescription / totalItems) * 100)}%` : "N/A",
      };
    })
  );

  return {
    content: JSON.stringify({
      operatorName: user.operatorAccount.name,
      brandCount: user.operatorAccount.brands.length,
      brandLimit: user.operatorAccount.brandLimit,
      brands: brandStats,
    }),
  };
}

async function execListSupportTickets(restaurantId: string, input: Input): Promise<ToolResult> {
  const limitRaw = typeof input.limit === "number" ? input.limit : 5;
  const limit = Math.max(1, Math.min(Math.floor(limitRaw), 20));
  const status =
    typeof input.status === "string" &&
    ["open", "in_progress", "waiting_on_customer", "resolved", "closed"].includes(input.status)
      ? input.status
      : undefined;

  const tickets = await prisma.supportTicket.findMany({
    where: {
      restaurantId,
      ...(status ? { status: status as any } : {}),
    },
    orderBy: [{ priorityScore: "desc" }, { updatedAt: "desc" }],
    take: limit,
    include: {
      messages: {
        where: { isInternal: false },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { body: true, authorType: true, createdAt: true },
      },
      events: {
        where: { visibleToOwner: true },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { eventType: true, note: true, createdAt: true },
      },
    },
  });

  return {
    content: JSON.stringify({
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        priorityScore: ticket.priorityScore,
        severity: ticket.adminOverrideSeverity ?? ticket.aiSeverity,
        category: ticket.category,
        summary: ticket.aiSummary,
        resolutionSummary: ticket.resolutionSummary,
        createdAt: ticket.createdAt.toISOString(),
        updatedAt: ticket.updatedAt.toISOString(),
        latestVisibleMessage: ticket.messages[0]
          ? {
              authorType: ticket.messages[0].authorType,
              body: ticket.messages[0].body,
              createdAt: ticket.messages[0].createdAt.toISOString(),
            }
          : null,
        latestVisibleEvent: ticket.events[0]
          ? {
              eventType: ticket.events[0].eventType,
              note: ticket.events[0].note,
              createdAt: ticket.events[0].createdAt.toISOString(),
            }
          : null,
      })),
    }),
  };
}

async function execGetSupportTicket(restaurantId: string, input: Input): Promise<ToolResult> {
  const ticketId = typeof input.ticket_id === "string" ? input.ticket_id : "";
  if (!ticketId) {
    return { content: JSON.stringify({ error: "ticket_id is required." }) };
  }

  const ticket = await prisma.supportTicket.findFirst({
    where: { id: ticketId, restaurantId },
    include: {
      messages: {
        where: { isInternal: false },
        orderBy: { createdAt: "asc" },
        select: { id: true, authorType: true, body: true, createdAt: true },
      },
      events: {
        where: { visibleToOwner: true },
        orderBy: { createdAt: "asc" },
        select: { id: true, eventType: true, note: true, createdAt: true },
      },
    },
  });

  if (!ticket) {
    return { content: JSON.stringify({ error: "Support ticket not found." }) };
  }

  return {
    content: JSON.stringify({
      id: ticket.id,
      title: ticket.title,
      description: ticket.description,
      status: ticket.status,
      priority: ticket.priority,
      priorityScore: ticket.priorityScore,
      severity: ticket.adminOverrideSeverity ?? ticket.aiSeverity,
      category: ticket.category,
      summary: ticket.aiSummary,
      suggestedResponse: ticket.suggestedResponse,
      resolutionSummary: ticket.resolutionSummary,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      messages: ticket.messages.map((message) => ({
        id: message.id,
        authorType: message.authorType,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      })),
      timeline: ticket.events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        note: event.note,
        createdAt: event.createdAt.toISOString(),
      })),
    }),
  };
}

// ── WRITE Tool Implementations ─────────────────────────────────

async function execEnhanceDescriptions(
  restaurantId: string,
  clerkId: string,
  entitlements: PlanEntitlements,
  input: Input
): Promise<ToolResult> {
  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found. Please try again." }) };
    }

    const storedInput = action.input as Input;

    if (storedInput.menu_item_id) {
      // Single item enhancement — apply the suggestion
      const preview = action.preview as { suggestion: string; itemId: string };
      await prisma.menuItem.updateMany({
        where: { id: preview.itemId, restaurantId },
        data: {
          description: preview.suggestion,
          aiDescriptionStatus: "accepted",
        },
      });
      return { content: JSON.stringify({ success: true, message: "Description updated successfully." }) };
    } else {
      // Bulk — apply all suggestions
      const preview = action.preview as { suggestions: Record<string, string> };
      for (const [itemId, description] of Object.entries(preview.suggestions)) {
        await prisma.menuItem.updateMany({
          where: { id: itemId, restaurantId },
          data: {
            description,
            aiDescriptionStatus: "accepted",
          },
        });
      }
      return {
        content: JSON.stringify({
          success: true,
          message: `${Object.keys(preview.suggestions).length} descriptions updated.`,
        }),
      };
    }
  }

  // Preview mode
  const limit = await checkAiLimit(restaurantId, "description_enhance", entitlements.aiDescriptionLimit);
  if (!limit.allowed) {
    return {
      content: JSON.stringify({
        error: `Description enhancement limit reached (${limit.used}/${entitlements.aiDescriptionLimit}). Upgrade for more.`,
      }),
    };
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true, cuisineType: true, location: true },
  });

  if (!restaurant) {
    return { content: JSON.stringify({ error: "Restaurant not found" }) };
  }

  const tone = input.tone as "casual" | "upscale" | "playful" | "formal" | undefined;

  if (input.menu_item_id) {
    // Single item
    const item = await prisma.menuItem.findUnique({
      where: { id: String(input.menu_item_id) },
      include: { section: { select: { name: true } } },
    });

    if (!item || item.restaurantId !== restaurantId) {
      return { content: JSON.stringify({ error: "Menu item not found." }) };
    }

    const result = await enhanceSingleDescription(
      {
        id: item.id,
        name: item.name,
        description: item.description,
        price: item.price.toString(),
        sectionName: item.section.name,
      },
      restaurant,
      tone
    );

    await logAiUsage(restaurantId, "description_enhance", result.tokensIn, result.tokensOut);

    const pendingActionId = createPendingAction(
      restaurantId,
      clerkId,
      "enhance_descriptions",
      input,
      { suggestion: result.description, itemId: item.id }
    );

    const draft = await createDraft(restaurantId, clerkId, {
      actionType: "menu_description",
      source: DraftActionSource.chat,
      title: `${item.description ? "Refresh" : "Add"} description for "${item.name}"`,
      subtitle: item.description
        ? "Rewriting an existing description"
        : "Missing description hurts SEO + ordering",
      iconKey: "menu",
      affectedSurface: "/dashboard/menu",
      payload: { menuItemId: item.id, description: result.description },
      preview: {
        itemName: item.name,
        sectionName: item.section.name,
        before: item.description,
        after: result.description,
      },
      menuItemId: item.id,
    });

    return {
      content: JSON.stringify({
        preview: true,
        item: item.name,
        currentDescription: item.description,
        suggestedDescription: result.description,
        draftId: draft.id,
        inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
      }),
      preview: {
        pendingActionId,
        description: `Enhance description for "${item.name}"`,
        changes: [
          {
            label: item.name,
            before: item.description,
            after: result.description,
          },
        ],
      },
      draftId: draft.id,
    };
  }

  // Bulk mode
  if (!entitlements.bulkDescriptionEnabled) {
    return {
      content: JSON.stringify({ error: "Bulk description enhancement requires Pro plan." }),
    };
  }

  const mode = (input.bulk_mode as "missing" | "weak" | "all") ?? "missing";

  const sections = await prisma.menuSection.findMany({
    where: { restaurantId },
    orderBy: { displayOrder: "asc" },
    include: { items: { orderBy: { displayOrder: "asc" } } },
  });

  const items = sections.flatMap((s) =>
    s.items.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      price: i.price.toString(),
      sectionName: s.name,
    }))
  );

  const result = await enhanceBulkDescriptions(items, restaurant, mode, tone);

  if (result.tokensIn > 0) {
    await logAiUsage(restaurantId, "description_enhance", result.tokensIn, result.tokensOut);
  }

  const count = Object.keys(result.suggestions).length;
  if (count === 0) {
    return { content: JSON.stringify({ message: "No items need description enhancement." }) };
  }

  // Get item names for the preview
  const enhancedItems = await prisma.menuItem.findMany({
    where: { id: { in: Object.keys(result.suggestions) } },
    select: { id: true, name: true, description: true },
  });
  const itemMap = new Map(enhancedItems.map((i) => [i.id, i]));

  const pendingActionId = createPendingAction(
    restaurantId,
    clerkId,
    "enhance_descriptions",
    input,
    { suggestions: result.suggestions }
  );

  const draft = await createDraft(restaurantId, clerkId, {
    kind: DraftActionKind.bulk,
    actionType: "menu_descriptions_bulk",
    source: DraftActionSource.chat,
    title: `Enhance descriptions for ${count} item${count === 1 ? "" : "s"}`,
    subtitle: Object.keys(result.suggestions)
      .slice(0, 3)
      .map((id) => itemMap.get(id)?.name ?? id)
      .join(", ") +
      (count > 3 ? `, +${count - 3} more` : ""),
    iconKey: "menu",
    affectedSurface: "/dashboard/menu",
    childCount: count,
    payload: { suggestions: result.suggestions },
    preview: {
      items: Object.entries(result.suggestions).map(([id, desc]) => ({
        name: itemMap.get(id)?.name ?? id,
        before: itemMap.get(id)?.description ?? null,
        after: desc,
      })),
    },
  });

  return {
    content: JSON.stringify({
      preview: true,
      count,
      suggestions: Object.entries(result.suggestions).map(([id, desc]) => ({
        item: itemMap.get(id)?.name ?? id,
        current: itemMap.get(id)?.description ?? null,
        suggested: desc,
      })),
      draftId: draft.id,
      inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
    }),
    preview: {
      pendingActionId,
      description: `Enhance descriptions for ${count} items`,
      changes: Object.entries(result.suggestions).map(([id, desc]) => ({
        label: itemMap.get(id)?.name ?? id,
        before: itemMap.get(id)?.description ?? null,
        after: desc,
      })),
    },
    draftId: draft.id,
  };
}

async function execSuggestDietaryTags(
  restaurantId: string,
  clerkId: string,
  entitlements: PlanEntitlements,
  input: Input
): Promise<ToolResult> {
  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found." }) };
    }

    const preview = action.preview as {
      suggestions: Array<{
        menuItemId: string;
        tags: Array<{ tagKey: string; tagId: string }>;
      }>;
    };

    // Apply the tags
    for (const item of preview.suggestions) {
      for (const tag of item.tags) {
        await prisma.menuItemDietaryTag.upsert({
          where: {
            menuItemId_tagId: {
              menuItemId: item.menuItemId,
              tagId: tag.tagId,
            },
          },
          create: {
            menuItemId: item.menuItemId,
            tagId: tag.tagId,
            source: "ai_confirmed",
          },
          update: { source: "ai_confirmed" },
        });
      }
    }

    const totalTags = preview.suggestions.reduce((sum, s) => sum + s.tags.length, 0);
    return {
      content: JSON.stringify({
        success: true,
        message: `Applied ${totalTags} dietary tags across ${preview.suggestions.length} items.`,
      }),
    };
  }

  // Preview mode
  const limit = await checkAiLimit(restaurantId, "tag_analysis", entitlements.aiTagAnalysisLimit);
  if (!limit.allowed) {
    return {
      content: JSON.stringify({
        error: `Tag analysis limit reached (${limit.used}/${entitlements.aiTagAnalysisLimit}). Upgrade for more.`,
      }),
    };
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true, cuisineType: true },
  });

  if (!restaurant) {
    return { content: JSON.stringify({ error: "Restaurant not found" }) };
  }

  const sections = await prisma.menuSection.findMany({
    where: { restaurantId },
    orderBy: { displayOrder: "asc" },
    include: { items: { orderBy: { displayOrder: "asc" } } },
  });

  const items = sections.flatMap((s) =>
    s.items.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      sectionName: s.name,
    }))
  );

  const result = await suggestDietaryTags(restaurant, items);
  await logAiUsage(restaurantId, "tag_analysis", result.tokensIn, result.tokensOut);

  // Resolve tag IDs
  const allTagKeys = new Set(
    result.suggestions.flatMap((s) => s.tags.map((t) => t.tagKey))
  );
  const dbTags = await prisma.dietaryTag.findMany({
    where: { key: { in: Array.from(allTagKeys) } },
  });
  const tagKeyToId = new Map(dbTags.map((t) => [t.key, t.id]));
  const tagKeyToLabel = new Map(dbTags.map((t) => [t.key, t.label]));

  // Get item names
  const itemIds = result.suggestions.map((s) => s.menuItemId);
  const dbItems = await prisma.menuItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, name: true },
  });
  const itemNameMap = new Map(dbItems.map((i) => [i.id, i.name]));

  const previewSuggestions = result.suggestions
    .filter((s) => s.tags.length > 0)
    .map((s) => ({
      menuItemId: s.menuItemId,
      itemName: itemNameMap.get(s.menuItemId) ?? s.menuItemId,
      tags: s.tags
        .filter((t) => tagKeyToId.has(t.tagKey))
        .map((t) => ({
          tagKey: t.tagKey,
          tagId: tagKeyToId.get(t.tagKey)!,
          label: tagKeyToLabel.get(t.tagKey) ?? t.tagKey,
          confidence: t.confidence,
        })),
    }))
    .filter((s) => s.tags.length > 0);

  if (previewSuggestions.length === 0) {
    return { content: JSON.stringify({ message: "No new dietary tag suggestions for your menu." }) };
  }

  const totalTags = previewSuggestions.reduce((sum, s) => sum + s.tags.length, 0);

  const pendingActionId = createPendingAction(
    restaurantId,
    clerkId,
    "suggest_dietary_tags",
    input,
    { suggestions: previewSuggestions }
  );

  const draft = await createDraft(restaurantId, clerkId, {
    kind: DraftActionKind.bulk,
    actionType: "dietary_tags_apply",
    source: DraftActionSource.chat,
    title: `Apply ${totalTags} dietary tags to ${previewSuggestions.length} items`,
    subtitle: previewSuggestions.slice(0, 3).map((s) => s.itemName).join(", ") +
      (previewSuggestions.length > 3 ? `, +${previewSuggestions.length - 3} more` : ""),
    iconKey: "menu",
    affectedSurface: "/dashboard/menu",
    childCount: previewSuggestions.length,
    payload: {
      suggestions: previewSuggestions.map((s) => ({
        menuItemId: s.menuItemId,
        tagIds: s.tags.map((t) => t.tagId),
      })),
    },
    preview: {
      totalItems: previewSuggestions.length,
      totalTags,
      items: previewSuggestions.map((s) => ({
        name: s.itemName,
        tags: s.tags.map((t) => ({ label: t.label, confidence: t.confidence })),
      })),
    },
  });

  return {
    content: JSON.stringify({
      preview: true,
      totalItems: previewSuggestions.length,
      totalTags,
      suggestions: previewSuggestions.map((s) => ({
        item: s.itemName,
        tags: s.tags.map((t) => `${t.label} (${Math.round(t.confidence * 100)}%)`),
      })),
      draftId: draft.id,
      inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
    }),
    preview: {
      pendingActionId,
      description: `Apply ${totalTags} dietary tags to ${previewSuggestions.length} items`,
      changes: previewSuggestions.map((s) => ({
        label: s.itemName,
        before: null,
        after: s.tags.map((t) => t.label).join(", "),
      })),
    },
    draftId: draft.id,
  };
}

async function execUpdateMenuItem(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found." }) };
    }

    const updates = action.input as Input;
    const storedItemId = String(updates.menu_item_id);
    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = String(updates.name);
    if (updates.description !== undefined) data.description = String(updates.description);
    if (updates.price !== undefined) data.price = Number(updates.price);
    if (updates.is_available !== undefined) {
      data.isAvailable = Boolean(updates.is_available);
      if (!updates.is_available) {
        data.soldOutDate = new Date();
      } else {
        data.soldOutDate = null;
      }
    }

    await prisma.menuItem.updateMany({ where: { id: storedItemId, restaurantId }, data });
    return { content: JSON.stringify({ success: true, message: "Item updated." }) };
  }

  // Preview
  const itemId = String(input.menu_item_id);
  const item = await prisma.menuItem.findUnique({
    where: { id: itemId },
    include: { section: { select: { name: true } } },
  });

  if (!item || item.restaurantId !== restaurantId) {
    return await buildItemNotFoundResult(restaurantId, [itemId], []);
  }

  const changes: Array<{ label: string; before: string | null; after: string }> = [];
  if (input.name !== undefined) {
    changes.push({ label: "Name", before: item.name, after: String(input.name) });
  }
  if (input.description !== undefined) {
    changes.push({ label: "Description", before: item.description, after: String(input.description) });
  }
  if (input.price !== undefined) {
    changes.push({ label: "Price", before: formatPrice(item.price), after: formatPrice(Number(input.price)) });
  }
  if (input.is_available !== undefined) {
    changes.push({
      label: "Availability",
      before: item.isAvailable ? "Available" : "Sold out",
      after: input.is_available ? "Available" : "Sold out",
    });
  }

  if (changes.length === 0) {
    return { content: JSON.stringify({ error: "No changes specified." }) };
  }

  const pendingActionId = createPendingAction(restaurantId, clerkId, "update_menu_item", input, null);

  const onlyPrice =
    input.price !== undefined &&
    input.name === undefined &&
    input.description === undefined &&
    input.is_available === undefined;

  const draft = await createDraft(restaurantId, clerkId, {
    actionType: onlyPrice ? "price_change" : "menu_item_update",
    source: DraftActionSource.chat,
    title: onlyPrice
      ? `Change "${item.name}" price · ${formatPrice(item.price)} → ${formatPrice(Number(input.price))}`
      : `Update "${item.name}"`,
    subtitle: changes.map((c) => c.label).join(" · "),
    iconKey: onlyPrice ? "price" : "menu",
    affectedSurface: "/dashboard/menu",
    payload: {
      menuItemId: itemId,
      ...(input.name !== undefined && { name: String(input.name) }),
      ...(input.description !== undefined && { description: String(input.description) }),
      ...(input.price !== undefined && { price: Number(input.price) }),
      ...(input.is_available !== undefined && { isAvailable: Boolean(input.is_available) }),
    },
    preview: {
      itemName: item.name,
      sectionName: item.section.name,
      changes: changes.map((c) => ({ field: c.label, from: c.before, to: c.after })),
    },
    menuItemId: itemId,
  });

  return {
    content: JSON.stringify({
      preview: true,
      item: item.name,
      section: item.section.name,
      changes: changes.map((c) => ({ field: c.label, from: c.before, to: c.after })),
      draftId: draft.id,
      inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
    }),
    preview: {
      pendingActionId,
      description: `Update "${item.name}"`,
      changes,
    },
    draftId: draft.id,
  };
}

async function execUpdateMenuItemsBulk(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  const updates = input.updates as Array<Input>;

  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found." }) };
    }

    const storedUpdates = (action.input as Input).updates as Array<Input>;

    await prisma.$transaction(async (tx) => {
      for (const update of storedUpdates) {
        const data: Record<string, unknown> = {};
        if (update.name !== undefined) data.name = String(update.name);
        if (update.description !== undefined) data.description = String(update.description);
        if (update.price !== undefined) data.price = Number(update.price);
        if (update.is_available !== undefined) {
          data.isAvailable = Boolean(update.is_available);
          data.soldOutDate = update.is_available ? null : new Date();
        }
        if (Object.keys(data).length) {
          await tx.menuItem.updateMany({
            where: { id: String(update.menu_item_id), restaurantId },
            data,
          });
        }
      }
    });

    return {
      content: JSON.stringify({ success: true, message: `${storedUpdates.length} items updated.` }),
    };
  }

  // Preview
  const itemIds = updates.map((u) => String(u.menu_item_id));
  const items = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, restaurantId },
    select: { id: true, name: true, description: true, price: true, isAvailable: true },
  });
  const itemMap = new Map(items.map((i) => [i.id, i]));

  const changes: Array<{ label: string; before: string | null; after: string }> = [];

  for (const update of updates) {
    const item = itemMap.get(String(update.menu_item_id));
    if (!item) continue;
    const fields: string[] = [];
    if (update.name !== undefined) fields.push(`name: "${item.name}" -> "${update.name}"`);
    if (update.price !== undefined)
      fields.push(`price: ${formatPrice(item.price)} -> ${formatPrice(Number(update.price))}`);
    if (update.description !== undefined) fields.push("description updated");
    if (update.is_available !== undefined)
      fields.push(update.is_available ? "mark available" : "mark sold out");

    changes.push({
      label: item.name,
      before: fields.length ? "Current" : null,
      after: fields.join(", "),
    });
  }

  const pendingActionId = createPendingAction(restaurantId, clerkId, "update_menu_items_bulk", input, null);

  const draftItems = updates
    .map((u) => {
      const item = itemMap.get(String(u.menu_item_id));
      if (!item) return null;
      return {
        menuItemId: item.id,
        ...(u.name !== undefined && { name: String(u.name) }),
        ...(u.description !== undefined && { description: String(u.description) }),
        ...(u.price !== undefined && { price: Number(u.price) }),
        ...(u.is_available !== undefined && { isAvailable: Boolean(u.is_available) }),
      };
    })
    .filter((i): i is NonNullable<typeof i> => i !== null);

  const draft = await createDraft(restaurantId, clerkId, {
    kind: DraftActionKind.bulk,
    actionType: "menu_items_bulk_update",
    source: DraftActionSource.chat,
    title: `Batch update ${draftItems.length} item${draftItems.length === 1 ? "" : "s"}`,
    subtitle: changes.slice(0, 3).map((c) => c.label).join(", ") + (changes.length > 3 ? `, +${changes.length - 3} more` : ""),
    iconKey: "menu",
    affectedSurface: "/dashboard/menu",
    childCount: draftItems.length,
    payload: { items: draftItems },
    preview: {
      count: changes.length,
      changes: changes.map((c) => ({ item: c.label, updates: c.after })),
    },
  });

  return {
    content: JSON.stringify({
      preview: true,
      count: changes.length,
      changes: changes.map((c) => ({ item: c.label, updates: c.after })),
      draftId: draft.id,
      inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
    }),
    preview: {
      pendingActionId,
      description: `Batch update ${changes.length} items`,
      changes,
    },
    draftId: draft.id,
  };
}

async function execCreatePromotion(
  restaurantId: string,
  clerkId: string,
  entitlements: PlanEntitlements,
  input: Input
): Promise<ToolResult> {
  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found." }) };
    }

    const preview = action.preview as {
      type: string;
      title: string;
      subtitle: string | null;
      description: string | null;
      badgeLabel: string | null;
      terms: string | null;
      promoPrice: number | null;
      startsAt: string | null;
      endsAt: string | null;
      itemIds: string[];
      sourceMomentId: string | null;
      sourceMomentYear: number | null;
      sourceMomentStartsOn: string | null;
    };

    const promo = await prisma.promotion.create({
      data: {
        restaurantId,
        type: preview.type as "discounted_item" | "deal" | "combo",
        title: preview.title,
        subtitle: preview.subtitle,
        description: preview.description,
        badgeLabel: preview.badgeLabel,
        terms: preview.terms,
        promoPrice: preview.promoPrice,
        startsAt: preview.startsAt ? new Date(preview.startsAt) : null,
        endsAt: preview.endsAt ? new Date(preview.endsAt) : null,
        sourceMomentId: preview.sourceMomentId,
        sourceMomentYear: preview.sourceMomentYear,
        sourceMomentStartsOn: preview.sourceMomentStartsOn ? new Date(preview.sourceMomentStartsOn) : null,
        isActive: true,
        isFeatured: false,
        displayOrder: 0,
        items: {
          create: preview.itemIds.map((itemId, index) => ({
            menuItemId: itemId,
            role: "main",
            displayOrder: index,
          })),
        },
      },
    });

    return {
      content: JSON.stringify({ success: true, promotionId: promo.id, message: "Promotion created." }),
    };
  }

  // Preview
  const itemIds = (input.item_ids as string[]) ?? [];
  const items = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, restaurantId },
    include: { section: { select: { name: true } } },
  });

  if (items.length < itemIds.length) {
    return await buildItemNotFoundResult(restaurantId, itemIds, items);
  }

  // Resolve calendar moment (if any). Defaults dates to the moment's next-upcoming
  // occurrence when the owner didn't supply explicit starts_at/ends_at.
  let startsAt = input.starts_at ? String(input.starts_at) : null;
  let endsAt = input.ends_at ? String(input.ends_at) : null;
  let sourceMomentId: string | null = null;
  let sourceMomentYear: number | null = null;
  let sourceMomentStartsOn: string | null = null;
  let momentName: string | null = null;

  if (input.moment_id) {
    const occurrence = resolveUpcomingMomentOccurrence(String(input.moment_id), new Date().toISOString());
    if (!occurrence) {
      return {
        content: JSON.stringify({
          error: `Unknown calendar moment "${String(input.moment_id)}". Call list_calendar_moments to see valid IDs.`,
        }),
      };
    }
    sourceMomentId = occurrence.moment.id;
    sourceMomentYear = occurrence.year;
    sourceMomentStartsOn = occurrence.from;
    momentName = occurrence.moment.name;
    if (!startsAt) startsAt = occurrence.from;
    if (!endsAt) endsAt = occurrence.to;
  }

  // Resolve promo price. discount_percent wins over absolute promo_price when both
  // are passed — the agent prompt steers Sous Chef to prefer discount_percent for
  // percentage requests so the server (not the LLM) does the arithmetic.
  let promoPrice: number | null = input.promo_price != null ? Number(input.promo_price) : null;
  let discountPercent: number | null = null;
  if (input.discount_percent != null) {
    const pct = Number(input.discount_percent);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      return {
        content: JSON.stringify({ error: "discount_percent must be between 0 and 100 (exclusive)." }),
      };
    }
    discountPercent = pct;
    const baseTotal = items.reduce((sum, item) => sum + Number(item.price), 0);
    // Round to 2 decimals — AED display convention. (KSA SAR also 2dp; KWD/BHD/OMR
    // are 3dp but Bustan menus quote in 2dp today; revisit when currency-aware.)
    promoPrice = Math.round(baseTotal * (1 - pct / 100) * 100) / 100;
  }

  let title = input.title ? String(input.title) : "";
  let subtitle = input.subtitle ? String(input.subtitle) : null;
  let description = input.description ? String(input.description) : null;
  let badgeLabel = input.badge_label ? String(input.badge_label) : null;
  let terms = input.terms ? String(input.terms) : null;

  // AI copy generation
  if (input.use_ai_copy) {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true, cuisineType: true, location: true },
    });

    if (restaurant) {
      const aiResult = await suggestPromotionContent(
        {
          type: String(input.type) as "discounted_item" | "deal" | "combo",
          title: title || null,
          subtitle,
          description,
          badgeLabel,
          terms,
          promoPrice: promoPrice != null ? String(promoPrice) : null,
          startsAt,
          endsAt,
          items: items.map((i) => ({
            id: i.id,
            name: i.name,
            description: i.description,
            price: i.price.toString(),
            sectionName: i.section.name,
          })),
        },
        restaurant,
        input.tone as "casual" | "upscale" | "playful" | "formal" | undefined
      );

      await logAiUsage(restaurantId, "description_enhance", aiResult.tokensIn, aiResult.tokensOut);

      title = aiResult.content.title || title;
      subtitle = aiResult.content.subtitle || subtitle;
      description = aiResult.content.description || description;
      badgeLabel = aiResult.content.badgeLabel || badgeLabel;
      terms = aiResult.content.terms || terms;
    }
  }

  if (!title) {
    title = momentName
      ? `${momentName} special`
      : `${String(input.type)} promotion`;
  }
  if (!badgeLabel && momentName) {
    badgeLabel = momentName;
  }

  const promoData = {
    type: String(input.type),
    title,
    subtitle,
    description,
    badgeLabel,
    terms,
    promoPrice,
    startsAt,
    endsAt,
    itemIds,
    sourceMomentId,
    sourceMomentYear,
    sourceMomentStartsOn,
  };

  const pendingActionId = createPendingAction(restaurantId, clerkId, "create_promotion", input, promoData);

  const draft = await createDraft(restaurantId, clerkId, {
    actionType: "promotion_create",
    source: DraftActionSource.chat,
    title: `Create "${title}" promotion`,
    subtitle: `${items.length} item${items.length === 1 ? "" : "s"}${
      promoData.promoPrice ? ` · ${formatPrice(promoData.promoPrice)}` : ""
    }${momentName ? ` · ${momentName} ${sourceMomentYear ?? ""}` : ""}`,
    iconKey: "promotion",
    affectedSurface: "/dashboard/menu",
    payload: {
      type: promoData.type,
      title: promoData.title,
      subtitle: promoData.subtitle,
      description: promoData.description,
      badgeLabel: promoData.badgeLabel,
      terms: promoData.terms,
      promoPrice: promoData.promoPrice,
      startsAt: promoData.startsAt,
      endsAt: promoData.endsAt,
      itemIds: promoData.itemIds,
      isFeatured: false,
      sourceMomentId: promoData.sourceMomentId,
      sourceMomentYear: promoData.sourceMomentYear,
      sourceMomentStartsOn: promoData.sourceMomentStartsOn,
    },
    preview: {
      type: promoData.type,
      title: promoData.title,
      subtitle: promoData.subtitle,
      description: promoData.description,
      badgeLabel: promoData.badgeLabel,
      terms: promoData.terms,
      promoPrice: promoData.promoPrice ? formatPrice(promoData.promoPrice) : null,
      items: items.map((i) => i.name),
      moment: momentName ? { id: sourceMomentId, name: momentName, year: sourceMomentYear } : null,
    },
  });

  const baseTotal = items.reduce((sum, item) => sum + Number(item.price), 0);

  return {
    content: JSON.stringify({
      preview: true,
      promotion: {
        type: promoData.type,
        title: promoData.title,
        subtitle: promoData.subtitle,
        description: promoData.description,
        badgeLabel: promoData.badgeLabel,
        terms: promoData.terms,
        promoPrice: promoData.promoPrice ? formatPrice(promoData.promoPrice) : null,
        discountPercent,
        startsAt,
        endsAt,
        items: items.map((i) => i.name),
        moment: momentName
          ? { id: sourceMomentId, name: momentName, year: sourceMomentYear, startsOn: sourceMomentStartsOn }
          : null,
        baseTotal: baseTotal > 0 ? formatPrice(baseTotal) : null,
      },
      draftId: draft.id,
      inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
    }),
    preview: {
      pendingActionId,
      description: `Create "${title}" promotion`,
      changes: [
        { label: "Title", before: null, after: title },
        ...(subtitle ? [{ label: "Subtitle", before: null, after: subtitle }] : []),
        { label: "Items", before: null, after: items.map((i) => i.name).join(", ") },
        ...(promoData.promoPrice
          ? [
              {
                label: discountPercent ? `Promo Price (${discountPercent}% off)` : "Promo Price",
                before: baseTotal > 0 ? formatPrice(baseTotal) : null,
                after: formatPrice(promoData.promoPrice),
              },
            ]
          : []),
        ...(momentName
          ? [{ label: "Event", before: null, after: `${momentName} ${sourceMomentYear ?? ""}`.trim() }]
          : []),
        ...(startsAt && endsAt
          ? [{ label: "Window", before: null, after: `${startsAt.slice(0, 10)} → ${endsAt.slice(0, 10)}` }]
          : []),
      ],
    },
    draftId: draft.id,
  };
}

async function execUpdatePromotion(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  const promotionId = String(input.promotion_id ?? "");
  const promo = await prisma.promotion.findFirst({
    where: { id: promotionId, restaurantId },
    include: { items: { include: { menuItem: { select: { id: true, name: true, price: true } } } } },
  });

  if (!promo) {
    const recent = await prisma.promotion.findMany({
      where: { restaurantId },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, isActive: true },
      take: 10,
    });
    return {
      content: JSON.stringify({
        error: "promotion_not_found",
        did_you_mean: recent,
        hint: "Pick the intended promotion from did_you_mean or call get_promotion_list.",
      }),
    };
  }

  // Resolve target items: replacement list if given, else current items.
  let items = promo.items.map((pi) => pi.menuItem);
  let replaceItemIds: string[] | null = null;
  if (Array.isArray(input.item_ids) && input.item_ids.length > 0) {
    const requested = (input.item_ids as string[]).map(String);
    const found = await prisma.menuItem.findMany({
      where: { id: { in: requested }, restaurantId },
      select: { id: true, name: true, price: true },
    });
    if (found.length < requested.length) {
      return await buildItemNotFoundResult(restaurantId, requested, found);
    }
    items = found;
    replaceItemIds = requested;
  }

  // Percent shorthand recomputes off the (possibly replaced) item set.
  let promoPrice: number | null | undefined =
    input.promo_price != null ? Number(input.promo_price) : undefined;
  if (input.discount_percent != null) {
    const pct = Number(input.discount_percent);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      return { content: JSON.stringify({ error: "discount_percent must be between 0 and 100 (exclusive)." }) };
    }
    const baseTotal = items.reduce((sum, item) => sum + Number(item.price), 0);
    promoPrice = Math.round(baseTotal * (1 - pct / 100) * 100) / 100;
  }

  const changes: Array<{ label: string; before: string | null; after: string }> = [];
  const set = (label: string, before: unknown, after: unknown) =>
    changes.push({ label, before: before == null ? null : String(before), after: String(after) });

  if (input.title !== undefined) set("Title", promo.title, input.title);
  if (input.subtitle !== undefined) set("Subtitle", promo.subtitle, input.subtitle);
  if (input.description !== undefined) set("Description", promo.description, input.description);
  if (input.badge_label !== undefined) set("Badge", promo.badgeLabel, input.badge_label);
  if (input.terms !== undefined) set("Terms", promo.terms, input.terms);
  if (promoPrice !== undefined) set("Price", promo.promoPrice ? formatPrice(promo.promoPrice) : null, formatPrice(promoPrice ?? 0));
  if (input.starts_at !== undefined) set("Starts", promo.startsAt?.toISOString() ?? null, String(input.starts_at));
  if (input.ends_at !== undefined) set("Ends", promo.endsAt?.toISOString() ?? null, String(input.ends_at));
  if (input.is_active !== undefined) set("Status", promo.isActive ? "Active" : "Inactive", input.is_active ? "Active" : "Ended");
  if (replaceItemIds) set("Items", promo.items.map((pi) => pi.menuItem.name).join(", "), items.map((i) => i.name).join(", "));

  if (changes.length === 0) {
    return { content: JSON.stringify({ error: "No changes supplied. Pass at least one field to update." }) };
  }

  const ending = input.is_active === false;
  const draft = await createDraft(restaurantId, clerkId, {
    actionType: "promotion_update",
    source: DraftActionSource.chat,
    title: ending ? `End "${promo.title}"` : `Update "${promo.title}"`,
    subtitle: changes.map((chg) => chg.label).join(" · "),
    iconKey: "promotion",
    affectedSurface: "/dashboard/menu",
    payload: {
      promotionId: promo.id,
      title: input.title !== undefined ? String(input.title) : undefined,
      subtitle: input.subtitle !== undefined ? String(input.subtitle) : undefined,
      description: input.description !== undefined ? String(input.description) : undefined,
      badgeLabel: input.badge_label !== undefined ? String(input.badge_label) : undefined,
      terms: input.terms !== undefined ? String(input.terms) : undefined,
      promoPrice: promoPrice !== undefined ? promoPrice : undefined,
      startsAt: input.starts_at !== undefined ? String(input.starts_at) : undefined,
      endsAt: input.ends_at !== undefined ? String(input.ends_at) : undefined,
      isActive: input.is_active !== undefined ? Boolean(input.is_active) : undefined,
      replaceItemIds: replaceItemIds ?? undefined,
    },
    preview: { promotion: promo.title, changes },
  });

  return {
    content: JSON.stringify({
      success: true,
      draft_id: draft.id,
      message: `Drafted ${ending ? "ending" : "update of"} "${promo.title}" — awaiting owner approval in the Inbox.`,
      changes,
    }),
    draftId: draft.id,
  };
}

async function execSendWhatsappCampaign(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  const segment = String(input.segment ?? "");
  const type =
    segment === "inactive" ? ("inactive_30" as const)
    : segment === "weekend_special" ? ("weekend_special" as const)
    : segment === "new_promotion" ? ("new_promotion" as const)
    : null;
  if (!type) {
    return { content: JSON.stringify({ error: "Unknown segment. Use inactive, weekend_special, or new_promotion." }) };
  }

  let inactiveDays: number | undefined;
  if (segment === "inactive") {
    inactiveDays = input.inactive_days != null ? Number(input.inactive_days) : 30;
    if (!Number.isFinite(inactiveDays) || inactiveDays < 7 || inactiveDays > 365) {
      return { content: JSON.stringify({ error: "inactive_days must be between 7 and 365." }) };
    }
  }

  let promotion: { id: string; title: string } | null = null;
  if (input.promotion_id) {
    promotion = await prisma.promotion.findFirst({
      where: { id: String(input.promotion_id), restaurantId },
      select: { id: true, title: true },
    });
    if (!promotion) {
      return { content: JSON.stringify({ error: "promotion_not_found", hint: "Call get_promotion_list for valid promotion ids." }) };
    }
  }
  if (type === "new_promotion" && !promotion) {
    return { content: JSON.stringify({ error: "new_promotion segment requires promotion_id." }) };
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true },
  });
  if (!restaurant) {
    return { content: JSON.stringify({ error: "restaurant_not_found" }) };
  }
  const templateName = input.template_name ? String(input.template_name) : type;

  const audience = await resolveCampaignAudience({ restaurantId, type, inactiveDays, templateName });

  if (audience.eligibleCount === 0) {
    return {
      content: JSON.stringify({
        error: "segment_empty",
        opted_in_total: audience.optedInTotal,
        hint:
          audience.optedInTotal === 0
            ? "No customers have opted in to WhatsApp marketing yet."
            : "Opted-in customers exist but none match this segment. Try a different segment or a larger inactive_days window.",
      }),
    };
  }

  const recipientLabel = audience.capped
    ? `first ${audience.eligibleCount} of ${audience.optedInTotal}`
    : `${audience.eligibleCount}`;
  const segmentLabel =
    segment === "inactive" ? `customers inactive ${inactiveDays} days` : segment.replace("_", " ");
  const modeNote =
    audience.mode === "meta_cloud_api"
      ? "sends automatically via WhatsApp"
      : "stages tap-to-send links in CRM (Meta API not connected or template not approved)";

  const draft = await createDraft(restaurantId, clerkId, {
    actionType: "whatsapp_campaign_send",
    source: DraftActionSource.chat,
    title: `WhatsApp blast · ${recipientLabel} customer${audience.eligibleCount === 1 ? "" : "s"}`,
    subtitle: `${segmentLabel} · ${modeNote} · 5-min undo after approval · counts re-checked at send`,
    iconKey: "whatsapp",
    affectedSurface: "/dashboard/crm",
    payload: {
      type,
      inactiveDays,
      templateName,
      body: input.body ? String(input.body) : undefined,
      name: input.name ? String(input.name) : undefined,
      promotionId: promotion?.id ?? null,
      restaurantName: restaurant.name,
    },
    preview: {
      recipients: audience.eligibleCount,
      capped: audience.capped,
      optedInTotal: audience.optedInTotal,
      segment: segmentLabel,
      template: templateName,
      templateStatus: audience.templateStatus,
      mode: audience.mode,
      promotion: promotion?.title ?? null,
    },
  });

  return {
    content: JSON.stringify({
      success: true,
      draft_id: draft.id,
      recipients: audience.eligibleCount,
      capped: audience.capped,
      mode: audience.mode,
      message: `Drafted a broadcast to ${recipientLabel} eligible customers (${segmentLabel}). Approving it in the Inbox ${audience.mode === "meta_cloud_api" ? "SENDS it after a 5-minute undo window" : "stages tap-to-send links in CRM"} — make sure the owner knows.`,
    }),
    draftId: draft.id,
  };
}

async function execCreateAdCampaign(
  restaurantId: string,
  clerkId: string,
  entitlements: PlanEntitlements,
  input: Input
): Promise<ToolResult> {
  if (!entitlements.adStudioEnabled) {
    return { content: JSON.stringify({ error: "not_eligible", hint: "Ad Studio requires the Pro plan." }) };
  }
  if (entitlements.adProjectMonthlyLimit !== null) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const created = await prisma.adProject.count({
      where: { restaurantId, createdAt: { gte: monthStart } },
    });
    if (created >= entitlements.adProjectMonthlyLimit) {
      return {
        content: JSON.stringify({
          error: "quota_exhausted",
          used: created,
          limit: entitlements.adProjectMonthlyLimit,
          hint: "Monthly ad project limit reached; resets next month.",
        }),
      };
    }
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { cuisineType: true },
  });
  if (!restaurant) {
    return { content: JSON.stringify({ error: "restaurant_not_found" }) };
  }

  if (input.primary_dish_id) {
    const dish = await prisma.menuItem.findFirst({
      where: { id: String(input.primary_dish_id), restaurantId },
      select: { id: true },
    });
    if (!dish) {
      return await buildItemNotFoundResult(restaurantId, [String(input.primary_dish_id)], []);
    }
  }

  let sourceMoment: { id: string; year: number; startsOn: string; name: string } | null = null;
  if (input.moment_id) {
    const occurrence = resolveUpcomingMomentOccurrence(String(input.moment_id), new Date().toISOString());
    if (!occurrence) {
      return {
        content: JSON.stringify({
          error: `Unknown calendar moment "${String(input.moment_id)}". Call list_calendar_moments to see valid IDs.`,
        }),
      };
    }
    sourceMoment = { id: occurrence.moment.id, year: occurrence.year, startsOn: occurrence.from, name: occurrence.moment.name };
  }

  const budgetAed = input.budget_aed != null ? Number(input.budget_aed) : 1500;
  if (!Number.isFinite(budgetAed) || budgetAed < 500 || budgetAed > 500000) {
    return { content: JSON.stringify({ error: "budget_aed must be between 500 and 500000." }) };
  }

  const brief = {
    restaurantId,
    name: String(input.name),
    campaignType: "freeform",
    campaignBrief: String(input.campaign_brief),
    goal: (input.goal as string) ?? "bofu",
    countries: Array.isArray(input.countries) && input.countries.length > 0 ? (input.countries as string[]) : ["AE"],
    cuisines: [restaurant.cuisineType ?? "international"],
    targetPlatforms: ["Meta"],
    budgetTier: (input.budget_tier as string) ?? "lean",
    budgetAed: Math.round(budgetAed),
    primaryDishId: input.primary_dish_id ? String(input.primary_dish_id) : undefined,
  };

  // Validate NOW so the model gets immediate structured feedback instead of a
  // ship-time failure (e.g. an invalid country code).
  const parsedCheck = briefInputSchema.safeParse(brief);
  if (!parsedCheck.success) {
    return {
      content: JSON.stringify({
        error: "invalid_brief",
        issues: parsedCheck.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      }),
    };
  }

  const draft = await createDraft(restaurantId, clerkId, {
    actionType: "ad_campaign_create_and_generate",
    source: DraftActionSource.chat,
    title: `Create "${brief.name}" ad campaign`,
    subtitle: `${brief.goal} · AED ${brief.budgetAed} · generates ad variants on approval`,
    iconKey: "ad",
    affectedSurface: "/dashboard/ad-studio",
    payload: { brief, sourceMomentId: sourceMoment?.id ?? null, sourceMomentYear: sourceMoment?.year ?? null, sourceMomentStartsOn: sourceMoment?.startsOn ?? null },
    preview: {
      name: brief.name,
      brief: brief.campaignBrief,
      goal: brief.goal,
      budgetAed: brief.budgetAed,
      budgetTier: brief.budgetTier,
      countries: brief.countries,
      moment: sourceMoment ? { id: sourceMoment.id, name: sourceMoment.name, year: sourceMoment.year } : null,
    },
  });

  return {
    content: JSON.stringify({
      success: true,
      draft_id: draft.id,
      message: `Drafted ad campaign "${brief.name}" (AED ${brief.budgetAed}, ${brief.goal}). On approval the project is created and ad variants start generating in Ad Studio.`,
    }),
    draftId: draft.id,
  };
}

async function execGenerateDishImages(
  restaurantId: string,
  clerkId: string,
  entitlements: PlanEntitlements,
  input: Input
): Promise<ToolResult> {
  const PER_DRAFT_CAP = 15;

  let items: Array<{ id: string; name: string }> = [];
  if (Array.isArray(input.menu_item_ids) && input.menu_item_ids.length > 0) {
    const requested = (input.menu_item_ids as string[]).map(String);
    if (requested.length > PER_DRAFT_CAP) {
      return { content: JSON.stringify({ error: `Max ${PER_DRAFT_CAP} images per request. Split into batches.` }) };
    }
    const found = await prisma.menuItem.findMany({
      where: { id: { in: requested }, restaurantId },
      select: { id: true, name: true },
    });
    if (found.length < requested.length) {
      return await buildItemNotFoundResult(restaurantId, requested, found);
    }
    items = found;
  } else if (input.missing_only) {
    const limit = Math.min(Math.max(Number(input.limit ?? 10) || 10, 1), PER_DRAFT_CAP);
    items = await prisma.menuItem.findMany({
      where: { restaurantId, imageStatus: { in: ["none", "failed"] } },
      select: { id: true, name: true },
      orderBy: { displayOrder: "asc" },
      take: limit,
    });
    if (items.length === 0) {
      return { content: JSON.stringify({ success: true, message: "Every menu item already has an image — nothing to generate." }) };
    }
  } else {
    return { content: JSON.stringify({ error: "Pass menu_item_ids or missing_only=true." }) };
  }

  const usage = await checkAiLimit(restaurantId, "dish_image_generation", entitlements.dishImageGenerationLimit);
  const remaining = usage.remaining ?? Number.MAX_SAFE_INTEGER;
  if (remaining < items.length) {
    return {
      content: JSON.stringify({
        error: "quota_exhausted",
        requested: items.length,
        remaining,
        hint: remaining > 0 ? `Only ${remaining} generations left this month — propose a batch of ${remaining}.` : "Monthly image generation limit reached; resets next month.",
      }),
    };
  }

  const draft = await createDraft(restaurantId, clerkId, {
    kind: DraftActionKind.bulk,
    actionType: "dish_images_generate",
    source: DraftActionSource.chat,
    title: `Generate ${items.length} dish photo${items.length === 1 ? "" : "s"}`,
    subtitle: items.map((i) => i.name).slice(0, 3).join(", ") + (items.length > 3 ? `, +${items.length - 3} more` : ""),
    iconKey: "image",
    affectedSurface: "/dashboard/menu",
    childCount: items.length,
    payload: {
      menuItemIds: items.map((i) => i.id),
      promptModifier: input.prompt_modifier ? String(input.prompt_modifier) : null,
    },
    preview: {
      items: items.map((i) => i.name),
      quotaRemainingAfter: remaining === Number.MAX_SAFE_INTEGER ? null : remaining - items.length,
    },
  });

  return {
    content: JSON.stringify({
      success: true,
      draft_id: draft.id,
      count: items.length,
      message: `Drafted photo generation for ${items.length} item(s) — generation starts after Inbox approval.`,
    }),
    draftId: draft.id,
  };
}

async function execDeleteMenuItems(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  const itemIds = Array.isArray(input.menu_item_ids) ? (input.menu_item_ids as string[]).map(String) : [];
  const sectionIds = Array.isArray(input.section_ids) ? (input.section_ids as string[]).map(String) : [];
  if (itemIds.length === 0 && sectionIds.length === 0) {
    return { content: JSON.stringify({ error: "Pass menu_item_ids and/or section_ids." }) };
  }

  const directItems = itemIds.length
    ? await prisma.menuItem.findMany({ where: { id: { in: itemIds }, restaurantId }, select: { id: true, name: true } })
    : [];
  if (directItems.length < itemIds.length) {
    return await buildItemNotFoundResult(restaurantId, itemIds, directItems);
  }

  const sections = sectionIds.length
    ? await prisma.menuSection.findMany({
        where: { id: { in: sectionIds }, restaurantId },
        select: { id: true, name: true, items: { select: { id: true, name: true } } },
      })
    : [];
  if (sections.length < sectionIds.length) {
    const missing = sectionIds.filter((id) => !sections.some((s) => s.id === id));
    return { content: JSON.stringify({ error: "section_not_found", missing_section_ids: missing }) };
  }

  const cascadeItems = sections.flatMap((s) => s.items);
  const allItemIds = [...new Set([...directItems.map((i) => i.id), ...cascadeItems.map((i) => i.id)])];

  // Promotions that would lose items (and which would empty out entirely).
  const affectedPromos = allItemIds.length
    ? await prisma.promotion.findMany({
        where: { restaurantId, isActive: true, items: { some: { menuItemId: { in: allItemIds } } } },
        select: { id: true, title: true, items: { select: { menuItemId: true } } },
      })
    : [];
  const promoWarnings = affectedPromos.map((p) => {
    const losing = p.items.filter((pi) => allItemIds.includes(pi.menuItemId)).length;
    const emptiesOut = losing === p.items.length;
    return { title: p.title, losingItems: losing, totalItems: p.items.length, willBeRemoved: emptiesOut };
  });

  const totalCount = allItemIds.length;
  const draft = await createDraft(restaurantId, clerkId, {
    kind: DraftActionKind.bulk,
    actionType: "menu_items_delete",
    source: DraftActionSource.chat,
    title: `Delete ${totalCount} item${totalCount === 1 ? "" : "s"}${sections.length ? ` (${sections.length} section${sections.length === 1 ? "" : "s"})` : ""}`,
    subtitle: [...sections.map((s) => `§${s.name}`), ...directItems.map((i) => i.name)].slice(0, 3).join(", ") + (totalCount > 3 ? ", …" : ""),
    iconKey: "menu",
    affectedSurface: "/dashboard/menu",
    childCount: totalCount,
    payload: { menuItemIds: directItems.map((i) => i.id), sections: sections.map((s) => ({ id: s.id, previewedCount: s.items.length })) },
    preview: {
      items: directItems.map((i) => i.name),
      sections: sections.map((s) => ({ name: s.name, cascadeCount: s.items.length, itemNames: s.items.map((i) => i.name) })),
      promotionWarnings: promoWarnings,
      permanent: true,
    },
  });

  return {
    content: JSON.stringify({
      success: true,
      draft_id: draft.id,
      total_items_deleted: totalCount,
      promotion_warnings: promoWarnings,
      message: `Drafted PERMANENT deletion of ${totalCount} item(s)${promoWarnings.length ? ` — warning: affects ${promoWarnings.length} active promotion(s)` : ""}. Spell out the blast radius to the owner before they approve.`,
    }),
    draftId: draft.id,
  };
}

async function execToggleAvailability(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found." }) };
    }

    const stored = action.input as Input;
    const storedItemIds = stored.menu_item_ids as string[];
    const storedAvailable = Boolean(stored.available);

    await prisma.menuItem.updateMany({
      where: { id: { in: storedItemIds }, restaurantId },
      data: {
        isAvailable: storedAvailable,
        soldOutDate: storedAvailable ? null : new Date(),
      },
    });

    return {
      content: JSON.stringify({
        success: true,
        message: `${storedItemIds.length} item(s) marked as ${storedAvailable ? "available" : "sold out"}.`,
      }),
    };
  }

  // Preview
  const itemIds = input.menu_item_ids as string[];
  const available = Boolean(input.available);
  const items = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, restaurantId },
    select: { id: true, name: true, isAvailable: true },
  });

  if (items.length < itemIds.length) {
    return await buildItemNotFoundResult(
      restaurantId,
      itemIds,
      items.map((i) => ({ id: i.id, name: i.name }))
    );
  }

  const pendingActionId = createPendingAction(restaurantId, clerkId, "toggle_availability", input, null);

  const draft = await createDraft(restaurantId, clerkId, {
    // Always bulk so the renderer has a per-item preview even when N=1.
    // SingleCard has no availability_toggle case and would JSON-dump the
    // preview otherwise.
    kind: DraftActionKind.bulk,
    actionType: "availability_toggle",
    source: DraftActionSource.chat,
    title: `${available ? "Mark available" : "Mark sold out"} · ${items.length} item${items.length === 1 ? "" : "s"}`,
    subtitle: items.map((i) => i.name).slice(0, 3).join(", ") + (items.length > 3 ? `, +${items.length - 3} more` : ""),
    iconKey: "menu",
    affectedSurface: "/dashboard/menu",
    childCount: items.length,
    payload: { menuItemIds: items.map((i) => i.id), available },
    preview: {
      action: available ? "Mark available" : "Mark sold out",
      items: items.map((i) => ({
        name: i.name,
        currentStatus: i.isAvailable ? "Available" : "Sold out",
        nextStatus: available ? "Available" : "Sold out",
      })),
    },
  });

  return {
    content: JSON.stringify({
      preview: true,
      action: available ? "Mark available" : "Mark sold out",
      items: items.map((i) => ({
        name: i.name,
        currentStatus: i.isAvailable ? "Available" : "Sold out",
      })),
      draftId: draft.id,
      inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
    }),
    preview: {
      pendingActionId,
      description: `${available ? "Mark available" : "Mark sold out"}: ${items.length} item(s)`,
      changes: items.map((i) => ({
        label: i.name,
        before: i.isAvailable ? "Available" : "Sold out",
        after: available ? "Available" : "Sold out",
      })),
    },
    draftId: draft.id,
  };
}

async function execCreateMenuItem(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found." }) };
    }

    const stored = action.input as Input;
    const sectionId = String(stored.section_id);

    // Verify section belongs to this restaurant
    const section = await prisma.menuSection.findFirst({
      where: { id: sectionId, restaurantId },
    });
    if (!section) {
      return { content: JSON.stringify({ error: "Section not found." }) };
    }

    const maxOrder = await prisma.menuItem.aggregate({
      where: { sectionId },
      _max: { displayOrder: true },
    });

    const item = await prisma.menuItem.create({
      data: {
        restaurantId,
        sectionId,
        name: String(stored.name),
        description: stored.description ? String(stored.description) : null,
        price: Number(stored.price),
        currency: "AED",
        displayOrder: (maxOrder._max.displayOrder ?? -1) + 1,
      },
    });

    return {
      content: JSON.stringify({ success: true, itemId: item.id, message: `"${item.name}" added to menu.` }),
    };
  }

  // Preview
  const section = await prisma.menuSection.findUnique({
    where: { id: String(input.section_id) },
  });

  if (!section || section.restaurantId !== restaurantId) {
    return { content: JSON.stringify({ error: "Section not found." }) };
  }

  const pendingActionId = createPendingAction(restaurantId, clerkId, "create_menu_item", input, null);

  const draft = await createDraft(restaurantId, clerkId, {
    actionType: "menu_item_create",
    source: DraftActionSource.chat,
    title: `Add "${input.name}" to ${section.name}`,
    subtitle: `${formatPrice(Number(input.price))} · new item`,
    iconKey: "menu",
    affectedSurface: "/dashboard/menu",
    payload: {
      sectionId: String(input.section_id),
      name: String(input.name),
      description: input.description ? String(input.description) : null,
      price: Number(input.price),
    },
    preview: {
      sectionName: section.name,
      itemName: String(input.name),
      price: formatPrice(Number(input.price)),
      description: input.description ? String(input.description) : null,
    },
  });

  return {
    content: JSON.stringify({
      preview: true,
      section: section.name,
      item: { name: input.name, price: formatPrice(Number(input.price)), description: input.description ?? null },
      draftId: draft.id,
      inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
    }),
    preview: {
      pendingActionId,
      description: `Add "${input.name}" to ${section.name}`,
      changes: [
        { label: "Item", before: null, after: `${input.name} - ${formatPrice(Number(input.price))}` },
        { label: "Section", before: null, after: section.name },
      ],
    },
    draftId: draft.id,
  };
}

async function execCreateMenuSection(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found." }) };
    }

    const stored = action.input as Input;
    const maxOrder = await prisma.menuSection.aggregate({
      where: { restaurantId },
      _max: { displayOrder: true },
    });

    const section = await prisma.menuSection.create({
      data: {
        restaurantId,
        name: String(stored.name),
        displayOrder: (maxOrder._max.displayOrder ?? -1) + 1,
      },
    });

    return {
      content: JSON.stringify({
        success: true,
        sectionId: section.id,
        message: `Section "${section.name}" created.`,
      }),
    };
  }

  // Preview
  const pendingActionId = createPendingAction(restaurantId, clerkId, "create_menu_section", input, null);

  const draft = await createDraft(restaurantId, clerkId, {
    actionType: "menu_section_create",
    source: DraftActionSource.chat,
    title: `Create section "${input.name}"`,
    subtitle: "New menu section",
    iconKey: "menu",
    affectedSurface: "/dashboard/menu",
    payload: { name: String(input.name) },
    preview: { sectionName: String(input.name) },
  });

  return {
    content: JSON.stringify({
      preview: true,
      sectionName: input.name,
      draftId: draft.id,
      inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
    }),
    preview: {
      pendingActionId,
      description: `Create section "${input.name}"`,
      changes: [{ label: "New Section", before: null, after: String(input.name) }],
    },
    draftId: draft.id,
  };
}

async function execUpdateRestaurant(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found." }) };
    }

    const stored = action.input as Input;
    const data: Record<string, unknown> = {};
    if (stored.description !== undefined) data.description = String(stored.description);
    if (stored.whatsapp_number !== undefined) data.whatsappNumber = String(stored.whatsapp_number);
    if (stored.location !== undefined) data.location = String(stored.location);
    if (stored.address !== undefined) data.address = String(stored.address);
    if (stored.phone !== undefined) data.phone = String(stored.phone);
    if (stored.website !== undefined) data.website = String(stored.website);

    await prisma.restaurant.update({ where: { id: restaurantId }, data });
    return { content: JSON.stringify({ success: true, message: "Restaurant profile updated." }) };
  }

  // Preview
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      description: true,
      whatsappNumber: true,
      location: true,
      address: true,
      phone: true,
      website: true,
    },
  });

  if (!restaurant) {
    return { content: JSON.stringify({ error: "Restaurant not found." }) };
  }

  const changes: Array<{ label: string; before: string | null; after: string }> = [];
  if (input.description !== undefined)
    changes.push({ label: "Description", before: restaurant.description, after: String(input.description) });
  if (input.whatsapp_number !== undefined)
    changes.push({ label: "WhatsApp", before: restaurant.whatsappNumber, after: String(input.whatsapp_number) });
  if (input.location !== undefined)
    changes.push({ label: "Location", before: restaurant.location, after: String(input.location) });
  if (input.address !== undefined)
    changes.push({ label: "Address", before: restaurant.address, after: String(input.address) });
  if (input.phone !== undefined)
    changes.push({ label: "Phone", before: restaurant.phone, after: String(input.phone) });
  if (input.website !== undefined)
    changes.push({ label: "Website", before: restaurant.website, after: String(input.website) });

  if (changes.length === 0) {
    return { content: JSON.stringify({ error: "No changes specified." }) };
  }

  const pendingActionId = createPendingAction(restaurantId, clerkId, "update_restaurant", input, null);

  const draft = await createDraft(restaurantId, clerkId, {
    actionType: "restaurant_profile_update",
    source: DraftActionSource.chat,
    title: "Update restaurant profile",
    subtitle: changes.map((c) => c.label).join(" · "),
    iconKey: "menu",
    affectedSurface: "/dashboard/appearance",
    payload: {
      ...(input.description !== undefined && { description: String(input.description) }),
      ...(input.whatsapp_number !== undefined && { whatsappNumber: String(input.whatsapp_number) }),
      ...(input.location !== undefined && { location: String(input.location) }),
      ...(input.address !== undefined && { address: String(input.address) }),
      ...(input.phone !== undefined && { phone: String(input.phone) }),
      ...(input.website !== undefined && { website: String(input.website) }),
    },
    preview: {
      changes: changes.map((c) => ({ field: c.label, from: c.before, to: c.after })),
    },
  });

  return {
    content: JSON.stringify({
      preview: true,
      changes: changes.map((c) => ({ field: c.label, from: c.before, to: c.after })),
      draftId: draft.id,
      inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
    }),
    preview: {
      pendingActionId,
      description: "Update restaurant profile",
      changes,
    },
    draftId: draft.id,
  };
}

async function execPublishMenu(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found." }) };
    }

    const stored = action.input as Input;
    const storedPublish = Boolean(stored.publish);

    await prisma.restaurant.update({
      where: { id: restaurantId },
      data: { isPublished: storedPublish },
    });

    return {
      content: JSON.stringify({
        success: true,
        message: storedPublish ? "Restaurant is now published and visible to diners." : "Restaurant has been unpublished.",
      }),
    };
  }

  const publish = Boolean(input.publish);

  // Preview
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { isPublished: true, name: true },
  });

  if (!restaurant) {
    return { content: JSON.stringify({ error: "Restaurant not found." }) };
  }

  const pendingActionId = createPendingAction(restaurantId, clerkId, "publish_menu", input, null);

  const draft = await createDraft(restaurantId, clerkId, {
    actionType: "publish_menu",
    source: DraftActionSource.chat,
    title: publish ? `Publish ${restaurant.name}` : `Unpublish ${restaurant.name}`,
    subtitle: restaurant.isPublished
      ? publish
        ? "Already published"
        : "Will hide the public menu"
      : publish
        ? "Will go live to diners"
        : "Already unpublished",
    iconKey: "menu",
    affectedSurface: "/dashboard",
    payload: { publish },
    preview: {
      currentStatus: restaurant.isPublished ? "Published" : "Unpublished",
      nextStatus: publish ? "Published" : "Unpublished",
    },
  });

  return {
    content: JSON.stringify({
      preview: true,
      action: publish ? "Publish" : "Unpublish",
      currentStatus: restaurant.isPublished ? "Published" : "Unpublished",
      draftId: draft.id,
      inboxNotice: "Drafted in the Sous Chef Inbox — approve there to ship.",
    }),
    preview: {
      pendingActionId,
      description: publish ? `Publish ${restaurant.name}` : `Unpublish ${restaurant.name}`,
      changes: [
        {
          label: "Status",
          before: restaurant.isPublished ? "Published" : "Unpublished",
          after: publish ? "Published" : "Unpublished",
        },
      ],
    },
    draftId: draft.id,
  };
}

async function execRunMenuAnalysis(
  restaurantId: string,
  clerkId: string,
  entitlements: PlanEntitlements,
  input: Input
): Promise<ToolResult> {
  if (input.execute && input.pending_action_id) {
    const action = consumePendingAction(String(input.pending_action_id), restaurantId, clerkId);
    if (!action) {
      return { content: JSON.stringify({ error: "Pending action expired or not found." }) };
    }

    const limit = await checkAiLimit(restaurantId, "menu_analysis", entitlements.analysisLimit);
    if (!limit.allowed) {
      return {
        content: JSON.stringify({
          error: `Menu analysis limit reached (${limit.used}/${entitlements.analysisLimit}).`,
        }),
      };
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true, cuisineType: true, location: true },
    });

    if (!restaurant) {
      return { content: JSON.stringify({ error: "Restaurant not found." }) };
    }

    const result = await analyzeMenu(
      { id: restaurantId, name: restaurant.name, cuisineType: restaurant.cuisineType, location: restaurant.location },
      entitlements.menuAnalysisLevel
    );

    if (!result.cached) {
      await logAiUsage(restaurantId, "menu_analysis", result.tokensIn, result.tokensOut);
    }

    return {
      content: JSON.stringify({
        success: true,
        analysis: result.result,
        cached: result.cached,
      }),
    };
  }

  // Preview — just confirm running the analysis
  const pendingActionId = createPendingAction(restaurantId, clerkId, "run_menu_analysis", input, null);

  return {
    content: JSON.stringify({
      preview: true,
      message: "This will run a fresh AI menu health analysis. It may take 30-60 seconds.",
      level: entitlements.menuAnalysisLevel,
    }),
    preview: {
      pendingActionId,
      description: "Run fresh menu health analysis",
      changes: [{ label: "Action", before: null, after: `Run ${entitlements.menuAnalysisLevel} analysis` }],
    },
  };
}

// =============================================================================
// AD STUDIO — read tools
// =============================================================================

async function execGetAdProjectsSummary(restaurantId: string): Promise<ToolResult> {
  const projects = await prisma.adProject.findMany({
    where: { restaurantId },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: {
      id: true,
      name: true,
      campaignType: true,
      status: true,
      budgetAed: true,
      durationWeeks: true,
      updatedAt: true,
      _count: { select: { creatives: true, liveCampaigns: true } },
    },
  });

  return {
    content: JSON.stringify({
      total: projects.length,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        campaignType: p.campaignType,
        status: p.status,
        budget: formatPrice(p.budgetAed),
        durationWeeks: p.durationWeeks,
        variantCount: p._count.creatives,
        liveCampaignCount: p._count.liveCampaigns,
        updatedAt: p.updatedAt.toISOString(),
      })),
    }),
  };
}

async function execGetAdCampaignPerformance(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  const projectId = String(input.project_id ?? "");
  const days = Math.min(Math.max(Number(input.days ?? 7), 1), 90);

  if (!projectId) {
    return { content: JSON.stringify({ error: "project_id is required" }) };
  }

  // Verify project belongs to the owner's restaurants
  const project = await prisma.adProject.findFirst({
    where: { id: projectId, restaurant: { owner: { clerkId } } },
    select: { id: true, name: true, restaurantId: true },
  });
  if (!project) {
    return { content: JSON.stringify({ error: "Project not found or not owned by you." }) };
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const liveCampaigns = await prisma.adLiveCampaign.findMany({
    where: { projectId },
    select: {
      id: true,
      platform: true,
      status: true,
      launchedAt: true,
      lastSyncedAt: true,
    },
  });

  const snapshots = await prisma.adPerformanceSnapshot.findMany({
    where: {
      liveCampaign: { projectId },
      reportedAt: { gte: cutoff },
    },
    select: {
      spendAed: true,
      impressions: true,
      reach: true,
      clicks: true,
      conversions: true,
      revenueAed: true,
      source: true,
      reportedAt: true,
    },
    orderBy: { reportedAt: "desc" },
  });

  const totalSpend = snapshots.reduce((s, x) => s + Number(x.spendAed ?? 0), 0);
  const totalImpressions = snapshots.reduce((s, x) => s + x.impressions, 0);
  const totalClicks = snapshots.reduce((s, x) => s + x.clicks, 0);
  const totalConversions = snapshots.reduce((s, x) => s + x.conversions, 0);
  const totalRevenue = snapshots.reduce((s, x) => s + Number(x.revenueAed ?? 0), 0);

  const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const cpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
  const cpa = totalConversions > 0 ? totalSpend / totalConversions : 0;
  const roas = totalSpend > 0 ? totalRevenue / totalSpend : 0;

  return {
    content: JSON.stringify({
      project: { id: project.id, name: project.name },
      lookbackDays: days,
      snapshotCount: snapshots.length,
      liveCampaigns,
      totals: {
        spend: formatPrice(totalSpend),
        impressions: totalImpressions,
        clicks: totalClicks,
        conversions: totalConversions,
        attributedRevenue: formatPrice(totalRevenue),
        ctrPct: ctr.toFixed(2),
        cpc: formatPrice(cpc),
        cpa: totalConversions > 0 ? formatPrice(cpa) : "n/a",
        roas: totalSpend > 0 ? roas.toFixed(2) : "n/a",
      },
    }),
  };
}

async function execGetAdAttributedCustomers(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  const projectId = String(input.project_id ?? "");
  const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 50);

  if (!projectId) {
    return { content: JSON.stringify({ error: "project_id is required" }) };
  }

  const project = await prisma.adProject.findFirst({
    where: { id: projectId, restaurant: { owner: { clerkId } } },
    select: { id: true, name: true },
  });
  if (!project) {
    return { content: JSON.stringify({ error: "Project not found or not owned by you." }) };
  }

  const customers = await prisma.customer.findMany({
    where: { referralAdProjectId: projectId },
    orderBy: [{ totalSpend: "desc" }, { lastOrderAt: "desc" }],
    take: limit,
    select: {
      displayName: true,
      phoneNumber: true,
      orderCount: true,
      totalSpend: true,
      lastOrderAt: true,
      marketingOptIn: true,
    },
  });

  const totalAttributedSpend = customers.reduce(
    (s, c) => s + Number(c.totalSpend ?? 0),
    0
  );

  return {
    content: JSON.stringify({
      project: { id: project.id, name: project.name },
      totalAttributedCustomers: customers.length,
      totalAttributedSpend: formatPrice(totalAttributedSpend),
      customers: customers.map((c) => ({
        name: c.displayName,
        phone: c.phoneNumber.slice(-4).padStart(c.phoneNumber.length, "*"),
        orderCount: c.orderCount,
        totalSpend: formatPrice(c.totalSpend),
        lastOrderAt: c.lastOrderAt?.toISOString() ?? null,
        marketingOptIn: c.marketingOptIn,
      })),
    }),
  };
}

// =============================================================================
// CRM — read tools
// =============================================================================

async function execGetCrmSummary(restaurantId: string): Promise<ToolResult> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalCustomers,
    repeatCustomers,
    optInCount,
    active30dCount,
    aggregateSpend,
    lastBroadcast,
  ] = await Promise.all([
    prisma.customer.count({ where: { restaurantId } }),
    prisma.customer.count({ where: { restaurantId, orderCount: { gt: 1 } } }),
    prisma.customer.count({ where: { restaurantId, marketingOptIn: true } }),
    prisma.customer.count({
      where: { restaurantId, lastOrderAt: { gte: thirtyDaysAgo } },
    }),
    prisma.orderIntent.aggregate({
      where: { restaurantId },
      _sum: { totalPrice: true },
      _count: true,
    }),
    prisma.campaign.findFirst({
      where: { restaurantId },
      orderBy: { createdAt: "desc" },
      select: {
        type: true,
        name: true,
        status: true,
        createdAt: true,
        loggedCount: true,
        targetCount: true,
      },
    }),
  ]);

  const avgOrderValue =
    aggregateSpend._count > 0
      ? Number(aggregateSpend._sum.totalPrice ?? 0) / aggregateSpend._count
      : 0;

  return {
    content: JSON.stringify({
      totalCustomers,
      repeatCustomers,
      optInCount,
      active30dCount,
      totalOrders: aggregateSpend._count,
      totalRevenue: formatPrice(aggregateSpend._sum.totalPrice ?? 0),
      avgOrderValue: formatPrice(avgOrderValue),
      lastBroadcast: lastBroadcast
        ? {
            name: lastBroadcast.name,
            type: lastBroadcast.type,
            status: lastBroadcast.status,
            loggedCount: lastBroadcast.loggedCount,
            targetCount: lastBroadcast.targetCount,
            sentAt: lastBroadcast.createdAt.toISOString(),
          }
        : null,
    }),
  };
}

async function execGetRecentCustomers(
  restaurantId: string,
  input: Input
): Promise<ToolResult> {
  const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 50);

  const customers = await prisma.customer.findMany({
    where: { restaurantId },
    orderBy: [{ lastOrderAt: "desc" }, { updatedAt: "desc" }],
    take: limit,
    select: {
      displayName: true,
      phoneNumber: true,
      orderCount: true,
      totalSpend: true,
      lastOrderAt: true,
      marketingOptIn: true,
      referralAdProjectId: true,
    },
  });

  return {
    content: JSON.stringify({
      count: customers.length,
      customers: customers.map((c) => ({
        name: c.displayName,
        phone: c.phoneNumber.slice(-4).padStart(c.phoneNumber.length, "*"),
        orderCount: c.orderCount,
        totalSpend: formatPrice(c.totalSpend),
        lastOrderAt: c.lastOrderAt?.toISOString() ?? null,
        marketingOptIn: c.marketingOptIn,
        attributedToAdProjectId: c.referralAdProjectId,
      })),
    }),
  };
}

async function execGetInactiveCustomers(
  restaurantId: string,
  input: Input
): Promise<ToolResult> {
  const days = Math.min(Math.max(Number(input.days ?? 30), 7), 365);
  const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 100);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const customers = await prisma.customer.findMany({
    where: {
      restaurantId,
      marketingOptIn: true,
      OR: [{ lastOrderAt: { lt: cutoff } }, { lastOrderAt: null }],
      orderCount: { gt: 0 }, // exclude prospects who never ordered
    },
    orderBy: [{ totalSpend: "desc" }, { lastOrderAt: "asc" }],
    take: limit,
    select: {
      displayName: true,
      phoneNumber: true,
      orderCount: true,
      totalSpend: true,
      lastOrderAt: true,
    },
  });

  return {
    content: JSON.stringify({
      thresholdDays: days,
      count: customers.length,
      customers: customers.map((c) => ({
        name: c.displayName,
        phone: c.phoneNumber.slice(-4).padStart(c.phoneNumber.length, "*"),
        orderCount: c.orderCount,
        totalSpend: formatPrice(c.totalSpend),
        lastOrderAt: c.lastOrderAt?.toISOString() ?? null,
        daysSinceLastOrder: c.lastOrderAt
          ? Math.floor((Date.now() - c.lastOrderAt.getTime()) / (24 * 60 * 60 * 1000))
          : null,
      })),
    }),
  };
}

// =============================================================================
// Analytics expansion — read tools
// =============================================================================

async function execGetEngagementBreakdown(
  restaurantId: string,
  input: Input
): Promise<ToolResult> {
  const days = Math.min(Math.max(Number(input.days ?? 7), 1), 90);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [likes, brandingClicks, whatsappClicks, cartOrders] = await Promise.all([
    prisma.menuItemLike.count({
      where: { menuItem: { restaurantId }, createdAt: { gte: cutoff } },
    }),
    prisma.brandingClick.count({ where: { restaurantId, createdAt: { gte: cutoff } } }),
    prisma.whatsAppClick.count({ where: { restaurantId, createdAt: { gte: cutoff } } }),
    prisma.whatsAppCartOrder.aggregate({
      where: { restaurantId, createdAt: { gte: cutoff } },
      _sum: { totalPrice: true },
      _count: true,
    }),
  ]);

  return {
    content: JSON.stringify({
      lookbackDays: days,
      menuItemLikes: likes,
      brandingClicks,
      whatsappClicks,
      cartOrders: {
        count: cartOrders._count,
        revenue: formatPrice(cartOrders._sum.totalPrice ?? 0),
      },
    }),
  };
}

async function execGetTopPaths(
  restaurantId: string,
  input: Input
): Promise<ToolResult> {
  const days = Math.min(Math.max(Number(input.days ?? 7), 1), 90);
  const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 50);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const grouped = await prisma.pageView.groupBy({
    by: ["path"],
    where: { restaurantId, createdAt: { gte: cutoff } },
    _count: { _all: true },
    orderBy: { _count: { path: "desc" } },
    take: limit,
  });

  return {
    content: JSON.stringify({
      lookbackDays: days,
      paths: grouped.map((r) => ({
        path: r.path,
        views: r._count._all,
      })),
    }),
  };
}

// =============================================================================
// SEO — read tools
// =============================================================================

async function execGetSeoAnalysis(restaurantId: string): Promise<ToolResult> {
  const latest = await prisma.seoAnalysis.findFirst({
    where: { restaurantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      overallScore: true,
      gbpScore: true,
      onPageScore: true,
      rankGridScore: true,
      citationsScore: true,
      reviewsScore: true,
      recommendations: true,
      errorMessage: true,
      createdAt: true,
      completedAt: true,
    },
  });

  if (!latest) {
    return {
      content: JSON.stringify({
        status: "not_run",
        message:
          "No SEO analysis has been run yet. Suggest the owner runs one from the SEO Analysis page.",
      }),
    };
  }

  // recommendations is a JSON value — try to surface the top 3 actionable lines.
  type RecItem = { title?: string; recommendation?: string };
  let topRecommendations: string[] = [];
  if (latest.recommendations && typeof latest.recommendations === "object") {
    if (Array.isArray(latest.recommendations)) {
      topRecommendations = (latest.recommendations as RecItem[])
        .slice(0, 3)
        .map((r) => r.title ?? r.recommendation ?? JSON.stringify(r))
        .filter((s): s is string => typeof s === "string" && s.length > 0);
    } else {
      const rec = latest.recommendations as Record<string, unknown>;
      // Try common shapes
      const list = (rec.priority ?? rec.top ?? rec.items ?? []) as RecItem[];
      if (Array.isArray(list)) {
        topRecommendations = list
          .slice(0, 3)
          .map((r) => r.title ?? r.recommendation ?? "")
          .filter((s): s is string => typeof s === "string" && s.length > 0);
      }
    }
  }

  return {
    content: JSON.stringify({
      status: latest.status,
      analysisId: latest.id,
      overallScore: latest.overallScore,
      subScores: {
        googleBusinessProfile: latest.gbpScore,
        onPage: latest.onPageScore,
        rankGrid: latest.rankGridScore,
        citations: latest.citationsScore,
        reviews: latest.reviewsScore,
      },
      topRecommendations,
      errorMessage: latest.errorMessage,
      createdAt: latest.createdAt.toISOString(),
      completedAt: latest.completedAt?.toISOString() ?? null,
    }),
  };
}

// =============================================================================
// Market Pulse — read tool
// =============================================================================

/**
 * Read recent competitor activity for the dashboard agent. Compact JSON
 * shape — keeps Claude's context lean while still giving the model enough
 * structure to synthesize natural-language summaries and chain follow-ups
 * ("draft an Ad Studio counter-campaign for X's lunch promo").
 *
 * Lookup order:
 *   1. requested week_bucket (defaults to current UAE Sunday)
 *   2. fall back to PRIOR week if current has zero rows — the Sunday cron
 *      runs at 02:00 UTC, so on Saturday a "this week" query would return
 *      nothing. Falling back means owners get useful data 7 days/week.
 *
 * Gating:
 *   • Not entitled → return { status: "not_eligible" } with upgrade hint.
 *   • Entitled but no data ever → { status: "no_data_yet" } with cron hint.
 *   • Entitled with data → { status: "ok", competitors: [...] }.
 */
async function execGetCompetitorActivity(
  restaurantId: string,
  entitlements: PlanEntitlements,
  input: Input
): Promise<ToolResult> {
  if (!entitlements.competitorIntelligenceEnabled) {
    return {
      content: JSON.stringify({
        status: "not_eligible",
        message:
          "Market Pulse is on Pro and Portfolio. Tell the owner upgrading unlocks weekly competitor menu, promo, press, and review tracking — and offer to walk them through plans (use get_bustan_info topic=pricing).",
      }),
    };
  }

  const requestedWeek =
    typeof input.week_bucket === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.week_bucket)
      ? input.week_bucket
      : sundayOfThisWeekUae();
  const limit = Math.min(
    Math.max(typeof input.limit === "number" ? input.limit : 10, 1),
    10
  );

  // Try the requested week first; if empty (e.g. Saturday before Sunday's
  // cron), fall back to the prior week so we always return something useful.
  async function loadForWeek(week: string) {
    return prisma.competitorSnapshot.findMany({
      where: { restaurantId, weekBucket: week },
      orderBy: [{ distanceMeters: "asc" }, { reviewCount: "desc" }],
      take: limit,
    });
  }

  let weekBucket = requestedWeek;
  let rows = await loadForWeek(weekBucket);
  if (rows.length === 0) {
    const prior = new Date(`${requestedWeek}T00:00:00Z`);
    prior.setUTCDate(prior.getUTCDate() - 7);
    const priorBucket = prior.toISOString().slice(0, 10);
    const priorRows = await loadForWeek(priorBucket);
    if (priorRows.length > 0) {
      weekBucket = priorBucket;
      rows = priorRows;
    }
  }

  if (rows.length === 0) {
    return {
      content: JSON.stringify({
        status: "no_data_yet",
        message:
          "No Market Pulse snapshots exist yet for this restaurant. The weekly cron runs Sunday morning (UAE) — first useful data lands the Sunday after the restaurant goes Pro. Suggest the owner check back on Monday.",
        weekBucket: requestedWeek,
      }),
    };
  }

  // Compact per-competitor projection. Trim arrays aggressively — the
  // model only needs enough signal to synthesize, not raw dumps.
  const competitors = rows.map((row) => {
    const menuItems = (row.menuItems as unknown as MenuItemSignal[]) ?? [];
    const promotions = (row.promotions as unknown as PromoSignal[]) ?? [];
    const pressMentions =
      (row.pressMentions as unknown as PressMentionSignal[]) ?? [];
    const webReviews = (row.webReviews as unknown as WebReviewSignal[]) ?? [];
    const changes = (row.changes as unknown as CompetitorChanges) ?? null;

    return {
      name: row.name,
      cuisine: row.cuisine,
      distanceMeters: row.distanceMeters,
      rating: row.rating !== null ? Number(row.rating) : null,
      reviewCount: row.reviewCount,
      topMenuItems: menuItems.slice(0, 5).map((m) => ({
        name: m.name,
        price: m.price,
        currency: m.currency,
      })),
      menuItemsTotal: menuItems.length,
      promotions: promotions.slice(0, 3).map((p) => ({
        title: p.title,
        publishedAt: p.publishedAt,
      })),
      pressMentions: pressMentions.slice(0, 3).map((p) => ({
        title: p.title,
        publication: p.publication,
        publishedAt: p.publishedAt,
      })),
      webReviewsCount: webReviews.length,
      // Diff is the highest-signal field — surface even on weeks with
      // no movement so the model can confidently say "no changes."
      changes: changes
        ? {
            addedDishes: changes.addedDishes.slice(0, 5).map((d) => ({
              name: d.name,
              price: d.price,
            })),
            removedDishes: changes.removedDishes.slice(0, 5).map((d) => d.name),
            priceChanges: changes.priceChanges.slice(0, 5),
            newPromos: changes.newPromos.slice(0, 3).map((p) => p.title),
          }
        : null,
    };
  });

  // One-line headline the model can quote directly without re-counting.
  const movementCount = competitors.filter(
    (c) =>
      c.changes !== null &&
      (c.changes.addedDishes.length > 0 ||
        c.changes.priceChanges.length > 0 ||
        c.changes.newPromos.length > 0)
  ).length;
  const anyMovement = movementCount > 0;

  return {
    content: JSON.stringify({
      status: "ok",
      weekBucket,
      isFromPriorWeek: weekBucket !== requestedWeek,
      competitorsCount: competitors.length,
      summary: anyMovement
        ? `${movementCount} of ${competitors.length} nearby competitors made notable moves this week.`
        : `${competitors.length} nearby competitors tracked; no notable changes this week.`,
      competitors,
    }),
  };
}

// =============================================================================
// WhatsApp — read tools
// =============================================================================

async function execGetWhatsAppStatus(restaurantId: string): Promise<ToolResult> {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [integration, templateCount, pendingReplies] = await Promise.all([
    prisma.whatsAppIntegration.findUnique({
      where: { restaurantId },
      select: {
        status: true,
        displayPhoneNumber: true,
        connectedAt: true,
        lastWebhookAt: true,
        lastError: true,
      },
    }),
    prisma.whatsAppTemplate.count({ where: { restaurantId } }),
    // Conversations with unread inbound messages — owner's "to-do list"
    // within the 24h service window.
    prisma.whatsAppConversation.count({
      where: {
        restaurantId,
        unreadCount: { gt: 0 },
        lastMessageAt: { gte: twentyFourHoursAgo },
      },
    }),
  ]);

  if (!integration) {
    return {
      content: JSON.stringify({
        connected: false,
        message:
          "WhatsApp Business API is not connected. Suggest the owner connects it from Settings > WhatsApp.",
      }),
    };
  }

  return {
    content: JSON.stringify({
      connected: integration.status === "connected",
      status: integration.status,
      registeredPhone: integration.displayPhoneNumber,
      connectedAt: integration.connectedAt?.toISOString() ?? null,
      lastWebhookAt: integration.lastWebhookAt?.toISOString() ?? null,
      templateCount,
      pendingReplies24h: pendingReplies,
      lastError: integration.lastError,
    }),
  };
}

async function execListWhatsAppTemplates(restaurantId: string): Promise<ToolResult> {
  const templates = await prisma.whatsAppTemplate.findMany({
    where: { restaurantId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 50,
    select: {
      name: true,
      label: true,
      category: true,
      language: true,
      status: true,
      rejectionReason: true,
      lastSyncedAt: true,
      createdAt: true,
    },
  });

  // Count by status for a quick summary line
  const statusCounts: Record<string, number> = {};
  for (const t of templates) {
    statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
  }

  return {
    content: JSON.stringify({
      total: templates.length,
      byStatus: statusCounts,
      templates: templates.map((t) => ({
        name: t.name,
        label: t.label,
        category: t.category,
        language: t.language,
        status: t.status,
        rejectionReason: t.rejectionReason,
        lastSyncedAt: t.lastSyncedAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
    }),
  };
}

async function execGetBroadcastPerformance(
  restaurantId: string,
  input: Input
): Promise<ToolResult> {
  const days = Math.min(Math.max(Number(input.days ?? 30), 1), 365);
  const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 50);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const campaigns = await prisma.campaign.findMany({
    where: { restaurantId, createdAt: { gte: cutoff } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      name: true,
      type: true,
      status: true,
      templateName: true,
      targetCount: true,
      loggedCount: true,
      targetSegment: true,
      createdAt: true,
      loggedAt: true,
    },
  });

  return {
    content: JSON.stringify({
      lookbackDays: days,
      total: campaigns.length,
      campaigns: campaigns.map((c) => ({
        name: c.name,
        type: c.type,
        status: c.status,
        templateName: c.templateName,
        targetSegment: c.targetSegment,
        targetCount: c.targetCount,
        loggedCount: c.loggedCount,
        deliveryRate:
          c.targetCount > 0 ? `${((c.loggedCount / c.targetCount) * 100).toFixed(1)}%` : "n/a",
        createdAt: c.createdAt.toISOString(),
        loggedAt: c.loggedAt?.toISOString() ?? null,
      })),
    }),
  };
}

// =============================================================================
// Widget — read tools
// =============================================================================

async function execGetWidgetStatus(restaurantId: string): Promise<ToolResult> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    include: {
      subscription: true,
      operatorAccount: { include: { _count: { select: { brands: true } } } },
    },
  });

  if (!restaurant) {
    return { content: JSON.stringify({ error: "Restaurant not found." }) };
  }

  const entitlements = getRestaurantEntitlements(restaurant);
  const base = env.FRONTEND_APP_URL.replace(/\/$/, "");
  const menuUrl = `${base}/m/${restaurant.slug}`;
  const embedUrl = `${base}/embed/${restaurant.slug}`;
  const embedCode = `<iframe src="${embedUrl}" style="width:100%;height:800px;border:0;" loading="lazy"></iframe>`;

  return {
    content: JSON.stringify({
      enabled: entitlements.widgetEnabled,
      plan: entitlements.plan,
      slug: restaurant.slug,
      menuUrl,
      embedUrl,
      embedCode,
      upsellHint: entitlements.widgetEnabled
        ? null
        : "Widget embeds are available on Pro and Portfolio plans.",
    }),
  };
}

// ── plan_marketing_week — bundle macro ────────────────────────────
//
// Produces ONE parent DraftAction (kind=bundle, actionType=marketing_bundle)
// plus up to 3 children: a featured promotion (if a hot menu item exists),
// an ad campaign (if an event moment falls in the next 14 days), and a
// WhatsApp blast (if there are 30+ lapsed regulars). Each child uses a Phase
// 4 actionType — promotion_create / ad_campaign_create / whatsapp_campaign_create
// — that maps to a real shipper that writes the entity in DRAFT status.
// Owner reviews the bundle, taps "Ship all" → every entity lands at the same
// time and the owner finalizes each in its native surface.

async function execPlanMarketingWeek(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  const themeHint = input.theme_hint ? String(input.theme_hint) : null;
  const now = new Date();
  const horizonStart = new Date(now);
  const horizonEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  // 1. Restaurant context
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      name: true,
      cuisineType: true,
      location: true,
      eventCalendarEnabled: true,
    },
  });
  if (!restaurant) {
    return { content: JSON.stringify({ error: "Restaurant not found" }) };
  }

  // 2. Hero menu item — pick the highest-priced available item with an image,
  //    a proxy for "this is the one to feature" until we have order analytics
  //    integrated into the planner.
  const heroItem = await prisma.menuItem.findFirst({
    where: {
      restaurantId,
      isAvailable: true,
      OR: [{ imageStatus: "ready" }, { imageStatus: "generated" }],
    },
    orderBy: { price: "desc" },
    select: { id: true, name: true, price: true },
  });

  // 3. Upcoming event from the active AdProject set (event-stager already
  //    staged briefs for the prep window). Pick the soonest unconsumed one
  //    if any.
  const upcomingAdProject = await prisma.adProject.findFirst({
    where: {
      restaurantId,
      sourceMomentStartsOn: { gte: horizonStart, lte: horizonEnd },
      status: "draft",
    },
    orderBy: { sourceMomentStartsOn: "asc" },
    select: {
      id: true,
      name: true,
      campaignType: true,
      goal: true,
      countries: true,
      cuisines: true,
      targetPlatforms: true,
      budgetTier: true,
      budgetAed: true,
      sourceMomentId: true,
      sourceMomentStartsOn: true,
    },
  });

  // 4. Lapsed regulars (haven't ordered in 21d, marketing-opted-in).
  const lapsedCutoff = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);
  const lapsedCount = await prisma.customer.count({
    where: {
      restaurantId,
      marketingOptIn: true,
      OR: [{ lastOrderAt: { lt: lapsedCutoff } }, { lastOrderAt: null }],
      orderCount: { gt: 0 },
    },
  });

  // ── Plan children ──
  const children: CreateDraftParams[] = [];
  const themeOfWeek =
    themeHint ??
    (upcomingAdProject?.name
      ? `${upcomingAdProject.name} weekend`
      : heroItem
        ? `${heroItem.name} hero week`
        : "Stay top-of-mind");

  // Child 1: featured promotion
  if (heroItem) {
    children.push({
      actionType: "promotion_create",
      source: DraftActionSource.quick_prompt,
      title: `Feature "${heroItem.name}" this week`,
      subtitle: `Promo price suggestion · ${formatPrice(Number(heroItem.price) * 0.85)}`,
      iconKey: "promotion",
      affectedSurface: "/dashboard/menu",
      payload: {
        type: "discounted_item",
        title: `${heroItem.name} · ${themeOfWeek}`,
        description: `Highlighted dish for ${themeOfWeek}.`,
        promoPrice: Math.round(Number(heroItem.price) * 0.85 * 100) / 100,
        startsAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        itemIds: [heroItem.id],
        isFeatured: true,
      },
      preview: {
        type: "discounted_item",
        title: `${heroItem.name} · ${themeOfWeek}`,
        items: [heroItem.name],
        promoPrice: formatPrice(Number(heroItem.price) * 0.85),
      },
    });
  }

  // Child 2: Meta ad campaign tied to upcoming event
  if (upcomingAdProject) {
    const launchAt =
      upcomingAdProject.sourceMomentStartsOn ??
      new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    children.push({
      actionType: "ad_campaign_create",
      source: DraftActionSource.quick_prompt,
      title: `Meta ad · ${upcomingAdProject.name}`,
      subtitle: `${upcomingAdProject.targetPlatforms.join(", ")} · ${upcomingAdProject.budgetAed} AED`,
      iconKey: "ad",
      affectedSurface: `/dashboard/ad-studio`,
      payload: {
        name: `${upcomingAdProject.name} · ${themeOfWeek}`,
        campaignType: upcomingAdProject.campaignType,
        goal: upcomingAdProject.goal,
        countries: upcomingAdProject.countries,
        cuisines: upcomingAdProject.cuisines,
        targetPlatforms: upcomingAdProject.targetPlatforms,
        budgetTier: upcomingAdProject.budgetTier,
        budgetAed: upcomingAdProject.budgetAed,
        durationWeeks: 1,
        startsOn: launchAt.toISOString(),
        primaryDishId: heroItem?.id ?? null,
        briefJson: { themeOfWeek, sourceBundle: true },
        // Idempotency: when event-stager has already staged a project for
        // this moment, the shipper will UPDATE that row with the bundle's
        // enriched theme/hero details instead of creating a duplicate.
        sourceMomentId: upcomingAdProject.sourceMomentId ?? null,
        sourceMomentYear: upcomingAdProject.sourceMomentStartsOn?.getFullYear() ?? null,
      },
      preview: {
        eventName: upcomingAdProject.name,
        budgetAed: upcomingAdProject.budgetAed,
        platforms: upcomingAdProject.targetPlatforms,
        startsOn: launchAt.toISOString(),
      },
    });
  }

  // Child 3: WhatsApp win-back blast — only if (a) enough lapsed regulars
  // AND (b) the restaurant actually has an approved WhatsApp template for
  // win-back messaging. Drafting a campaign tied to an unapproved template
  // creates a dead-end card: it lands in CRM, owner tries to send, Meta
  // rejects it. Better to skip the child entirely than to surface that.
  if (lapsedCount >= 30) {
    const approvedTemplate = await prisma.whatsAppTemplate.findFirst({
      where: {
        restaurantId,
        status: "approved",
        OR: [
          { name: { contains: "winback", mode: "insensitive" } },
          { category: "MARKETING" },
        ],
      },
      select: { name: true },
      orderBy: { createdAt: "desc" },
    });

    if (approvedTemplate) {
      const heroLabel = heroItem ? `your favourite ${heroItem.name.toLowerCase()}` : "your favourite dish";
      children.push({
        actionType: "whatsapp_campaign_create",
        source: DraftActionSource.quick_prompt,
        title: `Win-back blast · ${lapsedCount} lapsed regulars`,
        subtitle: themeOfWeek,
        iconKey: "whatsapp",
        affectedSurface: "/dashboard/crm",
        payload: {
          name: `Win-back · ${themeOfWeek}`,
          campaignType: "inactive_30",
          templateName: approvedTemplate.name,
          body: `Hey {{name}} 👋 ${restaurant.name} misses you! ${heroLabel} is back this week — tap to reorder.`,
          targetSegment: "lapsed_21d",
          promotionId: null,
        },
        preview: {
          segment: "Lapsed 21d+",
          audienceSize: lapsedCount,
          template: approvedTemplate.name,
          bodyPreview: `Hey {{name}} 👋 ${restaurant.name} misses you! ${heroLabel}…`,
        },
      });
    }
  }

  if (children.length === 0) {
    return {
      content: JSON.stringify({
        error:
          "Not enough signal to plan a bundle yet — try adding a featured dish or finishing onboarding first.",
      }),
    };
  }

  // ── Aggregate impact ──
  // Formulas are coarse estimates, calibrated to real UAE F&B Meta benchmarks:
  //   - Reach: ~35 AED CPM is the working mid-funnel rate for UAE food
  //     (i.e., 1000 impressions per 35 AED). spendAed / 35 * 1000 = spend×28.5
  //     Rounded down to ×24 to undersell rather than oversell — the BundleCard
  //     stat is read in seconds and an obviously-too-high number burns trust
  //     instantly when the owner cross-checks against Ads Manager.
  //   - Projected orders: 6% of ad spend (1.5% landing CTR × 4% conversion)
  //     plus 4% of lapsed-customer audience (WhatsApp win-back rates).
  const estimatedSpendAed = upcomingAdProject?.budgetAed ?? 0;
  const projectedOrders = Math.max(
    8,
    Math.round(estimatedSpendAed * 0.06) + Math.round(lapsedCount * 0.04)
  );
  const estimatedReach = Math.max(
    lapsedCount,
    Math.round(estimatedSpendAed * 24) + lapsedCount
  );

  // Resolve User.id once for the whole batch — saves N lookups inside the txn.
  const ownerUser = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });
  if (!ownerUser) {
    return { content: JSON.stringify({ error: "User session not found" }) };
  }

  // ── Write parent + children atomically ──
  // If any child fails to insert, the parent rolls back too. Without this a
  // half-formed bundle (parent.childCount=3 but only 2 child rows) would ship
  // "2 of 3" silently on Approve, with the BundleCard mis-counting.
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const parent = await prisma.$transaction(async (tx) => {
    const p = await tx.draftAction.create({
      data: {
        restaurantId,
        ownerUserId: ownerUser.id,
        kind: DraftActionKind.bundle,
        actionType: "marketing_bundle",
        source: DraftActionSource.quick_prompt,
        title: `${themeOfWeek} · ${children.length}-action bundle`,
        subtitle: children.map((c) => c.iconKey).join(" · "),
        iconKey: "ad",
        affectedSurface: "/dashboard",
        childCount: children.length,
        estimatedImpact: {
          reach: estimatedReach,
          spendAed: estimatedSpendAed,
          projectedOrders,
        },
        payload: {
          themeOfWeek,
          childActionTypes: children.map((c) => c.actionType),
        },
        preview: {
          themeOfWeek,
          childCount: children.length,
          children: children.map((c) => ({
            actionType: c.actionType,
            title: c.title,
            iconKey: c.iconKey,
          })),
          estimatedImpact: {
            reach: estimatedReach,
            spendAed: estimatedSpendAed,
            projectedOrders,
          },
        },
        expiresAt,
      },
    });

    for (const childParams of children) {
      await tx.draftAction.create({
        data: {
          restaurantId,
          ownerUserId: ownerUser.id,
          parentDraftId: p.id,
          kind: childParams.kind ?? DraftActionKind.single,
          actionType: childParams.actionType,
          source: childParams.source,
          title: childParams.title,
          subtitle: childParams.subtitle ?? null,
          iconKey: childParams.iconKey ?? null,
          affectedSurface: childParams.affectedSurface ?? null,
          payload: childParams.payload,
          preview: childParams.preview,
          childCount: childParams.childCount ?? 0,
          expiresAt,
        },
      });
    }

    return p;
  });

  return {
    content: JSON.stringify({
      preview: true,
      themeOfWeek,
      bundleChildCount: children.length,
      estimatedImpact: {
        reach: estimatedReach,
        spendAed: estimatedSpendAed,
        projectedOrders,
      },
      draftId: parent.id,
      inboxNotice: "Bundle drafted in the Sous Chef Inbox — Ship all to fire every child at once.",
    }),
    draftId: parent.id,
  };
}

// ── draft_review_replies ──────────────────────────────────────────
//
// Pulls recent Google reviews (throttled), reads unanswered ones, asks
// Claude to draft one reply per review, persists a bulk DraftAction. The
// shipper (shipReviewReply) writes draftReply + flips status to
// draft_approved per GbpReview row — it does NOT post back to Google.
// The inbox card carries a "Copy reply" affordance and the owner pastes
// each reply into their own GBP. When GBP API OAuth integration lands
// later, the shipper switches to auto-post and the copy step disappears.

async function execDraftReviewReplies(
  restaurantId: string,
  clerkId: string,
  input: Input
): Promise<ToolResult> {
  const force = Boolean(input.force_refresh);
  const limit = Math.min(Math.max(Number(input.limit ?? 8), 1), 15);

  // Pull fresh reviews (or honor the 6h throttle). Errors here surface to
  // the owner — likely missing GBP placeId, which the message hints at.
  let pullResult;
  try {
    pullResult = await pullGoogleReviews(restaurantId, { force });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Apify pull failed";
    return {
      content: JSON.stringify({
        error: `Couldn't refresh reviews from Google: ${message}. You can still draft replies for already-pulled reviews.`,
      }),
    };
  }

  if (pullResult.status === "no_connection") {
    return {
      content: JSON.stringify({
        error:
          "Google Business Profile isn't connected for this restaurant. Connect it in /dashboard/google first.",
      }),
    };
  }
  if (pullResult.status === "no_place_id") {
    return {
      content: JSON.stringify({
        error:
          "We couldn't find your place on Google Maps. Add a place ID in /dashboard/google to enable review pulling.",
      }),
    };
  }

  const reviews = await listUnansweredReviews(restaurantId, { limit });
  if (reviews.length === 0) {
    return {
      content: JSON.stringify({
        message:
          pullResult.status === "throttled"
            ? "No unanswered reviews right now (cached data; ask again with force_refresh:true to pull fresh)."
            : "No unanswered reviews — every recent review already has a reply or has been dismissed.",
        pullStatus: pullResult.status,
        newReviews: pullResult.newReviews,
      }),
    };
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true, cuisineType: true, location: true },
  });
  if (!restaurant) {
    return { content: JSON.stringify({ error: "Restaurant not found" }) };
  }

  const draftResult = await draftReplies(restaurant, reviews);
  // Bookkeeping: log under its own category so review-reply spend doesn't
  // erode the owner's monthly description_enhance allotment.
  await logAiUsage(
    restaurantId,
    "review_reply_draft",
    draftResult.tokensIn,
    draftResult.tokensOut
  );

  // Mark each review as draft_pending so a parallel chat session doesn't
  // re-draft the same row. Owner approval (shipReviewReply) flips to
  // draft_approved; rejection should flip back to unanswered — done via the
  // rejectDraft path catching review_reply specifically.
  const draftedReviewIds = draftResult.drafts.map((d) => d.reviewId);
  await prisma.gbpReview.updateMany({
    where: { id: { in: draftedReviewIds }, restaurantId, status: "unanswered" },
    data: { status: "draft_pending", draftedAt: new Date() },
  });

  const reviewById = new Map(reviews.map((r) => [r.id, r]));
  const items = draftResult.drafts.map((d) => {
    const review = reviewById.get(d.reviewId);
    return {
      reviewId: d.reviewId,
      reply: d.reply,
      reviewerName: review?.reviewerName ?? "Unknown",
      rating: review?.rating ?? 0,
      reviewText: review?.text ?? "",
      publishedAt: review?.publishedAt?.toISOString() ?? null,
    };
  });

  const draft = await createDraft(restaurantId, clerkId, {
    kind: DraftActionKind.bulk,
    actionType: "review_reply",
    source: DraftActionSource.chat,
    title: `${items.length} review repl${items.length === 1 ? "y" : "ies"} drafted`,
    subtitle: summariseReviewBatch(items),
    iconKey: "review",
    affectedSurface: "/dashboard/google",
    childCount: items.length,
    payload: {
      items: items.map(({ reviewId, reply }) => ({ reviewId, reply })),
    },
    preview: { items },
  });

  return {
    content: JSON.stringify({
      preview: true,
      count: items.length,
      pulledFromGoogle: pullResult.newReviews,
      draftId: draft.id,
      inboxNotice:
        "Drafted in the Sous Chef Inbox — approve to mark replies ready, then copy each one into Google.",
    }),
    draftId: draft.id,
  };
}

function summariseReviewBatch(
  items: Array<{ rating: number; reviewerName: string }>
): string {
  const fiveStars = items.filter((i) => i.rating === 5).length;
  const lowStars = items.filter((i) => i.rating <= 2).length;
  const parts: string[] = [];
  if (fiveStars) parts.push(`${fiveStars}× 5★`);
  if (lowStars) parts.push(`${lowStars}× ≤2★`);
  const head = items
    .slice(0, 2)
    .map((i) => i.reviewerName.split(/\s+/)[0])
    .join(", ");
  return [parts.join(" · "), head ? `from ${head}${items.length > 2 ? ` +${items.length - 2}` : ""}` : null]
    .filter(Boolean)
    .join(" · ");
}
