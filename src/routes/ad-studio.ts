// Ad Creative Studio routes (Phase 1).
// All endpoints require auth. Project endpoints enforce tenant isolation via
// resolveRestaurantForUser + entitlement check (adStudioEnabled).

import { Hono, type Context } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { getRestaurantEntitlements, getAdStudioUpgradeMessage } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import {
  campaignArchetypes,
  calendarMoments,
  creativeArchetypes,
  hookTemplates,
  ctaPatterns,
  countryRules,
  audienceRecipes,
  type CountryCode,
} from "@/services/ad-studio";
import {
  briefInputSchema,
  validateBudgetTierAgainstCampaign,
  getRecommendedPlatformsForCountries,
  type BriefInput,
} from "@/services/ad-studio-ai";
import { randomBytes } from "node:crypto";
import { enqueueAdStudioGeneration, enqueueRegenImage } from "@/queue/ad-studio-jobs";
import { buildSlideshowFrames } from "@/services/ad-studio-ai/slideshow-compositor";
import { generateSlideshowCaptions } from "@/services/ad-studio-ai/slideshow-captions";
import { hydrateBrief } from "@/services/ad-studio-ai";
import { SLIDESHOW_FRAME_COUNT } from "@/services/ad-studio-ai/slideshow-dish-picker";
import { runEventStagerForRestaurantNow } from "@/queue/event-stager";
import { buildAndUploadBundle } from "@/services/ad-studio-ai/export-bundle";
import { buildMetaExport } from "@/services/ad-studio-meta-export";
import {
  deriveMetrics,
  summarizeCampaignInsights,
} from "@/services/ad-studio-insights/insights-engine";
import {
  buildAuthorizeUrl,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchAdsMetaUserId,
  fetchGrantedScopes,
  encryptMetaAdsToken,
  decryptMetaAdsToken,
  getTokenLastFour,
  listAdAccounts,
  syncLiveCampaignFromMeta,
} from "@/services/meta-ads-oauth";
import { env } from "@/lib/env";
import { checkAiLimit } from "@/lib/ai-usage";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  enforceGenerateRateLimit,
  enforceGlobalBudget,
  enforceImageRegenRateLimit,
  enforceOpenAiRegenRateLimit,
  enforceExportRateLimit,
  enforceReportMetricsRateLimit,
  enforceLinkCampaignRateLimit,
  enforceMetaApiRateLimit,
} from "@/services/ad-studio-ai/guards";

export const adStudioRoute = new Hono<{
  Variables: { auth: { clerkId: string; email: string | null; fullName: string | null } };
}>();
adStudioRoute.use("*", requireAuth);

// =============================================================================
// Helpers
// =============================================================================

async function loadRestaurantForUser(restaurantId: string, clerkId: string) {
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId, owner: { clerkId } },
    include: {
      subscription: true,
      operatorAccount: { include: { _count: { select: { brands: true } } } },
    },
  });
  if (!restaurant) {
    throw new ApiError("Restaurant not found", 404);
  }
  return restaurant;
}

async function loadProjectForUser(projectId: string, clerkId: string) {
  const project = await prisma.adProject.findFirst({
    where: { id: projectId, restaurant: { owner: { clerkId } } },
    include: {
      restaurant: {
        include: {
          subscription: true,
          operatorAccount: { include: { _count: { select: { brands: true } } } },
        },
      },
      creatives: { orderBy: { variant: "asc" } },
      exports: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!project) throw new ApiError("Project not found", 404);
  return project;
}

function ensureAdStudioEnabled(restaurant: Parameters<typeof getRestaurantEntitlements>[0]) {
  const ents = getRestaurantEntitlements(restaurant);
  if (!ents.adStudioEnabled) {
    throw new ApiError(getAdStudioUpgradeMessage(), 402);
  }
  return ents;
}

// =============================================================================
// KB read endpoints — for the wizard pickers
// =============================================================================

adStudioRoute.get("/kb/campaigns", async (c) => {
  return c.json({
    campaigns: campaignArchetypes.map((a) => ({
      id: a.id,
      name: a.name,
      goal: a.goal,
      duration: a.duration,
      budgetTiers: a.budgetTiers,
      platformMix: a.platformMix,
      benchmarks: a.benchmarks,
    })),
  });
});

adStudioRoute.get("/kb/archetypes", async (c) => {
  return c.json({
    archetypes: creativeArchetypes.map((a) => ({
      id: a.id,
      name: a.name,
      why: a.why,
      durationSec: a.durationSec,
      bestPlatforms: a.bestPlatforms,
      cuisineFits: a.cuisineFits,
      funnelStages: a.funnelStages,
    })),
  });
});

adStudioRoute.get("/kb/calendar", async (c) => {
  const country = c.req.query("country");
  const moments = country
    ? calendarMoments.filter((m) => m.countries.includes(country as CountryCode))
    : calendarMoments;

  return c.json({
    moments: moments.map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      dates: m.dates,
      countries: m.countries,
      spendPulse: m.spendPulse,
      creativeAngles: m.creativeAngles,
      doList: m.doList,
      doNotList: m.doNotList,
      channelMixHint: m.channelMixHint ?? null,
      budgetMultiplierVsBaseline: m.budgetMultiplierVsBaseline ?? null,
    })),
  });
});

adStudioRoute.get("/kb/recommend-platforms", async (c) => {
  const countries = (c.req.query("countries") ?? "").split(",").filter(Boolean) as CountryCode[];
  if (!countries.length) return c.json({ platforms: [] });
  return c.json({ platforms: getRecommendedPlatformsForCountries(countries) });
});

// =============================================================================
// Event calendar — staged drafts + autopilot trigger
// =============================================================================

/** List drafts that the daily event-stager cron auto-created for this restaurant.
 *  The calendar page joins these against moments to surface a "Draft ready"
 *  chip next to each matching moment card. */
adStudioRoute.get("/event-stager/drafts", async (c) => {
  try {
    const auth = c.var.auth;
    const restaurantId = c.req.query("restaurantId");
    if (!restaurantId) throw new ApiError("restaurantId is required", 400);
    const restaurant = await loadRestaurantForUser(restaurantId, auth.clerkId);
    ensureAdStudioEnabled(restaurant);

    // Show drafts whose moment hasn't fully ended yet — once the moment is
    // over the draft is historical and the calendar won't list its source row.
    const drafts = await prisma.adProject.findMany({
      where: {
        restaurantId: restaurant.id,
        sourceMomentId: { not: null },
      },
      orderBy: { sourceMomentStartsOn: "asc" },
      select: {
        id: true,
        status: true,
        sourceMomentId: true,
        sourceMomentYear: true,
        sourceMomentStartsOn: true,
        sourceMomentStagedAt: true,
        name: true,
      },
      take: 100,
    });

    return c.json({ drafts });
  } catch (error) {
    return errorResponse(c, error);
  }
});

/** Manual trigger — owner can force a stage-now pass without waiting for the
 *  04:00 UTC cron. Mirrors sabt-pack's admin trigger. Idempotent thanks to the
 *  unique key on (restaurant_id, source_moment_id, source_moment_year). */
adStudioRoute.post("/event-stager/run", async (c) => {
  try {
    const auth = c.var.auth;
    const body = await c.req.json().catch(() => ({}));
    const restaurantId = typeof body.restaurantId === "string" ? body.restaurantId : null;
    if (!restaurantId) throw new ApiError("restaurantId is required", 400);
    const restaurant = await loadRestaurantForUser(restaurantId, auth.clerkId);
    ensureAdStudioEnabled(restaurant);

    // Run inline so the owner sees results in the same request — for ~10
    // moments per restaurant this is well under any reasonable timeout.
    await runEventStagerForRestaurantNow(restaurant.id);

    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

/** Toggle the per-restaurant master switch. Default true on signup, so most
 *  owners never touch this — it exists for the rare operator who wants to
 *  drive briefs entirely manually. */
adStudioRoute.patch("/event-stager/settings", async (c) => {
  try {
    const auth = c.var.auth;
    const body = await c.req.json().catch(() => ({}));
    const restaurantId = typeof body.restaurantId === "string" ? body.restaurantId : null;
    const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
    if (!restaurantId || enabled === null) {
      throw new ApiError("restaurantId and enabled (boolean) are required", 400);
    }
    const restaurant = await loadRestaurantForUser(restaurantId, auth.clerkId);
    ensureAdStudioEnabled(restaurant);

    await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { eventCalendarEnabled: enabled },
    });

    return c.json({ ok: true, eventCalendarEnabled: enabled });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Project CRUD
// =============================================================================

adStudioRoute.get("/projects", async (c) => {
  try {
    const auth = c.var.auth;
    const restaurantId = c.req.query("restaurantId");
    if (!restaurantId) throw new ApiError("restaurantId is required", 400);

    const restaurant = await loadRestaurantForUser(restaurantId, auth.clerkId);
    const ents = ensureAdStudioEnabled(restaurant);

    const projects = await prisma.adProject.findMany({
      where: { restaurantId: restaurant.id },
      orderBy: { createdAt: "desc" },
      include: {
        creatives: { select: { id: true, variant: true, status: true, heroImageUrl: true }, orderBy: { variant: "asc" } },
      },
      take: 50,
    });

    return c.json({ projects, entitlements: ents });
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.post("/projects", async (c) => {
  try {
    const auth = c.var.auth;
    const body = await c.req.json();
    const parsed = briefInputSchema.parse(body);

    const restaurant = await loadRestaurantForUser(parsed.restaurantId, auth.clerkId);
    const ents = ensureAdStudioEnabled(restaurant);

    // Per-month quota check
    if (ents.adProjectMonthlyLimit !== null) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const created = await prisma.adProject.count({
        where: { restaurantId: restaurant.id, createdAt: { gte: monthStart } },
      });
      if (created >= ents.adProjectMonthlyLimit) {
        throw new ApiError(
          `You've reached this month's limit of ${ents.adProjectMonthlyLimit} projects. Upgrade or wait until next month.`,
          429
        );
      }
    }

    // Slideshow is organic and has no paid budget — owners aren't shown a
    // budget input, so skip the per-campaign tier validation. Free-form
    // campaigns have no KB archetype to validate against, so skip there too.
    // Static-multi non-freeform still enforces it.
    if (
      parsed.creativeFormat !== "slideshow_tiktok" &&
      parsed.campaignType !== "freeform"
    ) {
      validateBudgetTierAgainstCampaign(parsed);
    }

    // Slideshow owners may pick a planned post date — store it on the
    // existing startsOn column so the dashboard can show a "planned for
    // today" reminder without adding new schema.
    const startsOn = parsed.plannedPostDate ? new Date(parsed.plannedPostDate) : null;

    const project = await prisma.adProject.create({
      data: {
        restaurantId: restaurant.id,
        name: parsed.name,
        campaignType: parsed.campaignType,
        goal: parsed.goal,
        countries: parsed.countries,
        cuisines: parsed.cuisines,
        targetPlatforms: parsed.targetPlatforms,
        budgetTier: parsed.budgetTier,
        budgetAed: parsed.budgetAed,
        durationWeeks: parsed.durationWeeks ?? null,
        startsOn,
        primaryDishId: parsed.primaryDishId ?? null,
        brandVoice: parsed.brandVoice ?? null,
        status: "draft",
        briefJson: parsed as unknown as Prisma.InputJsonValue,
      },
    });

    return c.json({ project }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.get("/projects/:id", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    return c.json({ project });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// PATCH a draft project's editable fields. Today this is just `primaryDishId`
// — the picker on the draft page lets the owner swap the auto-staged dish
// before clicking Generate. We sync into briefJson too because the generator
// re-hydrates the brief from that snapshot, so the two must agree.
const projectPatchSchema = z.object({
  primaryDishId: z.string().cuid().nullable(),
});

adStudioRoute.patch("/projects/:id", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);

    // Allow edits while the project hasn't successfully shipped creative yet.
    // `failed` is the common case: the owner wants to swap the dish that caused
    // image-gen to fall over and click Retry. Block on `ready`/`exported`/
    // `generating`/`archived` so we never silently mutate a live brief mid-flight.
    if (project.status !== "draft" && project.status !== "failed") {
      throw new ApiError("Only draft or failed projects can be edited", 409);
    }

    const body = await c.req.json();
    const parsed = projectPatchSchema.parse(body);

    // Validate the dish belongs to this restaurant — tenant isolation.
    // Null clears the selection.
    if (parsed.primaryDishId) {
      const dish = await prisma.menuItem.findFirst({
        where: { id: parsed.primaryDishId, restaurantId: project.restaurantId },
        select: { id: true },
      });
      if (!dish) {
        throw new ApiError("That dish doesn't belong to this restaurant", 400);
      }
    }

    // Keep briefJson.primaryDishId in sync — the generator re-builds the
    // brief from the persisted snapshot, not from project columns.
    const currentBrief =
      project.briefJson && typeof project.briefJson === "object" && !Array.isArray(project.briefJson)
        ? (project.briefJson as Record<string, unknown>)
        : {};
    const updatedBrief = {
      ...currentBrief,
      primaryDishId: parsed.primaryDishId,
    };

    const updated = await prisma.adProject.update({
      where: { id: project.id },
      data: {
        primaryDishId: parsed.primaryDishId,
        briefJson: updatedBrief as Prisma.InputJsonValue,
      },
    });

    return c.json({ project: updated });
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.delete("/projects/:id", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);
    // P1 PDPL hygiene: the FK on customers.referral_ad_project_id is
    // ON DELETE SET NULL, but the rest of the referral_* fields
    // (headline, body, media_url, source_url, etc.) would persist as
    // orphaned marketing copy attached to a phone number. Clear them in
    // the same transaction as the project delete so deletion is
    // genuinely "tombstone everything".
    await prisma.$transaction(async (tx) => {
      await tx.customer.updateMany({
        where: { referralAdProjectId: project.id },
        data: {
          referralCtwaClid: null,
          referralSourceId: null,
          referralSourceType: null,
          referralSourceUrl: null,
          referralHeadline: null,
          referralBody: null,
          referralMediaUrl: null,
          referralCapturedAt: null,
          // referralAdProjectId + referralCreativeId are nulled by the
          // FK ON DELETE SET NULL when adProject.delete cascades.
        },
      });
      await tx.adProject.delete({ where: { id: project.id } });
    });
    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Generation kickoff
// =============================================================================

adStudioRoute.post("/projects/:id/generate", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    const ents = ensureAdStudioEnabled(project.restaurant);

    // Cost guardrails — per-restaurant per-day cap + global daily USD ceiling.
    await enforceGlobalBudget();
    await enforceGenerateRateLimit(project.restaurantId);

    const numberOfVariants = Math.min(Math.max(ents.adGenerationsPerProject, 1), 6);

    // Race-safe status flip: only enqueue if we successfully transitioned out of
    // a non-generating state. updateMany returns count of matched rows.
    const flipped = await prisma.adProject.updateMany({
      where: { id: project.id, status: { not: "generating" } },
      data: { status: "generating", lastError: null },
    });
    if (flipped.count === 0) {
      throw new ApiError("Generation already in progress", 409);
    }

    await enqueueAdStudioGeneration({ projectId: project.id, numberOfVariants });

    return c.json({ ok: true, jobEnqueued: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// Cancel a generation that's in flight. We can't actually kill a running
// pg-boss worker, but flipping status to `failed` here makes the worker's
// final write-back a no-op (the worker uses updateMany with where status=
// "generating"), so torn writes are impossible. Owner can retry immediately.
adStudioRoute.post("/projects/:id/cancel", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);

    // Race-safe: only flip if still generating. If a worker just finished and
    // wrote `ready` 50ms ago, we return 409 so the UI re-fetches and shows the
    // creatives instead of "Cancelled by owner".
    const flipped = await prisma.adProject.updateMany({
      where: { id: project.id, status: "generating" },
      data: {
        status: "failed",
        generationPhase: null,
        lastError: "Cancelled by owner — click Retry to start a fresh generation.",
      },
    });

    if (flipped.count === 0) {
      throw new ApiError("This project is no longer generating", 409);
    }

    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Creative variant edit + regenerate-image
// =============================================================================

const variantEditSchema = z.object({
  headline: z.string().min(1).max(200).optional(),
  primaryText: z.string().min(1).max(500).optional(),
  ctaText: z.string().min(1).max(80).optional(),
  headlineAr: z.string().max(200).nullable().optional(),
  primaryTextAr: z.string().max(500).nullable().optional(),
  ctaTextAr: z.string().max(80).nullable().optional(),
  isApproved: z.boolean().optional(),
});

adStudioRoute.patch("/creatives/:creativeId", async (c) => {
  try {
    const auth = c.var.auth;
    const creativeId = c.req.param("creativeId");
    const body = await c.req.json();
    const parsed = variantEditSchema.parse(body);

    // Tenant isolation: resolve creative → project → restaurant → owner
    const creative = await prisma.adCreative.findUnique({
      where: { id: creativeId },
      include: { project: { include: { restaurant: { select: { ownerId: true } } } } },
    });
    if (!creative) throw new ApiError("Creative not found", 404);

    const restaurantWithOwner = await prisma.restaurant.findFirst({
      where: { id: creative.project.restaurantId, owner: { clerkId: auth.clerkId } },
      include: {
        subscription: true,
        operatorAccount: { include: { _count: { select: { brands: true } } } },
      },
    });
    if (!restaurantWithOwner) throw new ApiError("Creative not found", 404);
    ensureAdStudioEnabled(restaurantWithOwner);

    const updated = await prisma.adCreative.update({
      where: { id: creativeId },
      data: {
        ...parsed,
        isEdited: true,
      },
    });

    return c.json({ creative: updated });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Slideshow (TikTok Photo Mode) — frame swap + caption regenerate
// =============================================================================

interface SlideshowStateFrame {
  menuItemId: string;
  headline: string;
  headlineAr: string | null;
  url: string | null;
}
interface SlideshowState {
  frames: SlideshowStateFrame[];
  postBody: string;
  postBodyAr: string | null;
  ctaText: string;
  ctaTextAr: string | null;
  generatedAt: string;
}

function readSlideshowState(project: { briefJson: unknown }): SlideshowState {
  const brief = project.briefJson;
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    throw new ApiError("Project is missing slideshow state", 409);
  }
  const slot = (brief as Record<string, unknown>)._slideshow;
  if (!slot || typeof slot !== "object") {
    throw new ApiError("Project does not have a slideshow yet — generate first", 409);
  }
  return slot as unknown as SlideshowState;
}

async function writeSlideshowState(projectId: string, state: SlideshowState) {
  const current = await prisma.adProject.findUnique({
    where: { id: projectId },
    select: { briefJson: true },
  });
  const persisted =
    current?.briefJson && typeof current.briefJson === "object" && !Array.isArray(current.briefJson)
      ? (current.briefJson as Record<string, unknown>)
      : {};
  await prisma.adProject.update({
    where: { id: projectId },
    data: {
      briefJson: {
        ...persisted,
        _slideshow: state,
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

const swapFrameSchema = z.object({
  menuItemId: z.string().cuid(),
  /** Optional new headline. When omitted, the existing frame headline is reused. */
  headline: z.string().min(1).max(32).optional(),
});

adStudioRoute.post("/projects/:id/slideshow/frames/:index/swap", async (c) => {
  try {
    const auth = c.var.auth;
    const indexParam = c.req.param("index");
    const frameIndex = Number.parseInt(indexParam, 10);
    if (
      !Number.isInteger(frameIndex) ||
      frameIndex < 0 ||
      frameIndex >= SLIDESHOW_FRAME_COUNT
    ) {
      throw new ApiError(
        `Frame index must be between 0 and ${SLIDESHOW_FRAME_COUNT - 1}`,
        400
      );
    }

    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);

    // Don't allow edits while generation is in flight — the worker is mid-write
    // and we'd race on briefJson._slideshow. Once status is ready/exported,
    // the project is stable enough to mutate.
    if (project.status !== "ready" && project.status !== "exported") {
      throw new ApiError(
        `Cannot edit a slideshow while it's ${project.status}. Wait for generation to finish.`,
        409
      );
    }

    const body = await c.req.json();
    const parsed = swapFrameSchema.parse(body);

    // Tenant-check the menu item and require a ready image.
    const item = await prisma.menuItem.findFirst({
      where: { id: parsed.menuItemId, restaurantId: project.restaurantId },
      select: { id: true, imageStatus: true, imageUrl: true },
    });
    if (!item) throw new ApiError("Menu item not found in this restaurant", 404);
    if (item.imageStatus !== "ready" && item.imageStatus !== "generated") {
      throw new ApiError("Menu item has no ready image to use in the slideshow", 422);
    }

    const state = readSlideshowState(project);
    if (!state.frames[frameIndex]) {
      throw new ApiError("Slideshow does not have a frame at this index", 409);
    }
    const newHeadline = parsed.headline ?? state.frames[frameIndex].headline ?? "";

    // Re-composite ONLY this frame.
    const composed = await buildSlideshowFrames({
      restaurantId: project.restaurantId,
      frames: [{ menuItemId: parsed.menuItemId, headline: newHeadline }],
    });
    if (composed.frameUrls.length !== 1) {
      const reason = composed.perFrame[0]?.reason ?? "unknown";
      throw new ApiError(`Failed to compose replacement frame: ${reason}`, 502);
    }
    const newUrl = composed.frameUrls[0];

    // Mutate state + write back.
    const nextFrames = state.frames.map((f, i) =>
      i === frameIndex
        ? { ...f, menuItemId: parsed.menuItemId, headline: newHeadline, url: newUrl }
        : f
    );
    const nextState: SlideshowState = { ...state, frames: nextFrames };
    await writeSlideshowState(project.id, nextState);

    // Mirror the URL array into AdCreative.sabtPackSlideshowFrames (the slot
    // the frontend renderer reads). Variant=1 by orchestrator convention.
    const creative = await prisma.adCreative.findFirst({
      where: { projectId: project.id, variant: 1 },
      select: { id: true },
    });
    if (creative) {
      await prisma.adCreative.update({
        where: { id: creative.id },
        data: {
          sabtPackSlideshowFrames: nextFrames.map((f) => f.url) as unknown as Prisma.InputJsonValue,
          heroImageUrl: nextFrames[0]?.url ?? null,
          // Keep AdCreative.headline aligned with frame 0 so list views stay in sync.
          ...(frameIndex === 0 ? { headline: newHeadline } : {}),
          isEdited: true,
        },
      });
    }

    return c.json({ ok: true, frameIndex, url: newUrl, state: nextState });
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.post("/projects/:id/slideshow/captions/regenerate", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);

    if (project.status !== "ready" && project.status !== "exported") {
      throw new ApiError(
        `Cannot regenerate captions while project is ${project.status}.`,
        409
      );
    }
    await enforceGenerateRateLimit(project.restaurantId);

    const state = readSlideshowState(project);
    if (state.frames.length !== SLIDESHOW_FRAME_COUNT) {
      throw new ApiError(
        `Slideshow does not have ${SLIDESHOW_FRAME_COUNT} frames`,
        409
      );
    }

    // Load fresh dish context for the current 5 menu items in frame order.
    const ids = state.frames.map((f) => f.menuItemId);
    const items = await prisma.menuItem.findMany({
      where: { id: { in: ids }, restaurantId: project.restaurantId },
      select: { id: true, name: true, description: true, price: true },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    const dishes = ids
      .map((id) => byId.get(id))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        price: d.price ? Number(d.price) : null,
      }));
    if (dishes.length !== SLIDESHOW_FRAME_COUNT) {
      throw new ApiError("One or more slideshow dishes were removed from the menu", 409);
    }

    const briefInput = {
      restaurantId: project.restaurantId,
      name: project.name,
      campaignType: project.campaignType,
      goal: project.goal,
      countries: project.countries,
      cuisines: project.cuisines,
      targetPlatforms: project.targetPlatforms,
      budgetTier: project.budgetTier,
      budgetAed: project.budgetAed,
      durationWeeks: project.durationWeeks ?? undefined,
      primaryDishId: project.primaryDishId ?? undefined,
      brandVoice: project.brandVoice ?? undefined,
    };
    const { brief, brand } = await hydrateBrief(briefInput as never);

    const ARABIC_FIRST = new Set(["SA", "KW", "BH", "OM", "QA"]);
    const bilingual = brief.countries.some((c) => ARABIC_FIRST.has(c));

    const totals = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    const captions = await generateSlideshowCaptions({
      brief,
      brand,
      dishes,
      bilingual,
      totals,
    });

    // Recomposite all 5 frames with the new headlines.
    const composed = await buildSlideshowFrames({
      restaurantId: project.restaurantId,
      frames: dishes.map((d, i) => ({
        menuItemId: d.id,
        headline: captions.frames[i]?.headline ?? "",
      })),
    });
    if (!composed.fullSlideshow) {
      throw new ApiError("Failed to recomposite all 5 frames", 502);
    }

    const nextState: SlideshowState = {
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
    await writeSlideshowState(project.id, nextState);

    const creative = await prisma.adCreative.findFirst({
      where: { projectId: project.id, variant: 1 },
      select: { id: true },
    });
    if (creative) {
      await prisma.adCreative.update({
        where: { id: creative.id },
        data: {
          sabtPackSlideshowFrames: composed.frameUrls as unknown as Prisma.InputJsonValue,
          heroImageUrl: composed.frameUrls[0] ?? null,
          headline: captions.frames[0]?.headline ?? "Slideshow",
          headlineAr: captions.frames[0]?.headlineAr ?? null,
          primaryText: captions.postBody,
          primaryTextAr: captions.postBodyAr ?? null,
          ctaText: captions.ctaText,
          ctaTextAr: captions.ctaTextAr ?? null,
          isEdited: false,
        },
      });
    }

    return c.json({ ok: true, state: nextState, costUsd: totals.costUsd });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Export
// =============================================================================

adStudioRoute.post("/projects/:id/export", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);

    if (project.status !== "ready" && project.status !== "exported") {
      throw new ApiError("Project is not ready to export. Wait for generation to finish.", 409);
    }

    if (project.creatives.length === 0) {
      throw new ApiError("Project has no creatives to export", 400);
    }

    const result = await buildAndUploadBundle({
      projectId: project.id,
      restaurantId: project.restaurantId,
      restaurantName: project.restaurant.name,
      projectName: project.name,
      campaignType: project.campaignType,
      countries: project.countries,
      cuisines: project.cuisines,
      targetPlatforms: project.targetPlatforms,
      budgetAed: project.budgetAed,
      variants: project.creatives.map((v) => ({
        variant: v.variant,
        archetypeId: v.archetypeId,
        hookId: v.hookId,
        ctaId: v.ctaId,
        headline: v.headline,
        primaryText: v.primaryText,
        ctaText: v.ctaText,
        headlineAr: v.headlineAr,
        primaryTextAr: v.primaryTextAr,
        ctaTextAr: v.ctaTextAr,
        heroImageUrl: v.heroImageUrl,
      })),
    });

    await prisma.adProject.update({
      where: { id: project.id },
      data: { status: "exported" },
    });

    return c.json({
      ok: true,
      signedUrl: result.signedUrl,
      expiresAt: result.expiresAt,
      fileSizeBytes: result.fileSizeBytes,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Phase 2A — Meta-ready ZIP export
// =============================================================================

adStudioRoute.post("/projects/:id/export-meta", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);

    if (project.status !== "ready" && project.status !== "exported") {
      throw new ApiError("Project is not ready to export. Wait for generation to finish.", 409);
    }
    if (project.creatives.length === 0) {
      throw new ApiError("Project has no creatives to export", 400);
    }

    // Hourly + daily export rate-limit. Bundle exports are CPU/memory-intensive;
    // a spam loop pins the container.
    await enforceExportRateLimit(project.restaurantId);

    // Destination URL: prefer a valid WhatsApp number → menu page → fallback.
    // E.164: 8-15 digits after stripping. Anything outside that range is junk.
    const restaurant = project.restaurant;
    const waDigits = restaurant.whatsappNumber?.replace(/\D/g, "") ?? "";
    const waValid = waDigits.length >= 8 && waDigits.length <= 15;
    const destinationUrl =
      (waValid ? `https://wa.me/${waDigits}` : null) ??
      (restaurant.slug ? `https://getbustan.com/r/${restaurant.slug}` : null) ??
      "";

    const result = await buildMetaExport({
      projectId: project.id,
      restaurantId: project.restaurantId,
      restaurantName: restaurant.name,
      projectName: project.name,
      campaignType: project.campaignType as never,
      goal: project.goal as never,
      countries: project.countries as never,
      cuisines: project.cuisines,
      budgetAed: project.budgetAed,
      durationWeeks: project.durationWeeks,
      destinationUrl,
      pageNameHint: restaurant.name,
      creatives: project.creatives.map((v) => ({
        id: v.id,
        variant: v.variant,
        archetypeId: v.archetypeId,
        hookId: v.hookId,
        ctaId: v.ctaId,
        headline: v.headline,
        primaryText: v.primaryText,
        ctaText: v.ctaText,
        headlineAr: v.headlineAr,
        primaryTextAr: v.primaryTextAr,
        ctaTextAr: v.ctaTextAr,
        heroImageUrl: v.heroImageUrl,
      })),
    });

    await prisma.adProject.update({
      where: { id: project.id },
      data: { status: "exported" },
    });

    return c.json({
      ok: true,
      signedUrl: result.signedUrl,
      expiresAt: result.expiresAt,
      fileSizeBytes: result.fileSizeBytes,
      validationIssues: result.validationIssues,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Phase 2C — Meta OAuth autopilot
// =============================================================================

const PENDING_STATE_TTL_MIN = 10;

function buildMetaCallbackUri(): string {
  // Backend serves callback; frontend redirects there after OAuth.
  // FRONTEND_APP_URL is the public origin (e.g. https://getbustan.com).
  return `${env.FRONTEND_APP_URL.replace(/\/$/, "")}/dashboard/ad-studio/integrations/meta/callback`;
}

adStudioRoute.get("/integrations/meta/start", async (c) => {
  try {
    const auth = c.var.auth;
    const restaurantId = c.req.query("restaurantId");
    if (!restaurantId) throw new ApiError("restaurantId is required", 400);
    const restaurant = await loadRestaurantForUser(restaurantId, auth.clerkId);
    ensureAdStudioEnabled(restaurant);
    if (!isMetaBetaRestaurant(restaurant.id)) {
      throw new ApiError(
        "Meta auto-sync is in early access. We'll notify you as soon as it's open.",
        403
      );
    }
    enforceMetaApiRateLimit(restaurant.id);

    // M5 fix: idempotent within 60s. A double-click on Connect must NOT
    // overwrite a fresh state — that would 400-out the callback that's
    // already round-tripping through Meta.
    const existing = await prisma.metaAdsIntegration.findUnique({
      where: { restaurantId: restaurant.id },
    });
    const fresh =
      existing?.pendingState &&
      existing.pendingStateAt &&
      Date.now() - existing.pendingStateAt.getTime() < 60_000;

    let state: string;
    if (fresh) {
      state = existing!.pendingState!;
    } else {
      state = nodeRandomBytes(24).toString("base64url");
      await prisma.metaAdsIntegration.upsert({
        where: { restaurantId: restaurant.id },
        create: {
          restaurantId: restaurant.id,
          status: "pending",
          pendingState: state,
          pendingStateAt: new Date(),
        },
        update: {
          pendingState: state,
          pendingStateAt: new Date(),
          // Don't overwrite a connected token — only the callback flips
          // status to "connected" and writes the new cipher.
        },
      });
    }

    const authorizeUrl = buildAuthorizeUrl({ state, redirectUri: buildMetaCallbackUri() });
    return c.json({ authorizeUrl, state });
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.post("/integrations/meta/callback", async (c) => {
  try {
    const auth = c.var.auth;
    const body = z
      .object({
        restaurantId: z.string().cuid(),
        code: z.string().min(8).max(2000),
        state: z.string().min(8).max(200),
      })
      .parse(await c.req.json());

    const restaurant = await loadRestaurantForUser(body.restaurantId, auth.clerkId);
    ensureAdStudioEnabled(restaurant);
    enforceMetaApiRateLimit(restaurant.id);

    const integration = await prisma.metaAdsIntegration.findUnique({
      where: { restaurantId: restaurant.id },
    });
    if (!integration?.pendingState || !integration.pendingStateAt) {
      throw new ApiError("No pending OAuth state — start the flow again.", 409);
    }
    // Constant-time compare + TTL check
    if (
      integration.pendingState.length !== body.state.length ||
      !timingSafeEqualString(integration.pendingState, body.state)
    ) {
      throw new ApiError("State mismatch — start the flow again.", 400);
    }
    const stateAgeMs = Date.now() - integration.pendingStateAt.getTime();
    if (stateAgeMs > PENDING_STATE_TTL_MIN * 60 * 1000) {
      throw new ApiError("OAuth state expired — start the flow again.", 400);
    }

    const redirectUri = buildMetaCallbackUri();
    const shortLived = await exchangeCodeForShortLivedToken({ code: body.code, redirectUri });
    const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
    const [scopes, metaUserId] = await Promise.all([
      fetchGrantedScopes(longLived.accessToken),
      fetchAdsMetaUserId(longLived.accessToken),
    ]);

    await prisma.metaAdsIntegration.update({
      where: { id: integration.id },
      data: {
        status: "connected",
        accessTokenCipher: encryptMetaAdsToken(longLived.accessToken),
        tokenLastFour: getTokenLastFour(longLived.accessToken),
        tokenExpiresAt: new Date(Date.now() + longLived.expiresInSec * 1000),
        scopes,
        // C-1 fix: persist Meta user_id for data-deletion / deauthorize
        // callbacks. Best-effort — falls back to existing value if /me
        // failed transiently (won't overwrite a previously-known id).
        metaUserId: metaUserId ?? undefined,
        connectedAt: new Date(),
        lastError: null,
        // Clear the pending state so the same code can't be replayed.
        pendingState: null,
        pendingStateAt: null,
      },
    });

    return c.json({ ok: true, requiresAdAccountSelection: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

function isMetaBetaRestaurant(restaurantId: string): boolean {
  const allowlist = (env.AD_STUDIO_META_BETA_RESTAURANT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Empty allowlist = open to everyone (post-Tech-Provider production state).
  if (allowlist.length === 0) return true;
  return allowlist.includes(restaurantId);
}

adStudioRoute.get("/integrations/meta", async (c) => {
  try {
    const auth = c.var.auth;
    const restaurantId = c.req.query("restaurantId");
    if (!restaurantId) throw new ApiError("restaurantId is required", 400);
    const restaurant = await loadRestaurantForUser(restaurantId, auth.clerkId);
    ensureAdStudioEnabled(restaurant);

    const integration = await prisma.metaAdsIntegration.findUnique({
      where: { restaurantId: restaurant.id },
      // Strict select — never expose accessTokenCipher or pendingState.
      select: {
        id: true,
        status: true,
        businessId: true,
        businessName: true,
        adAccountId: true,
        adAccountName: true,
        pageId: true,
        pageName: true,
        pixelId: true,
        tokenLastFour: true,
        tokenExpiresAt: true,
        scopes: true,
        connectedAt: true,
        lastSyncedAt: true,
        lastError: true,
      },
    });

    return c.json({
      integration,
      betaAccess: isMetaBetaRestaurant(restaurant.id),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.delete("/integrations/meta", async (c) => {
  try {
    const auth = c.var.auth;
    const body = z.object({ restaurantId: z.string().cuid() }).parse(await c.req.json());
    const restaurant = await loadRestaurantForUser(body.restaurantId, auth.clerkId);
    ensureAdStudioEnabled(restaurant);

    await prisma.metaAdsIntegration.update({
      where: { restaurantId: restaurant.id },
      data: {
        status: "disconnected",
        accessTokenCipher: null,
        tokenLastFour: null,
        tokenExpiresAt: null,
        scopes: [],
        pendingState: null,
        pendingStateAt: null,
      },
    });
    // Stop autopilot on any campaigns linked to this integration.
    await prisma.adLiveCampaign.updateMany({
      where: { metaIntegration: { restaurantId: restaurant.id } },
      data: { autoSync: false, metaIntegrationId: null },
    });
    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.get("/integrations/meta/ad-accounts", async (c) => {
  try {
    const auth = c.var.auth;
    const restaurantId = c.req.query("restaurantId");
    if (!restaurantId) throw new ApiError("restaurantId is required", 400);
    const restaurant = await loadRestaurantForUser(restaurantId, auth.clerkId);
    ensureAdStudioEnabled(restaurant);

    const integration = await prisma.metaAdsIntegration.findUnique({
      where: { restaurantId: restaurant.id },
    });
    if (!integration?.accessTokenCipher) {
      throw new ApiError("Meta is not connected for this restaurant.", 409);
    }
    enforceMetaApiRateLimit(restaurant.id);
    let token: string;
    try {
      token = decryptMetaAdsToken(integration.accessTokenCipher);
    } catch {
      // M3: graceful handling — flip integration to failed + force re-consent
      // instead of bubbling a 500. This blocks token-tampering oracles.
      await prisma.metaAdsIntegration.update({
        where: { id: integration.id },
        data: { status: "failed", lastError: "Token decryption failed — please reconnect." },
      });
      throw new ApiError("Meta token is invalid. Please reconnect.", 409);
    }
    const accounts = await listAdAccounts(token);
    return c.json({ accounts });
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.post("/integrations/meta/select-ad-account", async (c) => {
  try {
    const auth = c.var.auth;
    const body = z
      .object({
        restaurantId: z.string().cuid(),
        adAccountId: z.string().regex(/^act_\d+$/, "ad account id must be in act_NNN format"),
        adAccountName: z.string().max(120).optional(),
        businessId: z.string().regex(/^\d+$/).optional(),
        businessName: z.string().max(120).optional(),
        pageId: z.string().regex(/^\d+$/).optional(),
        pageName: z.string().max(120).optional(),
        pixelId: z.string().regex(/^\d+$/).optional(),
      })
      .parse(await c.req.json());
    const restaurant = await loadRestaurantForUser(body.restaurantId, auth.clerkId);
    ensureAdStudioEnabled(restaurant);

    const integration = await prisma.metaAdsIntegration.update({
      where: { restaurantId: restaurant.id },
      data: {
        adAccountId: body.adAccountId,
        adAccountName: body.adAccountName ?? null,
        businessId: body.businessId ?? null,
        businessName: body.businessName ?? null,
        pageId: body.pageId ?? null,
        pageName: body.pageName ?? null,
        pixelId: body.pixelId ?? null,
      },
    });
    return c.json({ integration: { id: integration.id, adAccountId: integration.adAccountId } });
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.post("/projects/:id/sync-meta", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);
    enforceMetaApiRateLimit(project.restaurantId);

    // Find the most-recent live campaign linked to this project + integration.
    const live = await prisma.adLiveCampaign.findFirst({
      where: { projectId: project.id, metaIntegration: { restaurantId: project.restaurantId } },
      orderBy: { launchedAt: "desc" },
    });
    if (!live) {
      throw new ApiError(
        "No Meta-linked campaign for this project. Connect Meta + link the campaign first.",
        404
      );
    }
    const result = await syncLiveCampaignFromMeta(live.id);
    return c.json(result);
  } catch (error) {
    return errorResponse(c, error);
  }
});

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// =============================================================================
// Phase 2B — performance feedback loop
// =============================================================================

const META_CAMPAIGN_ID_RX = /^[0-9]{6,30}$/;
const PLATFORM_RX = /^(meta|tiktok|snapchat)$/;

const linkCampaignSchema = z.object({
  platform: z.string().regex(PLATFORM_RX),
  externalCampaignId: z.string().regex(META_CAMPAIGN_ID_RX, "Campaign ID should be the numeric ID from your Ads Manager URL."),
  externalAdSetIds: z.array(z.string().regex(META_CAMPAIGN_ID_RX)).max(10).optional(),
  externalAdIds: z.array(z.string().regex(META_CAMPAIGN_ID_RX)).max(50).optional(),
  // P1: structured per-ad → creative variant mapping. When provided, the
  // CTWA webhook resolver attributes inbound conversations to the specific
  // Bustan creative — not just the project. creativeId is optional; an
  // entry with just an externalAdId still gives project-level attribution
  // via the GIN-indexed externalAdIds[] fallback.
  externalAds: z
    .array(
      z.object({
        externalAdId: z.string().regex(META_CAMPAIGN_ID_RX),
        creativeId: z.string().cuid().optional(),
      })
    )
    .max(50)
    .optional(),
  launchedAt: z
    .string()
    .datetime()
    .refine((d) => new Date(d) <= new Date(Date.now() + 60 * 60 * 1000), {
      message: "launchedAt cannot be in the future.",
    })
    .optional(),
  notes: z.string().max(2000).optional(),
});

adStudioRoute.post("/projects/:id/link-campaign", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);
    await enforceLinkCampaignRateLimit(project.restaurantId);
    const body = linkCampaignSchema.parse(await c.req.json());

    // Reject reuse with a generic 409 — never disclose whether the campaign
    // ID belongs to *another* project. A specific message turns the unique
    // index into a cross-tenant existence oracle for paying customers.
    const existingForId = await prisma.adLiveCampaign.findUnique({
      where: { platform_externalCampaignId: { platform: body.platform, externalCampaignId: body.externalCampaignId } },
    });
    if (existingForId && existingForId.projectId !== project.id) {
      throw new ApiError("This campaign ID can't be linked to this project.", 409);
    }

    // If the restaurant has a connected Meta integration AND the linked
    // platform is meta, auto-attach the live campaign to it so the cron
    // sync picks it up without a separate user step.
    let metaIntegrationId: string | null = null;
    if (body.platform === "meta") {
      const integration = await prisma.metaAdsIntegration.findUnique({
        where: { restaurantId: project.restaurantId },
        select: { id: true, status: true, accessTokenCipher: true },
      });
      if (integration?.status === "connected" && integration.accessTokenCipher) {
        metaIntegrationId = integration.id;
      }
    }

    // P1: derive the canonical externalAdIds list. If structured mappings
    // were supplied, take their adIds plus any explicit externalAdIds the
    // owner also passed. De-dupe so the GIN index lookup remains O(1) per
    // entry. If creativeIds are present, they MUST belong to this project
    // (cross-tenant attribution is rejected).
    const structuredAds = body.externalAds ?? [];
    if (structuredAds.length > 0) {
      const projectCreativeIds = new Set(project.creatives.map((c) => c.id));
      for (const m of structuredAds) {
        if (m.creativeId && !projectCreativeIds.has(m.creativeId)) {
          throw new ApiError(
            `Creative ${m.creativeId} does not belong to this project.`,
            400
          );
        }
      }
    }
    const flatAdIds = Array.from(
      new Set([
        ...(body.externalAdIds ?? []),
        ...structuredAds.map((m) => m.externalAdId),
      ])
    );

    let live;
    try {
      live = await prisma.$transaction(async (tx) => {
      const liveRow = await tx.adLiveCampaign.upsert({
        where: { platform_externalCampaignId: { platform: body.platform, externalCampaignId: body.externalCampaignId } },
        create: {
          projectId: project.id,
          platform: body.platform,
          externalCampaignId: body.externalCampaignId,
          externalAdSetIds: body.externalAdSetIds ?? [],
          externalAdIds: flatAdIds,
          launchedAt: body.launchedAt ? new Date(body.launchedAt) : new Date(),
          notes: body.notes ?? null,
          status: "linked",
          metaIntegrationId,
          autoSync: metaIntegrationId !== null,
        },
        update: {
          externalAdSetIds: body.externalAdSetIds ?? [],
          externalAdIds: flatAdIds,
          launchedAt: body.launchedAt ? new Date(body.launchedAt) : undefined,
          // Use undefined (not null) so a re-link without notes preserves the prior note.
          notes: body.notes ?? undefined,
          // Refresh the integration link in case the owner just connected Meta.
          metaIntegrationId: metaIntegrationId ?? undefined,
          autoSync: metaIntegrationId !== null ? true : undefined,
        },
      });

      // P1: persist per-ad → creative mappings. Re-link replaces the
      // existing set so a corrected mapping wins. Two-step delete:
      //  (a) wipe this campaign's prior mappings,
      //  (b) wipe any other same-restaurant campaign's mappings for the
      //      adIds we're about to claim — owner-driven re-assignment of
      //      an ad ID from one Bustan campaign to another. The unique
      //      index is on (platform, externalAdId) so without (b) the
      //      createMany would partially fail.
      if (structuredAds.length > 0) {
        await tx.adLiveCampaignAdMapping.deleteMany({
          where: { liveCampaignId: liveRow.id },
        });
        await tx.adLiveCampaignAdMapping.deleteMany({
          where: {
            platform: body.platform,
            externalAdId: { in: structuredAds.map((m) => m.externalAdId) },
            liveCampaign: { project: { restaurantId: project.restaurantId } },
          },
        });
        await tx.adLiveCampaignAdMapping.createMany({
          data: structuredAds.map((m) => ({
            liveCampaignId: liveRow.id,
            creativeId: m.creativeId ?? null,
            platform: body.platform,
            externalAdId: m.externalAdId,
          })),
        });
      }

      return liveRow;
      });
    } catch (err) {
      // P1: A double-click on Link campaign can race two transactions
      // through the structured-mapping insert. Without this catch the
      // unique (platform, external_ad_id) index throws P2002 and the
      // user sees a generic 500. Map to a clean 409 so the UI can show
      // "already linked — refresh to see the latest" instead.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new ApiError(
          "Already linked. Reload to see the latest status.",
          409
        );
      }
      throw err;
    }

    return c.json({ liveCampaign: live });
  } catch (error) {
    return errorResponse(c, error);
  }
});

const reportMetricsSchema = z.object({
  liveCampaignId: z.string().cuid(),
  daysLive: z.number().int().min(1).max(180),
  variants: z
    .array(
      z.object({
        creativeId: z.string().cuid(),
        spendAed: z.number().nonnegative().max(1_000_000),
        impressions: z.number().int().nonnegative().max(100_000_000),
        reach: z.number().int().nonnegative().max(100_000_000).optional(),
        clicks: z.number().int().nonnegative().max(10_000_000),
        conversions: z.number().int().nonnegative().max(1_000_000),
        revenueAed: z.number().nonnegative().max(10_000_000).optional(),
        frequency: z.number().nonnegative().max(50).optional(),
        dailyBudgetAed: z.number().nonnegative().max(100_000).optional(),
        // Phase 2B: extraJson intentionally NOT accepted from clients.
        // Phase 4 (Meta API sync) will populate it with a fixed allowlist
        // of platform-returned fields. Until then, accepting arbitrary JSON
        // from the UI is a stored-data abuse vector.
      })
    )
    .min(1)
    .max(10),
});

adStudioRoute.post("/projects/:id/report-metrics", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);
    await enforceReportMetricsRateLimit(project.restaurantId);
    const body = reportMetricsSchema.parse(await c.req.json());

    // Tenant isolation: live campaign must belong to this project.
    const live = await prisma.adLiveCampaign.findFirst({
      where: { id: body.liveCampaignId, projectId: project.id },
    });
    if (!live) throw new ApiError("Live campaign not found for this project.", 404);

    // Validate every reported creative ID belongs to this project. We do
    // NOT pin creatives to a specific liveCampaign — same-tenant data
    // integrity (an owner could accidentally report metrics for a creative
    // launched in a previous campaign) is acceptable; cross-tenant isolation
    // is what matters here.
    const projectCreativeIds = new Set(project.creatives.map((c) => c.id));
    for (const v of body.variants) {
      if (!projectCreativeIds.has(v.creativeId)) {
        throw new ApiError(`Creative ${v.creativeId} does not belong to this project.`, 400);
      }
    }

    const reportedAt = new Date();
    const rows = body.variants.map((v) => {
      const derived = deriveMetrics({
        spendAed: v.spendAed,
        impressions: v.impressions,
        reach: v.reach,
        clicks: v.clicks,
        conversions: v.conversions,
        revenueAed: v.revenueAed,
        frequency: v.frequency,
      });
      const variantNumber = project.creatives.find((c) => c.id === v.creativeId)?.variant ?? null;
      return {
        liveCampaignId: live.id,
        creativeId: v.creativeId,
        variant: variantNumber,
        source: "owner_reported" as const,
        reportedAt,
        daysLive: body.daysLive,
        spendAed: new Prisma.Decimal(v.spendAed.toFixed(2)),
        impressions: v.impressions,
        reach: v.reach ?? null,
        clicks: v.clicks,
        conversions: v.conversions,
        revenueAed: v.revenueAed != null ? new Prisma.Decimal(v.revenueAed.toFixed(2)) : null,
        ctrPct: derived.ctrPct != null ? new Prisma.Decimal(derived.ctrPct.toFixed(3)) : null,
        cpmAed: derived.cpmAed != null ? new Prisma.Decimal(derived.cpmAed.toFixed(2)) : null,
        cpcAed: derived.cpcAed != null ? new Prisma.Decimal(derived.cpcAed.toFixed(2)) : null,
        cpaAed: derived.cpaAed != null ? new Prisma.Decimal(derived.cpaAed.toFixed(2)) : null,
        frequency: v.frequency != null ? new Prisma.Decimal(v.frequency.toFixed(2)) : null,
        dailyBudgetAed: v.dailyBudgetAed != null ? new Prisma.Decimal(v.dailyBudgetAed.toFixed(2)) : null,
        // extraJson populated only by trusted server-side sources (Phase 4
        // Meta API sync). Owner submissions can never write here.
        extraJson: Prisma.JsonNull,
      } satisfies Prisma.AdPerformanceSnapshotCreateManyInput;
    });

    // Soft idempotency: if any snapshot was reported in the last 60 seconds
    // for this live campaign, treat the request as a duplicate-tap and return
    // the prior result. Phase 4 (Meta API sync) will introduce a proper
    // (liveCampaignId, creativeId, reportingPeriodKey) unique index.
    const recent = await prisma.adPerformanceSnapshot.findFirst({
      where: {
        liveCampaignId: live.id,
        createdAt: { gte: new Date(Date.now() - 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (recent) {
      return c.json({
        ok: true,
        snapshotsRecorded: 0,
        reportedAt: recent.reportedAt,
        deduplicated: true,
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.adPerformanceSnapshot.createMany({ data: rows });
      await tx.adLiveCampaign.update({
        where: { id: live.id },
        data: { status: "reporting", lastSyncedAt: reportedAt },
      });
    });

    return c.json({ ok: true, snapshotsRecorded: rows.length, reportedAt });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// P1 — CRM impact: customers, conversations, orders, revenue attributed
// to this Ad Studio project via the CTWA referral bridge.
// =============================================================================

adStudioRoute.get("/projects/:id/crm-impact", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);

    // Single-roundtrip aggregation. Three queries hit the partial index
    // on customers.referral_ad_project_id; conversations + order
    // aggregation are scoped to the attributed customer set.
    //
    // We do NOT trust customer.restaurantId implicitly — we always join
    // through the restaurant scope to defend against cross-tenant
    // attribution writes (a malicious AdLiveCampaignAdMapping insert
    // somehow naming another restaurant's project). Tenant isolation
    // is enforced at write time too, but defence in depth.
    const customerWhere = {
      restaurantId: project.restaurantId,
      referralAdProjectId: project.id,
    } as const;

    const [
      customerCount,
      conversationCount,
      orderAggregate,
      conversationBounds,
    ] = await Promise.all([
      prisma.customer.count({ where: customerWhere }),
      prisma.whatsAppConversation.count({
        where: {
          restaurantId: project.restaurantId,
          customer: customerWhere,
        },
      }),
      prisma.orderIntent.aggregate({
        where: {
          restaurantId: project.restaurantId,
          customer: customerWhere,
        },
        _count: { _all: true },
        _sum: { totalPrice: true },
      }),
      prisma.whatsAppConversation.aggregate({
        where: {
          restaurantId: project.restaurantId,
          customer: customerWhere,
        },
        // First-conversation-started uses `createdAt` (when the row was
        // inserted on the customer's first inbound message). Most-recent-
        // activity uses `lastMessageAt`. Conflating these — using min of
        // lastMessageAt — would surface "first conversation = today" for
        // a customer who started weeks ago but messaged again today.
        _min: { createdAt: true },
        _max: { lastMessageAt: true },
      }),
    ]);

    return c.json({
      impact: {
        customers: customerCount,
        conversations: conversationCount,
        orders: orderAggregate._count._all,
        revenue: orderAggregate._sum.totalPrice
          ? Number(orderAggregate._sum.totalPrice.toString())
          : 0,
        currency: "AED",
        firstConversationAt: conversationBounds._min.createdAt ?? null,
        lastConversationAt: conversationBounds._max.lastMessageAt ?? null,
      },
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.get("/projects/:id/insights", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);

    // Pick the most recently launched live campaign for this project.
    const live = await prisma.adLiveCampaign.findFirst({
      where: { projectId: project.id },
      orderBy: { launchedAt: "desc" },
      include: {
        snapshots: { orderBy: { reportedAt: "desc" }, take: 200 },
      },
    });

    if (!live) {
      return c.json({ liveCampaign: null, insights: null });
    }

    const insights = summarizeCampaignInsights({
      liveCampaignId: live.id,
      platform: live.platform,
      creatives: project.creatives.map((c) => ({
        id: c.id,
        variant: c.variant,
        archetypeId: c.archetypeId,
      })),
      snapshots: live.snapshots,
    });

    return c.json({ liveCampaign: live, insights });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Phase 1.5 — single-variant image regeneration
// =============================================================================

adStudioRoute.post("/creatives/:creativeId/regenerate-image", async (c) => {
  try {
    const auth = c.var.auth;
    const creativeId = c.req.param("creativeId");

    // Optional body — { provider?: "gemini" | "openai" }. Tolerate a
    // missing or empty body (legacy clients send no body) but DO surface
    // schema errors on a present-but-invalid provider so the operator's
    // explicit GPT Image choice isn't silently downgraded to Gemini.
    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({ provider: z.enum(["gemini", "openai"]).optional() })
      .parse(rawBody);
    let provider: "gemini" | "openai" = parsed.provider ?? "gemini";
    console.log(
      `[ad-studio regen] request creative=${creativeId} requestedProvider=${provider}`
    );

    const creative = await prisma.adCreative.findUnique({
      where: { id: creativeId },
      include: { project: { include: { restaurant: { select: { id: true, ownerId: true } } } } },
    });
    if (!creative) throw new ApiError("Creative not found", 404);

    const restaurant = await loadRestaurantForUser(creative.project.restaurantId, auth.clerkId);
    ensureAdStudioEnabled(restaurant);

    // OpenAI gating: feature is gated to Pro+ (Starter has no Ad Studio
    // anyway), and additionally requires the API key to be configured at
    // the platform level. This keeps the dropdown actionable in the UI
    // and surfaces a single clean error rather than a 502 from upstream.
    if (provider === "openai") {
      if (!env.OPENAI_API_KEY) {
        console.warn(
          `[ad-studio regen] GPT Image requested for creative ${creativeId}, but OPENAI_API_KEY is not configured`
        );
        throw new ApiError(
          "GPT Image is not yet enabled on this environment.",
          503
        );
      }
      const monthlyOpenAi = await checkAiLimit(
        restaurant.id,
        "ad_studio_image_openai",
        getRestaurantEntitlements(restaurant).openaiImageMonthlyLimit
      );
      if (monthlyOpenAi.allowed) {
        await enforceOpenAiRegenRateLimit(restaurant.id);
      } else {
        throw new ApiError(
          "Monthly GPT Image limit reached. Switch to Gemini or try again next month.",
          429,
          { used: monthlyOpenAi.used, remaining: monthlyOpenAi.remaining }
        );
      }
    }

    // Image regen has its own daily pool so it doesn't eat full-project quota,
    // plus shares the global USD ceiling for absolute spend control.
    await enforceGlobalBudget();
    await enforceImageRegenRateLimit(restaurant.id);

    // Race-safe: only enqueue if not already generating.
    const flipped = await prisma.adCreative.updateMany({
      where: { id: creativeId, status: { not: "generating" } },
      data: {
        status: "generating",
        heroImageUrl: null,
        heroImageSourceMenuItemId: null,
        imageProvider: null,
      },
    });
    if (flipped.count === 0) {
      throw new ApiError("Image regeneration already in progress for this variant", 409);
    }

    await enqueueRegenImage({ creativeId, provider });
    console.log(
      `[ad-studio regen] enqueued creative=${creativeId} provider=${provider}`
    );
    return c.json({ ok: true, provider });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Phase 1.5 — duplicate project (clone the brief into a new draft)
// =============================================================================

adStudioRoute.post("/projects/:id/duplicate", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    const ents = ensureAdStudioEnabled(project.restaurant);

    // Honor monthly project quota
    if (ents.adProjectMonthlyLimit !== null) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const created = await prisma.adProject.count({
        where: { restaurantId: project.restaurantId, createdAt: { gte: monthStart } },
      });
      if (created >= ents.adProjectMonthlyLimit) {
        throw new ApiError(
          `You've reached this month's limit of ${ents.adProjectMonthlyLimit} projects.`,
          429
        );
      }
    }

    // Validate primaryDishId still belongs to this restaurant — null it
    // out if the source dish has been deleted/moved so generation doesn't
    // fail downstream with a broken reference.
    let resolvedPrimaryDishId: string | null = null;
    if (project.primaryDishId) {
      const stillExists = await prisma.menuItem.findFirst({
        where: { id: project.primaryDishId, restaurantId: project.restaurantId },
        select: { id: true },
      });
      resolvedPrimaryDishId = stillExists?.id ?? null;
    }

    const cloned = await prisma.adProject.create({
      data: {
        restaurantId: project.restaurantId,
        name: `${project.name} (copy)`,
        campaignType: project.campaignType,
        goal: project.goal,
        countries: project.countries,
        cuisines: project.cuisines,
        targetPlatforms: project.targetPlatforms,
        budgetTier: project.budgetTier,
        budgetAed: project.budgetAed,
        durationWeeks: project.durationWeeks ?? null,
        primaryDishId: resolvedPrimaryDishId,
        brandVoice: project.brandVoice ?? null,
        status: "draft",
        briefJson: project.briefJson as Prisma.InputJsonValue,
      },
    });
    return c.json({ project: cloned }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Phase 1.5 — mint or fetch the share token
// =============================================================================

adStudioRoute.post("/projects/:id/share", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);

    if (project.status !== "ready" && project.status !== "exported") {
      throw new ApiError("Project must be ready before sharing", 409);
    }

    let token = project.shareToken;
    if (!token) {
      // 22 chars of base64url ≈ 132 bits of entropy — strong enough that
      // unauthenticated guessing is infeasible without a public listing.
      const candidate = randomBytes(16).toString("base64url");
      // Race-safe: only set the token if no other concurrent request already
      // wrote one. Read-back picks up whoever won the race.
      await prisma.adProject.updateMany({
        where: { id: project.id, shareToken: null },
        data: { shareToken: candidate },
      });
      const fresh = await prisma.adProject.findUnique({
        where: { id: project.id },
        select: { shareToken: true },
      });
      token = fresh?.shareToken ?? candidate;
    }

    return c.json({ shareToken: token });
  } catch (error) {
    return errorResponse(c, error);
  }
});

adStudioRoute.delete("/projects/:id/share", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("id"), auth.clerkId);
    ensureAdStudioEnabled(project.restaurant);
    await prisma.adProject.update({
      where: { id: project.id },
      data: { shareToken: null },
    });
    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// Phase 1.5 — public share endpoint (NO auth, token-gated)
// =============================================================================
// Mounted on the same router but explicitly skips `requireAuth` by short-circuiting
// before any auth-touching code is reached. The middleware runs first though;
// for true unauthenticated access we expose this from a separate router below.

export const adStudioPublicRoute = new Hono();

// In-memory IP rate limiter (60 req/min) — defence-in-depth on the only
// unauthenticated ingress. For multi-instance deployments swap for Redis;
// for Phase 1.5 single-instance Railway this is sufficient.
const PUBLIC_RATE_WINDOW_MS = 60_000;
const PUBLIC_RATE_MAX = 60;
const publicHits = new Map<string, { count: number; resetAt: number }>();

function publicRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = publicHits.get(ip);
  if (!entry || entry.resetAt < now) {
    publicHits.set(ip, { count: 1, resetAt: now + PUBLIC_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= PUBLIC_RATE_MAX) return false;
  entry.count += 1;
  return true;
}

// Periodic cleanup so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of publicHits) {
    if (entry.resetAt < now) publicHits.delete(ip);
  }
}, 5 * 60_000).unref?.();

function applyPublicCacheHeaders(c: Context) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

adStudioPublicRoute.get("/projects/:token", async (c) => {
  // Defence-in-depth: identical caching headers on every code path so a 404
  // for a revoked token can't be served from any intermediary cache.
  applyPublicCacheHeaders(c);

  // Rate-limit by client IP (best-effort — falls back to a constant key
  // when the proxy chain doesn't expose a peer IP).
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown";
  if (!publicRateLimit(ip)) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  try {
    const token = c.req.param("token");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
      throw new ApiError("Share link is no longer available", 404);
    }

    const project = await prisma.adProject.findUnique({
      where: { shareToken: token },
      include: {
        // Only fields the public page actually renders. Slug intentionally
        // dropped so a recipient can't pivot from a single share to the full
        // restaurant portfolio without a separate share decision.
        restaurant: { select: { name: true, location: true, logoUrl: true, cuisineType: true } },
        creatives: {
          where: { isApproved: true, status: "ready" },
          orderBy: { variant: "asc" },
          select: {
            id: true,
            variant: true,
            archetypeId: true,
            language: true,
            headline: true,
            primaryText: true,
            ctaText: true,
            headlineAr: true,
            primaryTextAr: true,
            ctaTextAr: true,
            heroImageUrl: true,
          },
        },
      },
    });

    if (!project || (project.status !== "ready" && project.status !== "exported")) {
      throw new ApiError("Share link is no longer available", 404);
    }

    // Only expose minimal fields — never restaurantId, ownerId, briefJson,
    // costs, internal taxonomy ids (archetypeId/hookId/ctaId), or status.
    return c.json({
      project: {
        name: project.name,
        countries: project.countries,
        cuisines: project.cuisines,
        creatives: project.creatives,
      },
      restaurant: project.restaurant,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});
