import { uploadBuffer } from "@/services/r2";
import { getAnthropicClient } from "@/services/claude";
import type { AuditRestaurantContext, PhotoVisionData, PhotoVisionScore } from "./types";

const MAX_PHOTOS = 8;

function fallbackPhotoData(photoUrls: string[], reason: string): PhotoVisionData {
  return {
    aggregateScore: photoUrls.length ? 58 : null,
    photos: photoUrls.map((url) => ({
      url,
      score: 58,
      lighting: 58,
      composition: 58,
      foodAppeal: 58,
      notes: reason,
    })),
    summary: reason,
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

function clampScore(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 50;
  return Math.max(0, Math.min(100, Math.round(number)));
}

async function stagePhoto(url: string, index: number) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return url;
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    const arrayBuffer = await response.arrayBuffer();
    const uploaded = await uploadBuffer({
      buffer: Buffer.from(arrayBuffer),
      contentType,
      folder: "audit-photos",
      key: `audit-photos/${Date.now()}-${index}.jpg`,
    });
    return uploaded.url;
  } catch (error) {
    console.warn("Audit photo staging failed; using source URL", {
      url,
      message: error instanceof Error ? error.message : String(error),
    });
    return url;
  }
}

function normalizePhotoScores(raw: any, urls: string[]): PhotoVisionData {
  const photos = Array.isArray(raw?.photos) ? raw.photos : [];
  const normalizedPhotos: PhotoVisionScore[] = urls.map((url, index) => {
    const entry = photos[index] ?? {};
    return {
      url,
      score: clampScore(entry.score),
      lighting: clampScore(entry.lighting),
      composition: clampScore(entry.composition),
      foodAppeal: clampScore(entry.foodAppeal),
      notes:
        typeof entry.notes === "string" && entry.notes.trim()
          ? entry.notes.trim().slice(0, 500)
          : "Photo reviewed for restaurant discovery quality.",
    };
  });

  const aggregateScore = normalizedPhotos.length
    ? Math.round(
        normalizedPhotos.reduce((sum, photo) => sum + photo.score, 0) /
          normalizedPhotos.length
      )
    : null;

  return {
    aggregateScore,
    photos: normalizedPhotos,
    summary:
      typeof raw?.summary === "string" && raw.summary.trim()
        ? raw.summary.trim().slice(0, 700)
        : "Photo quality was reviewed across lighting, composition, and food appeal.",
  };
}

export async function analyzeAuditPhotos(input: {
  restaurant: AuditRestaurantContext;
  photoUrls: string[];
}): Promise<{ data: PhotoVisionData; tokensIn: number; tokensOut: number }> {
  const photoUrls = input.photoUrls.slice(0, MAX_PHOTOS);
  if (!photoUrls.length) {
    return {
      data: fallbackPhotoData([], "No Google Maps photos were available for vision scoring."),
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  const client = getAnthropicClient();
  if (!client) {
    return {
      data: fallbackPhotoData(photoUrls, "Claude vision is not configured; photo score is estimated."),
      tokensIn: 0,
      tokensOut: 0,
    };
  }

  const stagedUrls = await Promise.all(photoUrls.map(stagePhoto));
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1800,
    system: `You are a restaurant photo quality reviewer for UAE and MENA restaurants. Return only valid JSON.
Score every image from 0-100 for lighting, composition, foodAppeal, and overall score.
Be concrete and avoid generic advice.`,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              restaurantName: input.restaurant.name,
              location: input.restaurant.location,
              expectedShape: {
                summary: "one concrete paragraph",
                photos: [
                  {
                    score: 0,
                    lighting: 0,
                    composition: 0,
                    foodAppeal: 0,
                    notes: "specific issue or strength",
                  },
                ],
              },
            }),
          },
          ...stagedUrls.map((url) => ({
            type: "image" as const,
            source: {
              type: "url" as const,
              url,
            },
          })),
        ] as any,
      },
    ],
  });

  const text = response.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");

  try {
    return {
      data: normalizePhotoScores(parseJson(text), stagedUrls),
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  } catch (error) {
    console.warn("Failed to parse audit photo vision response", error);
    return {
      data: fallbackPhotoData(stagedUrls, "Photo review completed, but detailed scoring could not be parsed."),
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  }
}
