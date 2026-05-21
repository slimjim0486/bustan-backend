import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";

export type AiFeature =
  | "description_enhance"
  | "tag_analysis"
  | "menu_analysis"
  | "image_enhancement"
  | "dish_image_generation"
  | "owner_chat"
  | "owner_chat_extraction"
  | "owner_chat_whisper"
  | "seo_analysis"
  | "ad_studio_project"
  | "sous_chef_message"
  | "ad_studio_image"
  | "ad_studio_image_openai"
  | "review_reply_draft"
  | "competitor_intel_digest";

const TOKEN_PRICING_USD = {
  haiku: {
    input: 0.0000008,
    output: 0.000004,
  },
  sonnet: {
    input: 0.000003,
    output: 0.000015,
  },
} as const;

function getTokenPricing(feature: AiFeature) {
  switch (feature) {
    case "owner_chat":
    case "owner_chat_extraction":
    case "owner_chat_whisper":
    case "sous_chef_message":
    case "competitor_intel_digest":
      return TOKEN_PRICING_USD.haiku;
    default:
      return TOKEN_PRICING_USD.sonnet;
  }
}

export function estimateAiUsageCost(
  feature: AiFeature,
  tokensIn: number,
  tokensOut: number,
  extraCostUsd = 0
) {
  const pricing = getTokenPricing(feature);
  return tokensIn * pricing.input + tokensOut * pricing.output + extraCostUsd;
}

export async function checkAiLimit(
  restaurantId: string,
  feature: AiFeature,
  limit: number | null
): Promise<{ used: number; remaining: number | null; allowed: boolean }> {
  if (limit === null) {
    return { used: 0, remaining: null, allowed: true };
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const used = await prisma.aiUsageLog.count({
    where: {
      restaurantId,
      feature,
      createdAt: { gte: monthStart },
    },
  });

  return {
    used,
    remaining: Math.max(limit - used, 0),
    allowed: used < limit,
  };
}

export async function logAiUsage(
  restaurantId: string,
  feature: AiFeature,
  tokensIn: number,
  tokensOut: number,
  extraCostUsd = 0
) {
  const costUsd = estimateAiUsageCost(feature, tokensIn, tokensOut, extraCostUsd);

  await prisma.aiUsageLog.create({
    data: {
      restaurantId,
      feature,
      tokensIn,
      tokensOut,
      costUsd,
    },
  });
}

export async function computeMenuHash(restaurantId: string): Promise<string> {
  const sections = await prisma.menuSection.findMany({
    where: { restaurantId },
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

  const serialized = JSON.stringify(
    sections.map((s) => ({
      name: s.name,
      items: s.items.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        price: i.price.toString(),
      })),
    }))
  );

  return createHash("sha256").update(serialized).digest("hex");
}

export async function getAiUsageSummary(restaurantId: string, feature: AiFeature) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const used = await prisma.aiUsageLog.count({
    where: {
      restaurantId,
      feature,
      createdAt: { gte: monthStart },
    },
  });

  return { used };
}
