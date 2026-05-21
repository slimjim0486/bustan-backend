// Ad-hoc TikTok Photo Mode / IG Carousel slideshow builder.
//
// Composes a single AdCreative row that holds a 5-frame slideshow built from
// the restaurant's existing menu photos, with on-image headlines generated
// by Claude. Reuses:
//   - pickSlideshowDishes()        → which 5 dishes
//   - generateSlideshowCaptions()  → on-image headlines + post body
//   - buildSlideshowFrames()       → sharp composite to R2
//
// Cost: ~$0.03/project (Claude only; image composite is free).

import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { campaignArchetypes } from "@/services/ad-studio";
import { buildSlideshowFrames } from "./slideshow-compositor";
import { generateSlideshowCaptions, type SlideshowCaptionsResult } from "./slideshow-captions";
import {
  pickSlideshowDishes,
  SLIDESHOW_FRAME_COUNT,
} from "./slideshow-dish-picker";
import type { UsageTotals } from "./claude-orchestrator";
import type { AdStudioBrief, RestaurantBrandContext } from "./types";

const SLIDESHOW_VARIANT_NUMBER = 1;
// Real KB ids — picked to match what TikTok Photo Mode actually optimizes
// for. "tell_me_without_telling" is the canonical curiosity-gap frame 1
// hook in the KB; "save_this_post" is the TikTok-native save-mechanic CTA
// the slideshow format leans on (saves > likes for slideshow ranking).
const SLIDESHOW_HOOK_ID = "tell_me_without_telling";
const SLIDESHOW_CTA_ID = "save_this_post";
const SLIDESHOW_COPY_FRAMEWORK_ID = "aida";

/** Countries where we generate Arabic mirrors for the post body + CTA.
 *  UAE stays English-only by default (expat-dominant); KSA/Kuwait/Bahrain/
 *  Oman/Qatar are Arabic-first markets. Owner can override later through
 *  the bilingual toggle (v1.1). */
const ARABIC_FIRST_COUNTRIES = new Set(["SA", "KW", "BH", "OM", "QA"]);

export interface RunSlideshowBuilderArgs {
  projectId: string;
  brief: AdStudioBrief;
  brand: RestaurantBrandContext;
}

export interface SlideshowBuilderResult {
  /** 5 R2 frame URLs in order. */
  frameUrls: string[];
  captions: SlideshowCaptionsResult;
  totalCostUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** archetype id we tagged the AdCreative with for downstream KB lookups. */
  archetypeId: string;
}

/** Resolve the default archetype for a campaign type by reading the KB.
 *  Falls back to "cheese_pull_money_shot" — the most universal food hero —
 *  which also covers the "freeform" campaign type (no KB entry by design). */
function defaultArchetypeForCampaign(campaignType: string): string {
  const campaign = campaignArchetypes.find((c) => c.id === campaignType);
  return campaign?.creativeMix?.[0]?.archetypeId ?? "cheese_pull_money_shot";
}

function isBilingual(brief: AdStudioBrief): boolean {
  return brief.countries.some((c) => ARABIC_FIRST_COUNTRIES.has(c));
}

async function loadDishesForCaptions(
  restaurantId: string,
  dishIds: string[]
): Promise<Array<{ id: string; name: string; description: string | null; price: number | null }>> {
  const items = await prisma.menuItem.findMany({
    where: { id: { in: dishIds }, restaurantId },
    select: { id: true, name: true, description: true, price: true },
  });
  // Preserve the order the picker returned (highest-priority dish in frame 1).
  const byId = new Map(items.map((i) => [i.id, i]));
  return dishIds
    .map((id) => byId.get(id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      price: d.price ? Number(d.price) : null,
    }));
}

/**
 * Build the slideshow end-to-end and write a single AdCreative row.
 *
 * Throws ApiError on:
 *  - <5 dishes with ready images (422)
 *  - Claude failure (502/503 from Claude client)
 *  - <5 frames successfully composited (502)
 *
 * Caller (worker) is responsible for flipping AdProject.status to "ready" /
 * "failed" and recording cost/tokens.
 */
export async function runSlideshowBuilder(
  args: RunSlideshowBuilderArgs
): Promise<SlideshowBuilderResult> {
  const totals: UsageTotals = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

  // Owner-picked dishes win frame ordering; primaryDishId is a fallback for
  // legacy briefs that only had the single-dish picker. Empty array means
  // full auto-pick.
  const ownerPicked = args.brief.featuredDishIds ?? [];
  const preferDishIds =
    ownerPicked.length > 0
      ? ownerPicked
      : args.brief.primaryDishId
        ? [args.brief.primaryDishId]
        : [];

  const dishIds = await pickSlideshowDishes({
    restaurantId: args.brief.restaurantId,
    preferDishIds,
  });

  if (dishIds.length < SLIDESHOW_FRAME_COUNT) {
    throw new ApiError(
      `Need at least ${SLIDESHOW_FRAME_COUNT} menu items with ready photos to build a slideshow (found ${dishIds.length}). Add more dish photos and try again.`,
      422
    );
  }

  const dishes = await loadDishesForCaptions(args.brief.restaurantId, dishIds);
  if (dishes.length < SLIDESHOW_FRAME_COUNT) {
    // Defensive — the picker only returns IDs that exist, but a race with a
    // simultaneous menu delete could trip this.
    throw new ApiError(
      `Menu items disappeared between picking and loading. Try again.`,
      409
    );
  }

  const captions = await generateSlideshowCaptions({
    brief: args.brief,
    brand: args.brand,
    dishes,
    bilingual: isBilingual(args.brief),
    totals,
  });

  const composed = await buildSlideshowFrames({
    restaurantId: args.brief.restaurantId,
    frames: dishes.map((d, i) => ({
      menuItemId: d.id,
      headline: captions.frames[i]?.headline ?? "",
    })),
  });

  if (!composed.fullSlideshow) {
    const failedReasons = composed.perFrame
      .filter((f) => !f.ok)
      .map((f) => `${f.menuItemId}: ${f.reason ?? "unknown"}`)
      .join("; ");
    throw new ApiError(
      `Slideshow composite produced only ${composed.frameUrls.length}/${SLIDESHOW_FRAME_COUNT} frames. ${failedReasons}`,
      502
    );
  }

  const archetypeId = defaultArchetypeForCampaign(args.brief.campaignType);

  // Stamp generated captions onto the project's briefJson._slideshow so the
  // swap-frame + regenerate-captions routes can rebuild individual frames
  // later without persisting another column. briefJson is a Json field on
  // AdProject; the underscored key marks orchestrator output (vs. the
  // frozen brief inputs the schema validates).
  const briefSnapshot = await prisma.adProject.findUnique({
    where: { id: args.projectId },
    select: { briefJson: true },
  });
  const slideshowState = {
    frames: dishes.map((d, i) => ({
      menuItemId: d.id,
      headline: captions.frames[i]?.headline ?? "",
      headlineAr: captions.frames[i]?.headlineAr ?? null,
      url: composed.frameUrls[i] ?? null,
    })),
    postBody: captions.postBody,
    postBodyAr: captions.postBodyAr ?? null,
    ctaText: captions.ctaText,
    ctaTextAr: captions.ctaTextAr ?? null,
    generatedAt: new Date().toISOString(),
  };
  const persistedBrief =
    briefSnapshot?.briefJson && typeof briefSnapshot.briefJson === "object" && !Array.isArray(briefSnapshot.briefJson)
      ? (briefSnapshot.briefJson as Record<string, unknown>)
      : {};
  await prisma.adProject.update({
    where: { id: args.projectId },
    data: {
      briefJson: {
        ...persistedBrief,
        _slideshow: slideshowState,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // Persist a single AdCreative variant with the frame URLs stored in the
  // legacy-named sabtPackSlideshowFrames JSON column (it's untyped JSON, so
  // re-using it for ad-hoc slideshows avoids a schema migration).
  await prisma.adCreative.upsert({
    where: {
      projectId_variant: {
        projectId: args.projectId,
        variant: SLIDESHOW_VARIANT_NUMBER,
      },
    },
    create: {
      projectId: args.projectId,
      variant: SLIDESHOW_VARIANT_NUMBER,
      archetypeId,
      hookId: SLIDESHOW_HOOK_ID,
      ctaId: SLIDESHOW_CTA_ID,
      copyFrameworkId: SLIDESHOW_COPY_FRAMEWORK_ID,
      language: isBilingual(args.brief) ? "bilingual" : "en",
      headline: captions.frames[0]?.headline ?? "Slideshow",
      primaryText: captions.postBody,
      ctaText: captions.ctaText,
      headlineAr: captions.frames[0]?.headlineAr ?? null,
      primaryTextAr: captions.postBodyAr ?? null,
      ctaTextAr: captions.ctaTextAr ?? null,
      heroImageUrl: composed.frameUrls[0] ?? null,
      heroImagePrompt: null,
      heroImageSourceMenuItemId: null,
      imageProvider: "menu_item",
      status: "ready",
      sabtPackSlideshowFrames: composed.frameUrls as unknown as Prisma.InputJsonValue,
      sabtPackSlotFormat: "slideshow_5_4_5",
      generationCostUsd: new Prisma.Decimal(totals.costUsd.toFixed(4)),
    },
    update: {
      archetypeId,
      hookId: SLIDESHOW_HOOK_ID,
      ctaId: SLIDESHOW_CTA_ID,
      copyFrameworkId: SLIDESHOW_COPY_FRAMEWORK_ID,
      language: isBilingual(args.brief) ? "bilingual" : "en",
      headline: captions.frames[0]?.headline ?? "Slideshow",
      primaryText: captions.postBody,
      ctaText: captions.ctaText,
      headlineAr: captions.frames[0]?.headlineAr ?? null,
      primaryTextAr: captions.postBodyAr ?? null,
      ctaTextAr: captions.ctaTextAr ?? null,
      heroImageUrl: composed.frameUrls[0] ?? null,
      imageProvider: "menu_item",
      status: "ready",
      sabtPackSlideshowFrames: composed.frameUrls as unknown as Prisma.InputJsonValue,
      sabtPackSlotFormat: "slideshow_5_4_5",
      generationCostUsd: new Prisma.Decimal(totals.costUsd.toFixed(4)),
    },
  });

  return {
    frameUrls: composed.frameUrls,
    captions,
    totalCostUsd: totals.costUsd,
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    archetypeId,
  };
}
