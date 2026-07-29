import { env } from "@/lib/env";
import type { AuditRestaurantContext, PageSpeedData } from "./types";

function score(category: unknown) {
  if (!category || typeof category !== "object") return null;
  const value = (category as Record<string, unknown>).score;
  return typeof value === "number" ? Math.round(value * 100) : null;
}

function auditNumeric(audits: Record<string, any>, key: string) {
  const value = audits[key]?.numericValue;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function diagnosticTitles(audits: Record<string, any>) {
  return Object.values(audits)
    .filter((audit) => audit?.score !== null && typeof audit?.score === "number" && audit.score < 0.75)
    .map((audit) => audit?.title)
    .filter((title): title is string => typeof title === "string" && Boolean(title.trim()))
    .slice(0, 5);
}

export async function collectPageSpeedData(
  restaurant: AuditRestaurantContext
): Promise<{ data: PageSpeedData; estimatedCostUsd: number }> {
  const url = restaurant.website;
  if (!url) {
    return {
      data: {
        url: null,
        performanceScore: null,
        accessibilityScore: null,
        seoScore: null,
        lcpMs: null,
        cls: null,
        inpMs: null,
        diagnostics: [],
      },
      estimatedCostUsd: 0,
    };
  }

  const requestUrl = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  requestUrl.searchParams.set("url", url);
  requestUrl.searchParams.set("strategy", "mobile");
  requestUrl.searchParams.append("category", "performance");
  requestUrl.searchParams.append("category", "accessibility");
  requestUrl.searchParams.append("category", "seo");
  if (env.GOOGLE_API_KEY) {
    requestUrl.searchParams.set("key", env.GOOGLE_API_KEY);
  }

  const response = await fetch(requestUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`PageSpeed failed with ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
  }

  const payload = (await response.json()) as any;
  const categories = payload.lighthouseResult?.categories ?? {};
  const audits = payload.lighthouseResult?.audits ?? {};

  return {
    data: {
      url,
      performanceScore: score(categories.performance),
      accessibilityScore: score(categories.accessibility),
      seoScore: score(categories.seo),
      lcpMs: auditNumeric(audits, "largest-contentful-paint"),
      cls: auditNumeric(audits, "cumulative-layout-shift"),
      inpMs: auditNumeric(audits, "interaction-to-next-paint"),
      diagnostics: diagnosticTitles(audits),
    },
    estimatedCostUsd: 0,
  };
}
