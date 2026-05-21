// Shared types for the Bustan Ad Creative Studio knowledge base.
// All data verified Q2 2026; see meta.ts for last-verified date and confidence flags.

export type CountryCode =
  | "AE" // UAE
  | "SA" // Saudi Arabia
  | "QA" // Qatar
  | "KW" // Kuwait
  | "BH" // Bahrain
  | "OM" // Oman
  | "EG" // Egypt
  | "JO" // Jordan
  | "LB"; // Lebanon

export type CurrencyCode = "AED" | "SAR" | "QAR" | "KWD" | "BHD" | "OMR" | "EGP" | "JOD" | "LBP" | "USD";

export type PlatformId =
  | "meta_feed"
  | "meta_reels"
  | "meta_stories"
  | "meta_carousel"
  | "meta_ctwa"
  | "tiktok_in_feed"
  | "tiktok_spark"
  | "tiktok_topview"
  | "snapchat_snap_ad"
  | "snapchat_story_ad"
  | "snapchat_collection"
  | "snapchat_ar_lens"
  | "snapchat_filter"
  | "snapchat_spotlight"
  | "google_search"
  | "google_pmax"
  | "google_demand_gen"
  | "youtube_in_stream"
  | "youtube_bumper"
  | "youtube_shorts"
  | "x_image"
  | "x_video"
  | "x_carousel"
  | "pinterest_pin"
  | "pinterest_video"
  | "whatsapp_status"
  | "whatsapp_template";

export type AspectRatio = "9:16" | "1:1" | "4:5" | "16:9" | "1.91:1" | "2:3" | "4:1";

export interface PixelDimensions {
  width: number;
  height: number;
}

export interface SafeZone {
  // Pixels assumed at 1080x1920 (9:16) unless format specifies otherwise.
  topPx: number;
  bottomPx: number;
  leftPx?: number;
  rightPx?: number;
  notes?: string;
}

export interface CharacterLimit {
  field: "headline" | "primary_text" | "description" | "caption" | "brand_name" | "long_headline" | "title" | "post_copy" | "media_headline" | "greeting_message" | "path";
  max: number;
  truncatedAt?: number; // Where the platform truncates with "see more" / etc.
  notes?: string;
}

export type CtaButton =
  | "Order Now"
  | "Order Food"
  | "Book Now"
  | "Reserve"
  | "Send Message"
  | "Send WhatsApp Message"
  | "Learn More"
  | "Get Offer"
  | "Get Directions"
  | "Call Now"
  | "Shop Now"
  | "Sign Up"
  | "Get Quote"
  | "Watch More"
  | "Install Now"
  | "Apply Now"
  | "More"
  | "Visit Site"
  | "Watch";

export type FundingCurrency = "AED" | "SAR" | "USD";

export interface PlatformFormat {
  id: PlatformId;
  platform: "meta" | "tiktok" | "snapchat" | "google" | "youtube" | "x" | "pinterest" | "whatsapp";
  surface: string; // e.g. "Reels", "Stories", "In-Feed"
  aspectRatios: AspectRatio[];
  recommendedPx: PixelDimensions;
  minPx?: PixelDimensions;
  maxVideoSeconds?: number;
  minVideoSeconds?: number;
  recommendedVideoSeconds?: { min: number; max: number };
  maxFileSizeMb?: number;
  fileTypes: string[]; // e.g. ["MP4", "MOV", "JPG"]
  safeZone?: SafeZone;
  characterLimits: CharacterLimit[];
  ctaButtons: CtaButton[];
  placement: string; // Where it appears in the host UX
  soundDefault: "sound_on" | "sound_off"; // Whether the audience defaults to sound on
  captionsRequired: boolean;
  notes?: string[];
}

// Performance benchmark (single metric)
export interface Benchmark {
  metric: "cpm" | "cpc" | "ctr" | "cvr" | "cpl" | "cpa_first_order" | "cpa_reservation" | "roas" | "video_completion_6s" | "video_completion_75pct" | "hook_rate_3s" | "redemption_rate";
  unit: "AED" | "USD" | "SAR" | "%" | "x";
  // Range, low to high typical for restaurants in MENA 2026.
  range: [number, number];
  // Where the value comes from.
  region?: "MENA" | "UAE" | "KSA" | "GCC" | "global" | "US";
  source?: string;
  confidence: "high" | "medium" | "low";
  asOf: string; // ISO-ish (e.g., "2026-Q2")
}

export interface PlatformBenchmarks {
  platformId: PlatformId | "meta" | "tiktok" | "snapchat" | "google" | "youtube" | "x" | "pinterest" | "whatsapp";
  vertical: "restaurant" | "fnb_general";
  metrics: Benchmark[];
}

export type FunnelStage = "tofu" | "mofu" | "bofu" | "retention";

export type CuisineFit =
  | "all"
  | "fine_dining"
  | "premium_casual"
  | "casual"
  | "qsr"
  | "cafe"
  | "dessert"
  | "streetfood"
  | "shawarma"
  | "mandi"
  | "mezze"
  | "lebanese"
  | "egyptian"
  | "khaleeji"
  | "indian"
  | "italian"
  | "asian"
  | "burger"
  | "pizza"
  | "sushi"
  | "brunch"
  | "kunafa"
  | "manakish"
  | "shisha"
  | "buffet"
  | "vegan"
  | "halal_certified";

export type SoundDesign = "asmr" | "trending_audio" | "voiceover_real" | "voiceover_synth" | "music_underscore" | "diegetic" | "silent";

export type EditingRhythm = "single_take" | "fast_cut_8_12" | "match_cut" | "stop_motion" | "split_screen" | "whip_pan" | "time_lapse";

export interface CreativeArchetype {
  id: string;
  name: string;
  // 1-2 sentence description for AI generator system prompt.
  why: string;
  bRollShots: string[];
  durationSec: { min: number; max: number };
  editingRhythm: EditingRhythm[];
  sound: SoundDesign[];
  textOverlay: string; // Description of overlay pattern.
  ctaPattern: string;
  bestPlatforms: PlatformId[];
  cuisineFits: CuisineFit[];
  funnelStages: FunnelStage[];
  failureModes: string[];
  menaAdaptation: string;
}

export type HookFatigue2026 = "low" | "mild" | "moderate" | "heavy" | "seasonal_peak";

export interface HookTemplate {
  id: string;
  // Fill-in template, e.g. "POV: you walked into [restaurant] and ordered the [dish]".
  template: string;
  templateAr?: string; // Arabic equivalent if applicable.
  bestPlatforms: PlatformId[];
  cuisineFits: CuisineFit[];
  funnelStages: FunnelStage[];
  voicingMode: "voiced" | "text" | "both";
  fatigue: HookFatigue2026;
  // Optional: which dialect to render in for MENA (default: bilingual).
  dialect?: "msa" | "khaleeji" | "egyptian" | "levantine" | "arabizi" | "english_only" | "bilingual";
  notes?: string;
}

export type CtaIntent = "reserve" | "order_delivery" | "visit_dine_in" | "engage" | "lead_gen" | "discount_led";

export interface CtaPattern {
  id: string;
  intent: CtaIntent;
  english: string;
  arabic?: string;
  bestPlatforms: PlatformId[];
  funnelStages: FunnelStage[];
  fatigue: HookFatigue2026;
  notes?: string;
}

export interface CopyFrameworkExample {
  cuisine: CuisineFit;
  language: "en" | "ar" | "bilingual";
  body: string;
}

export interface CopyFramework {
  id: string;
  name: string;
  acronym?: string; // AIDA, PAS, FAB, 4U
  description: string;
  // Step-by-step structure for the AI to fill.
  beats: Array<{ step: string; instruction: string }>;
  examples: CopyFrameworkExample[];
  bestFor: FunnelStage[];
}

export type CampaignType =
  | "soft_launch_awareness"
  | "grand_opening_blitz"
  | "iftar_fill_house"
  | "delivery_acquisition"
  | "weekday_reservation_fill"
  | "weekend_brunch_hero"
  | "birthday_club"
  | "weather_trigger_delivery"
  | "lto_menu_drop"
  | "influencer_led_launch"
  | "dormant_reactivation"
  | "catering_corporate_lead_gen"
  | "premium_brand_defense"
  | "multi_location_chain"
  // Festival- and season-specific archetypes (added 2026-05-21 to fix the
  // "Eid mapped to weekend_brunch_hero" gap — Eid prep, Eid event itself,
  // Summer Slump endurance play, National Day pride, etc.).
  | "pre_eid_lto"
  | "eid_brunch_hero"
  | "eid_al_adha_lamb_hero"
  | "summer_slowdown_combat"
  | "national_day_pride"
  | "back_to_school_family"
  | "restaurant_week_participant"
  | "dinner_for_two_date_night"
  | "ladies_night_thursday"
  // Free-form sentinel — owner described a campaign that doesn't fit any KB
  // archetype. Orchestrator branches on this to a synthesis prompt rather
  // than reading KB campaign attributes. Has no KB archetype entry; rows
  // in AdProject with campaignType="freeform" carry the owner's brief in
  // briefJson.campaignBrief.
  | "freeform"
  // Sabt Pack — synthetic campaign type for weekly auto-generated 7-post bundles.
  // Has no KB archetype entry (it's not a real campaign archetype owners can
  // choose in the wizard); only Sabt Pack rows in AdProject use this value.
  | "sabt_pack";

export interface CampaignArchetype {
  id: CampaignType;
  name: string;
  goal: string;
  primaryKpi: { metric: string; target: number; unit: "AED" | "%" | "x" | "count"; comparator: "lt" | "gt" };
  duration: { weeks: number | null; mode: "always_on" | "sprint" | "triggered" };
  budgetTiers: {
    lean: { minAed: number; maxAed: number };
    standard: { minAed: number; maxAed: number };
    aggressive: { minAed: number; maxAed: number };
  };
  // Percentage allocation per channel (must sum to 100).
  platformMix: Partial<Record<"meta" | "tiktok" | "snapchat" | "google" | "youtube" | "whatsapp" | "influencer" | "linkedin" | "email", number>>;
  funnelStages: { tofu: number; mofu: number; bofu: number; retention: number };
  audienceRecipeIds: string[];
  creativeMix: Array<{ archetypeId: string; sharePct: number }>;
  bidding: Partial<Record<"meta" | "tiktok" | "snapchat" | "google", string>>;
  landing: Array<"whatsapp" | "bustan_menu" | "reservation_widget" | "aggregator_deeplink" | "lead_form">;
  trackingEvents: string[];
  benchmarks: {
    cpmAed?: [number, number];
    ctrPct?: [number, number];
    cpaAed?: [number, number];
    roas?: [number, number];
    cplAed?: [number, number];
  };
  failureModes: string[];
  seasonalMods: Array<{ season: string; modifier: string }>;
}

export interface AudienceRecipe {
  id: string;
  platform: "meta" | "tiktok" | "snapchat" | "google";
  name: string;
  setup: string; // Plain-English setup
  bestFor: FunnelStage[];
  scalingNotes?: string;
  applicableCountries: CountryCode[];
}

export type CalendarMomentKind =
  | "religious_lunar" // Ramadan, Eid (lunar so dates shift)
  | "religious_fixed"
  | "national_day"
  | "shopping_festival"
  | "tourism_event"
  | "cultural_global" // Mother's Day, Valentine's
  | "weather_seasonal" // Summer slump, etc.
  | "food_focused"; // Restaurant Week

export interface CalendarMoment {
  id: string;
  name: string;
  kind: CalendarMomentKind;
  // ISO date(s) for upcoming year(s). For lunar moments, list known dates.
  dates: Array<{ year: number; from: string; to: string; notes?: string }>;
  countries: CountryCode[];
  spendPulse: "build_up" | "peak" | "taper" | "always_on" | "burst";
  creativeAngles: string[];
  doList: string[];
  doNotList: string[];
  channelMixHint?: Partial<Record<"meta" | "tiktok" | "snapchat" | "google" | "whatsapp", number>>;
  budgetMultiplierVsBaseline?: number; // e.g., 1.4 means +40%
}

export type AlcoholPolicy = "permitted" | "licensed_venue_only" | "banned" | "limited";

export type ModestyLevel = "very_modest" | "modest" | "moderate" | "permissive";

export interface CountryRules {
  country: CountryCode;
  currency: CurrencyCode;
  decimals: 2 | 3;
  alcoholImagery: AlcoholPolicy;
  porkImagery: "never" | "banned" | "avoid" | "ok_in_context";
  gamblingImagery: "ok" | "avoid" | "banned";
  modestyLevel: ModestyLevel;
  primaryDialect: "khaleeji" | "egyptian" | "levantine" | "msa";
  acceptableDialects: Array<"msa" | "khaleeji" | "egyptian" | "levantine" | "arabizi">;
  womenSoloVocalsInAds: "ok" | "limited" | "avoid";
  calorieDisclosureRequired: boolean;
  influencerLicenseRegime?: { authority: string; permitName: string; mandatorySince: string };
  preferredPlatforms: Array<{ platform: string; rank: number; note?: string }>;
  // Common errors to suppress (imagery clichés that read as "AI slop" locally).
  imageryClichesToAvoid: string[];
}

export interface PromoMechanic {
  id: string;
  name: string;
  description: string;
  // Typical redemption rate range (percentage).
  redemptionPct: [number, number];
  bestCuisineFits: CuisineFit[];
  worstCuisineFits?: CuisineFit[];
  bestFunnelStages: FunnelStage[];
  menaSpecificNotes?: string;
}

export interface BundleNamingRule {
  context: "ramadan" | "premium" | "family" | "default";
  preferredNouns: string[];
  bannedWords: string[];
}

export interface CinematographyRule {
  category: "lighting" | "angle" | "color" | "props" | "hands" | "trigger_moment" | "composition" | "disqualifier";
  rule: string;
  appliesTo?: CuisineFit[];
}

export interface VideoTemplate {
  id: string;
  durationSec: number;
  beats: Array<{ fromSec: number; toSec: number; description: string }>;
  bestFor: FunnelStage[];
  notes?: string;
}

export interface KbMeta {
  version: string;
  lastVerified: string; // ISO date
  nextReviewBy: string; // ISO date
  // Categories of confidence in the data.
  confidence: {
    platformSpecs: "high" | "medium" | "low";
    benchmarks: "high" | "medium" | "low";
    culturalRules: "high" | "medium" | "low";
    creativeArchetypes: "high" | "medium" | "low";
  };
  sources: Array<{ track: number; title: string; url?: string }>;
}
