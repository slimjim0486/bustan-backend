import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { collectCitationsData } from "@/services/seo/citations-collector";
import {
  collectGoogleMapsData,
  collectGoogleReviewsData,
} from "@/services/seo/google-maps-collector";
import { collectOnPageData } from "@/services/seo/onpage-collector";
import type { SeoProgressStatus } from "@/services/seo/types";
import { recommendAuditActions } from "./audit-recommender";
import { scoreAudit } from "./audit-scorer";
import { synthesizeAudit } from "./audit-synthesizer";
import { collectPageSpeedData } from "./pagespeed";
import { collectPeerBenchmarkData } from "./peer-benchmark";
import { analyzeAuditPhotos } from "./photo-vision";
import type {
  AuditCollectorOutput,
  AuditProgress,
  AuditProgressStep,
  AuditRestaurantContext,
} from "./types";

type CollectorResult<T> = {
  data: T;
  estimatedCostUsd: number;
};

export function computeAuditInputsHash(input: {
  restaurantName: string;
  location: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        restaurantName: input.restaurantName.toLowerCase().trim(),
        location: input.location.toLowerCase().trim(),
      })
    )
    .digest("hex");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function initialProgress(): AuditProgress {
  return {
    gbp: "queued",
    reviews: "queued",
    onPage: "queued",
    citations: "queued",
    pageSpeed: "queued",
    peers: "queued",
    photos: "queued",
    synthesis: "queued",
    recommendations: "queued",
  };
}

async function settleCollector<T>(
  collector: string,
  task: Promise<CollectorResult<T>>
): Promise<
  | { ok: true; collector: string; data: T; estimatedCostUsd: number }
  | { ok: false; collector: string; message: string }
> {
  try {
    const result = await task;
    return {
      ok: true,
      collector,
      data: result.data,
      estimatedCostUsd: result.estimatedCostUsd,
    };
  } catch (error) {
    const message = errorMessage(error);
    console.warn("Audit collector failed", { collector, message });
    return {
      ok: false,
      collector,
      message,
    };
  }
}

function get<T>(
  result:
    | { ok: true; data: T; estimatedCostUsd: number }
    | { ok: false; message: string }
): T | null {
  return result.ok ? result.data : null;
}

function inferCuisine(gbpCategories: string[] | undefined) {
  const categories = gbpCategories ?? [];
  const restaurantCategory = categories.find((category) =>
    /restaurant|cafe|bakery|kitchen|grill|bistro|diner/i.test(category)
  );
  return restaurantCategory ?? categories[0] ?? null;
}

export async function runAuditReportJob(reportId: string) {
  const report = await prisma.auditReport.findUnique({
    where: { id: reportId },
  });

  if (!report) {
    throw new Error(`Audit report ${reportId} not found`);
  }

  const restaurant: AuditRestaurantContext = {
    id: report.id,
    name: report.restaurantName,
    cuisineType: report.primaryCuisine,
    location: report.location,
    address: report.location,
    phone: null,
    website: null,
    deliverooUrl: null,
    talabatUrl: null,
    uberEatsUrl: null,
    operatingHours: null,
    gbpConnection: null,
  };

  const progress = initialProgress();

  async function persistProgress(
    updates: Partial<Record<AuditProgressStep, SeoProgressStatus>>
  ) {
    Object.assign(progress, updates);
    await prisma.auditReport.update({
      where: { id: reportId },
      data: { progress: progress as any },
    });
  }

  Object.assign(progress, {
    gbp: "running",
  });
  await prisma.auditReport.update({
    where: { id: reportId },
    data: {
      status: "running",
      errorMessage: null,
      progress: progress as any,
    },
  });

  try {
    const gbpResult = await settleCollector(
      "googleMaps",
      collectGoogleMapsData(restaurant)
    );

    const gbp = get(gbpResult);
    const discoveredCuisine = inferCuisine(gbp?.categories);
    const website = gbp?.website ?? restaurant.website;
    const enrichedRestaurant: AuditRestaurantContext = {
      ...restaurant,
      cuisineType: discoveredCuisine,
      address: gbp?.address ?? restaurant.address,
      phone: gbp?.phone ?? null,
      website,
      gbpConnection: gbp?.placeId
        ? {
            placeId: gbp.placeId,
            gbpUrl: null,
          }
        : null,
    };

    await prisma.auditReport.update({
      where: { id: reportId },
      data: { primaryCuisine: discoveredCuisine },
    });

    await persistProgress({
      gbp: gbpResult.ok ? "done" : "failed",
      reviews: "running",
      onPage: "running",
      citations: "running",
      pageSpeed: "running",
      peers: "running",
    });

    const reviewsTask = enrichedRestaurant.gbpConnection?.placeId
      ? collectGoogleReviewsData(enrichedRestaurant)
      : Promise.reject(
          new Error("Google place ID unavailable; skipping reviews to avoid broad matches.")
        );

    const [
      reviewsResult,
      onPageResult,
      citationsResult,
      pageSpeedResult,
      peerResult,
    ] = await Promise.all([
      settleCollector("reviews", reviewsTask),
      settleCollector("onPage", collectOnPageData(enrichedRestaurant)),
      settleCollector("citations", collectCitationsData(enrichedRestaurant, gbp)),
      settleCollector("pageSpeed", collectPageSpeedData(enrichedRestaurant)),
      settleCollector(
        "peerBenchmark",
        collectPeerBenchmarkData(enrichedRestaurant, discoveredCuisine)
      ),
    ]);

    await persistProgress({
      reviews: reviewsResult.ok ? "done" : "failed",
      onPage: onPageResult.ok ? "done" : "failed",
      citations: citationsResult.ok ? "done" : "failed",
      pageSpeed: pageSpeedResult.ok ? "done" : "failed",
      peers: peerResult.ok ? "done" : "failed",
      photos: "running",
      synthesis: "running",
    });

    const photoResult = await settleCollector("photoVision", analyzeAuditPhotos({
      restaurant: enrichedRestaurant,
      photoUrls: gbp?.photoUrls ?? [],
    }).then((result) => ({
      data: result.data,
      estimatedCostUsd:
        result.tokensIn * 0.000003 + result.tokensOut * 0.000015,
    })));

    const collectorResults = [
      gbpResult,
      reviewsResult,
      onPageResult,
      citationsResult,
      pageSpeedResult,
      peerResult,
      photoResult,
    ];

    const collectorOutput: AuditCollectorOutput = {
      gbp,
      reviews: get(reviewsResult),
      onPage: get(onPageResult),
      rankGrid: null,
      citations: get(citationsResult),
      pageSpeed: get(pageSpeedResult),
      peerBenchmark: get(peerResult),
      photoVision: get(photoResult),
      failures: collectorResults
        .filter((result) => !result.ok)
        .map((result) => ({
          collector: result.collector,
          message: result.ok ? "" : result.message,
        })),
      estimatedApifyCostUsd: collectorResults.reduce(
        (sum, result) =>
          sum +
          (result.ok &&
          ["googleMaps", "reviews", "onPage", "citations", "peerBenchmark"].includes(
            result.collector
          )
            ? result.estimatedCostUsd
            : 0),
        0
      ),
    };

    const scorecard = scoreAudit(collectorOutput);
    const synthesis = await synthesizeAudit({
      restaurant: enrichedRestaurant,
      scorecard,
      collectorOutput,
    });

    await persistProgress({
      photos: photoResult.ok ? "done" : "failed",
      synthesis: "done",
      recommendations: "running",
    });

    const recommendationResult = await recommendAuditActions({
      restaurant: enrichedRestaurant,
      scorecard,
      collectorOutput,
    });

    const aiCostUsd =
      collectorResults.reduce(
        (sum, result) =>
          sum + (result.ok && result.collector === "photoVision" ? result.estimatedCostUsd : 0),
        0
      ) +
      synthesis.tokensIn * 0.000003 +
      synthesis.tokensOut * 0.000015 +
      recommendationResult.tokensIn * 0.000003 +
      recommendationResult.tokensOut * 0.000015;
    const totalCostUsd = collectorOutput.estimatedApifyCostUsd + aiCostUsd;

    progress.recommendations = "done";
    await prisma.auditReport.update({
      where: { id: reportId },
      data: {
        status: "succeeded",
        scorecard: scorecard as any,
        rawData: collectorOutput as any,
        recommendations: recommendationResult.recommendations as any,
        photoScores: collectorOutput.photoVision as any,
        peerBenchmark: collectorOutput.peerBenchmark as any,
        executiveSummary: synthesis.executiveSummary,
        progress: progress as any,
        costUsd: totalCostUsd,
        completedAt: new Date(),
      },
    });
  } catch (error) {
    for (const key of Object.keys(progress) as AuditProgressStep[]) {
      if (progress[key] === "running" || progress[key] === "queued") {
        progress[key] = "failed";
      }
    }
    await prisma.auditReport.update({
      where: { id: reportId },
      data: {
        status: "failed",
        errorMessage: errorMessage(error),
        progress: progress as any,
        completedAt: new Date(),
      },
    });
  }
}
