/**
 * Bustan Knowledge Base — compact, customer-safe snippets surfaced to Bustan
 * so it can answer occasional questions about the platform.
 *
 * Keep this file lean: every word lives in the system prompt context window of
 * every assistant call. The full deep KB lives in `docs/knowledge-base/` and
 * the customer-facing rendered version is at /help and /faq.
 *
 * Topics must stay in sync with the public /faq and /help pages. If a feature
 * ships or a price changes, update here too so Bustan gives the same
 * answer the public pages do.
 */

export type BustanKbTopic =
  | "overview"
  | "pricing"
  | "trial"
  | "signup"
  | "ai_features"
  | "menu_import"
  | "public_page"
  | "whatsapp"
  | "whatsapp_onboarding"
  | "whatsapp_templates"
  | "whatsapp_compliance"
  | "google_integrations"
  | "portfolio"
  | "growth_tools"
  | "languages"
  | "data_privacy"
  | "refunds"
  | "support"
  | "for_owners";

interface BustanKbEntry {
  topic: BustanKbTopic;
  summary: string;
  links?: string[];
}

export const BUSTAN_KB: Record<BustanKbTopic, BustanKbEntry> = {
  overview: {
    topic: "overview",
    summary:
      "Bustan is a growth platform built in the UAE for restaurants across the Gulf and MENA. UAE-first today (AED pricing, UAE PDPL compliance), with KSA and wider GCC localization on the roadmap. It bundles: (a) a hosted public menu page at getbustan.com/their-slug with AI-extracted menu, photos, dietary tags, operating hours, and Bustan diner chat; (b) a WhatsApp CRM that connects the restaurant's real WhatsApp Business Account and runs campaigns to opted-in customers; (c) Ad Creative Studio for Meta ads and a weekly Sabt Pack of 7 ready-to-publish social posts; (d) Google integrations — Google Business Profile (for review stars on the public page and SEO inputs), Google Search Console (Pro+ read-only impressions/clicks dashboard), and an SEO scorecard across 5 pillars including a rank grid for local keywords; (e) a portfolio dashboard for operators managing up to 3 brands (more via AED 99/extra); and (f) growth tools — embeddable menu widget, short links, QR codes, locations directory pages at getbustan.com/locations/[city]/[neighborhood]. Bustan is a trading name of Jasmine Entertainment FZE in Sharjah Publishing City, UAE.",
    links: ["https://getbustan.com", "https://getbustan.com/help"],
  },
  pricing: {
    topic: "pricing",
    summary:
      "Bustan has three public plans, all in AED through Stripe: Draft is free for building privately. Pro is AED 299.99 per month for one restaurant ready to publish. Portfolio is AED 499.99 per month flat for up to 3 brands, with AED 99 per extra brand. Enterprise (4+ brands, white-label, SLAs) is custom. All paid plans include a 14-day free trial of full Pro features.",
    links: ["https://getbustan.com/#pricing", "https://getbustan.com/faq"],
  },
  trial: {
    topic: "trial",
    summary:
      "Bustan offers a 14-day free trial of full Pro features with no credit card required. Restaurants get a reminder email 3 days before it ends. If they don't pick a plan, their page goes back to Draft (private) and their data is kept.",
    links: ["https://getbustan.com/faq"],
  },
  signup: {
    topic: "signup",
    summary:
      "Any restaurant owner can list their restaurant on Bustan by going to getbustan.com and clicking 'List Your Restaurant'. Onboarding takes about 10-15 minutes: sign up, upload your menu (PDF, photo, or text), review the AI extraction, pick photos, choose a theme, and publish.",
    links: ["https://getbustan.com/dashboard", "https://getbustan.com/help#getting-started"],
  },
  ai_features: {
    topic: "ai_features",
    summary:
      "Bustan ships several AI features for restaurant owners: AI menu extraction from PDFs/photos, AI dish image generation, photo enhancement for uploaded shots, an AI description writer, a dietary tagger (vegan, halal, gluten-free, etc.), a Menu Insights scorecard, an Ad Creative Studio for Meta ads, a weekly Sabt Pack of 7 social posts, and Bustan — the sunbird restaurant manager owners talk to in the dashboard and on WhatsApp. All AI runs on Anthropic Claude (text) and OpenAI (images). Anthropic does not train its models on Bustan customer data.",
    links: ["https://getbustan.com/help#ai", "https://getbustan.com/help#marketing"],
  },
  menu_import: {
    topic: "menu_import",
    summary:
      "Bustan can import a restaurant's existing menu from a PDF (up to 8 pages), JPG/PNG/WebP photo, or pasted text. The AI extracts sections, dish names, descriptions, and prices. The owner reviews the draft before it commits to the live menu.",
    links: ["https://getbustan.com/help#menu"],
  },
  public_page: {
    topic: "public_page",
    summary:
      "Every restaurant on Bustan gets a hosted page at getbustan.com/their-slug, with their menu, photos, dietary tags, operating hours, an 'Open now' badge, a WhatsApp CTA, delivery app links, promotions, and (on paid plans) Bustan chat. The page is mobile-first and Google-friendly out of the box.",
    links: ["https://getbustan.com/help#public-page"],
  },
  whatsapp: {
    topic: "whatsapp",
    summary:
      "Bustan offers two levels of WhatsApp. The free click-to-WhatsApp button opens a pre-filled message to the restaurant's number. On Pro and Portfolio, restaurants can connect their real WhatsApp Business Account via Meta's Embedded Signup to use Bustan as their WhatsApp inbox, template manager, and campaign tool. Bustan is the registered Meta Tech Provider; restaurants own their number and can disconnect anytime. WhatsApp messaging fees are billed by Meta directly to the restaurant — Bustan does not mark up. Two kinds of messages flow through the system: transactional (Utility) templates that Bustan sends automatically as orders move through their lifecycle — order received, order accepted, order ready, order cancelled, plus a new-order alert to the restaurant — and marketing templates that the restaurant intentionally broadcasts to opted-in customers as campaigns. See whatsapp_onboarding for the connection flow, whatsapp_templates for what messages exist, and whatsapp_compliance for messaging rules.",
    links: ["https://getbustan.com/help#whatsapp"],
  },
  whatsapp_onboarding: {
    topic: "whatsapp_onboarding",
    summary:
      "Connecting WhatsApp Business on Bustan takes 5-10 minutes via Meta's Embedded Signup at Dashboard → CRM → Setup → Connect WhatsApp. Before starting the restaurant needs: (1) a Facebook account that admins their Business Manager (or be ready to create one mid-flow), (2) a phone number not currently registered on the consumer WhatsApp app — if it is, delete that account first and wait 10 minutes, (3) live access to the phone for a one-time 6-digit verification code by SMS or voice, (4) a brand display name that follows Meta's display-name policy (no 'WhatsApp' in name, no generic terms like 'Restaurant' alone, must match real brand), (5) optionally complete business verification at business.facebook.com first to unlock Tier 1 (250 recipients/24h) instead of Tier 0 (50/24h). The flow walks through: sign into Facebook → select/create Business Manager → select/create WABA → add phone number + verify with code → set display name → approve three permissions (whatsapp_business_messaging, whatsapp_business_management, public_profile — all Meta has approved Bustan to request as a Tech Provider). After connect, three readiness checks should turn green within an hour: number registered, webhook subscribed, templates synced. Common errors and fixes are documented in the troubleshooting section of the help docs (number stuck on consumer WhatsApp, display name rejected, popup redirect loops from third-party cookie blocking, business not eligible because of missing admin role). Once all three are green the number is live and customers can WhatsApp the restaurant. Bustan automatically submits the five transactional Utility templates to Meta on the restaurant's behalf during onboarding; marketing templates are submitted separately when the restaurant chooses to use them.",
    links: [
      "https://getbustan.com/help#72-connecting-your-whatsapp-business",
      "https://getbustan.com/help#711-troubleshooting-whatsapp-setup",
    ],
  },
  whatsapp_templates: {
    topic: "whatsapp_templates",
    summary:
      "WhatsApp on Bustan uses two distinct kinds of templates and the difference matters operationally. Transactional (Utility-category) templates fire automatically with the order lifecycle and don't need marketing opt-in — the customer ordering is consent for order updates. The five transactional templates: order_received (when customer places order on the public menu), order_accepted (when restaurant taps Accept in dashboard), order_ready (when restaurant taps Mark Ready, with pickup/delivery/dine-in specific wording), order_cancelled (when order is rejected, expires after 15 min, or fails payment), and order_new_alert (sent to the restaurant's own number with quick-reply Accept/Reject buttons). Restaurants cannot edit transactional template copy — it's managed centrally by Bustan for consistency and Meta pre-approval. Marketing templates are restaurant-triggered broadcasts to opted-in customers; the five starter ones are Inactive 30 (winback after 30-day silence), Weekend Special, New Promotion, Review Request (sent ~24h after an order), and Birthday Offer. Restaurants can customise marketing template copy before submitting to Meta. Approval is per-restaurant per-WABA, takes minutes to hours for utility templates and minutes to a day for marketing templates. Bustan ships a server-side policy linter that catches the most common Meta rejection reasons (URLs in body, all-caps shouting, missing variable example values, body whitespace) BEFORE submission. Status (draft, pending, approved, rejected) syncs live from Meta on demand via Sync from Meta button. View both groups at CRM → Templates tab.",
    links: ["https://getbustan.com/help#74-message-templates"],
  },
  whatsapp_compliance: {
    topic: "whatsapp_compliance",
    summary:
      "WhatsApp marketing has strict rules and Meta will throttle, demote, or ban numbers that spam. Core rules: (1) Only message customers who explicitly opted in — never scraped lists or POS exports without confirmation. (2) Keep marketing to ≤ 1–2 messages per customer per week; daily marketing gets numbers blocked. (3) After 24 hours of customer silence you can only message via approved templates; freeform text only works inside the 24-hour customer-service window. (4) Categorise templates correctly — Utility for confirmations/updates, Marketing for promos; mis-categorising is a fast way to get an account flagged. (5) Watch your Meta quality rating: Green is healthy, Yellow means pause campaigns immediately, Red means stop sending and let it recover over 7 clean days. Bustan automates: opted-in-only filtering on every campaign, permanent opt-out on STOP keywords, per-(customer, template) frequency cap, daily tier-budget reservation, and correctly-categorised pre-shipped templates. The owner is responsible for getting honest opt-in, choosing reasonable frequency, monitoring quality rating, and warming up new numbers. Full guidance and recovery playbook: getbustan.com/help#whatsapp-compliance and getbustan.com/faq.",
    links: [
      "https://getbustan.com/help#whatsapp-compliance",
      "https://getbustan.com/faq#whatsapp-compliance",
    ],
  },
  google_integrations: {
    topic: "google_integrations",
    summary:
      "Bustan integrates with Google in three ways. (1) Google Business Profile (Dashboard → Google Business): the owner pastes their GBP URL and Bustan uses it to display aggregate rating + review count as ⭐ stars on the public menu page (via AggregateRating JSON-LD that Google can surface in search results) and to feed the SEO scorecard. Today this is a self-reported URL link, not a two-way API sync — direct GBP API integration (auto-push hours, photos, menu to Google) is on the medium-term roadmap. (2) Google Search Console (Dashboard → Search Console, Pro+): a read-only dashboard showing impressions, clicks, click-through rate, average position, and top queries for the restaurant's Bustan page. Bustan runs a single shared GSC property and slices the data per restaurant by URL path, so owners don't have to authenticate anything — it works as soon as Google has crawled the published page (3–14 days). (3) SEO scorecard (Dashboard → SEO Analysis, Pro+): a 0–100 score across 5 weighted pillars — Google Business Profile (25%), on-page SEO (20%), rank grid for ~100 geo-points on local keywords (20%), citations across Google/Talabat/Deliveroo/directories (20%), and reviews (15%). Pro gets 2 scans/month, Portfolio gets 4 scans/month per brand. Results cache for 7 days. Bustan also ships full schema.org markup (Restaurant, Menu, AggregateRating, breadcrumbs), a dynamic sitemap, and an llms.txt for AI assistants — so the page is Google-ready out of the box without owner config.",
    links: ["https://getbustan.com/help#seo"],
  },
  portfolio: {
    topic: "portfolio",
    summary:
      "Portfolio is Bustan's plan for operators managing multiple brands from one account. AED 499.99/month flat covers up to 3 brands; additional brands are AED 99/month each. Portfolio unlocks: a brand switcher in the sidebar (flip between brands in one click), menu cloning (duplicate a menu or section from one brand to another with per-brand price overrides), cross-brand analytics (combined view of traffic, top dishes, WhatsApp engagement), per-brand QR generator, and a portfolio-wide SEO scorecard. Each brand keeps its own live restaurant page, menu, photos, WhatsApp CRM connection, AI quotas, and analytics — entitlements like dish image gen (300/mo per brand), Ad Studio (20 projects/mo per brand), and Bustan chat (2,000 msgs/mo per brand) are independent per brand, not shared across the portfolio. Pro users can upgrade to Portfolio anytime; the existing restaurant becomes brand #1 and they add the rest from Dashboard → Portfolio → Add brand. Cross-brand analytics and brand switcher unlock once 3 brands are set up.",
    links: ["https://getbustan.com/help#portfolio"],
  },
  growth_tools: {
    topic: "growth_tools",
    summary:
      "Beyond the menu page itself, Bustan ships several growth surfaces for Pro and Portfolio restaurants: (a) Embeddable widget — an iframe snippet at Dashboard → Widget that the owner pastes into their own website to render the full menu inline. (b) Short links — getbustan.com/r/XXXXXXX that redirect to the public page with separate click tracking, useful for offline-to-online conversion from flyers, table tents, and Instagram bios. (c) QR codes — auto-generated for the short link, downloadable for printing. (d) Locations directory — public discovery pages at getbustan.com/locations/[city]/[neighborhood] that group published restaurants by area; restaurants appear automatically once published. (e) Powered-by-Bustan footer — a tasteful link back to bustan on the public page, removable on Pro and Portfolio via Appearance → Branding. (f) PDF menu export — a print-ready PDF version of the menu with QR code back to the digital page. Together these turn every public page, embed, printed menu, and QR scan into a source of trackable traffic.",
    links: ["https://getbustan.com/help#public-page"],
  },
  languages: {
    topic: "languages",
    summary:
      "Today Bustan's dashboard and public menu pages render in English. Full Arabic menu fields and an Arabic public-page toggle are on the active product roadmap.",
  },
  data_privacy: {
    topic: "data_privacy",
    summary:
      "Bustan complies with UAE Federal Decree-Law No. 45 of 2021 (UAE PDPL). Data is stored on Railway (Postgres, US) and Cloudflare R2; authentication is via Clerk; payments are handled by Stripe (PCI DSS Level 1); WhatsApp tokens are encrypted at rest. Diner data on a public page is limited to anonymous analytics. The full privacy policy is at getbustan.com/privacy and data deletion requests can be made at getbustan.com/data-deletion or support@getbustan.com.",
    links: ["https://getbustan.com/privacy", "https://getbustan.com/data-deletion"],
  },
  refunds: {
    topic: "refunds",
    summary:
      "Fees already paid for a Bustan subscription are generally non-refundable, except where UAE consumer-protection law requires a refund or where Bustan materially reduces features the customer paid for (notify within 14 days). Cancellations stop renewal — the plan stays active until the end of the paid period. Goodwill refunds are handled case-by-case by emailing support@getbustan.com.",
    links: ["https://getbustan.com/terms", "https://getbustan.com/faq"],
  },
  support: {
    topic: "support",
    summary:
      "Bustan's support team can be reached at support@getbustan.com — usually a same-day reply on UAE business days. For deeper questions there's a public Knowledge Base at getbustan.com/help and an FAQ at getbustan.com/faq.",
    links: [
      "mailto:support@getbustan.com",
      "https://getbustan.com/help",
      "https://getbustan.com/faq",
    ],
  },
  for_owners: {
    topic: "for_owners",
    summary:
      "If a diner is themselves a restaurant owner who wants to list their restaurant on Bustan, point them to getbustan.com and the 'List Your Restaurant' button. The first 14 days are free, no credit card required, and most restaurants are live in under 15 minutes from sign-up.",
    links: ["https://getbustan.com", "https://getbustan.com/help#getting-started"],
  },
};

const TOPIC_KEYWORDS: Record<BustanKbTopic, string[]> = {
  // Keep `overview` narrow — it's the fallback when no specific topic matches,
  // so don't over-claim broad keywords here or you'll shadow more specific
  // topics. The resolver picks the longest-keyword match; keep these short
  // and identity-focused.
  overview: ["what is bustan", "what's bustan", "who made bustan", "company", "jasmine entertainment"],
  pricing: ["price", "pricing", "cost", "how much", "plan", "subscription", "monthly", "aed", "portfolio plan", "pro plan"],
  trial: ["trial", "free trial", "14 day", "14-day", "try it"],
  signup: ["sign up", "signup", "join bustan", "register", "create account", "list my restaurant", "get on bustan"],
  ai_features: ["ai", "artificial intelligence", "claude", "anthropic", "gemini", "chatgpt", "openai", "owner chat", "ad studio", "sabt pack", "menu insights"],
  menu_import: ["menu import", "upload menu", "import pdf", "extract menu"],
  public_page: ["public page", "this page", "menu page", "restaurant page", "url", "slug", "embed"],
  whatsapp: ["whatsapp", "wa.me", "messaging", "crm", "meta tech provider"],
  whatsapp_onboarding: [
    "connect whatsapp",
    "connecting whatsapp",
    "set up whatsapp",
    "setup whatsapp",
    "whatsapp setup",
    "whatsapp onboarding",
    "embedded signup",
    "facebook business manager",
    "business manager",
    "waba",
    "whatsapp business account",
    "register whatsapp",
    "register number",
    "verify number",
    "verify my number",
    "verification code",
    "display name",
    "display name rejected",
    "business verification",
    "business not verified",
    "tier 0",
    "tier 1",
    "trade licence",
    "trade license",
    "whatsapp permissions",
    "whatsapp_business_messaging",
    "whatsapp_business_management",
    "popup",
    "popup blocked",
    "popup loop",
    "redirect loop",
    "number stuck",
    "registering stuck",
    "webhook not working",
    "webhook subscribed",
    "templates not synced",
    "reconnect whatsapp",
    "needs reconsent",
    "needs_reconsent",
    "got disconnected",
    "delete consumer whatsapp",
    "already on whatsapp",
    "tech provider",
  ],
  whatsapp_templates: [
    "template",
    "templates",
    "transactional template",
    "transactional templates",
    "utility template",
    "marketing template",
    "marketing templates",
    "order received template",
    "order accepted template",
    "order ready template",
    "order cancelled template",
    "order alert",
    "new order alert",
    "edit template",
    "customise template",
    "customize template",
    "template approval",
    "template approved",
    "template pending",
    "template rejected",
    "template rejection",
    "submit to meta",
    "sync from meta",
    "sync templates",
    "template library",
    "invalid_format",
    "policy_violation",
    "url in body",
    "all caps",
  ],
  whatsapp_compliance: [
    "blocked",
    "banned",
    "throttled",
    "quality rating",
    "quality score",
    "yellow",
    "red rating",
    "messaging tier",
    "daily limit",
    "tier limit",
    "template rejected",
    "spam",
    "opt-in",
    "opt in",
    "opted in",
    "consent",
    "frequency cap",
    "compliance",
    "meta rules",
    "whatsapp policy",
    "stop sending",
    "24 hour window",
    "24-hour window",
    "customer service window",
    "warm up",
    "warmup",
    "list import",
  ],
  google_integrations: [
    "google",
    "google business",
    "google business profile",
    "gbp",
    "google my business",
    "gmb",
    "search console",
    "google search console",
    "gsc",
    "google search",
    "seo",
    "seo score",
    "seo scorecard",
    "seo analysis",
    "rank",
    "ranking",
    "rankings",
    "rank grid",
    "rank tracking",
    "local seo",
    "citations",
    "directory listing",
    "directory listings",
    "review count",
    "review stars",
    "star rating",
    "aggregate rating",
    "schema",
    "json-ld",
    "structured data",
    "sitemap",
    "llms.txt",
  ],
  portfolio: [
    "portfolio",
    "multi brand",
    "multi-brand",
    "multiple brands",
    "multiple restaurants",
    "brand switcher",
    "menu cloning",
    "clone menu",
    "extra brand",
    "cross-brand",
    "cross brand",
    "operator account",
    "chain",
    "multi location",
    "multi-location",
  ],
  growth_tools: [
    "widget",
    "embed",
    "embeddable",
    "iframe",
    "short link",
    "short links",
    "shortlink",
    "qr",
    "qr code",
    "qr codes",
    "powered by",
    "branding",
    "pdf export",
    "print menu",
    "locations directory",
    "locations page",
    "neighborhood",
  ],
  languages: ["arabic", "english", "language", "translate", "bilingual", "rtl"],
  data_privacy: ["privacy", "data", "gdpr", "pdpl", "delete my data", "data deletion", "tracking", "cookies"],
  refunds: ["refund", "cancel", "cancellation", "money back"],
  support: ["support", "help", "contact", "email", "human"],
  for_owners: ["i own a restaurant", "i'm a restaurant", "list my", "add my restaurant", "i have a restaurant"],
};

export function resolveBustanTopic(query: string): BustanKbTopic | null {
  const lower = query.toLowerCase();

  let bestTopic: BustanKbTopic | null = null;
  let bestScore = 0;

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS) as [
    BustanKbTopic,
    string[],
  ][]) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        // Longer keyword match wins
        const score = keyword.length;
        if (score > bestScore) {
          bestScore = score;
          bestTopic = topic;
        }
      }
    }
  }

  return bestTopic;
}

export function getBustanKbEntry(topic: BustanKbTopic): BustanKbEntry {
  return BUSTAN_KB[topic];
}

export function getAllBustanTopics(): BustanKbTopic[] {
  return Object.keys(BUSTAN_KB) as BustanKbTopic[];
}
