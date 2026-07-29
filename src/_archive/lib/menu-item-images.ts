import type { Prisma, MenuItemImage } from "@prisma/client";

type MenuItemWithImages = {
  id: string;
  imageUrl: string | null;
  imageStatus: string;
  images: Pick<
    MenuItemImage,
    | "id"
    | "slot"
    | "imageUrl"
    | "imageStatus"
    | "promptModifier"
    | "isPrimary"
    | "originType"
    | "derivationType"
    | "parentImageId"
  >[];
};

function sortImages<T extends { slot: number }>(images: T[]) {
  return [...images].sort((a, b) => a.slot - b.slot);
}

function getVisibleImages<T extends { slot: number }>(images: T[]) {
  return images.filter((image) => image.slot >= 0);
}

function getPrimaryImage<T extends { isPrimary: boolean; slot: number }>(images: T[]) {
  const ordered = sortImages(images);
  return ordered.find((image) => image.isPrimary) ?? ordered[0] ?? null;
}

export function buildMenuItemImageSummary(item: MenuItemWithImages) {
  const orderedImages = sortImages(getVisibleImages(item.images));
  const primaryImage = getPrimaryImage(orderedImages);
  const hasGenerating = orderedImages.some((image) => image.imageStatus === "generating");

  return {
    imageUrl: primaryImage?.imageUrl ?? item.imageUrl,
    imageStatus: hasGenerating ? "generating" : primaryImage?.imageStatus ?? item.imageStatus,
  };
}

export async function syncMenuItemImageSummary(
  tx: Prisma.TransactionClient,
  menuItemId: string
) {
  const item = await tx.menuItem.findUnique({
    where: { id: menuItemId },
    select: {
      id: true,
      imageUrl: true,
      imageStatus: true,
      images: {
        select: {
          id: true,
          slot: true,
          imageUrl: true,
          imageStatus: true,
          promptModifier: true,
          isPrimary: true,
          originType: true,
          derivationType: true,
          parentImageId: true,
        },
      },
    },
  });

  if (!item) {
    return null;
  }

  const summary = buildMenuItemImageSummary(item);

  return tx.menuItem.update({
    where: { id: item.id },
    data: summary,
  });
}

export async function ensurePrimaryImageRecord(
  tx: Prisma.TransactionClient,
  menuItemId: string
) {
  const item = await tx.menuItem.findUnique({
    where: { id: menuItemId },
    select: {
      id: true,
      imageUrl: true,
      imageStatus: true,
      images: {
        orderBy: { slot: "asc" },
        select: {
          id: true,
          slot: true,
          imageUrl: true,
          imageStatus: true,
          promptModifier: true,
          isPrimary: true,
          originType: true,
          derivationType: true,
          parentImageId: true,
        },
      },
    },
  });

  if (!item) {
    return null;
  }

  if (item.images.length || !item.imageUrl) {
    return item;
  }

  await tx.menuItemImage.create({
    data: {
      menuItemId: item.id,
      slot: 0,
      imageUrl: item.imageUrl,
      imageStatus: item.imageStatus,
      isPrimary: true,
      originType: "legacy_unspecified",
      derivationType: "original",
      parentImageId: null,
    },
  });

  const images = await tx.menuItemImage.findMany({
    where: { menuItemId: item.id },
    orderBy: { slot: "asc" },
    select: {
      id: true,
      slot: true,
      imageUrl: true,
      imageStatus: true,
      promptModifier: true,
      isPrimary: true,
      originType: true,
      derivationType: true,
      parentImageId: true,
    },
  });

  return {
    ...item,
    images,
  };
}

export function getNextImageSlot(images: Array<{ slot: number }>) {
  for (let slot = 0; slot < 10; slot += 1) {
    if (!images.some((image) => image.slot === slot)) {
      return slot;
    }
  }

  return null;
}

export function getNextHiddenImageSlot(images: Array<{ slot: number }>) {
  const hiddenSlots = images
    .map((image) => image.slot)
    .filter((slot) => slot < 0);

  if (!hiddenSlots.length) {
    return -1;
  }

  return Math.min(...hiddenSlots) - 1;
}
