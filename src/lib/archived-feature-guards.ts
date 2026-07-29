import { ApiError } from "@/lib/errors";

function archived(): never {
  throw new ApiError("This restaurant-era feature has been archived.", 409);
}

export async function deleteEmptyPromotions(..._args: unknown[]): Promise<void> {
  archived();
}

export async function enqueueMenuItemImage(..._args: unknown[]): Promise<never> {
  archived();
}

export async function ensurePrimaryImageRecord(..._args: unknown[]): Promise<any> {
  archived();
}

export function getNextImageSlot(..._args: unknown[]): number | null {
  archived();
}

export async function syncMenuItemImageSummary(..._args: unknown[]): Promise<void> {
  archived();
}

export async function enhanceSingleDescription(..._args: unknown[]): Promise<any> {
  archived();
}

export async function enhanceBulkDescriptions(..._args: unknown[]): Promise<any> {
  archived();
}

export async function suggestPromotionContent(..._args: unknown[]): Promise<any> {
  archived();
}

export async function suggestDietaryTags(..._args: unknown[]): Promise<any> {
  archived();
}

export async function analyzeMenu(..._args: unknown[]): Promise<any> {
  archived();
}

export const SLIDESHOW_FRAME_COUNT = 5;

export async function pickHeroDishForRestaurant(
  ..._args: unknown[]
): Promise<{ id: string; name: string } | null> {
  return null;
}

export async function pickSlideshowDishes(..._args: unknown[]): Promise<any[]> {
  return [];
}
