// Market Pulse orchestrator — runs the weekly competitor-intel pass for
// one restaurant. Designed to be called from:
//   • backend/src/queue/competitor-intel.ts (Sunday cron fanout — primary)
//   • backend/scripts/competitor-intel-trigger.ts (manual / dogfood)
//   • An owner-initiated refresh route (Phase 2 — rate-limited by entitlement)
//
// Per-competitor flow:
//   1. Look for a cache row in CompetitorSnapshot with the same
//      (competitorPlaceId, weekBucket) but a different restaurantId. If
//      one exists with Exa-derived payloads filled in, clone them — we
//      pay Exa once per neighborhood per week, not once per subscriber.
//   2. On cache miss, run the four Exa collectors in parallel, record
//      spend in ai_usage_logs, and check the per-restaurant monthly cap
//      between collectors so a single restaurant can't blow past the
//      ceiling in one pass.
//   3. Compute week-over-week diff against the SAME (restaurantId,
//      competitorPlaceId) snapshot from the previous weekBucket. The
//      diff is what Sous Chef surfaces ("they added X, dropped Y").
//   4. Upsert the CompetitorSnapshot row.
//
// What the orchestrator does NOT do:
//   • Send notifications. The cron/digest synthesizer (Phase 3) handles
//     the Monday-morning Sous Chef push.
//   • Run the digest synthesizer. That's a separate pass that runs after
//     ALL competitors for the week land, so the insight can compare them.

import { Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { exaIsEnabled } from "@/lib/exa";
import { prisma } from "@/lib/prisma";
import { getRestaurantEntitlements } from "@/lib/entitlements";
import { sundayOfThisWeekUae } from "@/services/sabt-pack";
import {
  checkRestaurantExaBudget,
  recordExaSpend,
} from "./budget";
import { computeCompetitorChanges } from "./diff";
import { synthesizeMarketPulseDigest, type MarketPulseDigest } from "./digest-synthesizer";
import { ensureMarketPulseDraft, type MarketPulseDraftResult } from "./draft-creator";
import {
  collectMenuSignals,
  collectPressSignals,
  collectPromoSignals,
  collectWebReviewSignals,
} from "./exa-collectors";
import { collectNearbyCompetitors } from "./proximity";
import type {
  CollectorName,
  CollectorStatusMap,
  CompetitorIntelCollectorResult,
  CompetitorIntelRestaurantContext,
  MenuItemSignal,
  NearbyCompetitor,
  PressMentionSignal,
  PromoSignal,
  WebReviewSignal,
} from "./types";

export interface RunCompetitorIntelArgs {
  restaurantId: string;
  /** Defaults to sundayOfThisWeekUae(). Override for backfills. */
  weekBucket?: string;
  /** "cron" by default; "manual" indicates owner-initiated and should
   *  bypass the cache (force a fresh fetch). */
  source?: "cron" | "manual";
}

export interface RunCompetitorIntelResult {
  status:
    | "completed"
    | "skipped_not_eligible"
    | "skipped_disabled"
    | "skipped_no_competitors"
    | "skipped_budget";
  weekBucket: string;
  competitorsProcessed: number;
  cacheHits: number;
  freshFetches: number;
  totalExaCostUsd: number;
  /** Present when status='completed' AND at least one snapshot landed. The
   *  digest may itself be null when synthesis failed (e.g. ANTHROPIC_API_KEY
   *  missing in local dev); orchestrator carries on regardless. */
  digest?: MarketPulseDigest | null;
  draft?: MarketPulseDraftResult;
  message?: string;
}

// Type-guard helper for the Promise.allSettled results.
function settled<T>(
  p: PromiseSettledResult<CompetitorIntelCollectorResult<T>>,
  fallback: T
): { data: T; cost: number; status: "ok" | "failed" | "disabled" | "skipped" } {
  if (p.status === "rejected") {
    return { data: fallback, cost: 0, status: "failed" };
  }
  return {
    data: p.value.data,
    cost: p.value.estimatedCostUsd,
    status: p.value.status === "ok" ? "ok" : p.value.status,
  };
}

function priorWeekBucket(weekBucket: string): string {
  const d = new Date(`${weekBucket}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

async function loadRestaurantContext(
  restaurantId: string
): Promise<CompetitorIntelRestaurantContext | null> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      name: true,
      location: true,
      cuisineType: true,
      gbpConnection: { select: { placeId: true } },
    },
  });
  if (!restaurant) return null;
  return {
    id: restaurant.id,
    name: restaurant.name,
    cuisine: restaurant.cuisineType ?? null,
    location: restaurant.location ?? null,
    placeId: restaurant.gbpConnection?.placeId ?? null,
  };
}

async function isEntitled(restaurantId: string): Promise<{
  ok: boolean;
  maxCompetitors: number;
}> {
  const source = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      subscriptionStatus: true,
      subscription: {
        select: { plan: true, status: true, stripeSubscriptionId: true },
      },
      operatorAccount: {
        select: { status: true, _count: { select: { brands: true } } },
      },
    },
  });
  if (!source) return { ok: false, maxCompetitors: 0 };
  const entitlements = getRestaurantEntitlements(source);
  return {
    ok: entitlements.competitorIntelligenceEnabled,
    maxCompetitors: entitlements.competitorIntelMaxCompetitors,
  };
}

interface CompetitorPayloads {
  menuItems: MenuItemSignal[];
  promotions: PromoSignal[];
  pressMentions: PressMentionSignal[];
  webReviews: WebReviewSignal[];
  collectorStatus: CollectorStatusMap;
}

async function fetchFromExa(
  competitor: NearbyCompetitor
): Promise<{ payloads: CompetitorPayloads; spendUsd: number }> {
  const [menuP, promoP, pressP, reviewsP] = await Promise.allSettled([
    collectMenuSignals(competitor),
    collectPromoSignals(competitor),
    collectPressSignals(competitor),
    collectWebReviewSignals(competitor),
  ]);

  const menu = settled(menuP, []);
  const promo = settled(promoP, []);
  const press = settled(pressP, []);
  const reviews = settled(reviewsP, []);

  const collectorStatus: CollectorStatusMap = {
    menu: menu.status,
    promo: promo.status,
    press: press.status,
    reviews: reviews.status,
  };

  return {
    payloads: {
      menuItems: menu.data,
      promotions: promo.data,
      pressMentions: press.data,
      webReviews: reviews.data,
      collectorStatus,
    },
    spendUsd: menu.cost + promo.cost + press.cost + reviews.cost,
  };
}

async function findCachePayload(
  competitorPlaceId: string,
  weekBucket: string,
  excludeRestaurantId: string
): Promise<CompetitorPayloads | null> {
  // We can't filter empty JSON arrays in a Prisma `where` clause (the
  // operators are designed for null vs non-null, not array length), so we
  // fetch the top few non-null rows and pick the first one with actual
  // content in TS. This bounds the per-cache-lookup work to ~5 rows.
  const candidates = await prisma.competitorSnapshot.findFirst({
    where: {
      competitorPlaceId,
      weekBucket,
      restaurantId: { not: excludeRestaurantId },
      OR: [
        { menuItems: { not: Prisma.AnyNull } },
        { promotions: { not: Prisma.AnyNull } },
        { pressMentions: { not: Prisma.AnyNull } },
        { webReviews: { not: Prisma.AnyNull } },
      ],
    },
    select: {
      menuItems: true,
      promotions: true,
      pressMentions: true,
      webReviews: true,
      collectorStatus: true,
    },
    orderBy: { fetchedAt: "desc" },
  });
  if (!candidates) return null;

  const menuItems = (candidates.menuItems as unknown as MenuItemSignal[]) ?? [];
  const promotions = (candidates.promotions as unknown as PromoSignal[]) ?? [];
  const pressMentions =
    (candidates.pressMentions as unknown as PressMentionSignal[]) ?? [];
  const webReviews =
    (candidates.webReviews as unknown as WebReviewSignal[]) ?? [];

  // Reject a cache hit when every payload is empty — a "successful" run
  // that returned no signal isn't worth cloning. Doing so would let one
  // restaurant's empty-result poison the whole neighborhood's week. Force
  // a fresh fetch in that case so we at least give it a second chance.
  const totalSignals =
    menuItems.length + promotions.length + pressMentions.length + webReviews.length;
  if (totalSignals === 0) return null;

  return {
    menuItems,
    promotions,
    pressMentions,
    webReviews,
    collectorStatus: (candidates.collectorStatus as unknown as CollectorStatusMap) ?? {
      menu: "ok",
      promo: "ok",
      press: "ok",
      reviews: "ok",
    },
  };
}

async function loadPriorWeekPayload(
  restaurantId: string,
  competitorPlaceId: string,
  weekBucket: string
): Promise<{
  menuItems: MenuItemSignal[];
  promotions: PromoSignal[];
} | null> {
  const prior = priorWeekBucket(weekBucket);
  const row = await prisma.competitorSnapshot.findUnique({
    where: {
      competitorPlaceId_weekBucket_restaurantId: {
        competitorPlaceId,
        weekBucket: prior,
        restaurantId,
      },
    },
    select: { menuItems: true, promotions: true },
  });
  if (!row) return null;
  return {
    menuItems: (row.menuItems as unknown as MenuItemSignal[]) ?? [],
    promotions: (row.promotions as unknown as PromoSignal[]) ?? [],
  };
}

export async function runCompetitorIntelForRestaurant(
  args: RunCompetitorIntelArgs
): Promise<RunCompetitorIntelResult> {
  const weekBucket = args.weekBucket ?? sundayOfThisWeekUae();
  const source = args.source ?? "cron";

  // Eligibility + kill-switch gates run before any spend.
  if (!exaIsEnabled()) {
    return {
      status: "skipped_disabled",
      weekBucket,
      competitorsProcessed: 0,
      cacheHits: 0,
      freshFetches: 0,
      totalExaCostUsd: 0,
      message: "EXA_ENABLED is false or EXA_API_KEY is missing",
    };
  }

  const ent = await isEntitled(args.restaurantId);
  if (!ent.ok) {
    return {
      status: "skipped_not_eligible",
      weekBucket,
      competitorsProcessed: 0,
      cacheHits: 0,
      freshFetches: 0,
      totalExaCostUsd: 0,
      message: "Restaurant not entitled to Market Pulse",
    };
  }

  const context = await loadRestaurantContext(args.restaurantId);
  if (!context) {
    return {
      status: "skipped_not_eligible",
      weekBucket,
      competitorsProcessed: 0,
      cacheHits: 0,
      freshFetches: 0,
      totalExaCostUsd: 0,
      message: "Restaurant not found",
    };
  }

  // Find the cohort. proximity.ts already handles the "no placeId, fall
  // back to text search" path.
  const proximity = await collectNearbyCompetitors(context, ent.maxCompetitors);
  if (proximity.data.length === 0) {
    return {
      status: "skipped_no_competitors",
      weekBucket,
      competitorsProcessed: 0,
      cacheHits: 0,
      freshFetches: 0,
      totalExaCostUsd: 0,
      message: "No nearby competitors discovered",
    };
  }

  let cacheHits = 0;
  let freshFetches = 0;
  let totalExaCostUsd = 0;

  for (const competitor of proximity.data) {
    // Manual mode bypasses cache so the owner who hit "Refresh" gets a
    // fresh pull, not a stale-but-shared row.
    let payloads: CompetitorPayloads | null = null;
    if (source !== "manual") {
      payloads = await findCachePayload(
        competitor.placeId,
        weekBucket,
        args.restaurantId
      );
    }

    let spendThisCompetitor = 0;
    if (payloads) {
      cacheHits++;
    } else {
      // Budget check BEFORE we spend. Max budget per competitor is the
      // sum of all four collectors (~$0.035). Skip if it would breach.
      const ESTIMATED_PER_COMPETITOR = 0.04;
      const budget = await checkRestaurantExaBudget(
        args.restaurantId,
        ESTIMATED_PER_COMPETITOR
      );
      if (!budget.allowed) {
        console.warn(
          `[market-pulse] ${args.restaurantId} hit monthly cap ($${budget.spentUsd.toFixed(2)}/$${budget.capUsd}) — stopping`
        );
        break;
      }

      const fetched = await fetchFromExa(competitor);
      payloads = fetched.payloads;
      spendThisCompetitor = fetched.spendUsd;
      totalExaCostUsd += spendThisCompetitor;
      freshFetches++;

      if (spendThisCompetitor > 0) {
        await recordExaSpend(args.restaurantId, spendThisCompetitor);
      }
    }

    const priorWeek = await loadPriorWeekPayload(
      args.restaurantId,
      competitor.placeId,
      weekBucket
    );
    const changes = computeCompetitorChanges(
      { menuItems: payloads.menuItems, promotions: payloads.promotions },
      priorWeek
    );

    await prisma.competitorSnapshot.upsert({
      where: {
        competitorPlaceId_weekBucket_restaurantId: {
          competitorPlaceId: competitor.placeId,
          weekBucket,
          restaurantId: args.restaurantId,
        },
      },
      create: {
        restaurantId: args.restaurantId,
        competitorPlaceId: competitor.placeId,
        weekBucket,
        name: competitor.name,
        address: competitor.address,
        distanceMeters: competitor.distanceMeters,
        cuisine: competitor.cuisine,
        rating: competitor.rating,
        reviewCount: competitor.reviewCount,
        menuItems: payloads.menuItems as unknown as Prisma.InputJsonValue,
        promotions: payloads.promotions as unknown as Prisma.InputJsonValue,
        pressMentions: payloads.pressMentions as unknown as Prisma.InputJsonValue,
        webReviews: payloads.webReviews as unknown as Prisma.InputJsonValue,
        collectorStatus: payloads.collectorStatus as unknown as Prisma.InputJsonValue,
        changes: changes as unknown as Prisma.InputJsonValue,
        exaCostUsd: spendThisCompetitor,
      },
      update: {
        // Refresh: name/address/rating may drift week-to-week even when
        // we cache the Exa payloads. Always persist the latest.
        name: competitor.name,
        address: competitor.address,
        distanceMeters: competitor.distanceMeters,
        cuisine: competitor.cuisine,
        rating: competitor.rating,
        reviewCount: competitor.reviewCount,
        menuItems: payloads.menuItems as unknown as Prisma.InputJsonValue,
        promotions: payloads.promotions as unknown as Prisma.InputJsonValue,
        pressMentions: payloads.pressMentions as unknown as Prisma.InputJsonValue,
        webReviews: payloads.webReviews as unknown as Prisma.InputJsonValue,
        collectorStatus: payloads.collectorStatus as unknown as Prisma.InputJsonValue,
        changes: changes as unknown as Prisma.InputJsonValue,
        // Don't overwrite exaCostUsd — keep the original fetch cost for
        // accurate per-row attribution. A refresh that hit the shared
        // cache cost $0 and we shouldn't claim otherwise.
        fetchedAt: new Date(),
      },
    });
  }

  console.log(
    `[market-pulse] ${args.restaurantId} week=${weekBucket} processed=${proximity.data.length} cacheHits=${cacheHits} fresh=${freshFetches} costUsd=${totalExaCostUsd.toFixed(4)}`
  );

  // Phase 3: synthesize the weekly digest + push it into the Sous Chef
  // Inbox as a single DraftAction. Both calls are best-effort — a failure
  // here must not invalidate the snapshot pass (which already succeeded).
  // The digest is upsert-keyed by (restaurantId, weekBucket) and the
  // draft is idempotent by digestId, so a retry of this whole orchestrator
  // call within the same week is safe.
  let digest: MarketPulseDigest | null = null;
  let draft: MarketPulseDraftResult | undefined;
  try {
    digest = await synthesizeMarketPulseDigest({
      restaurantId: args.restaurantId,
      weekBucket,
    });
    if (digest) {
      draft = await ensureMarketPulseDraft({
        restaurantId: args.restaurantId,
        digest,
      });
      console.log(
        `[market-pulse] ${args.restaurantId} digest=${digest.hasMovement ? "movement" : "quiet"} draft=${draft.status}`
      );
    }
  } catch (error) {
    console.warn(
      `[market-pulse] ${args.restaurantId} post-processing failed:`,
      error
    );
  }

  return {
    status: "completed",
    weekBucket,
    competitorsProcessed: proximity.data.length,
    cacheHits,
    freshFetches,
    totalExaCostUsd,
    digest,
    draft,
  };
}
