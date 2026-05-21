// Shared types for Market Pulse / Competitor Intelligence.
//
// Mirrors the audit module's CollectorResult<T> shape so the orchestrator
// can settle collectors with the same generic settleCollector() helper.

export interface CompetitorIntelRestaurantContext {
  id: string;
  name: string;
  cuisine: string | null;
  location: string | null;
  placeId: string | null;
}

export interface NearbyCompetitor {
  placeId: string;
  name: string;
  address: string | null;
  cuisine: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** Approximate driving distance in meters from the subject restaurant.
   *  Null when geometry wasn't available — we still surface the competitor
   *  but can't rank by proximity. */
  distanceMeters: number | null;
}

export interface CompetitorIntelCollectorResult<T> {
  data: T;
  estimatedCostUsd: number;
  /** "ok" when the call ran (even if it returned empty results),
   *  "disabled" when EXA_ENABLED is false or the key is missing,
   *  "skipped" when we proactively bailed (e.g. monthly cap reached). */
  status: "ok" | "disabled" | "skipped";
}

export interface MenuItemSignal {
  name: string;
  price: number | null;
  currency: string | null;
  isNew: boolean;
  source: string | null;
}

export interface PromoSignal {
  title: string;
  description: string | null;
  validUntil: string | null;
  source: string | null;
  publishedAt: string | null;
}

export interface PressMentionSignal {
  title: string;
  url: string;
  publishedAt: string | null;
  publication: string | null;
}

export interface WebReviewSignal {
  snippet: string;
  source: string | null;
  url: string;
  sentiment: "positive" | "neutral" | "negative" | null;
  publishedAt: string | null;
}

export interface CompetitorChanges {
  addedDishes: MenuItemSignal[];
  removedDishes: { name: string }[];
  priceChanges: { name: string; oldPrice: number | null; newPrice: number | null }[];
  newPromos: PromoSignal[];
}

export type CollectorName = "menu" | "promo" | "press" | "reviews";
export type CollectorStatus = "ok" | "failed" | "skipped" | "disabled";
export type CollectorStatusMap = Record<CollectorName, CollectorStatus>;
