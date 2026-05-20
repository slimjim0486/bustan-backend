// Build / validate / hydrate the brief that drives generation.

import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  campaignArchetypes,
  countryRules,
  type CountryCode,
  type CuisineFit,
  type FunnelStage,
  type PlatformId,
  type CampaignType,
} from "@/services/ad-studio";
import type { AdStudioBrief, RestaurantBrandContext } from "./types";

// =============================================================================
// Brief schema (used both at API boundary and by the orchestrator)
// =============================================================================

const VALID_COUNTRY_CODES: CountryCode[] = ["AE", "SA", "QA", "KW", "BH", "OM", "EG", "JO", "LB"];
const VALID_FUNNEL_STAGES: FunnelStage[] = ["tofu", "mofu", "bofu", "retention"];
const VALID_BUDGET_TIERS = ["lean", "standard", "aggressive"] as const;
// Creative output format. "static_multi" is the legacy 6-hero-image path;
// "slideshow_tiktok" produces a single 5-frame 1080×1350 slideshow built
// from owner-uploaded menu photos. Switch is read by the worker.
export const CREATIVE_FORMATS = ["static_multi", "slideshow_tiktok"] as const;
export type CreativeFormat = (typeof CREATIVE_FORMATS)[number];

// Sanitize free-text inputs that flow into LLM prompts. Strip newlines and
// angle/bracket characters so a malicious owner can't break out of our
// XML-tagged data envelopes (see prompts.ts buildXmlSafe).
const safeFreeText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.replace(/[\r\n<>{}]/g, " ").replace(/\s+/g, " ").trim());

export const briefInputSchema = z
  .object({
    restaurantId: z.string().cuid(),
    name: safeFreeText(120).pipe(z.string().min(2)),
    campaignType: z.string().refine(
      (v) => campaignArchetypes.some((c) => c.id === v),
      { message: "Unknown campaign type — must be a KB CampaignType id" }
    ),
    goal: z.enum(["tofu", "mofu", "bofu", "retention"] as [FunnelStage, ...FunnelStage[]]),
    countries: z.array(z.enum(VALID_COUNTRY_CODES as [CountryCode, ...CountryCode[]])).min(1).max(4),
    cuisines: z.array(z.string().max(50)).min(1).max(4),
    targetPlatforms: z.array(z.string().max(50)).min(1).max(8),
    budgetTier: z.enum(VALID_BUDGET_TIERS),
    budgetAed: z.number().int().min(500).max(500000),
    durationWeeks: z.number().int().min(1).max(26).optional(),
    primaryDishId: z.string().cuid().optional(),
    brandVoice: safeFreeText(500).optional(),
    creativeFormat: z.enum(CREATIVE_FORMATS).optional().default("static_multi"),
  })
  .strict();

export type BriefInput = z.infer<typeof briefInputSchema>;

// =============================================================================
// Hydrate — turn raw brief into orchestrator brief by joining with restaurant + dish
// =============================================================================

export async function hydrateBrief(input: BriefInput): Promise<{
  brief: AdStudioBrief;
  brand: RestaurantBrandContext;
}> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: input.restaurantId },
    select: {
      id: true,
      name: true,
      cuisineType: true,
      description: true,
      location: true,
      address: true,
      whatsappNumber: true,
      phone: true,
      talabatUrl: true,
      deliverooUrl: true,
      uberEatsUrl: true,
    },
  });

  if (!restaurant) {
    throw new ApiError("Restaurant not found", 404);
  }

  const primaryDish = input.primaryDishId
    ? await getDishContext(input.primaryDishId, restaurant.id)
    : null;

  const brief: AdStudioBrief = {
    restaurantId: restaurant.id,
    campaignType: input.campaignType as CampaignType,
    goal: input.goal,
    countries: input.countries,
    cuisines: input.cuisines as CuisineFit[],
    targetPlatforms: input.targetPlatforms as PlatformId[],
    budgetTier: input.budgetTier,
    budgetAed: input.budgetAed,
    durationWeeks: input.durationWeeks,
    primaryDishId: input.primaryDishId,
    primaryDishName: primaryDish?.name,
    primaryDishDescription: primaryDish?.description,
    primaryDishPrice: primaryDish?.price,
    primaryDishImageUrl: primaryDish?.imageUrl,
    primaryDishCurrency: primaryDish?.currency,
    brandVoice: input.brandVoice,
  };

  const brand: RestaurantBrandContext = {
    restaurantId: restaurant.id,
    name: restaurant.name,
    cuisineType: restaurant.cuisineType,
    description: restaurant.description,
    location: restaurant.location,
    address: restaurant.address,
    whatsappNumber: restaurant.whatsappNumber,
    phone: restaurant.phone,
    talabatUrl: restaurant.talabatUrl,
    deliverooUrl: restaurant.deliverooUrl,
    uberEatsUrl: restaurant.uberEatsUrl,
  };

  return { brief, brand };
}

async function getDishContext(menuItemId: string, restaurantId: string) {
  const item = await prisma.menuItem.findFirst({
    where: { id: menuItemId, restaurantId },
    select: {
      id: true,
      name: true,
      description: true,
      price: true,
      currency: true,
      imageUrl: true,
    },
  });

  if (!item) return null;

  return {
    name: item.name,
    description: item.description,
    price: Number(item.price),
    currency: item.currency,
    imageUrl: item.imageUrl,
  };
}

// =============================================================================
// Country-aware budget validation
// =============================================================================

export function validateBudgetTierAgainstCampaign(input: BriefInput): void {
  const campaign = campaignArchetypes.find((c) => c.id === input.campaignType);
  if (!campaign) return; // Schema already validated existence

  const tierRange = campaign.budgetTiers[input.budgetTier];
  if (input.budgetAed < tierRange.minAed) {
    throw new ApiError(
      `Budget AED ${input.budgetAed} is below the ${input.budgetTier} tier floor (AED ${tierRange.minAed}) for ${campaign.name}.`,
      400
    );
  }
  // Soft-cap upper bound — not a hard error, just guidance.
}

// =============================================================================
// Country-aware platform validation (so we don't propose Snap to Lebanon)
// =============================================================================

export function getRecommendedPlatformsForCountries(countries: CountryCode[]): PlatformId[] {
  const set = new Set<PlatformId>();
  for (const country of countries) {
    const rules = countryRules.find((r) => r.country === country);
    if (!rules) continue;
    // Always-relevant
    set.add("meta_reels");
    set.add("meta_stories");
    set.add("meta_feed");
    set.add("meta_ctwa");
    set.add("tiktok_in_feed");
    // KSA-heavy → Snap
    if (country === "SA" || country === "QA" || country === "KW") {
      set.add("snapchat_snap_ad");
      set.add("snapchat_story_ad");
    }
    // Egypt/Levant → YouTube and Facebook
    if (country === "EG" || country === "JO" || country === "LB") {
      set.add("youtube_shorts");
    }
    // Premium / corporate Gulf → Google
    set.add("google_search");
  }
  return Array.from(set);
}
