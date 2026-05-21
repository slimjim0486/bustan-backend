// Internal types for the ad-studio-ai orchestrator (Phase 1).

import type { CountryCode, CuisineFit, FunnelStage, PlatformId, CampaignType } from "@/services/ad-studio";

export interface AdStudioBrief {
  restaurantId: string;
  // Campaign type drives platform mix, audience recipes, etc.
  campaignType: CampaignType;
  goal: FunnelStage;
  countries: CountryCode[];
  cuisines: CuisineFit[];
  targetPlatforms: PlatformId[];
  budgetTier: "lean" | "standard" | "aggressive";
  budgetAed: number;
  durationWeeks?: number;
  // Optional context to ground the creative
  primaryDishId?: string;
  primaryDishName?: string;
  primaryDishDescription?: string | null;
  primaryDishPrice?: number;
  primaryDishImageUrl?: string | null;
  primaryDishCurrency?: string;
  brandVoice?: string;
  // Slideshow-only: ordered list of dish IDs owner picked for frames.
  // Empty/omitted means full auto-pick. Static projects ignore this.
  featuredDishIds?: string[];
  // Owner-supplied free-text description when campaignType === "freeform".
  // The strategy pass hands this to Claude as the primary brief signal in
  // place of a KB campaign archetype.
  campaignBrief?: string;
}

export interface RestaurantBrandContext {
  restaurantId: string;
  name: string;
  cuisineType: string | null;
  description: string | null;
  location: string | null;
  address: string | null;
  whatsappNumber: string | null;
  phone: string | null;
  talabatUrl: string | null;
  deliverooUrl: string | null;
  uberEatsUrl: string | null;
}

export interface StrategyDecision {
  archetypeIds: string[];      // 3 KB archetype ids, ordered by fit
  hookIds: string[];           // 3 KB hook ids
  ctaIds: string[];            // 2 KB cta ids
  copyFrameworkId: string;     // 1 KB copy framework id
  // Per-archetype image directions — one entry per archetypeId so each variant
  // gets a visually distinct hero shot brief, not a shared "hero plate" default.
  imageDirections: Array<{ archetypeId: string; direction: string }>;
  // Dialect choice for the creative — derived from country + audience
  dialect: "khaleeji" | "egyptian" | "levantine" | "msa" | "arabizi" | "english" | "bilingual";
  // Reasoning trace (for audit / debug; never shown to end user)
  rationale: string;
}

export interface CopyVariant {
  variant: number;               // 1, 2, 3, ...
  archetypeId: string;
  hookId: string;
  ctaId: string;
  language: "en" | "ar" | "bilingual";
  headline: string;              // primary headline (English by default)
  primaryText: string;           // main body / caption
  ctaText: string;
  // Arabic mirror (only when bilingual or ar)
  headlineAr?: string;
  primaryTextAr?: string;
  ctaTextAr?: string;
}

export interface SafetyVerdict {
  verdict: "pass" | "fail" | "warn";
  // Human-readable flags + which rule from KB universalNoGoList tripped
  flags: Array<{
    severity: "error" | "warning";
    field: "headline" | "primaryText" | "ctaText" | "imagePrompt" | "compliance";
    rule: string;
    suggestedFix?: string;
  }>;
}

export type ImageProvider = "gemini" | "openai" | "menu_item";

export interface ImageGenResult {
  source: "menu_item" | "ai_generated";
  // Which model rendered the image (for billing display + UI badges).
  // "menu_item" when reusing an existing photo; the AI provider name
  // otherwise.
  provider: ImageProvider;
  url: string;
  // Cost in USD; 0 when reusing existing menu image
  costUsd: number;
  prompt?: string;
  // Reference to MenuItemImage if reused
  menuItemImageId?: string;
}

export interface VariantOutput {
  copy: CopyVariant;
  hero: ImageGenResult | null;
  imagePrompt: string | null;
  safetyFlags: SafetyVerdict["flags"];
}

export interface OrchestratorResult {
  strategy: StrategyDecision;
  variants: VariantOutput[];
  totalCostUsd: number;
  tokensIn: number;
  tokensOut: number;
}

// =============================================================================
// SABT PACK — Weekly 7-slot bundle types
// =============================================================================

/** The 7 platform/aspect-ratio slots a Sabt Pack produces. Slot order is
 *  authored (1..7) so the review surface renders predictably. */
export type SabtPackSlotFormat =
  | "slideshow_5_4_5"     // slot 1: 5×1080×1350 TikTok Photo Mode / IG Carousel
  | "ig_reel_still_9_16"  // slot 2: Reels cover / Stories
  | "ig_feed_4_5"         // slot 3: IG Feed post
  | "carousel_1_1"        // slot 4: IG Carousel cover / Snap
  | "gbp_1_91_1"          // slot 5: GBP landscape image
  | "wa_status_9_16"      // slot 6: WhatsApp Status
  | "gbp_post_1_91_1";    // slot 7: GBP Post (text + image)

export interface WeeklySlotPlan {
  slot: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  format: SabtPackSlotFormat;
  archetypeId: string;
  hookId: string;
  ctaId: string;
  copyFrameworkId: string;
  language: "en" | "ar" | "bilingual";
  dialect: StrategyDecision["dialect"];
  /** Menu item ID to feature in this slot. The orchestrator passes this to
   *  the existing image-gen + image-prompt passes as the primary dish. */
  primaryDishId: string;
  /** 1-2 sentence shot brief consumed by runImagePromptPass. */
  imageDirection: string;
  /** Suggested post day, Mon..Sat ISO date. The owner sees this on the
   *  review surface as "Best to post Wed" — never auto-published. */
  scheduledFor: string;
  /** Optional KB calendar moment id (e.g. "ramadan_iftar", "uae_national_day")
   *  when this week intersects a high-impact event. */
  calendarMomentId?: string;
}

export interface WeeklyStrategyDecision {
  /** Sunday-of-the-week ISO date that this pack belongs to. */
  weekStartDate: string;
  /** 1-line cohesion theme so the 7 slots feel like a campaign, not 7 random
   *  posts. e.g. "First sunny weekend of May — outdoor lunch energy". */
  brandThemeOfWeek: string;
  slots: WeeklySlotPlan[];
  /** Default dialect when a slot doesn't override. English-first by default. */
  dialectDefault: StrategyDecision["dialect"];
  /** Reasoning trace for audit / debug; never shown to owner. */
  rationale: string;
}

