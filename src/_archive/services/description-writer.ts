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

interface MenuItemInput {
  id: string;
  name: string;
  description: string | null;
  price: number | string;
  sectionName: string;
}

interface RestaurantContext {
  name: string;
  cuisineType: string | null;
  location: string | null;
}

interface PromotionContentInput {
  type: "discounted_item" | "deal" | "combo";
  title?: string | null;
  subtitle?: string | null;
  description?: string | null;
  badgeLabel?: string | null;
  terms?: string | null;
  promoPrice?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  items: MenuItemInput[];
}

type Tone = "casual" | "upscale" | "playful" | "formal";

export async function enhanceSingleDescription(
  item: MenuItemInput,
  restaurant: RestaurantContext,
  tone?: Tone
): Promise<{ description: string; tokensIn: number; tokensOut: number }> {
  const client = getClient();
  if (!client) {
    throw new Error("AI service not configured");
  }

  const toneDirective = tone
    ? `Write in a ${tone} tone.`
    : "Write in a warm, inviting tone appropriate for the cuisine.";

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: `You are a menu copywriter for Gulf restaurants. Write a single compelling menu description.

Rules:
- Keep under 180 characters
- Use sensory language (taste, texture, aroma)
- Never invent ingredients not implied by the dish name
- Be culturally appropriate for the Gulf dining scene
- ${toneDirective}
- Return ONLY the description text, nothing else`,
    messages: [
      {
        role: "user",
        content: `Restaurant: ${restaurant.name}
Cuisine: ${restaurant.cuisineType ?? "International"}
Location: ${restaurant.location ?? "the UAE"}
Section: ${item.sectionName}
Dish: ${item.name}
Price: AED ${item.price}
${item.description ? `Current description: ${item.description}` : "No description yet."}

Write an enhanced menu description for this dish.`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return {
    description: text,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
  };
}

export async function enhanceBulkDescriptions(
  items: MenuItemInput[],
  restaurant: RestaurantContext,
  mode: "missing" | "weak" | "all",
  tone?: Tone
): Promise<{
  suggestions: Record<string, string>;
  tokensIn: number;
  tokensOut: number;
}> {
  const client = getClient();
  if (!client) {
    throw new Error("AI service not configured");
  }

  const filtered = items.filter((item) => {
    if (mode === "all") return true;
    if (mode === "missing") return !item.description;
    // "weak" = missing or under 30 chars
    return !item.description || item.description.length < 30;
  });

  if (!filtered.length) {
    return { suggestions: {}, tokensIn: 0, tokensOut: 0 };
  }

  const toneDirective = tone
    ? `Write in a ${tone} tone.`
    : "Write in a warm, inviting tone appropriate for the cuisine.";

  const menuListing = filtered
    .map(
      (item) =>
        `- ID: ${item.id} | Section: ${item.sectionName} | Name: ${item.name} | Price: AED ${item.price} | Description: ${item.description ?? "(none)"}`
    )
    .join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: `You are a menu copywriter for Gulf restaurants. Write compelling descriptions for multiple menu items, maintaining a consistent voice.

Rules:
- Keep each description under 180 characters
- Use sensory language (taste, texture, aroma)
- Never invent ingredients not implied by the dish name
- Be culturally appropriate for the Gulf dining scene
- ${toneDirective}
- Maintain consistent voice across all items
- Return ONLY valid JSON: { "suggestions": { "itemId": "description", ... } }`,
    messages: [
      {
        role: "user",
        content: `Restaurant: ${restaurant.name}
Cuisine: ${restaurant.cuisineType ?? "International"}
Location: ${restaurant.location ?? "the UAE"}

Menu items to enhance:
${menuListing}

Write enhanced descriptions for each item. Return JSON mapping item ID to description.`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  const parsed = JSON.parse(text) as { suggestions: Record<string, string> };

  return {
    suggestions: parsed.suggestions ?? {},
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
  };
}

export async function suggestPromotionContent(
  promotion: PromotionContentInput,
  restaurant: RestaurantContext,
  tone?: Tone
): Promise<{
  content: {
    title: string;
    subtitle: string;
    description: string;
    badgeLabel: string;
    terms: string;
  };
  tokensIn: number;
  tokensOut: number;
}> {
  const client = getClient();
  if (!client) {
    throw new Error("AI service not configured");
  }

  const toneDirective = tone
    ? `Write in a ${tone} tone.`
    : "Write in a warm, commercially sharp tone appropriate for Gulf restaurant marketing.";

  const itemListing = promotion.items
    .map(
      (item) =>
        `- Section: ${item.sectionName} | Dish: ${item.name} | Price: AED ${item.price} | Description: ${item.description ?? "(none)"}`
    )
    .join("\n");

  // Calculate total menu value of selected dishes for savings context
  const totalMenuValue = promotion.items.reduce(
    (sum, item) => sum + Number(item.price),
    0
  );
  const promoPrice = promotion.promoPrice ? Number(promotion.promoPrice) : null;
  const savings =
    promoPrice !== null && totalMenuValue > promoPrice
      ? totalMenuValue - promoPrice
      : null;
  const savingsPercent =
    savings !== null && totalMenuValue > 0
      ? Math.round((savings / totalMenuValue) * 100)
      : null;

  // Build pricing context block
  const pricingLines: string[] = [];
  pricingLines.push(`Total menu value of selected dishes: AED ${totalMenuValue}`);
  if (promoPrice !== null) {
    pricingLines.push(`Promo price: AED ${promoPrice}`);
  }
  if (savings !== null) {
    pricingLines.push(`Customer saves: AED ${savings} (${savingsPercent}% off)`);
  }

  // Build schedule context
  const scheduleLines: string[] = [];
  if (promotion.startsAt) {
    const start = new Date(promotion.startsAt);
    scheduleLines.push(
      `Starts: ${start.toLocaleDateString("en-AE", { weekday: "long", month: "long", day: "numeric" })}`
    );
  }
  if (promotion.endsAt) {
    const end = new Date(promotion.endsAt);
    scheduleLines.push(
      `Ends: ${end.toLocaleDateString("en-AE", { weekday: "long", month: "long", day: "numeric" })}`
    );
  }

  // Build offer-type guidance
  const typeGuidance: Record<string, string> = {
    discounted_item:
      "This is a single discounted dish. Emphasize the dish itself, its appeal, and the value. Great for upselling or spotlighting a signature item.",
    deal:
      "This is a merchandised deal. Focus on the overall value proposition and what the customer gets. Good for lunch specials, set menus, or timed offers.",
    combo:
      "This is a multi-dish combo. Highlight the variety and completeness of the meal. Emphasize convenience and the bundle value.",
  };

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 900,
    system: `You are Sous Chef, an AI copy strategist for restaurant offers in the Gulf. Generate offer copy for a restaurant owner.

Offer-type guidance:
${typeGuidance[promotion.type] ?? ""}

Rules:
- Optimize for conversion and clarity
- Keep title under 60 characters
- Keep subtitle under 90 characters
- Keep description under 220 characters
- Keep badgeLabel under 20 characters
- Keep terms under 120 characters
- Never invent ingredients not implied by the selected dishes
- Reference the actual dishes by name when it makes the copy more compelling
- If a promo price is provided, weave the value/savings angle into the copy naturally (e.g. "from AED X" or "save AED Y") without being pushy
- If schedule dates are provided, reflect any time-limited urgency or seasonal angle
- If the total value is much higher than the promo price, emphasize the exceptional deal
- Do not fabricate prices, dates, or dish names — only use what is provided
- ${toneDirective}
- Return ONLY valid JSON with this shape:
{
  "title": "...",
  "subtitle": "...",
  "description": "...",
  "badgeLabel": "...",
  "terms": "..."
}`,
    messages: [
      {
        role: "user",
        content: `Restaurant: ${restaurant.name}
Cuisine: ${restaurant.cuisineType ?? "International"}
Location: ${restaurant.location ?? "the UAE"}
Offer type: ${promotion.type}

Selected dishes:
${itemListing}

Pricing:
${pricingLines.join("\n")}
${scheduleLines.length > 0 ? `\nSchedule:\n${scheduleLines.join("\n")}` : ""}

Current copy (improve or replace):
- Title: ${promotion.title ?? "(empty)"}
- Subtitle: ${promotion.subtitle ?? "(empty)"}
- Description: ${promotion.description ?? "(empty)"}
- Badge label: ${promotion.badgeLabel ?? "(empty)"}
- Terms: ${promotion.terms ?? "(empty)"}

Generate compelling, offer-specific marketing copy that leverages the dishes, pricing, and schedule above.`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  const parsed = JSON.parse(text) as {
    title?: string;
    subtitle?: string;
    description?: string;
    badgeLabel?: string;
    terms?: string;
  };

  return {
    content: {
      title: parsed.title?.trim() ?? "",
      subtitle: parsed.subtitle?.trim() ?? "",
      description: parsed.description?.trim() ?? "",
      badgeLabel: parsed.badgeLabel?.trim() ?? "",
      terms: parsed.terms?.trim() ?? "",
    },
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
  };
}
