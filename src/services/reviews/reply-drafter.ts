// Claude-backed Google-review reply drafter.
//
// Given a restaurant + a batch of unanswered reviews, returns one
// professional, owner-voiced reply per review. Conservative tone: warm,
// brief, acknowledges the reviewer by first name, addresses one specific
// thing in the review when possible. Negative reviews get more deference,
// no defensiveness. Output is plain text (no markdown) so it pastes
// cleanly into the GBP reply box.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

let anthropic: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

interface RestaurantContext {
  name: string;
  cuisineType: string | null;
  location: string | null;
}

interface ReviewInput {
  id: string;
  reviewerName: string;
  rating: number;
  text: string;
}

interface ReplyDraft {
  reviewId: string;
  reply: string;
}

export interface DraftRepliesResult {
  drafts: ReplyDraft[];
  tokensIn: number;
  tokensOut: number;
}

const SYSTEM_PROMPT = `You are an owner-voiced reply drafter for Google Business Profile reviews. Write replies that:
- Greet the reviewer by their first name (extract from full name)
- Stay under 280 characters per reply
- Acknowledge one specific thing they mentioned (a dish, service moment, etc.)
- For 5-star reviews: warm and grateful, invite them back
- For 3-4 star reviews: thank them, briefly address their note constructively
- For 1-2 star reviews: deferential, no defensiveness, offer to make it right offline (mention the restaurant by name, not a generic "we")
- Never promise discounts or freebies
- Never use markdown, emojis except a single 🌿 or 🙏 if culturally appropriate
- Write in the language of the review (Arabic in Arabic, English in English)
- Sign as the restaurant team (e.g. "The team at <restaurant>")

Output JSON only: {"drafts": [{"reviewId": "...", "reply": "..."}]}`;

export async function draftReplies(
  restaurant: RestaurantContext,
  reviews: ReviewInput[]
): Promise<DraftRepliesResult> {
  if (reviews.length === 0) {
    return { drafts: [], tokensIn: 0, tokensOut: 0 };
  }
  const client = getClient();
  if (!client) {
    // Soft-fallback: produce a generic-but-personalised reply per review.
    return {
      drafts: reviews.map((r) => ({
        reviewId: r.id,
        reply: fallbackReply(restaurant, r),
      })),
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  const userPrompt = [
    `Restaurant: ${restaurant.name}`,
    restaurant.cuisineType ? `Cuisine: ${restaurant.cuisineType}` : null,
    restaurant.location ? `Location: ${restaurant.location}` : null,
    "",
    "Reviews to reply to:",
    JSON.stringify(
      reviews.map((r) => ({
        reviewId: r.id,
        reviewerName: r.reviewerName,
        rating: r.rating,
        text: r.text,
      })),
      null,
      2
    ),
    "",
    "Return JSON with one reply per review.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: Math.min(4096, 400 * reviews.length),
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  let drafts: ReplyDraft[] = [];
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
        drafts?: ReplyDraft[];
      };
      drafts = Array.isArray(parsed.drafts) ? parsed.drafts : [];
    } catch {
      drafts = [];
    }
  }

  // Belt-and-suspenders: ensure every input review has a draft. If Claude
  // dropped one (rare, but possible if max_tokens cuts mid-array), backfill
  // with the deterministic fallback so the owner doesn't see a gap.
  const haveDraftFor = new Set(drafts.map((d) => d.reviewId));
  for (const r of reviews) {
    if (!haveDraftFor.has(r.id)) {
      drafts.push({ reviewId: r.id, reply: fallbackReply(restaurant, r) });
    }
  }

  return {
    drafts,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
  };
}

function fallbackReply(restaurant: RestaurantContext, review: ReviewInput): string {
  const firstName = review.reviewerName.split(/\s+/)[0] || review.reviewerName;
  if (review.rating >= 4) {
    return `Thank you ${firstName}! It means a lot that you took the time to share this. We hope to see you again soon at ${restaurant.name}.`;
  }
  if (review.rating === 3) {
    return `Thanks for the honest feedback, ${firstName}. We're always looking to improve — if there's anything specific you'd like us to address, please reach out directly. — The team at ${restaurant.name}`;
  }
  return `${firstName}, thank you for taking the time to share this. We're sorry your visit didn't live up to expectations. Please reach out so we can make it right. — The team at ${restaurant.name}`;
}
