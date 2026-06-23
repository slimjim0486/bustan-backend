export type SeoPillar = "gbp" | "onPage" | "rankGrid" | "citations" | "reviews";
export type SeoSeverity = "critical" | "high" | "medium" | "low";

export type SeoProgressStep =
  | "gbp"
  | "reviews"
  | "onPage"
  | "rankGrid"
  | "citations"
  | "synthesis";

export type SeoProgressStatus = "queued" | "running" | "done" | "failed";

export type SeoProgress = Record<SeoProgressStep, SeoProgressStatus>;

export interface RestaurantSeoContext {
  id: string;
  name: string;
  cuisineType: string | null;
  location: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  deliverooUrl: string | null;
  talabatUrl: string | null;
  uberEatsUrl: string | null;
  operatingHours: unknown;
  gbpConnection: {
    placeId: string | null;
    gbpUrl: string | null;
  } | null;
}

export interface GbpData {
  placeId: string | null;
  name: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  hours: unknown;
  categories: string[];
  photosCount: number;
  photoUrls?: string[];
  rating: number | null;
  reviewCount: number | null;
  latitude: number | null;
  longitude: number | null;
  popularTimes: unknown;
}

export interface ReviewData {
  reviews: Array<{
    text: string;
    rating: number | null;
    publishedAt: string | null;
    ownerResponse: string | null;
  }>;
  averageRating: number | null;
  responseRate: number | null;
  themes: Array<{
    theme: string;
    count: number;
    sentiment: "positive" | "negative" | "mixed";
    /**
     * Short (~80 char) representative excerpts pulled from the actual reviews
     * that triggered this theme. Used by the audit's Voice of Customer card.
     * Older cached reports won't have this; frontend should treat as optional.
     */
    quotes?: string[];
  }>;
}

export interface RankGridCell {
  row: number;
  col: number;
  lat: number | null;
  lng: number | null;
  rank: number | null;
}

export interface RankGridKeywordResult {
  keyword: string;
  averageRank: number | null;
  foundCells: number;
  cells: RankGridCell[];
}

export interface RankGridData {
  keywords: RankGridKeywordResult[];
}

export interface OnPageData {
  url: string | null;
  title: string | null;
  metaDescription: string | null;
  schemaTypes: string[];
  hasRestaurantSchema: boolean;
  lcpEstimateMs: number | null;
  mobileFriendly: boolean | null;
  missingImageAltCount: number;
  pageCount: number;
}

export interface CitationPlatformResult {
  platform: "Google" | "Talabat" | "Deliveroo";
  url: string | null;
  found: boolean;
  name: string | null;
  address: string | null;
  phone: string | null;
  hours: unknown;
  matches: {
    name: boolean | null;
    address: boolean | null;
    phone: boolean | null;
    hours: boolean | null;
  };
  /**
   * 0..1 confidence that the matched listing is this restaurant (name match).
   * `null` when not comparable. Lets the report distinguish a confirmed match
   * from a likely one. Owner-supplied/saved URLs are trusted at 1.
   */
  nameConfidence: number | null;
}

export interface CitationsData {
  platforms: CitationPlatformResult[];
}

export interface CollectorOutput {
  gbp: GbpData | null;
  reviews: ReviewData | null;
  rankGrid: RankGridData | null;
  onPage: OnPageData | null;
  citations: CitationsData | null;
  failures: Array<{
    collector: string;
    message: string;
  }>;
  estimatedApifyCostUsd: number;
}

export interface ScorecardPillar {
  key: SeoPillar;
  label: string;
  score: number;
  summary: string;
  signals: string[];
  degraded?: boolean;
}

export interface SeoScorecard {
  overallScore: number;
  pillars: {
    gbp: ScorecardPillar;
    onPage: ScorecardPillar;
    rankGrid: ScorecardPillar;
    citations: ScorecardPillar;
    reviews: ScorecardPillar;
  };
}

export type SeoActionTarget =
  | "edit_profile"
  | "edit_menu"
  | "edit_photos"
  | "improve_descriptions"
  | "connect_gbp"
  | "open_gbp"
  | "open_talabat"
  | "open_deliveroo"
  | "open_website";

export interface SeoRecommendation {
  pillar: SeoPillar;
  severity: SeoSeverity;
  title: string;
  why: string;
  action: string;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
  actionTarget?: SeoActionTarget | null;
  actionLabel?: string | null;
  actionUrl?: string | null;
  actionExternal?: boolean;
  dismissedAt?: string | null;
}
