import type {
  CitationPlatformResult,
  CollectorOutput,
  GbpData,
  OnPageData,
  RestaurantSeoContext,
  ReviewData,
  SeoProgressStatus,
  SeoRecommendation,
  ScorecardPillar,
} from "@/services/seo/types";

export type AuditProgressStep =
  | "gbp"
  | "reviews"
  | "onPage"
  | "citations"
  | "pageSpeed"
  | "peers"
  | "photos"
  | "synthesis"
  | "recommendations";

export type AuditProgress = Record<AuditProgressStep, SeoProgressStatus>;

export type AuditPillar =
  | "discoverability"
  | "reputation"
  | "delivery"
  | "photo"
  | "mobile";

export interface AuditRestaurantContext extends RestaurantSeoContext {
  id: string;
  name: string;
  location: string;
}

export interface PageSpeedData {
  url: string | null;
  performanceScore: number | null;
  accessibilityScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  diagnostics: string[];
}

export interface PhotoVisionScore {
  url: string;
  score: number;
  lighting: number;
  composition: number;
  foodAppeal: number;
  notes: string;
}

export interface PhotoVisionData {
  aggregateScore: number | null;
  photos: PhotoVisionScore[];
  summary: string;
}

export interface PeerBenchmarkPlace {
  name: string | null;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
}

export interface PeerBenchmarkData {
  cuisine: string | null;
  location: string;
  medianRating: number | null;
  medianReviewCount: number | null;
  /**
   * Directional 0-100 score for the peer cohort built from rating + review
   * count. Only populated when the cohort has ≥ 5 peers; otherwise null and
   * the frontend hides the comparison line.
   */
  averagePeerScore: number | null;
  peers: PeerBenchmarkPlace[];
}

export interface AuditCollectorOutput extends CollectorOutput {
  onPage: OnPageData | null;
  reviews: ReviewData | null;
  gbp: GbpData | null;
  citations: {
    platforms: CitationPlatformResult[];
  } | null;
  pageSpeed: PageSpeedData | null;
  photoVision: PhotoVisionData | null;
  peerBenchmark: PeerBenchmarkData | null;
}

export type AuditPillarStatus = "ok" | "not_assessed";

export interface AuditScorecardPillar extends Omit<ScorecardPillar, "key"> {
  key: AuditPillar;
  /**
   * "not_assessed" means the collector couldn't return enough data to score
   * this pillar honestly. Frontend renders these neutrally — no score badge,
   * not flagged as CRITICAL — and overall-score weighting excludes them.
   * Older cached reports without this field default to "ok".
   */
  status?: AuditPillarStatus;
}

export interface AuditPeerComparison {
  /**
   * Cohort label used in copy ("Italian restaurants in Dubai Media City").
   * Backend builds this from cuisine + location.
   */
  cohortLabel: string;
  cohortSize: number;
  /**
   * Composite directional score for peers, 0-100, derived from peer rating +
   * review count. Not perfectly comparable to the subject's overallScore, but
   * good enough for a one-line comparison.
   */
  averagePeerScore: number | null;
  yourScore: number;
  /** Your overall score minus averagePeerScore (positive = ahead). */
  diff: number | null;
}

export interface AuditScorecard {
  overallScore: number;
  pillars: Record<AuditPillar, AuditScorecardPillar>;
  /** Present when we have ≥ 5 peers to compare against. */
  peerComparison?: AuditPeerComparison | null;
}

export interface AuditSynthesis {
  executiveSummary: string;
  photoCritique: string;
  peerNarrative: string;
  tokensIn: number;
  tokensOut: number;
}

export interface AuditRecommendationResult {
  recommendations: SeoRecommendation[];
  tokensIn: number;
  tokensOut: number;
}
