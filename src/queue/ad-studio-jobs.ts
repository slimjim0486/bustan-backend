// Async generation job for the Ad Studio.
// pg-boss pattern matches existing image-generation worker.

import PgBoss from "pg-boss";
import { Prisma } from "@prisma/client";
import { ApiError, isApiError } from "@/lib/errors";
import { logAiUsage } from "@/lib/ai-usage";
import { prisma } from "@/lib/prisma";
import {
  hydrateBrief,
  runAdStudioGeneration,
  getKbVersion,
  type GenerationPhase,
} from "@/services/ad-studio-ai";
import { runImagePromptPass } from "@/services/ad-studio-ai/claude-orchestrator";
import { runSafetyPass } from "@/services/ad-studio-ai/safety";
import { generateHeroImage } from "@/services/ad-studio-ai/image-gen";
import { runSlideshowBuilder } from "@/services/ad-studio-ai/slideshow-builder";
import {
  CREATIVE_FORMATS,
  type CreativeFormat,
} from "@/services/ad-studio-ai/brief-builder";
import { syncLiveCampaignFromMeta } from "@/services/meta-ads-oauth";
import { getBoss } from "@/queue/boss";

export const AD_STUDIO_JOB = "ad-studio-generation";
export const AD_STUDIO_REGEN_IMAGE_JOB = "ad-studio-regenerate-image";
export const AD_STUDIO_META_SYNC_JOB = "ad-studio-meta-sync";
const RETRY_LIMIT = 1; // Generation is expensive; only retry once
const RETRY_DELAY_SECONDS = 30;

export interface AdStudioJobData {
  projectId: string;
  numberOfVariants: number;
}

export interface AdStudioRegenImageJobData {
  creativeId: string;
  /** Operator-selected image provider. Defaults to gemini if omitted
   *  (older queued jobs without this field still work). */
  provider?: "gemini" | "openai";
}

/** Phase 2C: per-live-campaign Meta Insights sync. */
export interface AdStudioMetaSyncJobData {
  liveCampaignId: string;
}

type AdStudioWorkerJob = PgBoss.JobWithMetadata<AdStudioJobData>;
type AdStudioRegenImageWorkerJob = PgBoss.JobWithMetadata<AdStudioRegenImageJobData>;
type AdStudioMetaSyncWorkerJob = PgBoss.JobWithMetadata<AdStudioMetaSyncJobData>;

let queueReady: Promise<void> | null = null;
let regenQueueReady: Promise<void> | null = null;
let metaSyncQueueReady: Promise<void> | null = null;

async function ensureAdStudioQueue() {
  if (!queueReady) {
    queueReady = getBoss()
      .then((queue) => queue.createQueue(AD_STUDIO_JOB))
      .catch((error) => {
        queueReady = null;
        throw error;
      });
  }
  await queueReady;
}

export async function enqueueAdStudioGeneration(data: AdStudioJobData) {
  await ensureAdStudioQueue();
  const queue = await getBoss();
  const jobId = await queue.send(AD_STUDIO_JOB, data, {
    retryLimit: RETRY_LIMIT,
    retryDelay: RETRY_DELAY_SECONDS,
    retryBackoff: true,
  });
  if (!jobId) throw new Error(`Failed to enqueue ${AD_STUDIO_JOB}`);
  return jobId;
}

export async function startAdStudioWorker() {
  await ensureAdStudioQueue();
  await ensureAdStudioRegenQueue();
  await ensureAdStudioMetaSyncQueue();
  const queue = await getBoss();
  await queue.work<AdStudioJobData>(AD_STUDIO_JOB, { batchSize: 1, includeMetadata: true } as PgBoss.WorkOptions, async (jobs) => {
    for (const job of jobs as unknown as AdStudioWorkerJob[]) {
      await processAdStudioJob(job);
    }
  });
  await queue.work<AdStudioRegenImageJobData>(
    AD_STUDIO_REGEN_IMAGE_JOB,
    { batchSize: 1, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as AdStudioRegenImageWorkerJob[]) {
        await processRegenImageJob(job);
      }
    }
  );
  await queue.work<AdStudioMetaSyncJobData>(
    AD_STUDIO_META_SYNC_JOB,
    { batchSize: 4, includeMetadata: true } as PgBoss.WorkOptions,
    async (jobs) => {
      for (const job of jobs as unknown as AdStudioMetaSyncWorkerJob[]) {
        await processMetaSyncJob(job);
      }
    }
  );
  // Schedule daily autopilot at 09:00 GST (05:00 UTC). pg-boss uses cron syntax.
  await queue.schedule(AD_STUDIO_META_SYNC_FANOUT_JOB, "5 5 * * *", undefined, { tz: "UTC" });
  await queue.work(AD_STUDIO_META_SYNC_FANOUT_JOB, async () => {
    await fanOutMetaSyncJobs();
  });
}

async function ensureAdStudioMetaSyncQueue() {
  if (!metaSyncQueueReady) {
    metaSyncQueueReady = getBoss()
      .then(async (queue) => {
        await queue.createQueue(AD_STUDIO_META_SYNC_JOB);
        await queue.createQueue(AD_STUDIO_META_SYNC_FANOUT_JOB);
      })
      .catch((error) => {
        metaSyncQueueReady = null;
        throw error;
      });
  }
  await metaSyncQueueReady;
}

const AD_STUDIO_META_SYNC_FANOUT_JOB = "ad-studio-meta-sync-fanout";

/**
 * Fan out one job per active Meta-linked live campaign whose lastSyncedAt is
 * stale (>12h). The cron triggers this once a day; per-campaign sync runs
 * in parallel via the worker pool above.
 */
async function fanOutMetaSyncJobs() {
  const STALE_AFTER_HOURS = 12;
  const TOKEN_WARN_BEFORE_DAYS = 7;
  const cutoff = new Date(Date.now() - STALE_AFTER_HOURS * 60 * 60 * 1000);
  const expiryWarnCutoff = new Date(Date.now() + TOKEN_WARN_BEFORE_DAYS * 24 * 60 * 60 * 1000);

  // Proactively flip integrations near expiry to "expired" so the UI
  // surfaces the reconnect prompt BEFORE a sync fails. Meta also revokes
  // tokens on password change / 2FA reset / etc., so this is best-effort —
  // the actual sync still has a 401/403 catch in syncLiveCampaignFromMeta.
  const expiringSoon = await prisma.metaAdsIntegration.updateMany({
    where: {
      status: "connected",
      tokenExpiresAt: { not: null, lte: expiryWarnCutoff },
    },
    data: { status: "expired" },
  });
  if (expiringSoon.count > 0) {
    console.log(`[ad-studio meta-sync] marked ${expiringSoon.count} integrations expired`);
  }

  const due = await prisma.adLiveCampaign.findMany({
    where: {
      autoSync: true,
      metaIntegrationId: { not: null },
      status: { in: ["linked", "reporting"] },
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
      metaIntegration: { status: "connected" },
    },
    select: { id: true },
    take: 200,
  });

  await ensureAdStudioMetaSyncQueue();
  const queue = await getBoss();
  for (const c of due) {
    await queue.send(AD_STUDIO_META_SYNC_JOB, { liveCampaignId: c.id }, { retryLimit: 1 });
  }
  if (due.length === 200) {
    console.warn(
      `[ad-studio meta-sync] fan-out hit cap of 200 — Bustan now has 200+ active autosync campaigns. Consider raising the take cap.`
    );
  }
  console.log(`[ad-studio meta-sync] fanned out ${due.length} sync jobs`);
}

export async function enqueueMetaSync(liveCampaignId: string) {
  await ensureAdStudioMetaSyncQueue();
  const queue = await getBoss();
  await queue.send(AD_STUDIO_META_SYNC_JOB, { liveCampaignId }, { retryLimit: 1 });
}

async function processMetaSyncJob(job: AdStudioMetaSyncWorkerJob) {
  const { liveCampaignId } = job.data;
  try {
    const result = await syncLiveCampaignFromMeta(liveCampaignId);
    console.log(
      `[ad-studio meta-sync] ${liveCampaignId}: wrote ${result.snapshotsWritten} snapshots from ${result.perAdRowsReceived} insight rows`
    );
  } catch (error) {
    console.warn(`[ad-studio meta-sync] ${liveCampaignId} failed:`, error);
    // Don't re-throw — syncLiveCampaignFromMeta already records lastSyncError
    // on the live campaign + integration. pg-boss retry would just spam.
  }
}

async function ensureAdStudioRegenQueue() {
  if (!regenQueueReady) {
    regenQueueReady = getBoss()
      .then((queue) => queue.createQueue(AD_STUDIO_REGEN_IMAGE_JOB))
      .catch((error) => {
        regenQueueReady = null;
        throw error;
      });
  }
  await regenQueueReady;
}

export async function enqueueRegenImage(data: AdStudioRegenImageJobData) {
  await ensureAdStudioRegenQueue();
  const queue = await getBoss();
  const jobId = await queue.send(AD_STUDIO_REGEN_IMAGE_JOB, data, {
    retryLimit: RETRY_LIMIT,
    retryDelay: RETRY_DELAY_SECONDS,
  });
  if (!jobId) throw new Error(`Failed to enqueue ${AD_STUDIO_REGEN_IMAGE_JOB}`);
  return jobId;
}

async function processAdStudioJob(job: AdStudioWorkerJob) {
  const { projectId, numberOfVariants } = job.data;

  const project = await prisma.adProject.findUnique({
    where: { id: projectId },
    include: { restaurant: { select: { id: true } } },
  });
  if (!project) {
    console.warn(`[ad-studio] project ${projectId} not found; skipping`);
    return;
  }

  // Mark project + create variants in pending
  await prisma.adProject.update({
    where: { id: projectId },
    data: { status: "generating", lastError: null },
  });

  try {
    // Re-build the brief from the persisted brief snapshot.
    const persistedBrief = project.briefJson as Prisma.JsonObject;
    const persistedFormat =
      typeof persistedBrief?.creativeFormat === "string"
        ? (persistedBrief.creativeFormat as string)
        : "static_multi";
    const creativeFormat: CreativeFormat = (CREATIVE_FORMATS as readonly string[]).includes(
      persistedFormat
    )
      ? (persistedFormat as CreativeFormat)
      : "static_multi";
    const briefInput = {
      restaurantId: project.restaurantId,
      name: project.name,
      campaignType: project.campaignType,
      goal: project.goal,
      countries: project.countries,
      cuisines: project.cuisines,
      targetPlatforms: project.targetPlatforms,
      budgetTier: project.budgetTier,
      budgetAed: project.budgetAed,
      durationWeeks: project.durationWeeks ?? undefined,
      primaryDishId: project.primaryDishId ?? undefined,
      brandVoice: project.brandVoice ?? undefined,
      creativeFormat,
    };
    const { brief, brand } = await hydrateBrief(briefInput as never);

    // Slideshow path — single 5-frame creative built from owner-uploaded
    // menu photos with Claude-written on-image captions. Short-circuits the
    // standard 6-variant strategy/copy/image pipeline.
    if (creativeFormat === "slideshow_tiktok") {
      const slideshow = await runSlideshowBuilder({
        projectId,
        brief,
        brand,
      });
      // updateMany + where status=generating makes this a no-op if the owner
      // cancelled mid-flight (status was flipped to failed by the cancel
      // route). Without this guard, the worker would silently overwrite the
      // cancel with `ready` and the cancelled creative would appear.
      const flipped = await prisma.adProject.updateMany({
        where: { id: projectId, status: "generating" },
        data: {
          status: "ready",
          generationPhase: null,
          kbVersionAtGen: getKbVersion(),
          generationCostUsd: new Prisma.Decimal(slideshow.totalCostUsd.toFixed(4)),
          lastError: null,
        },
      });
      if (flipped.count === 0) {
        console.log(
          `[ad-studio] slideshow result for ${projectId} discarded — project was cancelled or already completed.`
        );
      }
      await logAiUsage(
        project.restaurantId,
        "ad_studio_project",
        slideshow.tokensIn,
        slideshow.tokensOut,
        0
      );
      return;
    }

    const result = await runAdStudioGeneration({
      brief,
      brand,
      numberOfVariants: Math.min(Math.max(numberOfVariants, 1), 6),
      onPhase: async (phase: GenerationPhase) => {
        await prisma.adProject.update({
          where: { id: projectId },
          data: { generationPhase: phase },
        });
      },
    });

    // Persist creatives — per-variant hero image and per-variant safety flags.
    await prisma.$transaction(async (tx) => {
      // Cancel guard: if the owner stopped this generation mid-flight, the
      // project is already in `failed` state. Bail before writing creatives so
      // a cancelled run can't leave stale variants attached. The final
      // updateMany below uses the same `status=generating` filter as a
      // belt-and-suspenders check in case the cancel arrives between this
      // read and the final write.
      const snapshot = await tx.adProject.findUnique({
        where: { id: projectId },
        select: { status: true },
      });
      if (snapshot?.status !== "generating") {
        console.log(
          `[ad-studio] static result for ${projectId} discarded — project was cancelled.`
        );
        return;
      }

      for (const out of result.variants) {
        const v = out.copy;
        const status = out.hero ? "ready" : "failed"; // No image = degraded variant
        await tx.adCreative.upsert({
          where: { projectId_variant: { projectId, variant: v.variant } },
          create: {
            projectId,
            variant: v.variant,
            archetypeId: v.archetypeId,
            hookId: v.hookId,
            ctaId: v.ctaId,
            copyFrameworkId: result.strategy.copyFrameworkId,
            language: v.language,
            headline: v.headline,
            primaryText: v.primaryText,
            ctaText: v.ctaText,
            headlineAr: v.headlineAr ?? null,
            primaryTextAr: v.primaryTextAr ?? null,
            ctaTextAr: v.ctaTextAr ?? null,
            heroImageUrl: out.hero?.url ?? null,
            heroImagePrompt: out.imagePrompt,
            heroImageSourceMenuItemId: out.hero?.menuItemImageId ?? null,
            imageProvider: out.hero?.provider ?? null,
            status,
            safetyFlags: out.safetyFlags as unknown as Prisma.InputJsonValue,
            generationCostUsd:
              v.variant === 1 ? new Prisma.Decimal(result.totalCostUsd.toFixed(4)) : null,
          },
          update: {
            archetypeId: v.archetypeId,
            hookId: v.hookId,
            ctaId: v.ctaId,
            copyFrameworkId: result.strategy.copyFrameworkId,
            language: v.language,
            headline: v.headline,
            primaryText: v.primaryText,
            ctaText: v.ctaText,
            headlineAr: v.headlineAr ?? null,
            primaryTextAr: v.primaryTextAr ?? null,
            ctaTextAr: v.ctaTextAr ?? null,
            heroImageUrl: out.hero?.url ?? null,
            heroImagePrompt: out.imagePrompt,
            heroImageSourceMenuItemId: out.hero?.menuItemImageId ?? null,
            imageProvider: out.hero?.provider ?? null,
            status,
            safetyFlags: out.safetyFlags as unknown as Prisma.InputJsonValue,
          },
        });
      }

      const anyImageReady = result.variants.some((v) => v.hero !== null);
      await tx.adProject.updateMany({
        where: { id: projectId, status: "generating" },
        data: {
          status: anyImageReady ? "ready" : "failed",
          generationPhase: null,
          kbVersionAtGen: getKbVersion(),
          generationCostUsd: new Prisma.Decimal(result.totalCostUsd.toFixed(4)),
          lastError: anyImageReady
            ? null
            : "All variants failed image generation — see per-variant safety flags.",
        },
      });
    });

    // Authoritative usage log — both Claude tokens and image costs counted.
    const imageCost = result.variants.reduce((sum, v) => sum + (v.hero?.costUsd ?? 0), 0);
    await logAiUsage(
      project.restaurantId,
      "ad_studio_project",
      result.tokensIn,
      result.tokensOut,
      imageCost
    );
  } catch (error) {
    const message =
      isApiError(error) ? error.message : error instanceof Error ? error.message : "Unknown error";

    // updateMany so a cancelled project keeps its "Cancelled by owner" message
    // instead of getting overwritten with the worker's last-ditch error.
    await prisma.adProject.updateMany({
      where: { id: projectId, status: "generating" },
      data: {
        status: "failed",
        generationPhase: null,
        lastError: message.slice(0, 1000),
      },
    });

    // Even when generation fails, we may have spent Claude tokens already.
    // Log a conservative usage row so the per-day rate limit still counts the
    // attempt (this prevents an attacker from looping a flaky brief).
    try {
      await logAiUsage(project.restaurantId, "ad_studio_project", 0, 0, 0);
    } catch {
      // Logging failure must not mask the real error
    }

    // Re-throw so pg-boss records the failure
    throw error instanceof ApiError || error instanceof Error ? error : new Error(message);
  }
}

// =============================================================================
// Single-variant image regeneration
// =============================================================================

async function processRegenImageJob(job: AdStudioRegenImageWorkerJob) {
  const { creativeId, provider } = job.data;
  console.log(
    `[ad-studio regen] worker start creative=${creativeId} requestedProvider=${provider}`
  );

  const creative = await prisma.adCreative.findUnique({
    where: { id: creativeId },
    include: { project: true },
  });
  if (!creative) {
    console.warn(`[ad-studio regen] creative ${creativeId} not found; skipping`);
    return;
  }

  await prisma.adCreative.update({
    where: { id: creativeId },
    data: {
      status: "generating",
      heroImageUrl: null,
      heroImageSourceMenuItemId: null,
      imageProvider: null,
    },
  });

  try {
    const project = creative.project;
    const briefInput = {
      restaurantId: project.restaurantId,
      name: project.name,
      campaignType: project.campaignType,
      goal: project.goal,
      countries: project.countries,
      cuisines: project.cuisines,
      targetPlatforms: project.targetPlatforms,
      budgetTier: project.budgetTier,
      budgetAed: project.budgetAed,
      durationWeeks: project.durationWeeks ?? undefined,
      primaryDishId: project.primaryDishId ?? undefined,
      brandVoice: project.brandVoice ?? undefined,
    };
    const { brief, brand } = await hydrateBrief(briefInput as never);

    const totals = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    // Synthesize a minimal strategy snapshot from the persisted creative — we
    // don't re-run the strategy pass here, just keep the same archetype/hook/CTA.
    const imagePrompt = await runImagePromptPass({
      brief,
      brand,
      strategy: {
        archetypeIds: [creative.archetypeId],
        hookIds: creative.hookId ? [creative.hookId] : [],
        ctaIds: creative.ctaId ? [creative.ctaId] : [],
        copyFrameworkId: creative.copyFrameworkId ?? "aida",
        imageDirections: [
          {
            archetypeId: creative.archetypeId,
            direction:
              "Re-shoot the same archetype with the same dish — vary lighting, props, or angle for visual freshness.",
          },
        ],
        dialect: "bilingual",
        rationale: "regen",
      },
      variant: {
        variant: creative.variant,
        archetypeId: creative.archetypeId,
        hookId: creative.hookId ?? "",
        ctaId: creative.ctaId ?? "",
        language: creative.language as "en" | "ar" | "bilingual",
        headline: creative.headline,
        primaryText: creative.primaryText,
        ctaText: creative.ctaText,
      },
      totals,
    });

    // Country-aware safety on the new image prompt — enforce strictly.
    const verdict = runSafetyPass({
      countries: brief.countries,
      copy: {
        variant: creative.variant,
        archetypeId: creative.archetypeId,
        hookId: creative.hookId ?? "",
        ctaId: creative.ctaId ?? "",
        language: creative.language as "en" | "ar" | "bilingual",
        headline: creative.headline,
        primaryText: creative.primaryText,
        ctaText: creative.ctaText,
        headlineAr: creative.headlineAr ?? undefined,
        primaryTextAr: creative.primaryTextAr ?? undefined,
        ctaTextAr: creative.ctaTextAr ?? undefined,
      },
      imagePrompt,
    });
    if (verdict.verdict === "fail") {
      await prisma.adCreative.update({
        where: { id: creativeId },
        data: {
          status: "failed",
          safetyFlags: verdict.flags as unknown as Prisma.InputJsonValue,
          heroImagePrompt: imagePrompt,
        },
      });
      return;
    }

    const hero = await generateHeroImage({
      restaurantId: brief.restaurantId,
      primaryDishId: brief.primaryDishId,
      primaryDishName: brief.primaryDishName,
      prompt: imagePrompt,
      provider,
      // Manual refresh means "make a new image", so bypass the real-photo
      // reuse path even when the project is anchored to a menu item.
      reuseMenuItemImage: false,
    });
    console.log(
      `[ad-studio regen] generated creative=${creativeId} requestedProvider=${provider} actualProvider=${hero.provider}`
    );

    await prisma.adCreative.update({
      where: { id: creativeId },
      data: {
        heroImageUrl: hero.url,
        heroImagePrompt: imagePrompt,
        heroImageSourceMenuItemId: hero.menuItemImageId ?? null,
        imageProvider: hero.provider,
        status: "ready",
        safetyFlags: verdict.flags as unknown as Prisma.InputJsonValue,
        isEdited: true,
      },
    });
    console.log(
      `[ad-studio regen] persisted creative=${creativeId} imageProvider=${hero.provider}`
    );

    // D2 fix: menu-photo reuse is free + instant; it should NOT consume
    // the daily regen cap. Skip the usage log entirely when reuse hit.
    // For real AI generations, tag OpenAI vs Gemini distinctly so the
    // per-provider cap can count them independently.
    if (hero.provider !== "menu_item") {
      const usageFeature =
        hero.provider === "openai" ? "ad_studio_image_openai" : "ad_studio_image";
      await logAiUsage(
        project.restaurantId,
        usageFeature,
        totals.tokensIn,
        totals.tokensOut,
        hero.costUsd
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn(
      `[ad-studio regen] failed creative=${creativeId} requestedProvider=${provider} error=${message}`
    );
    await prisma.adCreative.update({
      where: { id: creativeId },
      data: { status: "failed" },
    });
    try {
      // SEC-6 fix: failed OpenAI regens must count against the OpenAI cap
      // (otherwise a stream of failures bypasses the rate limit).
      const failureFeature =
        provider === "openai" ? "ad_studio_image_openai" : "ad_studio_image";
      await logAiUsage(creative.project.restaurantId, failureFeature, 0, 0, 0);
    } catch {
      // Logging failure must not mask the real error
    }
    throw error instanceof Error ? error : new Error(message);
  }
}
