// Market Pulse digest synthesizer.
//
// After the weekly orchestrator persists all CompetitorSnapshots for a
// restaurant, this module:
//   1. Reads the just-written snapshots.
//   2. Composes a compact text summary of the competitive landscape +
//      week-over-week diff.
//   3. Asks Claude Haiku to produce ONE actionable insight + ONE concrete
//      recommendation the owner can click on.
//   4. Persists the result to CompetitorIntelDigest (upsert by
//      restaurantId+weekBucket).
//
// Why Haiku, not Sonnet:
//   The task is well-bounded summarization with structured JSON output —
//   exactly what Haiku 4.5 excels at. Per-call cost ~$0.0015 (500 tokens
//   in + 200 out), so 1000 restaurants × 52 weeks = ~$78/year total.
//   Sonnet would be 5-10x more expensive for marginal quality gain on a
//   summarization task this constrained.
//
// What this module does NOT do:
//   • Create the DraftAction. That's a separate concern (draft-creator.ts)
//     so the synth can run for analytics-only use cases (e.g. an admin
//     dashboard) without producing an owner-facing Inbox card.
//   • Send notifications. The Inbox + dashboard banner are the surface;
//     no email is sent for Market Pulse (Sabt Pack email is the noisier
//     channel — we don't want two Monday emails fighting for attention).

import Anthropic from "@anthropic-ai/sdk";
import type { CompetitorSnapshot } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { logAiUsage } from "@/lib/ai-usage";
import { prisma } from "@/lib/prisma";
import { createSousChefMessage } from "@/services/anthropic-models";
import type {
  CompetitorChanges,
  MenuItemSignal,
  PressMentionSignal,
  PromoSignal,
} from "./types";

export interface MarketPulseRecommendedAction {
  label: string;
  /** Always rooted at /dashboard. Phase 3b's Ad Studio prefill handler
   *  reads ctaParams and pre-fills the new-project form. Until then the
   *  link just opens Ad Studio's project list. */
  ctaRoute: string;
  ctaParams: Record<string, string | number>;
}

export interface MarketPulseDigest {
  digestId: string;
  weekBucket: string;
  topInsight: string;
  hasMovement: boolean;
  recommendedAction: MarketPulseRecommendedAction | null;
  competitorsCount: number;
}

let anthropic: Anthropic | null = null;
function getClient() {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "" });
  }
  return anthropic;
}

interface SnapshotSummary {
  name: string;
  distanceMeters: number | null;
  cuisine: string | null;
  addedDishes: { name: string; price: number | null }[];
  priceChanges: { name: string; oldPrice: number | null; newPrice: number | null }[];
  newPromos: string[];
  pressMentionCount: number;
  recentPromoTitles: string[];
}

/** Compact text representation Haiku reads. Designed to be aggressive
 *  about brevity — every line is one competitor's signal. */
function buildPromptInput(rows: CompetitorSnapshot[]): {
  text: string;
  movementCount: number;
} {
  const summaries: SnapshotSummary[] = rows.map((row) => {
    const changes = (row.changes as unknown as CompetitorChanges | null) ?? null;
    const promos = (row.promotions as unknown as PromoSignal[]) ?? [];
    const press = (row.pressMentions as unknown as PressMentionSignal[]) ?? [];
    return {
      name: row.name,
      distanceMeters: row.distanceMeters,
      cuisine: row.cuisine,
      addedDishes: changes?.addedDishes.slice(0, 3).map((d: MenuItemSignal) => ({
        name: d.name,
        price: d.price,
      })) ?? [],
      priceChanges: changes?.priceChanges.slice(0, 3) ?? [],
      newPromos: changes?.newPromos.slice(0, 3).map((p) => p.title) ?? [],
      pressMentionCount: press.length,
      recentPromoTitles: promos.slice(0, 2).map((p) => p.title),
    };
  });

  const movementCount = summaries.filter(
    (s) =>
      s.addedDishes.length > 0 ||
      s.priceChanges.length > 0 ||
      s.newPromos.length > 0
  ).length;

  const lines: string[] = [];
  lines.push(`COMPETITORS THIS WEEK (${rows.length} tracked, ${movementCount} with movement):`);
  for (const s of summaries) {
    const parts: string[] = [];
    parts.push(
      `- ${s.name}${s.distanceMeters !== null ? ` (${Math.round(s.distanceMeters)}m away)` : ""}${s.cuisine ? `, ${s.cuisine}` : ""}`
    );
    if (s.addedDishes.length > 0) {
      parts.push(
        `  added: ${s.addedDishes
          .map((d) => `${d.name}${d.price !== null ? ` (AED ${d.price})` : ""}`)
          .join(", ")}`
      );
    }
    if (s.priceChanges.length > 0) {
      parts.push(
        `  re-priced: ${s.priceChanges
          .map((p) => `${p.name} ${p.oldPrice}→${p.newPrice}`)
          .join(", ")}`
      );
    }
    if (s.newPromos.length > 0) {
      parts.push(`  new promos: ${s.newPromos.join("; ")}`);
    }
    if (s.recentPromoTitles.length > 0 && s.newPromos.length === 0) {
      parts.push(`  ongoing promos: ${s.recentPromoTitles.join("; ")}`);
    }
    if (s.pressMentionCount > 0) {
      parts.push(`  press mentions: ${s.pressMentionCount}`);
    }
    lines.push(parts.join("\n"));
  }

  return { text: lines.join("\n"), movementCount };
}

const SYSTEM_PROMPT = `You are an analyst writing a one-line weekly competitive briefing for a UAE restaurant owner.

Your job: read the structured snapshot of nearby competitor activity for the past week and output ONE punchy insight + ONE concrete next action.

Output rules:
- Reply with VALID JSON only. No commentary, no markdown, no code fences.
- Schema: {"topInsight": string, "hasMovement": boolean, "recommendedAction": {"label": string, "ctaRoute": "/dashboard/ad-studio/new", "ctaParams": {"from": "market-pulse", "intent": string, ...}} | null}
- topInsight: ONE sentence, max 140 characters. Punchy, specific, owner-voice. Cite a specific competitor or dish when one stands out. Examples:
  * "3 of your 5 neighbors launched lunch promos this week — none of yours match."
  * "Operation: Falafel added Truffle Wrap at AED 48 and is taking press coverage."
  * "Quiet week — no notable competitor moves."
- hasMovement: true iff at least one competitor added a dish, changed a price, or launched a new promo.
- recommendedAction: null when hasMovement is false. Otherwise propose a concrete Ad Studio action the owner can click. The intent value is a short snake_case key the Ad Studio prefill handler will switch on. Pick from: lunch_promo_match, dinner_promo_match, weekend_promo_match, price_position_response, new_dish_announce, generic_competitor_response.
- Never fabricate competitor names that aren't in the input. Never fabricate prices.`;

export interface RawSynthResult {
  topInsight: string;
  hasMovement: boolean;
  recommendedAction: MarketPulseRecommendedAction | null;
}

export function parseSynthResponse(raw: string): RawSynthResult | null {
  // Haiku usually returns clean JSON when asked, but defensively strip any
  // accidental code-fence wrapping before parsing.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.topInsight !== "string" ||
      typeof parsed.hasMovement !== "boolean"
    ) {
      return null;
    }
    const action =
      parsed.hasMovement &&
      parsed.recommendedAction &&
      typeof parsed.recommendedAction === "object"
        ? {
            label: String(parsed.recommendedAction.label ?? "Open Ad Studio"),
            ctaRoute: "/dashboard/ad-studio/new",
            // Spread first so model-supplied extra params survive, then
            // overwrite with safe defaults so an evil/garbled `from` or
            // `intent` can't override the contract Ad Studio relies on.
            ctaParams: {
              ...((parsed.recommendedAction.ctaParams ?? {}) as Record<string, string | number>),
              from: "market-pulse",
              intent: String(parsed.recommendedAction.ctaParams?.intent ?? "generic_competitor_response"),
            },
          }
        : null;
    return {
      topInsight: parsed.topInsight.slice(0, 200),
      hasMovement: parsed.hasMovement,
      recommendedAction: action,
    };
  } catch {
    return null;
  }
}

export function fallbackDigest(movementCount: number): RawSynthResult {
  if (movementCount === 0) {
    return {
      topInsight: "Quiet week — no notable competitor moves nearby.",
      hasMovement: false,
      recommendedAction: null,
    };
  }
  return {
    topInsight: `${movementCount} nearby competitors made notable moves this week — open Ad Studio to respond.`,
    hasMovement: true,
    recommendedAction: {
      label: "Open Ad Studio",
      ctaRoute: "/dashboard/ad-studio/new",
      ctaParams: { from: "market-pulse", intent: "generic_competitor_response" },
    },
  };
}

export async function synthesizeMarketPulseDigest(args: {
  restaurantId: string;
  weekBucket: string;
}): Promise<MarketPulseDigest | null> {
  const rows = await prisma.competitorSnapshot.findMany({
    where: { restaurantId: args.restaurantId, weekBucket: args.weekBucket },
    orderBy: { distanceMeters: "asc" },
  });

  if (rows.length === 0) return null;

  const { text: promptInput, movementCount } = buildPromptInput(rows);

  let synth: RawSynthResult;
  let tokensIn = 0;
  let tokensOut = 0;

  if (!env.ANTHROPIC_API_KEY) {
    // Local-dev / kill-switch path: persist a deterministic fallback so
    // the rest of the pipeline (DraftAction creation, dashboard reads)
    // still has data to work with.
    synth = fallbackDigest(movementCount);
  } else {
    try {
      const response = await createSousChefMessage(
        getClient(),
        {
          max_tokens: 400,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: promptInput }],
        },
        { feature: "competitor_intel_digest", restaurantId: args.restaurantId }
      );
      tokensIn = response.usage.input_tokens;
      tokensOut = response.usage.output_tokens;

      const textBlock = response.content.find((c) => c.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      synth = parseSynthResponse(raw) ?? fallbackDigest(movementCount);

      await logAiUsage(
        args.restaurantId,
        "competitor_intel_digest",
        tokensIn,
        tokensOut
      );
    } catch (error) {
      console.warn(
        `[market-pulse] digest synth failed for ${args.restaurantId}; using fallback:`,
        error
      );
      synth = fallbackDigest(movementCount);
    }
  }

  const digest = await prisma.competitorIntelDigest.upsert({
    where: {
      restaurantId_weekBucket: {
        restaurantId: args.restaurantId,
        weekBucket: args.weekBucket,
      },
    },
    create: {
      restaurantId: args.restaurantId,
      weekBucket: args.weekBucket,
      topInsight: synth.topInsight,
      recommendedAction: synth.recommendedAction as unknown as Prisma.InputJsonValue,
      competitorsCount: rows.length,
    },
    update: {
      topInsight: synth.topInsight,
      recommendedAction: synth.recommendedAction as unknown as Prisma.InputJsonValue,
      competitorsCount: rows.length,
      // Don't touch notifiedAt — it's the source-of-truth for "did the
      // owner-facing surface already pick this up", and re-running synth
      // shouldn't reset that signal.
    },
  });

  return {
    digestId: digest.id,
    weekBucket: digest.weekBucket,
    topInsight: synth.topInsight,
    hasMovement: synth.hasMovement,
    recommendedAction: synth.recommendedAction,
    competitorsCount: rows.length,
  };
}
