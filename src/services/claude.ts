import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import type { MenuExtractionDraft, ServiceExtractionDraft } from "./types";

const MENU_EXTRACTION_TOOL_NAME = "record_menu_extraction";
const MENU_EXTRACTION_MAX_TOKENS = 16384;
const SERVICE_EXTRACTION_TOOL_NAME = "record_service_extraction";
const SERVICE_EXTRACTION_MAX_TOKENS = 12000;

const DETAILED_SYSTEM_PROMPT = [
  "You are a menu extraction assistant for restaurants.",
  "Extract all visible menu sections, item names, descriptions, and prices from the provided text, image, or PDF.",
  "Use 0 for prices that are missing or unreadable.",
  "Keep descriptions concise, at most 140 characters.",
  "Ignore duplicate modifier rows, legal text, QR instructions, delivery app notes, social media handles, and allergen disclaimers unless they are part of an item description.",
  "Preserve the restaurant's original section and dish wording where practical.",
  "Call the record_menu_extraction tool with the complete extracted menu.",
].join(" ");

const COMPACT_SYSTEM_PROMPT = [
  "You are a menu extraction assistant for restaurants.",
  "The first extraction attempt was too large, so produce a compact extraction that still gives the user an editable menu draft.",
  "Prioritize section names, item names, and numeric prices.",
  "Set description to null unless a very short description is essential to distinguish the item.",
  "Ignore duplicate modifier rows, legal text, QR instructions, delivery app notes, social media handles, and allergen disclaimers.",
  "If the source contains many repeated variants, keep the main menu item and omit repetitive add-ons.",
  "Call the record_menu_extraction tool with the compact extracted menu.",
].join(" ");

class MenuExtractionTooLargeError extends Error {
  constructor() {
    super("Menu extraction response exceeded the output token budget");
    this.name = "MenuExtractionTooLargeError";
  }
}

const priceSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    const numeric = Number(value.replace(/[^\d.-]/g, ""));
    return Number.isFinite(numeric) ? numeric : 0;
  }

  return value;
}, z.number().finite().nonnegative().default(0));

const menuExtractionSchema = z.object({
  sections: z.array(
    z.object({
      name: z.string().trim().min(1),
      items: z.array(
        z.object({
          name: z.string().trim().min(1),
          description: z.string().trim().nullable().default(null),
          price: priceSchema,
        })
      ),
    })
  ),
});

const MENU_EXTRACTION_TOOL: Anthropic.Tool = {
  name: MENU_EXTRACTION_TOOL_NAME,
  description: "Record the complete structured restaurant menu extracted from the source document.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sections: {
        type: "array",
        description: "All menu sections in reading order.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: {
              type: "string",
              description: "Section name, such as Starters, Mains, Desserts, or Beverages.",
            },
            items: {
              type: "array",
              description: "Menu items in this section.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: {
                    type: "string",
                    description: "Menu item name exactly as shown where practical.",
                  },
                  description: {
                    type: ["string", "null"],
                    description: "Item description if present, otherwise null.",
                  },
                  price: {
                    type: "number",
                    description: "Numeric price only. Use 0 when missing or unreadable.",
                  },
                },
                required: ["name", "description", "price"],
              },
            },
          },
          required: ["name", "items"],
        },
      },
    },
    required: ["sections"],
  },
};

const nullableTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? null : value),
  z.string().trim().nullable().default(null)
);

const serviceExtractionSchema = z.object({
  services: z.array(
    z.object({
      category: z.string().trim().min(1),
      name: z.string().trim().min(1),
      nameAr: nullableTrimmedString,
      priceAed: priceSchema,
      durationMinutes: z.preprocess(
        (value) => {
          if (value === null || value === undefined || value === "") return null;
          const numeric = Number(value);
          return Number.isFinite(numeric) ? Math.round(numeric) : null;
        },
        z.number().int().positive().max(1440).nullable().default(null)
      ),
      description: nullableTrimmedString,
    })
  ),
});

const SERVICE_EXTRACTION_TOOL: Anthropic.Tool = {
  name: SERVICE_EXTRACTION_TOOL_NAME,
  description:
    "Record the complete structured service list extracted from a salon or home-service price list.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      services: {
        type: "array",
        description: "All bookable services in reading order.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: { type: "string" },
            name: { type: "string" },
            nameAr: { type: ["string", "null"] },
            priceAed: { type: "number" },
            durationMinutes: { type: ["number", "null"] },
            description: { type: ["string", "null"] },
          },
          required: [
            "category",
            "name",
            "nameAr",
            "priceAed",
            "durationMinutes",
            "description",
          ],
        },
      },
    },
    required: ["services"],
  },
};

let anthropic: Anthropic | null = null;

export function getAnthropicClient() {
  if (!env.ANTHROPIC_API_KEY) {
    return null;
  }

  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  return anthropic;
}

function safeJsonParse(input: string): MenuExtractionDraft {
  const normalized = input
    .trim()
    .replace(/^```json/, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new ApiError("Menu extraction returned incomplete JSON. Please try again.", 502);
  }

  try {
    return validateMenuExtraction(parsed);
  } catch {
    throw new ApiError("Menu extraction response did not match the expected structure.", 502);
  }
}

function validateMenuExtraction(input: unknown): MenuExtractionDraft {
  const parsed = menuExtractionSchema.parse(input);

  if (!Array.isArray(parsed.sections)) {
    throw new ApiError("Claude extraction response was not valid JSON", 502);
  }

  return parsed;
}

function fallbackExtraction(sourceText: string): MenuExtractionDraft {
  const lines = sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return { sections: [] };
  }

  return {
    sections: [
      {
        name: "Imported Menu",
        items: lines.map((line, index) => ({
          name: line.replace(/\s+-\s+AED\s+\d+.*/, ""),
          description: null,
          price: index + 1,
        })),
      },
    ],
  };
}

export async function extractMenuFromSource(input: {
  sourceText?: string;
  fileName?: string;
  contentType?: string;
  base64?: string;
}) {
  const client = getAnthropicClient();
  const fallbackSource = [
    input.fileName ? `File: ${input.fileName}` : null,
    input.sourceText,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!client) {
    return fallbackExtraction(fallbackSource);
  }

  try {
    return await extractMenuWithClaude(client, input, fallbackSource, DETAILED_SYSTEM_PROMPT);
  } catch (error) {
    if (!(error instanceof MenuExtractionTooLargeError)) {
      throw error;
    }
  }

  try {
    return await extractMenuWithClaude(client, input, fallbackSource, COMPACT_SYSTEM_PROMPT);
  } catch (error) {
    if (error instanceof MenuExtractionTooLargeError && fallbackSource.trim()) {
      return fallbackExtraction(fallbackSource);
    }

    throw error;
  }
}

async function extractMenuWithClaude(
  client: Anthropic,
  input: {
    sourceText?: string;
    fileName?: string;
    contentType?: string;
    base64?: string;
  },
  fallbackSource: string,
  systemPrompt: string
) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: MENU_EXTRACTION_MAX_TOKENS,
    system: systemPrompt,
    tools: [MENU_EXTRACTION_TOOL],
    tool_choice: {
      type: "tool",
      name: MENU_EXTRACTION_TOOL_NAME,
    },
    messages: [
      {
        role: "user",
        content: [
          ...(input.base64 && input.contentType
            ? [
                input.contentType === "application/pdf"
                  ? {
                      type: "document" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "application/pdf" as const,
                        data: input.base64,
                      },
                    }
                  : {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: input.contentType as
                          | "image/jpeg"
                          | "image/png"
                          | "image/gif"
                          | "image/webp",
                        data: input.base64,
                      },
                    },
              ]
            : []),
          {
            type: "text" as const,
            text:
              fallbackSource ||
              "Extract the menu from the attached menu asset and return valid JSON only.",
          },
        ] as any,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") {
    throw new MenuExtractionTooLargeError();
  }

  const toolUse = response.content.find(
    (entry): entry is Anthropic.ToolUseBlock =>
      entry.type === "tool_use" && entry.name === MENU_EXTRACTION_TOOL_NAME
  );

  if (toolUse) {
    try {
      return validateMenuExtraction(toolUse.input);
    } catch {
      throw new ApiError("Menu extraction response did not match the expected structure.", 502);
    }
  }

  const text = response.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");

  if (!text.trim()) {
    throw new ApiError("Menu extraction returned no structured result.", 502);
  }

  return safeJsonParse(text);
}

export function validateServiceExtraction(
  input: unknown
): ServiceExtractionDraft {
  return serviceExtractionSchema.parse(input);
}

function fallbackServiceExtraction(sourceText: string): ServiceExtractionDraft {
  const lines = sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    services: lines.map((line) => {
      const priceMatch = line.match(
        /(?:AED\s*)?(\d+(?:\.\d{1,2})?)\s*(?:AED)?$/i
      );
      const priceAed = priceMatch ? Math.round(Number(priceMatch[1])) : 0;
      const name = priceMatch
        ? line.slice(0, priceMatch.index).replace(/[-–—:]\s*$/, "").trim()
        : line;
      return {
        category: "Imported services",
        name: name || line,
        nameAr: null,
        priceAed,
        durationMinutes: null,
        description: null,
      };
    }),
  };
}

export async function extractServicesFromSource(input: {
  sourceText?: string;
  fileName?: string;
  contentType?: string;
  base64?: string;
}): Promise<ServiceExtractionDraft> {
  const sourceText = [input.fileName ? `File: ${input.fileName}` : null, input.sourceText]
    .filter(Boolean)
    .join("\n\n");
  const client = getAnthropicClient();

  if (!client) {
    return fallbackServiceExtraction(sourceText);
  }

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: SERVICE_EXTRACTION_MAX_TOKENS,
    system: [
      "You extract bookable services from UAE salon, spa, barber, cleaning, AC, and pest-control price lists.",
      "Return every service with its category, English and Arabic names when present, AED price, duration in minutes when stated, and a concise description.",
      "Use 0 for a missing price and null for missing Arabic, duration, or description.",
      "Do not invent services, prices, or durations.",
      `Call the ${SERVICE_EXTRACTION_TOOL_NAME} tool with the complete result.`,
    ].join(" "),
    tools: [SERVICE_EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: SERVICE_EXTRACTION_TOOL_NAME },
    messages: [
      {
        role: "user",
        content: [
          ...(input.base64 && input.contentType
            ? [
                input.contentType === "application/pdf"
                  ? {
                      type: "document" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "application/pdf" as const,
                        data: input.base64,
                      },
                    }
                  : {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: input.contentType as
                          | "image/jpeg"
                          | "image/png"
                          | "image/gif"
                          | "image/webp",
                        data: input.base64,
                      },
                    },
              ]
            : []),
          {
            type: "text" as const,
            text:
              sourceText ||
              "Extract every service from the attached price-list asset.",
          },
        ] as any,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") {
    throw new ApiError(
      "Service extraction exceeded the output limit. Try a shorter price list.",
      413
    );
  }

  const toolUse = response.content.find(
    (entry): entry is Anthropic.ToolUseBlock =>
      entry.type === "tool_use" &&
      entry.name === SERVICE_EXTRACTION_TOOL_NAME
  );

  if (!toolUse) {
    throw new ApiError(
      "Service extraction returned no structured result.",
      502
    );
  }

  try {
    return validateServiceExtraction(toolUse.input);
  } catch {
    throw new ApiError(
      "Service extraction response did not match the expected structure.",
      502
    );
  }
}
