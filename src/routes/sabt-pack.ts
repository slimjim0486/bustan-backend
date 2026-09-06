// Sabt Pack API routes — owner-facing review surface.
//
// Mounted at /api/sabt-pack. All endpoints require auth. Project endpoints
// enforce tenant isolation (owner clerkId must match the restaurant) and the
// `sabtPackEnabled` entitlement (Pro / Portfolio only).

import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { getRestaurantEntitlements, getSabtPackUpgradeMessage } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";
import { sundayOfThisWeekUae } from "@/services/sabt-pack";
import { buildSabtPackBundle } from "@/services/sabt-pack/export-bundle";
import { enforceExportRateLimit } from "@/services/ad-studio-ai/guards";

export const sabtPackRoute = new Hono<{
  Variables: { auth: { clerkId: string; email: string | null; fullName: string | null } };
}>();
sabtPackRoute.use("*", requireAuth);

// =============================================================================
// Helpers
// =============================================================================

async function loadProjectForUser(projectId: string, clerkId: string) {
  const project = await prisma.adProject.findFirst({
    where: {
      id: projectId,
      campaignType: "sabt_pack",
      restaurant: { owner: { clerkId } },
    },
    include: {
      restaurant: {
        select: {
          id: true,
          name: true,
          cuisineType: true,
          slug: true,
          logoUrl: true,
          location: true,
          sabtPackEnabled: true,
          subscriptionStatus: true,
          subscription: true,
          operatorAccount: { include: { _count: { select: { brands: true } } } },
        },
      },
      creatives: {
        orderBy: [{ sabtPackSlot: "asc" }, { variant: "asc" }],
      },
    },
  });
  if (!project) throw new ApiError("Sabt Pack not found", 404);
  return project;
}

function ensureSabtPackEnabled(restaurant: Parameters<typeof getRestaurantEntitlements>[0]) {
  const ents = getRestaurantEntitlements(restaurant);
  if (!ents.sabtPackEnabled) {
    throw new ApiError(getSabtPackUpgradeMessage(), 402);
  }
  return ents;
}

function serializeCreative(c: Awaited<ReturnType<typeof loadProjectForUser>>["creatives"][number]) {
  return {
    id: c.id,
    slot: c.sabtPackSlot,
    format: c.sabtPackSlotFormat,
    archetypeId: c.archetypeId,
    hookId: c.hookId,
    ctaId: c.ctaId,
    copyFrameworkId: c.copyFrameworkId,
    language: c.language,
    headline: c.headline,
    primaryText: c.primaryText,
    ctaText: c.ctaText,
    headlineAr: c.headlineAr,
    primaryTextAr: c.primaryTextAr,
    ctaTextAr: c.ctaTextAr,
    heroImageUrl: c.heroImageUrl,
    heroImageSourceMenuItemId: c.heroImageSourceMenuItemId,
    slideshowFrames: Array.isArray(c.sabtPackSlideshowFrames)
      ? (c.sabtPackSlideshowFrames as string[])
      : null,
    gbpPostBody: c.gbpPostBody,
    scheduledFor: c.scheduledFor,
    status: c.status,
    safetyFlags: c.safetyFlags,
    isApproved: c.isApproved,
    isEdited: c.isEdited,
  };
}

// =============================================================================
// GET /api/sabt-pack/restaurants/:restaurantId  — list packs for a restaurant
// =============================================================================

sabtPackRoute.get("/restaurants/:restaurantId", async (c) => {
  try {
    const auth = c.var.auth;
    const restaurantId = c.req.param("restaurantId");

    const restaurant = await prisma.restaurant.findFirst({
      where: { id: restaurantId, owner: { clerkId: auth.clerkId } },
      include: {
        subscription: true,
        operatorAccount: { include: { _count: { select: { brands: true } } } },
      },
    });
    if (!restaurant) throw new ApiError("Restaurant not found", 404);

    const ents = ensureSabtPackEnabled(restaurant);

    const packs = await prisma.adProject.findMany({
      where: { restaurantId, campaignType: "sabt_pack" },
      orderBy: { sabtPackWeekStartDate: "desc" },
      take: 12,
      select: {
        id: true,
        sabtPackWeekStartDate: true,
        sabtPackStatus: true,
        sabtPackDeliveredAt: true,
        sabtPackApprovedAt: true,
        sabtPackThemeOfWeek: true,
        createdAt: true,
        _count: { select: { creatives: true } },
      },
    });

    return c.json({
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        sabtPackEnabled: restaurant.sabtPackEnabled,
      },
      entitlements: {
        sabtPackEnabled: ents.sabtPackEnabled,
        sabtPackMaxCostUsdPerWeek: ents.sabtPackMaxCostUsdPerWeek,
      },
      currentWeekStartDate: sundayOfThisWeekUae(),
      packs: packs.map((p) => ({
        id: p.id,
        weekStartDate: p.sabtPackWeekStartDate,
        status: p.sabtPackStatus,
        deliveredAt: p.sabtPackDeliveredAt,
        approvedAt: p.sabtPackApprovedAt,
        themeOfWeek: p.sabtPackThemeOfWeek,
        creativeCount: p._count.creatives,
        createdAt: p.createdAt,
      })),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// GET /api/sabt-pack/:projectId  — single pack with all 7 slots
// =============================================================================

sabtPackRoute.get("/:projectId", async (c) => {
  try {
    const auth = c.var.auth;
    const project = await loadProjectForUser(c.req.param("projectId"), auth.clerkId);
    ensureSabtPackEnabled(project.restaurant);

    return c.json({
      project: {
        id: project.id,
        name: project.name,
        status: project.sabtPackStatus,
        weekStartDate: project.sabtPackWeekStartDate,
        deliveredAt: project.sabtPackDeliveredAt,
        approvedAt: project.sabtPackApprovedAt,
        themeOfWeek: project.sabtPackThemeOfWeek,
      },
      restaurant: {
        id: project.restaurant.id,
        name: project.restaurant.name,
        cuisineType: project.restaurant.cuisineType,
        slug: project.restaurant.slug,
        logoUrl: project.restaurant.logoUrl,
        location: project.restaurant.location,
      },
      creatives: project.creatives.map(serializeCreative),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// PATCH /api/sabt-pack/:projectId/creatives/:creativeId  — edit copy / approve
// =============================================================================

const patchCreativeSchema = z
  .object({
    headline: z.string().min(1).max(280).optional(),
    primaryText: z.string().min(1).max(2000).optional(),
    ctaText: z.string().min(1).max(120).optional(),
    headlineAr: z.string().min(1).max(280).nullable().optional(),
    primaryTextAr: z.string().min(1).max(2000).nullable().optional(),
    ctaTextAr: z.string().min(1).max(120).nullable().optional(),
    gbpPostBody: z.string().min(1).max(1500).nullable().optional(),
    isApproved: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update.",
  });

sabtPackRoute.patch("/:projectId/creatives/:creativeId", async (c) => {
  try {
    const auth = c.var.auth;
    const projectId = c.req.param("projectId");
    const creativeId = c.req.param("creativeId");

    const project = await loadProjectForUser(projectId, auth.clerkId);
    ensureSabtPackEnabled(project.restaurant);

    const creative = project.creatives.find((cr) => cr.id === creativeId);
    if (!creative) throw new ApiError("Creative not found", 404);

    const body = await c.req.json();
    const parsed = patchCreativeSchema.parse(body);

    const hasCopyEdit =
      parsed.headline !== undefined ||
      parsed.primaryText !== undefined ||
      parsed.ctaText !== undefined ||
      parsed.headlineAr !== undefined ||
      parsed.primaryTextAr !== undefined ||
      parsed.ctaTextAr !== undefined ||
      parsed.gbpPostBody !== undefined;

    // Belt-and-suspenders tenant scope: the in-memory creative check above
    // proves the user owns the project, but the write itself MUST scope by
    // (id, projectId) so a future refactor that lazy-loads creatives can't
    // silently turn this into an unscoped write across tenants.
    const updateResult = await prisma.adCreative.updateMany({
      where: { id: creativeId, projectId },
      data: {
        headline: parsed.headline,
        primaryText: parsed.primaryText,
        ctaText: parsed.ctaText,
        headlineAr: parsed.headlineAr,
        primaryTextAr: parsed.primaryTextAr,
        ctaTextAr: parsed.ctaTextAr,
        gbpPostBody: parsed.gbpPostBody,
        isApproved: parsed.isApproved,
        isEdited: hasCopyEdit ? true : creative.isEdited,
      },
    });
    if (updateResult.count !== 1) {
      throw new ApiError("Creative not found in this project", 404);
    }
    const updated = await prisma.adCreative.findUniqueOrThrow({
      where: { id: creativeId },
    });

    return c.json({ creative: serializeCreative(updated as never) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// POST /api/sabt-pack/:projectId/approve  — bulk approve all 7 slots
// =============================================================================

sabtPackRoute.post("/:projectId/approve", async (c) => {
  try {
    const auth = c.var.auth;
    const projectId = c.req.param("projectId");
    const project = await loadProjectForUser(projectId, auth.clerkId);
    ensureSabtPackEnabled(project.restaurant);

    await prisma.$transaction(async (tx) => {
      await tx.adCreative.updateMany({
        where: { projectId },
        data: { isApproved: true },
      });
      await tx.adProject.update({
        where: { id: projectId },
        data: {
          sabtPackStatus: "approved",
          sabtPackApprovedAt: new Date(),
        },
      });
    });

    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// POST /api/sabt-pack/:projectId/skip  — owner opts out of this week
// =============================================================================
//
// Marks the current pack as approved-but-skipped so the dashboard banner
// disappears. Doesn't delete creatives — the owner can still come back and
// review them later. Conceptually equivalent to "I saw it, don't bug me."

sabtPackRoute.post("/:projectId/skip", async (c) => {
  try {
    const auth = c.var.auth;
    const projectId = c.req.param("projectId");
    const project = await loadProjectForUser(projectId, auth.clerkId);
    ensureSabtPackEnabled(project.restaurant);

    await prisma.adProject.update({
      where: { id: projectId },
      data: {
        sabtPackStatus: "approved",
        sabtPackApprovedAt: new Date(),
      },
    });
    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

// =============================================================================
// POST /api/sabt-pack/:projectId/export  — download approved posts as a ZIP
// =============================================================================
//
// Bundles every *approved* slot into a posting-ready ZIP: one folder per post
// with its image(s) + caption, an all-in-one captions.md, and a schedule
// README. Organic content, so no Meta audiences/pixel — just the assets the
// owner pastes into each app. Requires at least one approved slot.

sabtPackRoute.post("/:projectId/export", async (c) => {
  try {
    const auth = c.var.auth;
    const projectId = c.req.param("projectId");
    const project = await loadProjectForUser(projectId, auth.clerkId);
    ensureSabtPackEnabled(project.restaurant);

    // ZIP builds fetch + repack every image; rate-limit like Ad Studio exports
    // so a tap-loop can't pin the container. Shares the AdExport-counting cap.
    await enforceExportRateLimit(project.restaurantId);

    const approved = project.creatives.filter((cr) => cr.isApproved);
    if (approved.length === 0) {
      throw new ApiError("Approve at least one post before downloading.", 400);
    }

    const result = await buildSabtPackBundle({
      projectId: project.id,
      restaurantId: project.restaurantId,
      restaurantName: project.restaurant.name,
      weekStartDate: project.sabtPackWeekStartDate,
      themeOfWeek: project.sabtPackThemeOfWeek,
      slots: approved.map((cr) => ({
        slot: cr.sabtPackSlot,
        format: cr.sabtPackSlotFormat,
        headline: cr.headline,
        primaryText: cr.primaryText,
        ctaText: cr.ctaText,
        headlineAr: cr.headlineAr,
        primaryTextAr: cr.primaryTextAr,
        ctaTextAr: cr.ctaTextAr,
        heroImageUrl: cr.heroImageUrl,
        slideshowFrames: Array.isArray(cr.sabtPackSlideshowFrames)
          ? (cr.sabtPackSlideshowFrames as string[])
          : null,
        gbpPostBody: cr.gbpPostBody,
        scheduledFor: cr.scheduledFor,
      })),
    });

    return c.json({
      ok: true,
      signedUrl: result.signedUrl,
      expiresAt: result.expiresAt,
      fileSizeBytes: result.fileSizeBytes,
      postCount: approved.length,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});
