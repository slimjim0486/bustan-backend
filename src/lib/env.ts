import "dotenv/config";
import { z } from "zod";

const optionalString = (schema: z.ZodString = z.string()) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const isTestEnv =
  process.env.NODE_ENV === "test" || process.env.npm_lifecycle_event === "test";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3001),
  ANTHROPIC_API_KEY: optionalString(),
  SOUS_CHEF_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  SUPPORT_TRIAGE_MODEL: z.string().default("claude-sonnet-4-6"),
  GEMINI_API_KEY: optionalString(),
  GOOGLE_API_KEY: optionalString(),
  IP_HASH_PEPPER: isTestEnv
    ? z.string().min(16).default("test-only-ip-hash-pepper")
    : z.string().min(16),
  GOOGLE_IMAGE_MODEL: z.string().default("gemini-3-pro-image-preview"),
  GOOGLE_IMAGE_ALLOW_FALLBACK: z.coerce.boolean().default(false),
  GOOGLE_IMAGE_FALLBACK_MODEL: optionalString(),
  // OpenAI image generation (Ad Studio operator-selectable provider).
  // GPT Image is best-in-class for product/food photography per operator
  // testing; gated to Pro+ plans and to a daily per-restaurant cap. Cost
  // defaults to $0.19/image (high-quality 1024x1024) and should
  // be refreshed when the first invoice arrives.
  // OpenAI keys are `sk-…` (legacy ~51 chars) or `sk-proj-…` (newer 150+).
  // The prefix + min(40) keeps "placeholder" strings out without breaking
  // real keys.
  OPENAI_API_KEY: optionalString(z.string().regex(/^sk-/).min(40)),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2"),
  OPENAI_IMAGE_COST_USD: z.coerce.number().nonnegative().default(0.19),
  // gpt-image-1/2 high-quality renders routinely take 60–120s; raise on
  // Railway if you see timeouts. Clamped to 5 minutes to keep a hung
  // upstream from pinning a worker forever.
  OPENAI_IMAGE_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(120_000),
  /** Per-restaurant daily cap for OpenAI image regenerations. Defaults to 5
   *  to bound spend during the beta period. Owners can request a higher cap
   *  via support; long-term, the BYOK flow will move billing off our books. */
  AD_STUDIO_OPENAI_REGEN_PER_DAY: z.coerce.number().int().positive().default(5),
  APIFY_API_TOKEN: optionalString(),
  APIFY_ACTOR_GMAPS: z.string().default("compass/crawler-google-places"),
  APIFY_ACTOR_GMAPS_REVIEWS: z.string().default("compass/google-maps-reviews-scraper"),
  APIFY_ACTOR_GSEARCH: z.string().default("apify/google-search-scraper"),
  APIFY_ACTOR_WEB: z.string().default("apify/website-content-crawler"),
  APIFY_ACTOR_TALABAT: optionalString(),
  APIFY_ACTOR_DELIVEROO: optionalString(),
  NANOBANANA_API_KEY: optionalString(),
  NANOBANANA_API_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  R2_ACCOUNT_ID: optionalString(),
  R2_ACCESS_KEY_ID: optionalString(),
  R2_SECRET_ACCESS_KEY: optionalString(),
  R2_BUCKET_NAME: z.string().default("mydscvr-eats"),
  R2_PUBLIC_URL: z.string().url().default("https://images.getbustan.com"),
  CLERK_SECRET_KEY: optionalString(),
  CLERK_JWT_KEY: optionalString(),
  CLERK_JWT_ISSUER: optionalString(),
  CLERK_WEBHOOK_SECRET: optionalString(z.string().min(20)),
  STRIPE_SECRET_KEY: optionalString(),
  STRIPE_WEBHOOK_SECRET: optionalString(),
  // Telr — payment provider for WhatsApp Ordering v1. UAE-licensed,
  // supports AED + Apple Pay + Google Pay + cards out of the box. Each
  // restaurant connects their own Telr merchant account; we use a single
  // platform store id ONLY for COD-only restaurants that don't need
  // payment links. Webhook secret is shared across all restaurants since
  // Telr's IPN doesn't include a per-merchant signing scheme.
  TELR_STORE_ID: optionalString(),
  TELR_AUTH_KEY: optionalString(),
  TELR_MODE: z.enum(["test", "live"]).default("test"),
  TELR_WEBHOOK_SECRET: optionalString(z.string().min(16)),
  BACKEND_WEBHOOK_SYNC_SECRET: optionalString(z.string().min(32)),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optionalString(z.string().min(16)),
  WHATSAPP_TOKEN_ENCRYPTION_KEY: optionalString(z.string().min(32)),
  META_APP_ID: optionalString(),
  META_APP_SECRET: optionalString(),
  META_WHATSAPP_CONFIG_ID: optionalString(),
  /** OAuth config-id for Meta Ads access (separate from the WhatsApp Embedded Signup id) */
  META_ADS_CONFIG_ID: optionalString(),
  /** Encryption key for stored Meta Marketing API tokens. Distinct from WhatsApp's
   *  so a single key compromise doesn't cross integrations. */
  META_ADS_TOKEN_ENCRYPTION_KEY: optionalString(z.string().min(32)),
  /** Beta allowlist for Meta OAuth during dev-mode period (pre-Tech Provider).
   *  Comma-separated restaurant IDs. Anyone not in this list sees waitlist copy
   *  instead of a Connect button so they don't hit Meta's "app not available". */
  AD_STUDIO_META_BETA_RESTAURANT_IDS: optionalString(),
  META_GRAPH_API_VERSION: z.string().default("v24.0"),
  STRIPE_STARTER_PRICE_ID: optionalString(),
  STRIPE_PRO_PRICE_ID: optionalString(),
  STRIPE_PRO_PRICE_ID_V2: optionalString(),
  STRIPE_PORTFOLIO_PRICE_ID: optionalString(),
  STRIPE_PORTFOLIO_PRICE_ID_V2: optionalString(),
  STRIPE_PORTFOLIO_EXTRA_BRAND_PRICE_ID: optionalString(),
  STRIPE_TRIAL_DAYS: z.coerce.number().int().positive().default(14),
  RESEND_API_KEY: optionalString(),
  RESEND_FROM_EMAIL: optionalString(z.string().email()),
  FRONTEND_APP_URL: z.string().url().default("http://localhost:3000"),
  // Ad Studio cost guardrails. Three separate per-restaurant pools so regen
  // doesn't eat full-project quota; export DoS is bounded; all contribute
  // to the global USD ceiling.
  AD_STUDIO_GENERATE_PER_DAY: z.coerce.number().int().positive().default(20),
  AD_STUDIO_REGEN_IMAGE_PER_DAY: z.coerce.number().int().positive().default(15),
  AD_STUDIO_EXPORT_PER_DAY: z.coerce.number().int().positive().default(10),
  AD_STUDIO_EXPORT_PER_HOUR: z.coerce.number().int().positive().default(3),
  AD_STUDIO_GLOBAL_USD_PER_DAY: z.coerce.number().nonnegative().default(50),
  // Phase 3A H2: WhatsApp Business messaging-tier daily cap (per-WABA).
  // Meta's tiers: 250 (initial) → 1k → 10k → 100k → unlimited. We default
  // to 1k since most newly-onboarded restaurants are at that tier; Phase
  // 3B P4 will surface the real value from the Graph API quality check.
  WHATSAPP_DAILY_TIER_LIMIT: z.coerce.number().int().positive().default(1000),
  // Per-(customer,template) frequency cap window in hours. A given recipient
  // cannot receive the same template more than once in this window.
  WHATSAPP_FREQUENCY_CAP_HOURS: z.coerce.number().int().positive().default(24),
  // Google Search Console — single OAuth (not per-restaurant). We OAuth once
  // as the verified owner of getbustan.com and slice the data per-restaurant
  // by URL filter. See backend/scripts/get-gsc-refresh-token.ts.
  GOOGLE_OAUTH_CLIENT_ID: optionalString(),
  GOOGLE_OAUTH_CLIENT_SECRET: optionalString(),
  GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN: optionalString(),
  GOOGLE_SEARCH_CONSOLE_PROPERTY: z.string().default("sc-domain:getbustan.com"),
  // Sentry — error monitoring. Optional. When unset, the Sentry wrapper
  // (lib/sentry.ts) becomes a no-op so the app runs normally without it.
  // Paste the DSN from sentry.io into Railway when ready.
  SENTRY_DSN: optionalString(),
  SENTRY_ENVIRONMENT: optionalString(),
  // Sabt Pack — weekly auto-generated 7-post bundle. Owner notification is
  // delivered via Resend email (gated on RESEND_API_KEY + RESEND_FROM_EMAIL)
  // plus the always-on dashboard banner. Per-restaurant weekly USD ceiling
  // is enforced by the entitlements file (sabtPackMaxCostUsdPerWeek per
  // plan) plus an absolute circuit-breaker hardcoded in the orchestrator;
  // no env override needed.

  // ── Coworker ─────────────────────────────────────────────────────
  // Sous Chef delivered over WhatsApp on Bustan's own WABA. Separate Meta
  // app from the customer-ordering WhatsAppIntegration (which uses
  // META_APP_ID/META_APP_SECRET above via Embedded Signup per restaurant).
  // Coworker uses a single Bustan-owned phone number + system-user token, so
  // no per-restaurant token encryption is needed.
  //
  // When COWORKER_ENABLED is false, every send path short-circuits and every
  // webhook returns 200 OK without dispatching to the LLM — the entire
  // surface is commented-out at the runtime boundary, not the source level.
  COWORKER_ENABLED: z.coerce.boolean().default(false),
  /** Send-all-to-Saleem mode: every owner's brief is rerouted to
   *  COWORKER_DRY_RUN_PHONE so we can read what every restaurant would receive
   *  before opening to real owners. When true, owner sends never go out. */
  COWORKER_DRY_RUN: z.coerce.boolean().default(true),
  COWORKER_DRY_RUN_PHONE: optionalString(),
  /** WhatsApp Business Account ID Bustan owns (Jasmine Entertainment FZE). */
  COWORKER_WABA_ID: optionalString(),
  /** Phone number ID for the Bustan Coworker number, NOT a per-restaurant id. */
  COWORKER_PHONE_NUMBER_ID: optionalString(),
  /** System-user permanent token scoped to the Bustan WABA. Distinct from
   *  per-restaurant tokens stored in WhatsAppIntegration.accessTokenCipher. */
  COWORKER_ACCESS_TOKEN: optionalString(),
  /** Webhook verify token Bustan sets in Meta's WhatsApp app webhook config. */
  COWORKER_WEBHOOK_VERIFY_TOKEN: optionalString(z.string().min(16)),
  /** App secret for the Bustan Coworker Meta app — verifies inbound webhooks. */
  COWORKER_APP_SECRET: optionalString(),
  /** Display phone number for greetings / opt-in QR code, e.g. "+971501234567". */
  COWORKER_DISPLAY_PHONE: optionalString(),
  /** Per-utility-conversation USD cost (Meta MENA pricing). Used for cost
   *  tracking + margin alerts. Defaults to a conservative 0.02 — refresh
   *  when first Meta invoice lands. */
  COWORKER_UTILITY_COST_USD: z.coerce.number().nonnegative().default(0.02),

  // ── Market Pulse / Competitor Intelligence ────────────────────────
  // Exa.ai is the search backbone for the weekly competitor data pull.
  // Each competitor costs ~$0.035/week across 4 collectors (menu, promo,
  // press, deep-web reviews). The shared-cache row in CompetitorSnapshot
  // (unique on placeId+weekBucket) brings effective per-restaurant cost
  // down to ~$0.55-1.10/month in dense neighborhoods.
  //
  // Kill switch: EXA_ENABLED=false short-circuits every Exa call and the
  // weekly cron fanout, leaving the data layer (and any prior snapshots)
  // intact. Defaults to true — the *real* safety gate is the presence of
  // EXA_API_KEY (the orchestrator requires both), so leaving this true
  // means "Market Pulse runs in any environment that has a key", which is
  // the right production posture. Flip to false to stop spend mid-incident
  // without code changes.
  //
  // Per-restaurant monthly USD cap: when ai_usage_logs.cost_usd for
  // feature='competitor-intel' exceeds this in the current calendar month,
  // the orchestrator auto-pauses that restaurant's refreshes and notifies
  // the owner. Defaults to $5/restaurant/month (5-10x our expected spend,
  // so it only trips on runaway behavior, not normal usage).
  EXA_API_KEY: optionalString(),
  EXA_ENABLED: z.coerce.boolean().default(true),
  EXA_MONTHLY_USD_CAP_PER_RESTAURANT: z.coerce.number().nonnegative().default(5),
  EXA_ORG_MONTHLY_USD_ALERT: z.coerce.number().nonnegative().default(400),
});

export const env = envSchema.parse(process.env);
