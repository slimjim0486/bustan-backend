import { z } from "zod";
import { getAnthropicClient } from "@/services/claude";
import type {
  SeoActionTarget,
  SeoRecommendation,
  SeoSeverity,
} from "@/services/seo/types";
import type {
  AuditCollectorOutput,
  AuditRecommendationResult,
  AuditRestaurantContext,
  AuditScorecard,
} from "./types";

const ACTION_TARGETS = [
  "edit_profile",
  "edit_menu",
  "edit_photos",
  "improve_descriptions",
  "connect_gbp",
  "open_gbp",
  "open_talabat",
  "open_deliveroo",
  "open_website",
] as const;

const recommendationSchema = z.object({
  pillar: z.enum(["gbp", "onPage", "rankGrid", "citations", "reviews"]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().min(1).max(140),
  why: z.string().min(1).max(500),
  action: z.string().min(1).max(700),
  effort: z.enum(["low", "medium", "high"]),
  impact: z.enum(["low", "medium", "high"]),
  actionTarget: z.enum(ACTION_TARGETS).nullable().optional(),
});

const recommendationsSchema = z.array(recommendationSchema).min(1);

function parseJsonArray(text: string) {
  const normalized = text
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();
  return JSON.parse(normalized);
}

function fallbackSeverity(score: number): SeoSeverity {
  if (score < 40) return "critical";
  if (score < 58) return "high";
  if (score < 74) return "medium";
  return "low";
}

function fallbackTarget(key: string): SeoActionTarget {
  if (key === "photo") return "edit_photos";
  if (key === "delivery") return "open_talabat";
  if (key === "mobile") return "open_website";
  if (key === "reputation") return "open_gbp";
  return "edit_profile";
}

function toSeoPillar(key: string): SeoRecommendation["pillar"] {
  if (key === "reputation") return "reviews";
  if (key === "delivery") return "citations";
  if (key === "mobile") return "onPage";
  return "gbp";
}

function attachAction(
  recommendation: z.infer<typeof recommendationSchema>,
  restaurant: AuditRestaurantContext
): SeoRecommendation {
  const target = recommendation.actionTarget ?? null;
  const action = resolveActionTarget(target, restaurant);
  return {
    ...recommendation,
    actionTarget: target,
    actionLabel: action?.label ?? null,
    actionUrl: action?.url ?? null,
    actionExternal: action?.external ?? false,
    dismissedAt: null,
  };
}

function resolveActionTarget(
  target: SeoActionTarget | null,
  restaurant: AuditRestaurantContext
) {
  if (!target) return null;
  switch (target) {
    case "open_gbp":
      return restaurant.gbpConnection?.gbpUrl
        ? { label: "Open Google profile", url: restaurant.gbpConnection.gbpUrl, external: true }
        : null;
    case "open_talabat":
      return restaurant.talabatUrl
        ? { label: "Open Talabat", url: restaurant.talabatUrl, external: true }
        : null;
    case "open_deliveroo":
      return restaurant.deliverooUrl
        ? { label: "Open Deliveroo", url: restaurant.deliverooUrl, external: true }
        : null;
    case "open_website":
      return restaurant.website
        ? { label: "Open website", url: restaurant.website, external: true }
        : null;
    case "edit_photos":
      return { label: "Improve photos", url: "/dashboard/menu-photos", external: false };
    case "edit_menu":
      return { label: "Improve menu", url: "/dashboard/menu", external: false };
    case "improve_descriptions":
      return { label: "Improve descriptions", url: "/dashboard/menu-insights", external: false };
    case "connect_gbp":
      return { label: "Connect Google", url: "/dashboard/google-business", external: false };
    case "edit_profile":
    default:
      return { label: "Fix profile", url: "/dashboard/appearance", external: false };
  }
}

function fallbackTitle(key: string): string {
  if (key === "photo") return "Replace your weakest Google photos";
  if (key === "delivery") return "Close the gaps on delivery platforms";
  if (key === "mobile") return "Link a working website to your Google profile";
  if (key === "reputation") return "Respond to every review this month";
  return "Fill in your Google Business Profile";
}

function fallbackAction(key: string): string {
  if (key === "photo")
    return "Audit the lowest-scoring photos in your Google profile and replace them with daylight, eye-level food shots. Aim for at least 20 strong photos with at least 6 dish hero shots.";
  if (key === "delivery")
    return "Create or claim your listing on Talabat and Deliveroo using the same address and phone as your Google profile. Inconsistent NAP suppresses local rank.";
  if (key === "mobile")
    return "Add a website link to your Google Business Profile this week. If you don't have one, even a simple landing page with menu, hours, and an order link will unlock Google's 'Visit Website' button.";
  if (key === "reputation")
    return "Reply to every Google review from the past 90 days — both positive and negative. Aim for a response rate above 80%; it's a public signal that buyers and Google both weight.";
  return "Open your Google Business Profile and fill every empty field: secondary categories, services, attributes, and a complete weekly schedule.";
}

function fallbackRecommendations(
  scorecard: AuditScorecard,
  restaurant: AuditRestaurantContext
): SeoRecommendation[] {
  // Pillars marked not_assessed get a low-severity opportunity recommendation
  // rather than a CRITICAL flag, since we can't know how bad they really are.
  return Object.values(scorecard.pillars)
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((pillar) => {
      const isNotAssessed = pillar.status === "not_assessed";
      const severity: SeoSeverity = isNotAssessed ? "medium" : fallbackSeverity(pillar.score);
      return attachAction(
        {
          pillar: toSeoPillar(pillar.key),
          severity,
          title: fallbackTitle(pillar.key),
          why: isNotAssessed
            ? `${pillar.label} couldn't be measured this run — but the underlying setup is worth fixing for discovery.`
            : pillar.summary,
          action: fallbackAction(pillar.key),
          effort: "medium",
          impact: pillar.score < 70 && !isNotAssessed ? "high" : "medium",
          actionTarget: fallbackTarget(pillar.key),
        },
        restaurant
      );
    });
}

export async function recommendAuditActions(input: {
  restaurant: AuditRestaurantContext;
  scorecard: AuditScorecard;
  collectorOutput: AuditCollectorOutput;
}): Promise<AuditRecommendationResult> {
  const client = getAnthropicClient();
  if (!client) {
    return {
      recommendations: fallbackRecommendations(input.scorecard, input.restaurant),
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2600,
    system: `You are a Gulf/MENA restaurant growth strategist. Return only valid JSON.

You will receive: scorecard with pillars, GBP data, reviews + themes, delivery platform presence, photo-by-photo vision scores, page speed data, peer benchmark.

Output 5-8 recommendations. Each recommendation has:
- pillar: "gbp" | "onPage" | "rankGrid" | "citations" | "reviews"
- severity: "critical" | "high" | "medium" | "low"
- title: short imperative noun phrase, ≤ 70 chars (e.g., "Reshoot the 3 worst-performing photos", NOT "Improve Photo Quality")
- why: ONE sentence stating the current state with the actual number from the data ("Photos #2, #8, and #11 scored under 30/100 with poor lighting.")
- action: 1-3 sentences. MUST be a directive the owner can execute this week. MUST start with a verb. MUST reference specific items from the data — photo numbers, missing platforms by name, exact reviews count, etc. Include the "how" not just the "what".
- effort: "low" | "medium" | "high"
- impact: "low" | "medium" | "high"
- actionTarget: one of edit_profile, edit_menu, edit_photos, improve_descriptions, connect_gbp, open_gbp, open_talabat, open_deliveroo, open_website — pick the most relevant Bustan in-app target, or null if none fits.

CRITICAL RULES:
1. Pillars with status="not_assessed" should NOT generate a recommendation flagged as critical or high. If there's a useful action despite missing data (e.g., "no website detected → set one up"), use severity="medium" and frame it as opportunity, not problem.
2. Use REAL numbers from the data. "Photo #4 scored 22/100" not "some photos are low quality".
3. Pillar mapping: photo issues → "gbp"; mobile/website issues → "onPage"; delivery platform issues → "citations"; review issues → "reviews"; GBP profile gaps → "gbp".
4. Sort severity DESC, impact DESC. Highest-impact items first.
5. Never invent platform URLs, ratings, photos, or reviews not in the data.

EXAMPLES of good vs bad actions:

BAD: "Improve photo quality — 8 photos analyzed."
GOOD: "Delete photos #2 and #8 from your Google profile — both scored under 25/100 due to dim lighting. Reshoot the pesto pizza in daylight at a 45° angle and re-upload as the cover photo."

BAD: "Improve delivery citations — 1/3 tracked platforms found."
GOOD: "Create a Talabat and Deliveroo listing using your exact Google address. Both are missing — competitors in Dubai Media City average 2.5 delivery platforms, so you're losing aggregator demand to them."

BAD: "Improve Mobile & Web — collector did not return enough data."
GOOD: "Link a website to your Google profile this week. Without one, Google can't show 'Order Online' or 'Visit Website' buttons, which removes one of the highest-converting CTAs in local search."`,
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
          signals: input.collectorOutput,
        }),
      },
    ],
  });

  const text = response.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");

  try {
    const parsed = recommendationsSchema.parse(parseJsonArray(text)).slice(0, 8);
    return {
      recommendations: parsed.map((recommendation) =>
        attachAction(recommendation, input.restaurant)
      ),
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  } catch (error) {
    console.warn("Failed to parse audit recommendations; using fallback", error);
    return {
      recommendations: fallbackRecommendations(input.scorecard, input.restaurant),
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  }
}
