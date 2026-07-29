import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";

const responseSchema = z.object({
  matches: z.array(
    z.object({
      itemId: z.string().min(1),
      pageNumber: z.number().int().positive(),
      confidence: z.number().min(0).max(1),
      bbox: z.object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().min(0.05).max(1),
        height: z.number().min(0.05).max(1),
      }),
      note: z.string().max(280).optional(),
    })
  ),
});

let anthropic: Anthropic | null = null;

function getClient() {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ApiError("Anthropic is not configured", 503);
  }

  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  return anthropic;
}

function safeJsonParse(input: string) {
  const normalized = input
    .trim()
    .replace(/^```json/, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  return responseSchema.parse(JSON.parse(normalized));
}

export async function detectMenuSourceImages(input: {
  restaurantName: string;
  menuItems: Array<{
    id: string;
    name: string;
    sectionName?: string | null;
  }>;
  pages: Array<{
    pageNumber: number;
    base64: string;
    contentType: "image/jpeg" | "image/png" | "image/webp";
  }>;
}) {
  if (!input.pages.length || !input.menuItems.length) {
    return { matches: [] as z.infer<typeof responseSchema>["matches"] };
  }

  const client = getClient();
  const itemList = input.menuItems
    .map((item) => `- ${item.id} | ${item.name}${item.sectionName ? ` | ${item.sectionName}` : ""}`)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    system: [
      "You detect real dish or drink photographs from restaurant menu page images and match them to exact menu item IDs.",
      "Only return a match when the item identity is genuinely likely from surrounding text/layout or obvious visual pairing.",
      "Do not return decorative backgrounds, logos, icons, chef photos, or generic stock imagery.",
      "Bounding boxes must tightly frame the food/drink photograph in normalized coordinates from 0 to 1.",
      "If a page has no trustworthy dish photos, omit it.",
      "Return valid JSON only in this shape:",
      '{"matches":[{"itemId":"...","pageNumber":1,"confidence":0.91,"bbox":{"x":0.1,"y":0.2,"width":0.3,"height":0.25},"note":"short reason"}]}',
    ].join(" "),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `Restaurant: ${input.restaurantName}`,
              "",
              "Menu items:",
              itemList,
              "",
              "Task:",
              "- Review every attached page image.",
              "- Find real dish or drink photographs.",
              "- Match each photograph to the best exact itemId only if confident.",
              "- Prefer precision over recall.",
              "- Return at most one match per itemId.",
            ].join("\n"),
          },
          ...input.pages.flatMap((page) => [
            {
              type: "text" as const,
              text: `Page ${page.pageNumber}`,
            },
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: page.contentType,
                data: page.base64,
              },
            },
          ]),
        ],
      },
    ],
  });

  const text = response.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");

  const parsed = safeJsonParse(text);
  const deduped = new Map<string, (typeof parsed.matches)[number]>();

  for (const match of parsed.matches) {
    const existing = deduped.get(match.itemId);
    if (!existing || match.confidence > existing.confidence) {
      deduped.set(match.itemId, match);
    }
  }

  return {
    matches: Array.from(deduped.values())
      .filter((match) => match.confidence >= 0.55)
      .sort((a, b) => b.confidence - a.confidence),
  };
}
