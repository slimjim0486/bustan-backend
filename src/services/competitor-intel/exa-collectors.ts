// Four Exa-powered collectors that gather signal about one competitor:
//   • collectMenuSignals    — recent menu items + prices from their website
//   • collectPromoSignals   — discounts/offers mentioned anywhere in last 30d
//   • collectPressSignals   — news/blog mentions in last 30d
//   • collectWebReviewSignals — deep-web reviews (Reddit, TripAdvisor, Zomato)
//
// Why four narrow queries instead of one broad one:
//   Exa charges per call regardless of result count, but each call returns
//   higher-quality results when the query is tightly scoped. A single
//   "everything about X" query returns mostly homepage links and misses
//   the long-tail signal we actually want. Four scoped queries → four
//   high-signal result sets → a richer snapshot for ~$0.035/competitor.
//
// What we DON'T do here:
//   • LLM cleanup. v1 persists structured Exa output (title, snippet, url,
//     publishedDate) and lets the Sous Chef tool extract semantic facts at
//     read time. Adding an LLM pass per competitor would 5x the cost.
//   • Deep search ($12-15/1k vs $7/1k). Banned in v1 by guardrail.

import { exaSearch, type ExaSearchResult } from "@/lib/exa";
import type {
  CompetitorIntelCollectorResult,
  MenuItemSignal,
  NearbyCompetitor,
  PressMentionSignal,
  PromoSignal,
  WebReviewSignal,
} from "./types";

const PROMO_KEYWORDS = [
  "discount",
  "offer",
  "deal",
  "promo",
  "% off",
  "happy hour",
  "buy one",
  "free delivery",
];

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Strip characters that break Exa's phrase-query syntax. We interpolate
 *  competitor names inside double-quotes to force phrase matching; a name
 *  like `Mama's "Authentic" Lebanese` would otherwise terminate the phrase
 *  early and yield no results. Apostrophes are safe to keep — only the
 *  double-quote breaks the quote-delimited phrase. We also collapse
 *  whitespace so newlines in scraped names don't reach the query. */
function sanitizeForQuery(name: string): string {
  return name.replace(/"/g, "").replace(/\s+/g, " ").trim();
}

function emptyResult<T>(reason: "disabled" | "skipped"): CompetitorIntelCollectorResult<T[]> {
  return { data: [], estimatedCostUsd: 0, status: reason };
}

// ── Menu collector ────────────────────────────────────────────────────
// Combines search + inline contents (includeText=true) so we can scan
// the page body for price patterns. Costs slightly more per call but
// avoids a separate /contents round-trip.

const PRICE_REGEX = /\b(AED|د\.إ\.?|Dhs?|د\.إ)\s*([0-9]{1,4}(?:\.[0-9]{1,2})?)\b/gi;
const PRICE_REGEX_ALT = /\b([0-9]{1,4}(?:\.[0-9]{1,2})?)\s*(AED|د\.إ\.?|Dhs?)\b/gi;

function extractMenuItemsFromText(text: string, source: string | null): MenuItemSignal[] {
  // Light heuristic: pull lines with an AED price and treat the words
  // immediately preceding the price as the item name. Good enough for
  // v1 — accurate enough for "this restaurant added a dish at AED 48"
  // signals without an LLM extraction pass.
  const items: MenuItemSignal[] = [];
  const seen = new Set<string>();

  const lines = text.split(/[\n\r]+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const matches = [...line.matchAll(PRICE_REGEX), ...line.matchAll(PRICE_REGEX_ALT)];
    if (matches.length === 0) continue;

    for (const match of matches) {
      const priceStr = match[2] ?? match[1];
      const price = priceStr ? Number(priceStr) : NaN;
      if (!Number.isFinite(price) || price < 5 || price > 999) continue;

      const before = line.slice(0, match.index ?? 0).trim();
      // Take the last 4-8 words before the price as the item name. Trim
      // out punctuation and obvious section headers ("MENU", "PRICES").
      const words = before
        .split(/\s+/)
        .filter((w) => /[A-Za-z؀-ۿ]/.test(w))
        .slice(-6);
      if (words.length === 0) continue;
      const name = words.join(" ").replace(/^[-—·.•:]+/, "").trim();
      if (name.length < 3 || name.length > 80) continue;

      const dedupeKey = `${name.toLowerCase()}|${price}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      items.push({
        name,
        price,
        currency: "AED",
        isNew: false, // determined later in diff.ts against last week
        source,
      });

      if (items.length >= 20) return items;
    }
  }

  return items;
}

export async function collectMenuSignals(
  competitor: NearbyCompetitor
): Promise<CompetitorIntelCollectorResult<MenuItemSignal[]>> {
  const name = sanitizeForQuery(competitor.name);
  const query = `${name} menu prices ${competitor.address ?? "Dubai"}`;
  const result = await exaSearch({
    query,
    numResults: 3,
    category: "company",
    includeText: true,
    type: "auto",
  });

  if (result.status === "disabled") return emptyResult("disabled");

  const items: MenuItemSignal[] = [];
  for (const r of result.data) {
    if (!r.text) continue;
    items.push(...extractMenuItemsFromText(r.text, r.url));
    if (items.length >= 30) break;
  }

  return {
    data: items.slice(0, 30),
    estimatedCostUsd: result.estimatedCostUsd,
    status: "ok",
  };
}

// ── Promo collector ───────────────────────────────────────────────────

function looksLikePromo(r: ExaSearchResult): boolean {
  const haystack = [r.title, ...(r.highlights ?? [])]
    .filter((s): s is string => Boolean(s))
    .join(" ")
    .toLowerCase();
  return PROMO_KEYWORDS.some((kw) => haystack.includes(kw));
}

export async function collectPromoSignals(
  competitor: NearbyCompetitor
): Promise<CompetitorIntelCollectorResult<PromoSignal[]>> {
  const name = sanitizeForQuery(competitor.name);
  const query = `"${name}" (discount OR offer OR deal OR promo OR "happy hour")`;
  const result = await exaSearch({
    query,
    numResults: 6,
    startPublishedDate: isoDaysAgo(30),
    type: "auto",
  });

  if (result.status === "disabled") return emptyResult("disabled");

  const promos: PromoSignal[] = result.data
    .filter(looksLikePromo)
    .map((r) => ({
      title: r.title ?? "Untitled promo",
      description: r.highlights?.[0] ?? null,
      validUntil: null,
      source: r.url,
      publishedAt: r.publishedDate,
    }))
    .slice(0, 5);

  return {
    data: promos,
    estimatedCostUsd: result.estimatedCostUsd,
    status: "ok",
  };
}

// ── Press collector ───────────────────────────────────────────────────

function inferPublication(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

export async function collectPressSignals(
  competitor: NearbyCompetitor
): Promise<CompetitorIntelCollectorResult<PressMentionSignal[]>> {
  const name = sanitizeForQuery(competitor.name);
  const query = `"${name}" restaurant review OR feature OR best OR opening`;
  const result = await exaSearch({
    query,
    numResults: 5,
    category: "news",
    startPublishedDate: isoDaysAgo(30),
    type: "auto",
  });

  if (result.status === "disabled") return emptyResult("disabled");

  const mentions: PressMentionSignal[] = result.data
    .filter((r) => r.url && r.title)
    .map((r) => ({
      title: r.title!,
      url: r.url,
      publishedAt: r.publishedDate,
      publication: inferPublication(r.url),
    }))
    .slice(0, 5);

  return {
    data: mentions,
    estimatedCostUsd: result.estimatedCostUsd,
    status: "ok",
  };
}

// ── Deep-web reviews collector ────────────────────────────────────────

const DEEP_REVIEW_DOMAINS = [
  "reddit.com",
  "tripadvisor.com",
  "tripadvisor.ae",
  "zomato.com",
  "timeoutdubai.com",
  "lovinthatdubai.com",
  "thenationalnews.com",
  "gulfnews.com",
];

export async function collectWebReviewSignals(
  competitor: NearbyCompetitor
): Promise<CompetitorIntelCollectorResult<WebReviewSignal[]>> {
  const name = sanitizeForQuery(competitor.name);
  const query = `"${name}" review`;
  const result = await exaSearch({
    query,
    numResults: 6,
    includeDomains: DEEP_REVIEW_DOMAINS,
    type: "auto",
  });

  if (result.status === "disabled") return emptyResult("disabled");

  const reviews: WebReviewSignal[] = result.data
    .filter((r) => r.url)
    .map((r) => ({
      snippet: r.highlights?.[0] ?? r.title ?? "",
      source: inferPublication(r.url),
      url: r.url,
      sentiment: null, // v1: no LLM sentiment pass; defer to digest
      publishedAt: r.publishedDate,
    }))
    .filter((r) => r.snippet.length > 0)
    .slice(0, 5);

  return {
    data: reviews,
    estimatedCostUsd: result.estimatedCostUsd,
    status: "ok",
  };
}
