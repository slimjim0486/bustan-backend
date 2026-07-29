import { runActor } from "@/lib/apify";
import { env } from "@/lib/env";
import type {
  AuditRestaurantContext,
  PeerBenchmarkData,
  PeerBenchmarkPlace,
} from "./types";

function firstString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizePlace(item: Record<string, unknown>): PeerBenchmarkPlace {
  return {
    name: firstString(item, ["title", "name", "placeName"]),
    rating: firstNumber(item, ["totalScore", "rating", "stars"]),
    reviewCount: firstNumber(item, ["reviewsCount", "reviewCount", "numberOfReviews"]),
    address: firstString(item, ["address", "street", "fullAddress"]),
  };
}

/**
 * Compose a directional 0-100 discovery proxy from peer rating + review count.
 * Not a real audit score — we don't run the full pipeline on peers — but it
 * lets us answer "are we ahead of or behind nearby competition?" in one line.
 *
 * Weighting: 70% rating signal (0-100 from 1-5 stars), 30% review-volume
 * signal (logarithmic; 200+ reviews tops out the volume contribution).
 */
function computePeerScore(rating: number | null, reviewCount: number | null): number | null {
  if (rating === null && reviewCount === null) return null;
  const ratingPart = rating !== null ? Math.min(100, Math.max(0, ((rating - 1) / 4) * 100)) : 50;
  const volumePart =
    reviewCount !== null
      ? Math.min(100, Math.round((Math.log10(Math.max(reviewCount, 1)) / Math.log10(200)) * 100))
      : 30;
  return Math.round(ratingPart * 0.7 + volumePart * 0.3);
}

export async function collectPeerBenchmarkData(
  restaurant: AuditRestaurantContext,
  cuisineHint: string | null | undefined
): Promise<{ data: PeerBenchmarkData; estimatedCostUsd: number }> {
  const cuisine = cuisineHint || restaurant.cuisineType || "restaurant";
  const result = await runActor<Record<string, unknown>>(
    env.APIFY_ACTOR_GMAPS,
    {
      searchStringsArray: [`${cuisine} near ${restaurant.location}`],
      maxCrawledPlacesPerSearch: 10,
      language: "en",
      includeOpeningHours: false,
      maxImages: 0,
    },
    {
      timeoutMs: 120_000,
      estimateCostUsd: 0.18,
      maxItems: 10,
      maxTotalChargeUsd: 0.25,
      memoryMbytes: 4096,
    }
  );

  const peers = result.items
    .map(normalizePlace)
    .filter((peer) => peer.name)
    // Drop the subject restaurant if it appears in its own peer search.
    .filter((peer) => {
      if (!peer.name) return false;
      const normalizedSelf = restaurant.name.toLowerCase().replace(/\s+/g, "");
      const normalizedPeer = peer.name.toLowerCase().replace(/\s+/g, "");
      return !normalizedPeer.includes(normalizedSelf) && !normalizedSelf.includes(normalizedPeer);
    })
    .slice(0, 10);

  const ratings = peers
    .map((peer) => peer.rating)
    .filter((value): value is number => value !== null);
  const reviewCounts = peers
    .map((peer) => peer.reviewCount)
    .filter((value): value is number => value !== null);

  const peerScores = peers
    .map((peer) => computePeerScore(peer.rating, peer.reviewCount))
    .filter((value): value is number => value !== null);

  // Need at least 5 peers for the comparison to be statistically meaningful.
  // Below that, return null so the frontend hides the comparison line.
  const averagePeerScore =
    peerScores.length >= 5
      ? Math.round(peerScores.reduce((sum, value) => sum + value, 0) / peerScores.length)
      : null;

  return {
    data: {
      cuisine,
      location: restaurant.location,
      medianRating: median(ratings),
      medianReviewCount: median(reviewCounts),
      averagePeerScore,
      peers,
    },
    estimatedCostUsd: result.estimatedCostUsd,
  };
}
