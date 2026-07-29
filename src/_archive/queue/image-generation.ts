import PgBoss from "pg-boss";
import { buildMenuItemImageSummary, syncMenuItemImageSummary } from "@/lib/menu-item-images";
import { ApiError, isApiError } from "@/lib/errors";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { generateDishImage } from "@/services/google-image";
import { uploadBuffer } from "@/services/r2";

export const MENU_IMAGE_JOB = "menu-image-generation";
const MENU_IMAGE_RETRY_LIMIT = 3;
const MENU_IMAGE_RETRY_DELAY_SECONDS = 60;

export type MenuImageJobData = {
  menuItemId: string;
  imageId: string;
  allowFallback?: boolean;
};

type MenuImageWorkerJob = PgBoss.JobWithMetadata<MenuImageJobData>;

let boss: PgBoss | null = null;
let queueReady: Promise<void> | null = null;

export async function getBoss() {
  if (boss) {
    return boss;
  }

  boss = new PgBoss({
    connectionString: env.DATABASE_URL,
  });

  await boss.start();
  return boss;
}

async function ensureMenuImageQueue() {
  if (!queueReady) {
    queueReady = getBoss()
      .then((queue) => queue.createQueue(MENU_IMAGE_JOB))
      .catch((error) => {
        queueReady = null;
        throw error;
      });
  }

  await queueReady;
}

export async function enqueueMenuItemImage(options: {
  menuItemId: string;
  imageId: string;
  priority?: number;
  allowFallback?: boolean;
}) {
  await ensureMenuImageQueue();
  const queue = await getBoss();
  const jobId = await queue.send(
    MENU_IMAGE_JOB,
    {
      menuItemId: options.menuItemId,
      imageId: options.imageId,
      allowFallback: options.allowFallback,
    },
    {
      priority: options.priority,
      retryLimit: MENU_IMAGE_RETRY_LIMIT,
      retryDelay: MENU_IMAGE_RETRY_DELAY_SECONDS,
      retryBackoff: true,
    }
  );

  if (!jobId) {
    throw new Error(`Failed to enqueue pg-boss job for ${MENU_IMAGE_JOB}`);
  }

  return jobId;
}

function isRetryableImageGenerationError(error: unknown) {
  return isApiError(error) && [429, 500, 502, 503, 504].includes(error.status);
}

function isFinalAttempt(job: Pick<MenuImageWorkerJob, "retryCount" | "retryLimit">) {
  return job.retryCount >= job.retryLimit;
}

async function markMenuImageFailed(imageId: string, menuItemId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.menuItemImage.update({
      where: { id: imageId },
      data: {
        imageStatus: "failed",
      },
    });

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

    if (item) {
      const summary = buildMenuItemImageSummary(item);
      await tx.menuItem.update({
        where: { id: item.id },
        data: summary,
      });
    }
  });
}

function formatImageJobError(error: unknown) {
  if (isApiError(error)) {
    return {
      message: error.message,
      status: error.status,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
    };
  }

  return {
    message: "Unknown image generation error",
    error,
  };
}

export async function processMenuImageJob(job: MenuImageWorkerJob) {
  const image = await prisma.menuItemImage.findUnique({
    where: { id: job.data.imageId },
    include: {
      menuItem: {
        include: {
          restaurant: true,
          section: true,
          images: {
            orderBy: { slot: "asc" },
          },
        },
      },
    },
  });

  if (!image || image.menuItemId !== job.data.menuItemId) {
    return;
  }

  await prisma.menuItemImage.update({
    where: { id: image.id },
    data: { imageStatus: "generating" },
  });
  await prisma.$transaction((tx) => syncMenuItemImageSummary(tx, image.menuItemId));

  try {
    const generated = await generateDishImage({
      name: image.menuItem.name,
      description: image.menuItem.description,
      cuisineType: image.menuItem.restaurant.cuisineType,
      sectionName: image.menuItem.section.name,
      restaurantName: image.menuItem.restaurant.name,
      promptModifier: image.promptModifier,
      allowFallback: job.data.allowFallback,
    });

    const upload = await uploadBuffer({
      buffer: generated.buffer,
      contentType: generated.contentType,
      folder: `restaurants/${image.menuItem.restaurantId}/menu-items`,
      key: `restaurants/${image.menuItem.restaurantId}/menu-items/${image.menuItemId}-${image.slot + 1}.${generated.extension}`,
    });

    await prisma.$transaction(async (tx) => {
      await tx.menuItemImage.update({
        where: { id: image.id },
        data: {
          imageUrl: upload.url,
          imageStatus: "generated",
        },
      });

      await syncMenuItemImageSummary(tx, image.menuItemId);
    });
  } catch (error) {
    const retryable = isRetryableImageGenerationError(error);
    const finalAttempt = isFinalAttempt(job);

    if (retryable && !finalAttempt) {
      console.warn("Menu image job hit a retryable image generation error", {
        imageId: image.id,
        menuItemId: image.menuItemId,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
        error: formatImageJobError(error),
      });
      throw error;
    }

    console.error("Menu image job failed", {
      imageId: image.id,
      menuItemId: image.menuItemId,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
      error: formatImageJobError(error),
    });

    await markMenuImageFailed(image.id, image.menuItemId);

    if (retryable && finalAttempt) {
      throw error;
    }
  }
}

export async function startMenuImageWorker() {
  const queue = await getBoss();
  await queue.work(MENU_IMAGE_JOB, { batchSize: 1, includeMetadata: true }, async (jobs) => {
    const [job] = jobs as MenuImageWorkerJob[];
    if (!job) {
      return;
    }

    await processMenuImageJob(job);
  });
}
