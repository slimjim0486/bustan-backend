// Sous Chef review pull service.
//
// Wraps the Apify google-maps-reviews-scraper (already used by the SEO
// pipeline for aggregate-rating data) and PERSISTS individual reviews into
// the gbp_reviews table for the Phase 3 review-reply drafting flow.
//
// Throttled by GbpConnection.reviewsSyncedAt — Apify costs ~$0.50 per 50
// reviews so a Pro restaurant pulling on every chat ask would burn budget
// fast. Default refresh window: 6 hours.

import { runActor } from "@/lib/apify";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { GbpReviewSource, GbpReviewStatus } from "@prisma/client";

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface NormalizedReview {
  externalId: string;
  reviewerName: string;
  reviewerPhotoUrl: string | null;
  rating: number;
  text: string;
  publishedAt: Date | null;
  language: string | null;
  ownerResponse: string | null;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function normalizeReview(
  item: Record<string, unknown>,
  fallbackIndex: number
): NormalizedReview | null {
  const text = firstString(item, ["text", "reviewText", "review", "content"]) ?? "";
  const rating = firstNumber(item, ["stars", "rating", "reviewRating"]);
  const reviewerName = firstString(item, ["name", "reviewerName", "userName", "authorName"]);

  // Reject rows that don't have either text or rating — usually noise from
  // the actor's pagination overflow.
  if (!text && rating === null) return null;
  if (rating === null) return null;
  if (!reviewerName) return null;

  // Stable external id for dedupe across re-pulls. Apify exposes different
  // keys depending on the actor version; try each before falling back to a
  // composite key (reviewer + date), which is good enough since Google won't
  // let the same user post two reviews for the same place.
  const externalId =
    firstString(item, ["reviewId", "reviewerId", "id"]) ??
    `${reviewerName}|${firstString(item, ["publishedAtDate", "publishedAt", "date"]) ?? `fallback-${fallbackIndex}`}`;

  return {
    externalId,
    reviewerName,
    reviewerPhotoUrl: firstString(item, ["reviewerPhotoUrl", "userPhotoUrl", "photoUrl"]),
    rating: Math.max(1, Math.min(5, Math.round(rating))),
    text,
    publishedAt: parseDate(
      firstString(item, ["publishedAtDate", "publishedAt", "date", "reviewDate"])
    ),
    language: firstString(item, ["originalLanguage", "language", "lang"]),
    ownerResponse: firstString(item, ["responseFromOwnerText", "ownerResponse", "replyText"]),
  };
}

interface PullResult {
  status: "fresh" | "throttled" | "no_connection" | "no_place_id";
  newReviews: number;
  updatedReviews: number;
  totalSeen: number;
}

/**
 * Pulls reviews from Apify and upserts into gbp_reviews. Returns counts
 * suitable for the chat tool to surface ("pulled 12 new reviews"). Respects
 * the 6h throttle unless `force=true`.
 */
export async function pullGoogleReviews(
  restaurantId: string,
  options: { force?: boolean; maxReviews?: number } = {}
): Promise<PullResult> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      name: true,
      address: true,
      location: true,
      phone: true,
      website: true,
      cuisineType: true,
      gbpConnection: true,
    },
  });
  if (!restaurant?.gbpConnection) {
    return { status: "no_connection", newReviews: 0, updatedReviews: 0, totalSeen: 0 };
  }

  const lastSync = restaurant.gbpConnection.reviewsSyncedAt;
  if (!options.force && lastSync && Date.now() - lastSync.getTime() < REFRESH_INTERVAL_MS) {
    return { status: "throttled", newReviews: 0, updatedReviews: 0, totalSeen: 0 };
  }

  const placeId = restaurant.gbpConnection.placeId;
  const searchStrings = !placeId
    ? [
        [restaurant.name, restaurant.address ?? restaurant.location]
          .filter(Boolean)
          .join(" "),
        restaurant.name,
      ].filter(Boolean)
    : undefined;

  if (!placeId && (!searchStrings || searchStrings.length === 0)) {
    return { status: "no_place_id", newReviews: 0, updatedReviews: 0, totalSeen: 0 };
  }

  const maxReviews = Math.min(options.maxReviews ?? 50, 100);
  const result = await runActor<Record<string, unknown>>(
    env.APIFY_ACTOR_GMAPS_REVIEWS,
    {
      placeIds: placeId ? [placeId] : undefined,
      searchStringsArray: !placeId ? searchStrings : undefined,
      maxReviews,
      maxReviewsPerPlace: maxReviews,
      reviewsLimit: maxReviews,
      language: "en",
      reviewsSort: "newest",
    },
    {
      timeoutMs: 300_000,
      maxItems: maxReviews,
      maxTotalChargeUsd: 0.5,
      memoryMbytes: 4096,
    }
  );

  const reviews = result.items
    .map((item, idx) => normalizeReview(item, idx))
    .filter((r): r is NormalizedReview => r !== null);

  let newReviews = 0;
  let updatedReviews = 0;
  for (const review of reviews) {
    const existing = await prisma.gbpReview.findUnique({
      where: { restaurantId_externalId: { restaurantId, externalId: review.externalId } },
      select: { id: true, ownerResponse: true, status: true },
    });

    if (!existing) {
      // Seed status from Apify's reply state — if Google already shows an
      // owner reply, we don't want Sous Chef to draft another one.
      const seedStatus = review.ownerResponse
        ? GbpReviewStatus.has_owner_reply
        : GbpReviewStatus.unanswered;
      await prisma.gbpReview.create({
        data: {
          restaurantId,
          source: GbpReviewSource.google,
          externalId: review.externalId,
          reviewerName: review.reviewerName,
          reviewerPhotoUrl: review.reviewerPhotoUrl,
          rating: review.rating,
          text: review.text,
          publishedAt: review.publishedAt,
          language: review.language,
          ownerResponse: review.ownerResponse,
          status: seedStatus,
        },
      });
      newReviews++;
    } else {
      // If the owner replied via Google directly after we drafted, we want
      // to flip our cached status so the inbox doesn't keep nagging.
      const shouldFlip =
        review.ownerResponse &&
        !existing.ownerResponse &&
        existing.status !== GbpReviewStatus.has_owner_reply;
      if (shouldFlip) {
        await prisma.gbpReview.update({
          where: { id: existing.id },
          data: {
            ownerResponse: review.ownerResponse,
            status: GbpReviewStatus.has_owner_reply,
          },
        });
        updatedReviews++;
      }
    }
  }

  await prisma.gbpConnection.update({
    where: { restaurantId },
    data: { reviewsSyncedAt: new Date() },
  });

  return { status: "fresh", newReviews, updatedReviews, totalSeen: reviews.length };
}

/**
 * Reads currently unanswered reviews from the DB. Caller (the chat tool)
 * decides whether to call pullGoogleReviews first to refresh.
 */
export async function listUnansweredReviews(
  restaurantId: string,
  options: { limit?: number } = {}
): Promise<
  Array<{
    id: string;
    reviewerName: string;
    rating: number;
    text: string;
    publishedAt: Date | null;
    language: string | null;
  }>
> {
  return prisma.gbpReview.findMany({
    where: { restaurantId, status: GbpReviewStatus.unanswered },
    orderBy: [{ rating: "asc" }, { publishedAt: "desc" }],
    take: Math.min(options.limit ?? 12, 25),
    select: {
      id: true,
      reviewerName: true,
      rating: true,
      text: true,
      publishedAt: true,
      language: true,
    },
  });
}
