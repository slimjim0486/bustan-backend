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
      "Create a new promotion (discounted item, deal, or combo) with optional AI-generated copy.",
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
        promo_price: { type: "number" },
        starts_at: { type: "string", description: "ISO date string" },
        ends_at: { type: "string", description: "ISO date string" },
        use_ai_copy: { type: "boolean", description: "Generate AI copy for the promotion." },
        tone: { type: "string", enum: ["casual", "upscale", "playful", "formal"] },
        execute: { type: "boolean" },
        pending_action_id: { type: "string" },
      },
      required: ["type", "item_ids"],
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

      // Bustan platform KB
      case "get_bustan_info":
        return execGetBustanInfo(input);

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

    return {
      content: JSON.stringify({
        preview: true,
        item: item.name,
        currentDescription: item.description,
        suggestedDescription: result.description,
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

  return {
    content: JSON.stringify({
      preview: true,
      count,
      suggestions: Object.entries(result.suggestions).map(([id, desc]) => ({
        item: itemMap.get(id)?.name ?? id,
        current: itemMap.get(id)?.description ?? null,
        suggested: desc,
      })),
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

  return {
    content: JSON.stringify({
      preview: true,
      totalItems: previewSuggestions.length,
      totalTags,
      suggestions: previewSuggestions.map((s) => ({
        item: s.itemName,
        tags: s.tags.map((t) => `${t.label} (${Math.round(t.confidence * 100)}%)`),
      })),
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
    return { content: JSON.stringify({ error: "Menu item not found." }) };
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

  return {
    content: JSON.stringify({
      preview: true,
      item: item.name,
      section: item.section.name,
      changes: changes.map((c) => ({ field: c.label, from: c.before, to: c.after })),
    }),
    preview: {
      pendingActionId,
      description: `Update "${item.name}"`,
      changes,
    },
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

  return {
    content: JSON.stringify({
      preview: true,
      count: changes.length,
      changes: changes.map((c) => ({ item: c.label, updates: c.after })),
    }),
    preview: {
      pendingActionId,
      description: `Batch update ${changes.length} items`,
      changes,
    },
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

  if (items.length === 0) {
    return { content: JSON.stringify({ error: "No valid menu items found." }) };
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
          promoPrice: input.promo_price ? String(input.promo_price) : null,
          startsAt: input.starts_at ? String(input.starts_at) : null,
          endsAt: input.ends_at ? String(input.ends_at) : null,
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

  if (!title) title = `${String(input.type)} promotion`;

  const promoData = {
    type: String(input.type),
    title,
    subtitle,
    description,
    badgeLabel,
    terms,
    promoPrice: input.promo_price ? Number(input.promo_price) : null,
    startsAt: input.starts_at ? String(input.starts_at) : null,
    endsAt: input.ends_at ? String(input.ends_at) : null,
    itemIds,
  };

  const pendingActionId = createPendingAction(restaurantId, clerkId, "create_promotion", input, promoData);

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
        items: items.map((i) => i.name),
      },
    }),
    preview: {
      pendingActionId,
      description: `Create "${title}" promotion`,
      changes: [
        { label: "Title", before: null, after: title },
        ...(subtitle ? [{ label: "Subtitle", before: null, after: subtitle }] : []),
        { label: "Items", before: null, after: items.map((i) => i.name).join(", ") },
        ...(promoData.promoPrice
          ? [{ label: "Promo Price", before: null, after: formatPrice(promoData.promoPrice) }]
          : []),
      ],
    },
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

  const pendingActionId = createPendingAction(restaurantId, clerkId, "toggle_availability", input, null);

  return {
    content: JSON.stringify({
      preview: true,
      action: available ? "Mark available" : "Mark sold out",
      items: items.map((i) => ({
        name: i.name,
        currentStatus: i.isAvailable ? "Available" : "Sold out",
      })),
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

  return {
    content: JSON.stringify({
      preview: true,
      section: section.name,
      item: { name: input.name, price: formatPrice(Number(input.price)), description: input.description ?? null },
    }),
    preview: {
      pendingActionId,
      description: `Add "${input.name}" to ${section.name}`,
      changes: [
        { label: "Item", before: null, after: `${input.name} - ${formatPrice(Number(input.price))}` },
        { label: "Section", before: null, after: section.name },
      ],
    },
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

  return {
    content: JSON.stringify({ preview: true, sectionName: input.name }),
    preview: {
      pendingActionId,
      description: `Create section "${input.name}"`,
      changes: [{ label: "New Section", before: null, after: String(input.name) }],
    },
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

  return {
    content: JSON.stringify({
      preview: true,
      changes: changes.map((c) => ({ field: c.label, from: c.before, to: c.after })),
    }),
    preview: {
      pendingActionId,
      description: "Update restaurant profile",
      changes,
    },
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

  return {
    content: JSON.stringify({
      preview: true,
      action: publish ? "Publish" : "Unpublish",
      currentStatus: restaurant.isPublished ? "Published" : "Unpublished",
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
