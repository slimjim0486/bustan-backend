// Find nearby competitors for a subject restaurant.
//
// Reuses the Apify Google Maps actor (env.APIFY_ACTOR_GMAPS) we already
// run for the audit's peer-benchmark collector. The actor returns places
// with `placeId`, `title`, `address`, `totalScore` (rating), `reviewsCount`,
// `categoryName`, and (sometimes) a geo block with `location.lat/lng`.
//
// We rank results by approximate distance when geometry is available,
// then cap at the tier's maxCompetitors entitlement. The subject restaurant
// is filtered out by name-similarity AND by placeId match (when known).
//
// Cost note: ~$0.18 per actor run (same as peer-benchmark). This is paid
// per restaurant per week regardless of how many competitors are returned,
// so the marginal cost of going from 5 → 10 competitors is zero on the
// proximity side. The Exa side scales with competitor count.

import { runActor } from "@/lib/apify";
import { env } from "@/lib/env";
import type {
  CompetitorIntelCollectorResult,
  CompetitorIntelRestaurantContext,
  NearbyCompetitor,
} from "./types";

interface ApifyPlaceLocation {
  lat?: number;
  lng?: number;
}

interface ApifyPlace extends Record<string, unknown> {
  placeId?: string;
  title?: string;
  name?: string;
  address?: string;
  totalScore?: number;
  rating?: number;
  reviewsCount?: number;
  reviewCount?: number;
  categoryName?: string;
  category?: string;
  location?: ApifyPlaceLocation;
}

function firstString(source: ApifyPlace, keys: (keyof ApifyPlace)[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(source: ApifyPlace, keys: (keyof ApifyPlace)[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function isSameRestaurant(
  candidate: ApifyPlace,
  subject: CompetitorIntelRestaurantContext
): boolean {
  if (subject.placeId && candidate.placeId === subject.placeId) return true;
  const candidateName =
    firstString(candidate, ["title", "name"]) ?? "";
  if (!candidateName) return false;
  const a = normalizeName(candidateName);
  const b = normalizeName(subject.name);
  return a.includes(b) || b.includes(a);
}

export async function collectNearbyCompetitors(
  subject: CompetitorIntelRestaurantContext,
  maxCompetitors: number
): Promise<CompetitorIntelCollectorResult<NearbyCompetitor[]>> {
  if (maxCompetitors <= 0) {
    return { data: [], estimatedCostUsd: 0, status: "skipped" };
  }

  const cuisine = subject.cuisine ?? "restaurant";
  const location = subject.location ?? "UAE";

  // Ask for 2x the cap so we can drop the subject + low-signal places and
  // still hit the requested count. Apify charges per-item; overshooting by
  // 2x only adds ~$0.04 in the worst case.
  const searchCap = Math.min(maxCompetitors * 2, 25);

  const result = await runActor<ApifyPlace>(
    env.APIFY_ACTOR_GMAPS,
    {
      searchStringsArray: [`${cuisine} near ${location}`],
      maxCrawledPlacesPerSearch: searchCap,
      language: "en",
      includeOpeningHours: false,
      maxImages: 0,
    },
    {
      timeoutMs: 120_000,
      estimateCostUsd: 0.18,
      maxItems: searchCap,
      maxTotalChargeUsd: 0.25,
      memoryMbytes: 4096,
    }
  );

  // Resolve subject coordinates by finding the subject in the result set
  // (Apify often returns the subject as item 0 when its placeId matches).
  // If we can't, distance ranking is null and we fall back to insertion
  // order (Apify's relevance ranking).
  let subjectCoords: { lat: number; lng: number } | null = null;
  for (const item of result.items) {
    if (isSameRestaurant(item, subject)) {
      const lat = item.location?.lat;
      const lng = item.location?.lng;
      if (typeof lat === "number" && typeof lng === "number") {
        subjectCoords = { lat, lng };
        break;
      }
    }
  }

  const competitors: NearbyCompetitor[] = result.items
    .filter((item) => !isSameRestaurant(item, subject))
    .filter((item) => Boolean(item.placeId))
    .map((item) => {
      const lat = item.location?.lat;
      const lng = item.location?.lng;
      const distanceMeters =
        subjectCoords && typeof lat === "number" && typeof lng === "number"
          ? haversineMeters(subjectCoords, { lat, lng })
          : null;
      return {
        placeId: item.placeId as string,
        name: firstString(item, ["title", "name"]) ?? "Unknown",
        address: firstString(item, ["address"]),
        cuisine: firstString(item, ["categoryName", "category"]),
        rating: firstNumber(item, ["totalScore", "rating"]),
        reviewCount: firstNumber(item, ["reviewsCount", "reviewCount"]),
        distanceMeters,
      };
    });

  // Rank: distance ASC (nulls last), then review count DESC as tiebreaker
  // (more reviews = more relevant signal for the dashboard).
  competitors.sort((a, b) => {
    const ad = a.distanceMeters ?? Number.MAX_SAFE_INTEGER;
    const bd = b.distanceMeters ?? Number.MAX_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    return (b.reviewCount ?? 0) - (a.reviewCount ?? 0);
  });

  return {
    data: competitors.slice(0, maxCompetitors),
    estimatedCostUsd: result.estimatedCostUsd,
    status: "ok",
  };
}
