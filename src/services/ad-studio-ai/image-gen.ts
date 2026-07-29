// Hero image generation for Ad Studio creatives.
//
// Strategy (per KB §AI-vs-Human): real food photo first, AI fallback only.
// 1. If brief has a primary dish AND that dish has a real owner_upload image, REUSE that.
// 2. If brief has a primary dish AND has any high-confidence existing image, REUSE that.
// 3. Otherwise, fall back to AI generation. Provider is operator-selectable
//    (Gemini default, GPT Image 2 alt) — gated and cost-tracked at the route.
//
// Callers that need visual exploration can disable the reuse step. Ad Studio
// does this for most variants and all manual refreshes so a single menu photo
// does not collapse a 6-variant creative set into 6 identical images.

import { ApiError } from "@/lib/errors";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { generateDishImage } from "@/services/google-image";
import { generateOpenAiImage } from "@/services/openai-image";
import { uploadBuffer } from "@/services/r2";
import { pickHeroDishForRestaurant } from "@/lib/archived-feature-guards";
import type { ImageGenResult, ImageProvider } from "./types";

interface ImageGenInput {
  restaurantId: string;
  primaryDishId?: string;
  primaryDishName?: string;
  prompt: string;
  /** Operator-selected AI provider. Falls through to Gemini if omitted. */
  provider?: Exclude<ImageProvider, "menu_item">;
  reuseMenuItemImage?: boolean;
}

const AD_STUDIO_IMAGE_FOLDER = "ad-studio";
const GEMINI_IMAGE_COST_USD = 0.04; // Approx Gemini 3 Pro Image cost; refine when invoice arrives.

export async function generateHeroImage(input: ImageGenInput): Promise<ImageGenResult> {
  // Step 1: Try to reuse a real owner-uploaded photo for the featured dish.
  if (input.reuseMenuItemImage !== false && input.primaryDishId) {
    const reused = await tryReuseMenuItemImage(input.primaryDishId, input.restaurantId);
    if (reused) return reused;
  }

  // Step 2: Fall back to AI generation. If the brief never specified a dish
  // (e.g. an auto-staged calendar campaign that the owner hasn't reviewed),
  // pick one now so a single missing field doesn't take down every variant.
  let dishName = input.primaryDishName;
  let resolvedDishId = input.primaryDishId;
  if (!dishName) {
    const picked = await pickHeroDishForRestaurant(input.restaurantId);
    if (!picked) {
      throw new ApiError(
        "Add at least one menu item before generating ad creative — Ad Studio needs a real dish to feature.",
        400
      );
    }
    dishName = picked.name;
    resolvedDishId = picked.id;

    // If the menu item has a real photo, prefer that over an AI render —
    // mirrors Step 1 but for the fallback path. `reuseMenuItemImage` is the
    // caller's diversity gate, so we only do this when reuse is allowed.
    if (input.reuseMenuItemImage !== false) {
      const reused = await tryReuseMenuItemImage(resolvedDishId, input.restaurantId);
      if (reused) return reused;
    }
  }

  return generateAiImage({
    restaurantId: input.restaurantId,
    dishName,
    prompt: input.prompt,
    provider: input.provider ?? "gemini",
  });
}

async function tryReuseMenuItemImage(
  menuItemId: string,
  restaurantId: string
): Promise<ImageGenResult | null> {
  // Tenant isolation: confirm the dish belongs to this restaurant.
  const item = await prisma.menuItem.findFirst({
    where: { id: menuItemId, restaurantId },
    select: { id: true, imageUrl: true },
  });

  if (!item) return null;

  // Prefer the primary image if it's owner-uploaded (highest trust per KB).
  const primary = await prisma.menuItemImage.findFirst({
    where: {
      menuItemId,
      isPrimary: true,
      imageStatus: "ready",
      imageUrl: { not: null },
    },
    orderBy: [{ originType: "asc" }, { createdAt: "desc" }],
    select: { id: true, imageUrl: true, originType: true },
  });

  if (primary?.imageUrl) {
    return {
      source: "menu_item",
      provider: "menu_item",
      url: primary.imageUrl,
      costUsd: 0,
      menuItemImageId: primary.id,
    };
  }

  // Fall back to legacy imageUrl on the item itself.
  if (item.imageUrl) {
    return {
      source: "menu_item",
      provider: "menu_item",
      url: item.imageUrl,
      costUsd: 0,
    };
  }

  return null;
}

async function generateAiImage(args: {
  restaurantId: string;
  dishName: string;
  prompt: string;
  provider: Exclude<ImageProvider, "menu_item">;
}): Promise<ImageGenResult> {
  if (args.provider === "openai") {
    const generated = await generateOpenAiImage({
      // GPT Image follows literal prompts well; combine the dish name +
      // operator-tuned prompt rather than relying on Gemini's keyword form.
      prompt: `Editorial food photograph of ${args.dishName}. ${args.prompt}`,
    });
    const uploaded = await uploadBuffer({
      buffer: generated.buffer,
      contentType: generated.contentType,
      folder: AD_STUDIO_IMAGE_FOLDER,
    });
    return {
      source: "ai_generated",
      provider: "openai",
      url: uploaded.url,
      costUsd: env.OPENAI_IMAGE_COST_USD,
      prompt: args.prompt,
    };
  }

  // Default: Gemini path via the existing google-image service.
  const generated = await generateDishImage({
    name: args.dishName,
    promptModifier: args.prompt,
    allowFallback: true,
  });

  const uploaded = await uploadBuffer({
    buffer: generated.buffer,
    contentType: generated.contentType,
    folder: AD_STUDIO_IMAGE_FOLDER,
  });

  return {
    source: "ai_generated",
    provider: "gemini",
    url: uploaded.url,
    costUsd: GEMINI_IMAGE_COST_USD,
    prompt: args.prompt,
  };
}
