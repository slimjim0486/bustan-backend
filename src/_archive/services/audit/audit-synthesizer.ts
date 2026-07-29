import { z } from "zod";
import { getAnthropicClient } from "@/services/claude";
import type {
  AuditCollectorOutput,
  AuditRestaurantContext,
  AuditScorecard,
  AuditSynthesis,
} from "./types";

const synthesisSchema = z.object({
  executiveSummary: z.string().min(1).max(900),
  photoCritique: z.string().min(1).max(700),
  peerNarrative: z.string().min(1).max(700),
});

function fallbackSynthesis(
  restaurant: AuditRestaurantContext,
  scorecard: AuditScorecard,
  output: AuditCollectorOutput
): AuditSynthesis {
  const assessedPillars = Object.values(scorecard.pillars).filter(
    (pillar) => pillar.status !== "not_assessed"
  );
  const strongest = [...assessedPillars].sort((a, b) => b.score - a.score)[0];
  const weakest = [...assessedPillars].sort((a, b) => a.score - b.score)[0];

  const strengthLine = strongest
    ? `${restaurant.name} is performing well on ${strongest.label.toLowerCase()} (${strongest.score}/100).`
    : `${restaurant.name} has a baseline discovery footprint we measured.`;
  const opportunityLine = weakest
    ? ` The biggest unlock is ${weakest.label.toLowerCase()} — improving it would move your overall score the most.`
    : "";
  const peerLine = scorecard.peerComparison
    ? scorecard.peerComparison.diff !== null && scorecard.peerComparison.diff >= 0
      ? ` You're ${scorecard.peerComparison.diff} points ahead of ${scorecard.peerComparison.cohortLabel}.`
      : ` You're ${Math.abs(scorecard.peerComparison.diff ?? 0)} points behind ${scorecard.peerComparison.cohortLabel} — closeable in 2-4 weeks.`
    : "";

  return {
    executiveSummary: `${strengthLine}${opportunityLine}${peerLine}`.trim(),
    photoCritique:
      output.photoVision?.summary ??
      "Photo quality could not be fully reviewed from the available Google Maps images.",
    peerNarrative:
      output.peerBenchmark?.medianReviewCount !== null
        ? `Nearby peers have a median of ${output.peerBenchmark?.medianReviewCount} Google reviews in this cuisine/location sample.`
        : "Peer benchmark data was limited for this cuisine/location sample.",
    tokensIn: 0,
    tokensOut: 0,
  };
}

function parseJson(text: string) {
  const normalized = text
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(normalized);
}

export async function synthesizeAudit(input: {
  restaurant: AuditRestaurantContext;
  scorecard: AuditScorecard;
  collectorOutput: AuditCollectorOutput;
}): Promise<AuditSynthesis> {
  const client = getAnthropicClient();
  if (!client) {
    return fallbackSynthesis(input.restaurant, input.scorecard, input.collectorOutput);
  }

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: `You are a Gulf/MENA restaurant growth strategist writing an audit narrative for a restaurant owner.
Return only valid JSON.

Rules for executiveSummary (3-4 sentences, in this exact order):
1. Lead with the STRONGEST pillar as a compliment — name it specifically with the score.
2. Then name the BIGGEST UNLOCK (the lowest-scoring pillar that was actually assessed) and frame it as opportunity, not failure. Use phrasing like "the biggest unlock", "the clearest place to grow", "where the upside lives". Never use "data unavailable", "we couldn't", "degraded", "failed", or apologetic language.
3. State the single concrete action that would move the score the most, this week.
4. If peerComparison is present, add ONE clause comparing to peers (e.g., "ahead of Italian restaurants in Dubai Media City" or "5 points behind your cohort").

IMPORTANT — handling not_assessed pillars:
- Pillars with status="not_assessed" mean we couldn't collect data, NOT that the restaurant is failing.
- Never describe a not_assessed pillar as the weak spot. Pick the lowest-scoring pillar with status="ok" instead.
- If a not_assessed pillar is relevant (e.g., no website is linked), mention it as a separate observation, never as the main weakness.

For photoCritique (2-3 sentences): describe the visual quality patterns from the photo data — lighting, food appeal, composition. Be specific.

For peerNarrative (2-3 sentences): if peerComparison is present, compare directly using the cohortLabel and the diff. If only medianRating/medianReviewCount exists, use those. Be honest about cohort size.

Use Gulf/MENA framing where natural ("Gulf restaurants", "your area"). Never say "Dubai restaurants" generically.`,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          restaurant: {
            name: input.restaurant.name,
            location: input.restaurant.location,
            cuisine: input.restaurant.cuisineType,
          },
          scorecard: input.scorecard,
          signals: {
            google: input.collectorOutput.gbp,
            reviews: input.collectorOutput.reviews
              ? {
                  averageRating: input.collectorOutput.reviews.averageRating,
                  responseRate: input.collectorOutput.reviews.responseRate,
                  themes: input.collectorOutput.reviews.themes,
                  sampleSize: input.collectorOutput.reviews.reviews.length,
                }
              : null,
            delivery: input.collectorOutput.citations,
            mobile: input.collectorOutput.pageSpeed,
            photos: input.collectorOutput.photoVision,
            peers: input.collectorOutput.peerBenchmark,
            failures: input.collectorOutput.failures,
          },
          expectedShape: {
            executiveSummary: "3-4 sentences: strongest pillar (compliment) → biggest unlock (opportunity framing) → concrete action this week → peer comparison line if available",
            photoCritique: "2-3 sentences naming specific visual quality patterns",
            peerNarrative: "2-3 sentences using cohortLabel + diff or median data, honest about cohort size",
          },
        }),
      },
    ],
  });

  const text = response.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");

  try {
    const parsed = synthesisSchema.parse(parseJson(text));
    return {
      ...parsed,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  } catch (error) {
    console.warn("Failed to parse audit synthesis; using fallback", error);
    const fallback = fallbackSynthesis(input.restaurant, input.scorecard, input.collectorOutput);
    return {
      ...fallback,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  }
}
