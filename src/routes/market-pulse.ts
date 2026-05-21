// Market Pulse API routes.
//
// Mounted at /api/market-pulse. All endpoints require auth and enforce that
// the calling user owns the restaurant in the URL.
//
// Phase 3b scope: a single read endpoint used by the Ad Studio prefill page
// when the owner clicks a Market Pulse alert in the Sous Chef Inbox. The
// inbox-card link looks like:
//   /dashboard/ad-studio/new?from=market-pulse&intent=lunch_promo_match&digestId=cuid
// The frontend reads digestId from the URL and calls this endpoint to render
// the prefill banner + seed the brief.

import { Hono } from "hono";
import { ApiError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { getRestaurantEntitlements, getCompetitorIntelUpgradeMessage } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/middleware/auth";

export const marketPulseRoute = new Hono<{
  Variables: { auth: { clerkId: string; email: string | null; fullName: string | null } };
}>();
marketPulseRoute.use("*", requireAuth);

// =============================================================================
// GET /api/market-pulse/restaurants/:restaurantId/digests/:digestId
// =============================================================================

marketPulseRoute.get(
  "/restaurants/:restaurantId/digests/:digestId",
  async (c) => {
    try {
      const auth = c.var.auth;
      const restaurantId = c.req.param("restaurantId");
      const digestId = c.req.param("digestId");

      // Ownership check up-front so a guessable digestId from another tenant
      // can't be leaked just by knowing it.
      const restaurant = await prisma.restaurant.findFirst({
        where: { id: restaurantId, owner: { clerkId: auth.clerkId } },
        include: {
          subscription: true,
          operatorAccount: { include: { _count: { select: { brands: true } } } },
        },
      });
      if (!restaurant) throw new ApiError("Restaurant not found", 404);

      const ents = getRestaurantEntitlements(restaurant);
      if (!ents.competitorIntelligenceEnabled) {
        throw new ApiError(getCompetitorIntelUpgradeMessage(), 402);
      }

      const digest = await prisma.competitorIntelDigest.findFirst({
        where: { id: digestId, restaurantId },
        select: {
          id: true,
          weekBucket: true,
          topInsight: true,
          recommendedAction: true,
          competitorsCount: true,
          notifiedAt: true,
          generatedAt: true,
        },
      });
      if (!digest) throw new ApiError("Digest not found", 404);

      // Pull a small slice of the source snapshots so the prefill page can
      // show "From your Monday Market Pulse: <insight> — based on activity
      // from <Operation: Falafel, Mama's, …>". Keep the projection tight;
      // the prefill page only needs names + a couple of changes for context.
      const snapshots = await prisma.competitorSnapshot.findMany({
        where: { restaurantId, weekBucket: digest.weekBucket },
        orderBy: { distanceMeters: "asc" },
        take: 5,
        select: {
          name: true,
          distanceMeters: true,
          cuisine: true,
          changes: true,
        },
      });

      return c.json({
        digest: {
          id: digest.id,
          weekBucket: digest.weekBucket,
          topInsight: digest.topInsight,
          recommendedAction: digest.recommendedAction,
          competitorsCount: digest.competitorsCount,
          notifiedAt: digest.notifiedAt?.toISOString() ?? null,
          generatedAt: digest.generatedAt.toISOString(),
        },
        competitors: snapshots.map((s) => ({
          name: s.name,
          distanceMeters: s.distanceMeters,
          cuisine: s.cuisine,
          changes: s.changes,
        })),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  }
);
