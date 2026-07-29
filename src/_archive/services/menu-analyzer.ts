import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ApiError } from "@/lib/errors";
import { env } from "@/lib/env";
import { computeMenuHash } from "@/lib/ai-usage";
import { prisma } from "@/lib/prisma";
import type { MenuAnalysisLevel } from "@/lib/entitlements";

let anthropic: Anthropic | null = null;
const MENU_ANALYSIS_TIMEOUT_MS = 90_000;
const MENU_ANALYSIS_MAX_TOKENS = 12_000;

function getClient(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

interface RestaurantContext {
  id: string;
  name: string;
  cuisineType: string | null;
  location: string | null;
}

const menuFixSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().optional(),
    kind: z.literal("adjust_price"),
    menuItemId: z.string().min(1),
    suggestedPrice: z.number().positive(),
    reason: z.string().min(1).max(400),
  }),
  z.object({
    id: z.string().optional(),
    kind: z.literal("replace_description"),
    menuItemId: z.string().min(1),
    suggestedDescription: z.string().min(1).max(400),
    reason: z.string().min(1).max(400),
  }),
  z.object({
    id: z.string().optional(),
    kind: z.literal("add_menu_item"),
    targetSectionName: z.string().min(1).max(120),
    suggestedName: z.string().min(1).max(120),
    suggestedDescription: z.string().min(1).max(400),
    suggestedPrice: z.number().positive(),
    reason: z.string().min(1).max(400),
  }),
  z.object({
    id: z.string().optional(),
    kind: z.literal("normalize_name"),
    menuItemId: z.string().min(1),
    suggestedName: z.string().min(1).max(120),
    reason: z.string().min(1).max(400),
  }),
]);

const analysisItemSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["warning", "suggestion", "positive"]),
  message: z.string().min(1).max(500),
  menuItemId: z.string().optional(),
  menuItemName: z.string().optional(),
  fix: menuFixSchema.nullish(),
});

const categoryAnalysisSchema = z.object({
  score: z.number().min(0).max(100),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(500),
  items: z.array(analysisItemSchema).max(5),
});

const menuAnalysisSchema = z.object({
  overallScore: z.number().min(0).max(100),
  categories: z.object({
    pricing: categoryAnalysisSchema,
    descriptions: categoryAnalysisSchema,
    structure: categoryAnalysisSchema,
    gaps: categoryAnalysisSchema,
    seasonal: categoryAnalysisSchema,
  }),
});

export interface MenuAnalysisResult {
  overallScore: number;
  categories: {
    pricing: CategoryAnalysis;
    descriptions: CategoryAnalysis;
    structure: CategoryAnalysis;
    gaps: CategoryAnalysis;
    seasonal: CategoryAnalysis;
  };
}

export interface CategoryAnalysis {
  score: number;
  title: string;
  summary: string;
  items: AnalysisItem[];
}

export interface AnalysisItem {
  id: string;
  type: "warning" | "suggestion" | "positive";
  message: string;
  menuItemId?: string;
  menuItemName?: string;
  fix?: MenuAnalysisFix | null;
}

export type MenuAnalysisFix =
  | AdjustPriceFix
  | ReplaceDescriptionFix
  | AddMenuItemFix
  | NormalizeNameFix;

export interface BaseMenuAnalysisFix {
  id: string;
  reason: string;
}

export interface AdjustPriceFix extends BaseMenuAnalysisFix {
  kind: "adjust_price";
  menuItemId: string;
  suggestedPrice: number;
}

export interface ReplaceDescriptionFix extends BaseMenuAnalysisFix {
  kind: "replace_description";
  menuItemId: string;
  suggestedDescription: string;
}

export interface AddMenuItemFix extends BaseMenuAnalysisFix {
  kind: "add_menu_item";
  targetSectionName: string;
  suggestedName: string;
  suggestedDescription: string;
  suggestedPrice: number;
}

export interface NormalizeNameFix extends BaseMenuAnalysisFix {
  kind: "normalize_name";
  menuItemId: string;
  suggestedName: string;
}

export async function analyzeMenu(
  restaurant: RestaurantContext,
  level: MenuAnalysisLevel
): Promise<{
  result: MenuAnalysisResult;
  cached: boolean;
  tokensIn: number;
  tokensOut: number;
}> {
  const menuHash = await computeMenuHash(restaurant.id);

  // Check cache: matching hash < 24h old
  const cached = await prisma.menuAnalysis.findFirst({
    where: {
      restaurantId: restaurant.id,
      analysisType: "full",
      menuHash,
      createdAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (cached) {
    const fullResult = normalizeMenuAnalysisResult(cached.result);
    if (level === "basic") {
      return {
        result: trimToBasic(fullResult),
        cached: true,
        tokensIn: 0,
        tokensOut: 0,
      };
    }
    return { result: fullResult, cached: true, tokensIn: 0, tokensOut: 0 };
  }

  // Run fresh analysis
  const client = getClient();
  if (!client) {
    throw new Error("AI service not configured");
  }

  const sections = await prisma.menuSection.findMany({
    where: { restaurantId: restaurant.id },
    orderBy: { displayOrder: "asc" },
    include: {
      items: {
        orderBy: { displayOrder: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
        },
      },
    },
  });

  const menuListing = sections
    .map(
      (s) =>
        `## ${s.name}\n${s.items.map((i) => `- ID: ${i.id} | ${i.name} | AED ${i.price} | ${i.description ?? "(no description)"}`).join("\n")}`
    )
    .join("\n\n");

  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "long" });

  let response;
  try {
    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: MENU_ANALYSIS_MAX_TOKENS,
      system: `You are a Gulf restaurant menu consultant focused on the UAE and GCC market. Analyze the menu and provide actionable insights.

Current date context: ${month} ${now.getFullYear()}. Consider the Gulf calendar:
- Ramadan (varies): special iftar menus, shorter dining hours
- Summer (Jun-Sep): lighter dishes, cold beverages, indoor dining focus
- Tourist season (Nov-Mar): higher prices justified, international appeal matters
- UAE National Day (Dec 2), Saudi National Day (Sep 23): celebration menus

Return ONLY valid JSON in this exact format:
{
  "overallScore": 75,
  "categories": {
    "pricing": {
      "score": 80,
      "title": "Pricing Health",
      "summary": "Brief summary",
      "items": [{
        "type": "warning|suggestion|positive",
        "message": "Detail",
        "menuItemId": "optional",
        "menuItemName": "optional",
        "fix": {
          "kind": "adjust_price|replace_description|add_menu_item|normalize_name",
          "reason": "Why this fix helps",
          "...typeSpecificFields": "see below"
        }
      }]
    },
    "descriptions": {
      "score": 60,
      "title": "Description Quality",
      "summary": "Brief summary",
      "items": [...]
    },
    "structure": {
      "score": 70,
      "title": "Menu Structure",
      "summary": "Brief summary",
      "items": [...]
    },
    "gaps": {
      "score": 65,
      "title": "Missing Items",
      "summary": "Brief summary",
      "items": [...]
    },
    "seasonal": {
      "score": 80,
      "title": "Seasonal Tips",
      "summary": "Brief summary",
      "items": [...]
    }
  }
}

Analysis criteria:
- Pricing: inconsistencies within sections, outliers for cuisine type in the Gulf
- Descriptions: quality score per item, identify weak/missing (under 20 chars) or absent descriptions
- Structure: section count/balance, naming clarity, item distribution
- Gaps: missing staple dishes for cuisine type
- Seasonal: current month opportunities for the Gulf market
- Overall score: weighted average (0-100)
- Keep items arrays concise (max 5 items per category)
- Include menuItemId and menuItemName when referencing specific items
- Add a "fix" object for actionable warning/suggestion items when possible. Set "fix" to null for positive items or when no safe fix is available
- Fix shapes:
  - Pricing outlier -> { "kind": "adjust_price", "menuItemId": "...", "suggestedPrice": 42, "reason": "..." }
  - Weak/missing description -> { "kind": "replace_description", "menuItemId": "...", "suggestedDescription": "...", "reason": "..." }
  - Missing staple dish -> { "kind": "add_menu_item", "targetSectionName": "Mains", "suggestedName": "...", "suggestedDescription": "...", "suggestedPrice": 38, "reason": "..." }
  - Inconsistent naming -> { "kind": "normalize_name", "menuItemId": "...", "suggestedName": "...", "reason": "..." }
- Keep description fixes under 180 characters
- Use rounded AED prices when suggesting prices
- Never invent menuItemId values. Only use IDs present in the menu listing`,
    messages: [
      {
        role: "user",
        content: `Restaurant: ${restaurant.name}
Cuisine: ${restaurant.cuisineType ?? "International"}
Location: ${restaurant.location ?? "the UAE"}
Total items: ${totalItems}
Total sections: ${sections.length}

Menu:
${menuListing}

Analyze this menu comprehensively.`,
      },
    ],
    }, {
      timeout: MENU_ANALYSIS_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";

    if (message.includes("timeout") || message.includes("timed out") || message.includes("abort")) {
      throw new ApiError(
        "Menu analysis is taking too long right now. Please try again in a moment.",
        504
      );
    }

    throw error;
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```json\s*/, "")
    .replace(/^```\s*/, "")
    .replace(/```$/, "")
    .trim();

  const result = normalizeMenuAnalysisResult(JSON.parse(text));

  // Store in cache
  await prisma.menuAnalysis.create({
    data: {
      restaurantId: restaurant.id,
      analysisType: "full",
      result: result as any,
      menuHash,
    },
  });

  const finalResult = level === "basic" ? trimToBasic(result) : result;

  return {
    result: finalResult,
    cached: false,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
  };
}

function trimToBasic(result: MenuAnalysisResult): MenuAnalysisResult {
  // For basic tier: only overall score + top 3 issues across all categories
  const allItems = Object.values(result.categories).flatMap((cat) =>
    cat.items
      .filter((i) => i.type !== "positive")
      .map((i) => ({ ...i, categoryTitle: cat.title }))
  );

  const top3 = allItems.slice(0, 3);

  return {
    overallScore: result.overallScore,
    categories: {
      pricing: {
        ...result.categories.pricing,
        items: top3.filter((i) => i.categoryTitle === "Pricing Health"),
      },
      descriptions: {
        ...result.categories.descriptions,
        items: top3.filter((i) => i.categoryTitle === "Description Quality"),
      },
      structure: {
        ...result.categories.structure,
        items: top3.filter((i) => i.categoryTitle === "Menu Structure"),
      },
      gaps: {
        ...result.categories.gaps,
        items: top3.filter((i) => i.categoryTitle === "Missing Items"),
      },
      seasonal: {
        ...result.categories.seasonal,
        items: top3.filter((i) => i.categoryTitle === "Seasonal Tips"),
      },
    },
  };
}

export function normalizeMenuAnalysisResult(input: unknown): MenuAnalysisResult {
  const parsed = menuAnalysisSchema.parse(input);
  const categories = Object.fromEntries(
    Object.entries(parsed.categories).map(([categoryKey, category]) => [
      categoryKey,
      {
        ...category,
        items: category.items.map((item, index) => {
          const itemId = item.id?.trim() || buildAnalysisItemId(categoryKey, index, item);
          const fix = item.fix
            ? {
                ...item.fix,
                id: item.fix.id?.trim() || `${itemId}-fix`,
              }
            : null;

          return {
            ...item,
            id: itemId,
            fix,
          };
        }),
      },
    ])
  ) as MenuAnalysisResult["categories"];

  return {
    overallScore: parsed.overallScore,
    categories,
  };
}

function buildAnalysisItemId(
  categoryKey: string,
  index: number,
  item: z.infer<typeof analysisItemSchema>
) {
  const target = item.menuItemId ?? item.menuItemName ?? item.message;
  return `${categoryKey}-${index}-${slugify(target)}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "issue";
}
