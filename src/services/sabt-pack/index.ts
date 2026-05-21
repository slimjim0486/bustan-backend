// Sabt Pack orchestrator — the end-to-end runner for one restaurant's weekly
// 7-post bundle. Mirrors the shape of `runAdStudioGeneration()` but with the
// authored 7-slot mix and a single weekly-strategy pass instead of 7 isolated
// strategy passes.
//
// Called from:
//   - `backend/src/queue/sabt-pack.ts` (Sunday cron)
//   - `backend/scripts/sabt-pack-trigger.ts` (admin / local testing)
//   - `POST /api/sabt-pack/trigger` (admin route, optional)
//
// Idempotency: every restaurant has at most one Sabt Pack per `weekStartDate`,
// enforced by the unique (restaurant_id, sabt_pack_week_start_date) index on
// ad_projects. A re-run for the same week exits early as long as the existing
// row is in a terminal-ish state (ready / delivered / approved).

import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { generateHeroImage } from "@/services/ad-studio-ai/image-gen";
import {
  runCopyPass,
  runImagePromptPass,
  type UsageTotals,
} from "@/services/ad-studio-ai/claude-orchestrator";
import {
  runWeeklyStrategyPass,
  SABT_PACK_SLOT_FIXTURES,
  type WeeklyStrategyMenuItem,
} from "@/services/ad-studio-ai/weekly-strategy";
import { buildSlideshowFrames } from "@/services/ad-studio-ai/slideshow-compositor";
import {
  pickSlideshowDishes,
  SLIDESHOW_FRAME_COUNT,
} from "@/services/ad-studio-ai/slideshow-dish-picker";
import type {
  AdStudioBrief,
  CopyVariant,
  ImageGenResult,
  RestaurantBrandContext,
  StrategyDecision,
  WeeklySlotPlan,
  WeeklyStrategyDecision,
} from "@/services/ad-studio-ai/types";
import { kbMeta } from "@/services/ad-studio";
import type { CountryCode, CuisineFit, PlatformId } from "@/services/ad-studio/types";

const MENU_ITEMS_FOR_PLANNING = 20;
const MIN_SLOTS_FOR_READY = 5;
const SLIDESHOW_FALLBACK_HEADLINE = "This week at our table.";

/** Realistic per-image cost estimate. Gemini is $0.04 (the default provider);
 *  a 25% buffer covers occasional retries. The previous $0.20 figure assumed
 *  OpenAI fallback on every slot, which was wildly over-pessimistic and made
 *  the projection trip on slot 1 regardless of the cap. Real OpenAI fallback
 *  runs are caught by the hard per-slot ceiling check below. */
const PER_IMAGE_PROJECTION_USD = 0.05;

/** Absolute floor on the per-project cap. Even if entitlements ever set the
 *  cap to something pathological (e.g. $50), this circuit-breaker prevents a
 *  runaway weekly job from torching margins. Pro revenue is ~$80/mo so a
 *  single weekly run should never approach $1. */
const ABSOLUTE_PROJECT_CEILING_USD = 1.0;

const FUNCTION_TAG = "[sabt-pack]";

export interface RunSabtPackArgs {
  restaurantId: string;
  /** ISO date for Sunday of the target week (e.g. "2026-05-17"). The caller
   *  is responsible for picking the right Sunday; this function does not
   *  re-compute "current week" so dry-run and cron paths agree. */
  weekStartDate: string;
}

export interface RunSabtPackResult {
  adProjectId: string;
  status: "ready" | "partial" | "failed" | "skipped";
  slotsPersisted: number;
  totalCostUsd: number;
  themeOfWeek: string | null;
  /** True when the caller should send the owner notification (email today;
   *  the channel is the worker's choice, not the orchestrator's). False on
   *  partial/failed and when the project was already delivered/approved. */
  shouldNotifyOwner: boolean;
}

/** Quick guard: a Sabt Pack only ships for Pro/Portfolio restaurants with the
 *  feature toggled on. The fanout query also filters on this; the orchestrator
 *  re-checks belt-and-suspenders so the admin/test trigger endpoint can't
 *  bypass the gate.
 *
 *  Accepts either a cuid `id` or a `slug` (e.g. "zaytoun-kitchen") so manual
 *  triggers from the CLI / admin route are owner-friendly. The canonical id
 *  is what gets returned and used downstream for every DB write. */
async function loadEligibleRestaurant(idOrSlug: string) {
  const restaurant = await prisma.restaurant.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: {
      subscription: true,
      operatorAccount: {
        include: {
          _count: { select: { brands: true } },
        },
      },
    },
  });
  if (!restaurant) return null;
  if (!restaurant.sabtPackEnabled) return { restaurant, eligible: false as const };

  const entitlements = getRestaurantEntitlements(restaurant);
  if (!entitlements.sabtPackEnabled) {
    return { restaurant, eligible: false as const };
  }
  return { restaurant, entitlements, eligible: true as const };
}

async function loadBrandContext(restaurantId: string): Promise<RestaurantBrandContext> {
  const restaurant = await prisma.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
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
  return {
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
}

async function loadMenuItemsForPlanning(
  restaurantId: string
): Promise<WeeklyStrategyMenuItem[]> {
  const items = await prisma.menuItem.findMany({
    where: { restaurantId, isAvailable: true },
    select: {
      id: true,
      name: true,
      description: true,
      price: true,
      imageStatus: true,
    },
    orderBy: [{ price: "desc" }, { displayOrder: "asc" }],
    take: MENU_ITEMS_FOR_PLANNING,
  });
  return items.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    priceAed: Number(m.price),
    hasReadyImage: m.imageStatus === "ready" || m.imageStatus === "generated",
  }));
}

/** Synthesize a single-archetype strategy from a Sabt Pack slot so the
 *  existing runCopyPass / runImagePromptPass can be called unchanged. */
function strategyFromSlot(slot: WeeklySlotPlan): StrategyDecision {
  return {
    archetypeIds: [slot.archetypeId],
    hookIds: [slot.hookId],
    ctaIds: [slot.ctaId],
    copyFrameworkId: slot.copyFrameworkId,
    imageDirections: [
      { archetypeId: slot.archetypeId, direction: slot.imageDirection },
    ],
    dialect: slot.dialect,
    rationale: `Sabt Pack slot ${slot.slot}`,
  };
}

/** Synthesize an AdStudioBrief for a single slot. Most fields are minimal /
 *  inherited from the Sabt Pack defaults — the brief is only used as prompt
 *  context for runCopyPass and runImagePromptPass. */
function briefForSlot(args: {
  restaurantId: string;
  slot: WeeklySlotPlan;
  primaryDish: { id: string; name: string; priceAed: number; description: string | null } | null;
  countries: CountryCode[];
  brandVoice?: string | null;
}): AdStudioBrief {
  // Map Sabt Pack slot format to an existing PlatformId so the downstream
  // prompts have an honest platform value. GBP doesn't have a dedicated
  // PlatformId yet, so map to google_pmax (Discovery/Performance Max also
  // surfaces in the GBP photo grid). This is prompt-context only — never
  // used to launch a real GBP campaign.
  const slotPlatform: PlatformId =
    args.slot.format === "wa_status_9_16"
      ? "whatsapp_status"
      : args.slot.format === "gbp_post_1_91_1" || args.slot.format === "gbp_1_91_1"
        ? "google_pmax"
        : args.slot.format === "ig_feed_4_5"
          ? "meta_feed"
          : args.slot.format === "carousel_1_1"
            ? "meta_carousel"
            : args.slot.format === "ig_reel_still_9_16"
              ? "meta_reels"
              : "tiktok_in_feed";
  return {
    restaurantId: args.restaurantId,
    campaignType: "sabt_pack",
    goal: "tofu",
    countries: args.countries,
    cuisines: ["all"] as CuisineFit[],
    targetPlatforms: [slotPlatform],
    budgetTier: "lean",
    budgetAed: 0,
    primaryDishId: args.primaryDish?.id,
    primaryDishName: args.primaryDish?.name,
    primaryDishDescription: args.primaryDish?.description,
    primaryDishPrice: args.primaryDish?.priceAed,
    primaryDishCurrency: "AED",
    brandVoice: args.brandVoice ?? undefined,
  };
}

interface SlotOutput {
  slot: WeeklySlotPlan;
  copy: CopyVariant | null;
  imagePrompt: string | null;
  hero: ImageGenResult | null;
  slideshowFrames: string[] | null;
  costUsd: number;
  reason?: string;
}

async function runSlot(args: {
  brand: RestaurantBrandContext;
  countries: CountryCode[];
  brandVoice: string | null;
  menuById: Map<string, WeeklyStrategyMenuItem>;
  slot: WeeklySlotPlan;
  /** When true, force menu-photo reuse for this slot (budget brake). */
  forceReuseMenuPhoto: boolean;
  totals: UsageTotals;
  restaurantId: string;
}): Promise<SlotOutput> {
  const dish = args.menuById.get(args.slot.primaryDishId) ?? null;
  const strategy = strategyFromSlot(args.slot);
  const brief = briefForSlot({
    restaurantId: args.restaurantId,
    slot: args.slot,
    primaryDish: dish
      ? {
          id: dish.id,
          name: dish.name,
          priceAed: dish.priceAed,
          description: dish.description ?? null,
        }
      : null,
    countries: args.countries,
    brandVoice: args.brandVoice,
  });

  let copy: CopyVariant | null = null;
  let imagePrompt: string | null = null;
  let hero: ImageGenResult | null = null;
  let slideshowFrames: string[] | null = null;
  let reason: string | undefined;

  // Step 1: copy — one variant for this slot.
  try {
    const variants = await runCopyPass({
      brief,
      brand: args.brand,
      strategy,
      numberOfVariants: 1,
      totals: args.totals,
    });
    copy = variants[0] ?? null;
    if (copy) {
      // Force variant numbering = slot number for stable UX.
      copy.variant = args.slot.slot;
    }
  } catch (error) {
    reason = error instanceof Error ? `copy: ${error.message}` : "copy_failed";
    return {
      slot: args.slot,
      copy: null,
      imagePrompt: null,
      hero: null,
      slideshowFrames: null,
      costUsd: 0,
      reason,
    };
  }

  // Step 2: image prompt.
  try {
    imagePrompt = await runImagePromptPass({
      brief,
      brand: args.brand,
      strategy,
      variant: copy!,
      totals: args.totals,
    });
  } catch (error) {
    reason = error instanceof Error ? `image_prompt: ${error.message}` : "image_prompt_failed";
    // Copy survives; image fails downstream.
  }

  // Step 3: hero image.
  if (imagePrompt && dish) {
    try {
      hero = await generateHeroImage({
        restaurantId: args.restaurantId,
        primaryDishId: dish.id,
        primaryDishName: dish.name,
        prompt: imagePrompt,
        // Mix policy:
        // - Slot 1 (slideshow) always reuses menu photo as the *base* image
        //   (slideshow frames are built separately from menu photos).
        // - Other slots prefer AI generation for visual variety, unless the
        //   per-restaurant cost cap has been tripped.
        reuseMenuItemImage: args.forceReuseMenuPhoto || args.slot.slot === 1,
      });
    } catch (error) {
      reason = error instanceof Error ? `image: ${error.message}` : "image_failed";
    }
  } else if (!dish) {
    reason = reason ?? "missing_menu_item";
  }

  // Step 4: slideshow frames (slot 1 only).
  if (args.slot.slot === 1) {
    try {
      const dishIds = await pickSlideshowDishes({
        restaurantId: args.restaurantId,
        preferDishIds: args.slot.primaryDishId ? [args.slot.primaryDishId] : [],
      });
      if (dishIds.length < SLIDESHOW_FRAME_COUNT) {
        reason = reason ?? `slideshow_only_${dishIds.length}_ready_dishes`;
      } else {
        const headline = copy?.headline ?? SLIDESHOW_FALLBACK_HEADLINE;
        const composed = await buildSlideshowFrames({
          restaurantId: args.restaurantId,
          frames: dishIds.map((id) => ({ menuItemId: id, headline })),
        });
        if (composed.fullSlideshow) {
          slideshowFrames = composed.frameUrls;
        } else {
          reason = reason ?? "slideshow_compose_partial";
        }
      }
    } catch (error) {
      reason = error instanceof Error ? `slideshow: ${error.message}` : "slideshow_failed";
    }
  }

  return {
    slot: args.slot,
    copy,
    imagePrompt,
    hero,
    slideshowFrames,
    costUsd: hero?.costUsd ?? 0,
    reason,
  };
}

function projectedCostExceedsCap(
  spentUsd: number,
  perSlotCost: number,
  slotsRemaining: number,
  capUsd: number
): boolean {
  return spentUsd + perSlotCost * slotsRemaining > capUsd;
}

function slotFormatToString(slot: WeeklySlotPlan): string {
  return slot.format;
}

function safetyFlagsJson(flags: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(flags)) as Prisma.InputJsonValue;
}

export async function runSabtPackGeneration(
  args: RunSabtPackArgs
): Promise<RunSabtPackResult> {
  const { restaurantId: restaurantIdOrSlug, weekStartDate } = args;
  const weekDate = new Date(`${weekStartDate}T00:00:00Z`);

  // Eligibility — Pro/Portfolio + sabtPackEnabled.
  // loadEligibleRestaurant accepts either a cuid id or a slug (e.g. for
  // manual CLI / admin triggers). After this point, `restaurantId` always
  // refers to the canonical cuid — downstream queries must use that, not
  // the original input.
  const eligibility = await loadEligibleRestaurant(restaurantIdOrSlug);
  if (!eligibility) {
    throw new ApiError(`Restaurant not found: ${restaurantIdOrSlug}`, 404);
  }
  const restaurantId = eligibility.restaurant.id;
  if (!eligibility.eligible) {
    console.log(
      `${FUNCTION_TAG} ${restaurantId} ineligible (toggle off or no Pro/Portfolio subscription)`
    );
    return {
      adProjectId: "",
      status: "skipped",
      slotsPersisted: 0,
      totalCostUsd: 0,
      themeOfWeek: null,
      shouldNotifyOwner: false,
    };
  }
  const capUsd = eligibility.entitlements.sabtPackMaxCostUsdPerWeek;

  // Idempotency claim. If the row already exists with a "done" status, exit.
  const brand = await loadBrandContext(restaurantId);
  const menuItems = await loadMenuItemsForPlanning(restaurantId);
  if (menuItems.length === 0) {
    throw new ApiError(
      `Cannot generate Sabt Pack for ${restaurantId}: no available menu items`,
      400
    );
  }

  // Idempotency + retry policy, atomic.
  //
  // The unique index on (restaurant_id, sabt_pack_week_start_date) is the
  // serialization point. We must perform the existence check, the retry
  // policy decision, and the placeholder create inside a single transaction —
  // otherwise two workers (pg-boss batchSize=4 + admin trigger) can both pass
  // findUnique, both delete, then race on create. The previous implementation
  // had that race.
  //
  // Retry policy:
  //   - ready / delivered / approved → no-op (already done).
  //   - failed → wipe and rebuild. Generation never completed; nothing to lose.
  //   - partial → preserve. The owner can already review + edit the slots that
  //     did succeed. Wiping would destroy their work.
  //   - generating → in-flight. Don't touch.
  //   - queued → never persisted (we don't write `queued`); guard anyway.
  const claim = await prisma.$transaction(async (tx) => {
    const existing = await tx.adProject.findUnique({
      where: {
        uniq_sabt_pack_per_week: {
          restaurantId,
          sabtPackWeekStartDate: weekDate,
        },
      },
      select: {
        id: true,
        sabtPackStatus: true,
        creatives: {
          select: { id: true, isEdited: true },
        },
      },
    });

    if (existing) {
      const status = existing.sabtPackStatus;
      if (status === "ready" || status === "delivered" || status === "approved") {
        return { kind: "skip" as const, adProjectId: existing.id, status };
      }
      if (status === "generating") {
        return { kind: "skip" as const, adProjectId: existing.id, status };
      }
      if (status === "partial") {
        const hasEdits = existing.creatives.some((c) => c.isEdited);
        if (hasEdits) {
          // The owner already touched the partial pack. Never destroy edits.
          return { kind: "skip" as const, adProjectId: existing.id, status };
        }
        // Partial AND untouched — wipe and rebuild so the owner gets a fuller
        // pack on the next attempt.
        await tx.adProject.delete({ where: { id: existing.id } });
      } else if (status === "failed") {
        await tx.adProject.delete({ where: { id: existing.id } });
      } else {
        // Unknown status (queued, null) — treat as recoverable.
        await tx.adProject.delete({ where: { id: existing.id } });
      }
    }

    const adProject = await tx.adProject.create({
      data: {
        restaurantId,
        name: `Sabt Pack — week of ${weekStartDate}`,
        campaignType: "sabt_pack",
        goal: "tofu",
        countries: ["AE"],
        cuisines: ["all"],
        targetPlatforms: ["meta_feed", "tiktok_in_feed", "google_pmax"],
        budgetTier: "lean",
        budgetAed: 0,
        status: "generating",
        generationPhase: "strategy",
        sabtPackWeekStartDate: weekDate,
        sabtPackStatus: "generating",
        kbVersionAtGen: kbMeta.version,
        briefJson: {
          weekStartDate,
          menuItemsConsidered: menuItems.length,
          capUsd,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { kind: "claimed" as const, adProjectId: adProject.id };
  }, { isolationLevel: "Serializable" }).catch((error) => {
    // P2002 means the row was created concurrently between findUnique and
    // create — treat as a benign skip; the other worker owns the run.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      console.log(`${FUNCTION_TAG} ${restaurantId} ${weekStartDate} claimed by another worker`);
      return { kind: "skip" as const, adProjectId: "", status: null };
    }
    throw error;
  });

  if (claim.kind === "skip") {
    if (claim.adProjectId && claim.status) {
      console.log(
        `${FUNCTION_TAG} ${restaurantId} ${weekStartDate} already ${claim.status}; skipping`
      );
    }
    // "ready" means the pack was generated but the email hasn't been
    // confirmed sent yet (transient Resend failure, missing creds at the
    // time, etc.). Allow the worker to retry the notification on a re-run.
    // "delivered" / "approved" / "generating" never re-fire — those are
    // either truly done or in-flight by another worker.
    const shouldRetryNotify = claim.status === "ready";
    return {
      adProjectId: claim.adProjectId,
      status: "skipped",
      slotsPersisted: 0,
      totalCostUsd: 0,
      themeOfWeek: null,
      shouldNotifyOwner: shouldRetryNotify,
    };
  }

  const adProject = { id: claim.adProjectId };

  const totals: UsageTotals = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

  // ===========================================================================
  // Pass 1 — weekly strategy
  // ===========================================================================
  let decision: WeeklyStrategyDecision;
  try {
    decision = await runWeeklyStrategyPass({
      brand,
      weekStartDate,
      country: "AE",
      menuItems,
      totals,
    });
  } catch (error) {
    await prisma.adProject.update({
      where: { id: adProject.id },
      data: {
        sabtPackStatus: "failed",
        status: "failed",
        lastError: error instanceof Error ? error.message : "strategy_failed",
        generationCostUsd: totals.costUsd,
      },
    });
    throw error;
  }

  // ===========================================================================
  // Pass 2 — per-slot copy + image, in parallel
  // ===========================================================================
  await prisma.adProject.update({
    where: { id: adProject.id },
    data: { generationPhase: "copy" },
  });

  // Sequential per-slot to keep cost tracking + budget brake honest. Parallel
  // would be ~3x faster but the cost cap check would race.
  const menuById = new Map(menuItems.map((m) => [m.id, m]));
  const slotResults: SlotOutput[] = [];
  // Effective cap = min(per-restaurant entitlement, absolute circuit-breaker).
  // A misconfigured entitlement cannot waive the absolute ceiling.
  const effectiveCapUsd = Math.min(capUsd, ABSOLUTE_PROJECT_CEILING_USD);

  // Cost accounting:
  //   totals.costUsd — Claude tokens, mutated in-place by the orchestrator helpers.
  //   imageCostAccrued — image-gen $$, accumulated by the loop.
  //   Sum is the running total; checked before each slot.
  let imageCostAccrued = 0;

  for (let i = 0; i < decision.slots.length; i++) {
    const slot = decision.slots[i];
    const slotsRemaining = decision.slots.length - i;
    const spentUsd = totals.costUsd + imageCostAccrued;
    const force = projectedCostExceedsCap(
      spentUsd,
      PER_IMAGE_PROJECTION_USD,
      slotsRemaining,
      effectiveCapUsd
    );
    if (force) {
      console.log(
        `${FUNCTION_TAG} ${restaurantId} forcing menu-photo reuse from slot ${slot.slot} (spent=$${spentUsd.toFixed(
          3
        )}, cap=$${effectiveCapUsd})`
      );
    }
    const out = await runSlot({
      brand,
      countries: ["AE"],
      brandVoice: null,
      menuById,
      slot,
      forceReuseMenuPhoto: force,
      totals,
      restaurantId,
    });
    imageCostAccrued += out.costUsd;
    slotResults.push(out);

    // Hard circuit-breaker: if any slot's actual cost pushed us over the
    // absolute ceiling, stop the loop entirely. Better to ship a partial
    // pack than torch margin.
    const totalSoFar = totals.costUsd + imageCostAccrued;
    if (totalSoFar >= ABSOLUTE_PROJECT_CEILING_USD) {
      console.warn(
        `${FUNCTION_TAG} ${restaurantId} hit absolute ceiling $${ABSOLUTE_PROJECT_CEILING_USD} ` +
          `at slot ${slot.slot} (totalSoFar=$${totalSoFar.toFixed(3)}); stopping`
      );
      break;
    }
  }

  // ===========================================================================
  // Persist creatives
  // ===========================================================================
  await prisma.adProject.update({
    where: { id: adProject.id },
    data: { generationPhase: "images" },
  });

  let slotsPersisted = 0;
  for (const result of slotResults) {
    if (!result.copy) continue;
    await prisma.adCreative.create({
      data: {
        projectId: adProject.id,
        variant: result.slot.slot,
        archetypeId: result.slot.archetypeId,
        hookId: result.slot.hookId,
        ctaId: result.slot.ctaId,
        copyFrameworkId: result.slot.copyFrameworkId,
        language: result.copy.language,
        headline: result.copy.headline,
        primaryText: result.copy.primaryText,
        ctaText: result.copy.ctaText,
        headlineAr: result.copy.headlineAr ?? null,
        primaryTextAr: result.copy.primaryTextAr ?? null,
        ctaTextAr: result.copy.ctaTextAr ?? null,
        heroImageUrl: result.hero?.url ?? null,
        heroImagePrompt: result.imagePrompt,
        heroImageSourceMenuItemId: result.hero?.menuItemImageId ?? null,
        imageProvider: result.hero?.provider ?? null,
        status: result.hero ? "ready" : "failed",
        safetyFlags: result.reason
          ? safetyFlagsJson([{ severity: "warning", rule: result.reason }])
          : undefined,
        generationCostUsd: result.costUsd,
        sabtPackSlot: result.slot.slot,
        sabtPackSlotFormat: slotFormatToString(result.slot),
        sabtPackSlideshowFrames: result.slideshowFrames
          ? (result.slideshowFrames as unknown as Prisma.InputJsonValue)
          : undefined,
        gbpPostBody: result.slot.slot === 7 ? result.copy.primaryText : null,
        scheduledFor: new Date(`${result.slot.scheduledFor}T00:00:00Z`),
      },
    });
    slotsPersisted += 1;
  }

  // ===========================================================================
  // Finalize project status
  // ===========================================================================
  const totalCostUsd = totals.costUsd + imageCostAccrued;
  const finalStatus: "ready" | "partial" | "failed" =
    slotsPersisted >= SABT_PACK_SLOT_FIXTURES.length
      ? "ready"
      : slotsPersisted >= MIN_SLOTS_FOR_READY
        ? "partial"
        : "failed";

  await prisma.adProject.update({
    where: { id: adProject.id },
    data: {
      sabtPackStatus: finalStatus,
      sabtPackThemeOfWeek: decision.brandThemeOfWeek,
      status: finalStatus === "failed" ? "failed" : "ready",
      generationPhase: null,
      generationCostUsd: totalCostUsd,
      lastError:
        finalStatus === "failed"
          ? `Only ${slotsPersisted}/7 slots succeeded`
          : null,
    },
  });

  console.log(
    `${FUNCTION_TAG} ${restaurantId} ${weekStartDate} ${finalStatus} ` +
      `slots=${slotsPersisted}/7 costUsd=${totalCostUsd.toFixed(4)}`
  );

  return {
    adProjectId: adProject.id,
    status: finalStatus,
    slotsPersisted,
    totalCostUsd,
    themeOfWeek: decision.brandThemeOfWeek,
    shouldNotifyOwner: finalStatus === "ready",
  };
}

/** Returns the ISO date string ("YYYY-MM-DD") for the most-recent Sunday in
 *  the UAE local timezone. Used by the cron when no explicit week is given. */
export function sundayOfThisWeekUae(): string {
  // UAE is UTC+4 year-round. Build "now in Dubai", then walk back to Sunday.
  const dubaiNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
  // Day-of-week with Sunday = 0.
  const day = dubaiNow.getUTCDay();
  const sunday = new Date(dubaiNow.getTime() - day * 24 * 60 * 60 * 1000);
  return sunday.toISOString().slice(0, 10);
}
