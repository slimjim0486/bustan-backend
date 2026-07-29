import { scoreSeoAnalysis } from "@/services/seo/seo-scorer";
import type { GbpData, ScorecardPillar } from "@/services/seo/types";
import type {
  AuditCollectorOutput,
  AuditPeerComparison,
  AuditPillar,
  AuditScorecard,
  AuditScorecardPillar,
} from "./types";

const WEIGHTS: Record<AuditPillar, number> = {
  discoverability: 0.24,
  reputation: 0.22,
  delivery: 0.2,
  photo: 0.18,
  mobile: 0.16,
};

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function mapPillar(key: AuditPillar, pillar: ScorecardPillar): AuditScorecardPillar {
  return {
    key,
    label: pillar.label,
    score: pillar.score,
    summary: pillar.summary,
    signals: pillar.signals,
    degraded: pillar.degraded,
    status: "ok",
  };
}

function notAssessedPillar(
  key: AuditPillar,
  label: string,
  reason: string
): AuditScorecardPillar {
  return {
    key,
    label,
    score: 0,
    summary: reason,
    signals: ["We couldn't gather enough data to score this pillar."],
    degraded: true,
    status: "not_assessed",
  };
}

/**
 * GBP scoring that's more discriminating than fields-present. Hours length,
 * category breadth, photo volume, and review volume all contribute, so a
 * stock-standard listing lands in the 60-75 range and only well-maintained
 * profiles (multiple categories, 30+ photos, high review volume) can reach
 * the 90s. Pure "everything is filled in" caps around 78.
 */
function scoreGbpDiscriminating(gbp: GbpData): AuditScorecardPillar {
  const signals: string[] = [];
  const positives: string[] = [];
  let score = 30;

  if (gbp.name) {
    score += 4;
    positives.push("Business name is set.");
  } else {
    signals.push("Google profile name was not found.");
  }

  if (gbp.address) {
    score += 5;
    positives.push("Address is published.");
  } else {
    signals.push("Google address is missing.");
  }

  if (gbp.phone) {
    score += 5;
    positives.push("Phone number is published.");
  } else {
    signals.push("Phone number is missing on Google.");
  }

  if (gbp.website) {
    score += 6;
    positives.push("Website link is published.");
  } else {
    signals.push("No website is linked from the Google profile — owners lose direct traffic.");
  }

  // Hours: many days = full schedule. Short stubs (0-1 entries) suggest the
  // owner never properly filled out hours.
  if (gbp.hours) {
    const hoursLength = Array.isArray(gbp.hours)
      ? gbp.hours.length
      : typeof gbp.hours === "object"
      ? Object.keys(gbp.hours as object).length
      : 0;
    if (hoursLength >= 7) {
      score += 8;
      positives.push("Full weekly hours are published.");
    } else if (hoursLength >= 3) {
      score += 4;
      signals.push("Opening hours are partial — Google can mark you closed on missing days.");
    } else {
      signals.push("Opening hours are missing or incomplete.");
    }
  } else {
    signals.push("Opening hours were not returned.");
  }

  // Categories: primary + secondary signal. Most strong listings have 2-3.
  if (gbp.categories.length >= 3) {
    score += 8;
    positives.push(`${gbp.categories.length} categories set — strong category coverage.`);
  } else if (gbp.categories.length === 2) {
    score += 5;
    signals.push("Only 2 categories set — add a secondary category to surface in more searches.");
  } else if (gbp.categories.length === 1) {
    score += 2;
    signals.push("Only 1 category set — adding secondary categories opens more search intents.");
  } else {
    signals.push("No business categories detected.");
  }

  // Photo volume: graduated scale.
  if (gbp.photosCount >= 50) {
    score += 14;
    positives.push(`${gbp.photosCount} photos on Google — excellent visual coverage.`);
  } else if (gbp.photosCount >= 30) {
    score += 11;
    positives.push(`${gbp.photosCount} photos on Google — strong visual coverage.`);
  } else if (gbp.photosCount >= 15) {
    score += 7;
    signals.push(`${gbp.photosCount} photos — peers in your area usually have 25+.`);
  } else if (gbp.photosCount >= 5) {
    score += 3;
    signals.push(`Only ${gbp.photosCount} photos on Google — visual gaps hurt click-through.`);
  } else {
    signals.push("Fewer than 5 Google photos — this is a major discovery handicap.");
  }

  // Review volume (a GBP completeness signal even though reviews has its own
  // pillar — a listing with 0 reviews scores worse on discovery).
  const reviewCount = gbp.reviewCount ?? 0;
  if (reviewCount >= 300) {
    score += 10;
    positives.push(`${reviewCount} reviews — strong social proof on Google.`);
  } else if (reviewCount >= 100) {
    score += 7;
  } else if (reviewCount >= 30) {
    score += 4;
  } else if (reviewCount >= 10) {
    score += 1;
    signals.push(`Only ${reviewCount} Google reviews — request more from regulars.`);
  } else {
    signals.push("Almost no Google reviews — discovery is severely capped without social proof.");
  }

  const finalScore = clampScore(score);

  const summary =
    finalScore >= 85
      ? "Google listing is well-maintained and competitive."
      : finalScore >= 70
      ? "Google listing is in decent shape but has clear room to grow discovery."
      : finalScore >= 55
      ? "Google listing is below where peers in your area typically sit."
      : "Google listing has serious discovery gaps that need attention this week.";

  // Always lead with what's broken — that's what the owner needs to see.
  const finalSignals = [...signals, ...positives.slice(0, 2)];

  return {
    key: "discoverability",
    label: "Google Business Profile",
    score: finalScore,
    summary,
    signals: finalSignals.length ? finalSignals : ["Listing is set up but underutilized."],
    status: "ok",
  };
}

function scorePhoto(output: AuditCollectorOutput): AuditScorecardPillar {
  const photoVision = output.photoVision;
  if (!photoVision || photoVision.aggregateScore === null) {
    return notAssessedPillar(
      "photo",
      "Photo Quality",
      "We couldn't analyze enough Google photos to score photo quality."
    );
  }

  const photoCount = output.gbp?.photosCount ?? photoVision.photos.length;
  const countBonus = photoCount >= 20 ? 8 : photoCount >= 10 ? 4 : 0;
  const score = clampScore(photoVision.aggregateScore + countBonus);

  // Directional industry benchmark: Google's own data has shown listings
  // with high-quality cover photos see meaningfully higher click-through.
  // We don't have a per-restaurant CTR signal in the audit, so we cite the
  // range as a published benchmark rather than a measurement.
  const upsideNote =
    score < 78
      ? "Industry data shows listings with cover photos rated 70+ typically see 25-40% higher click-through than weaker visual sets."
      : null;

  return {
    key: "photo",
    label: "Photo Quality",
    score,
    summary:
      score >= 78
        ? "Restaurant photos are likely helping food appeal and conversion."
        : `Restaurant photos are likely leaving conversion upside on the table. ${upsideNote}`,
    signals: [
      `${photoVision.photos.length} photos analyzed.`,
      `${photoCount} Google photos detected.`,
      photoVision.summary,
    ].filter(Boolean),
    status: "ok",
  };
}

function scoreMobile(output: AuditCollectorOutput): AuditScorecardPillar {
  const pageSpeed = output.pageSpeed;

  // No website linked on GBP — that's a real finding, but it's a discovery
  // issue, not a "your mobile site is bad" issue. Mark not_assessed.
  if (!pageSpeed || !pageSpeed.url) {
    return notAssessedPillar(
      "mobile",
      "Mobile & Web",
      "No website is linked from your Google listing, so there's nothing to test for mobile speed yet."
    );
  }

  // Website exists but PageSpeed returned nothing usable — also not_assessed.
  if (
    pageSpeed.performanceScore === null &&
    pageSpeed.seoScore === null &&
    pageSpeed.accessibilityScore === null
  ) {
    return notAssessedPillar(
      "mobile",
      "Mobile & Web",
      "We reached your website but couldn't get reliable speed metrics this run."
    );
  }

  const performance = pageSpeed.performanceScore ?? 45;
  const seo = pageSpeed.seoScore ?? 50;
  const accessibility = pageSpeed.accessibilityScore ?? 50;
  const score = clampScore(performance * 0.6 + seo * 0.25 + accessibility * 0.15);

  return {
    key: "mobile",
    label: "Mobile & Web",
    score,
    summary:
      score >= 75
        ? "Mobile website signals are strong enough for restaurant discovery."
        : "Mobile website speed or technical signals need attention.",
    signals: [
      `Performance score: ${pageSpeed.performanceScore ?? "unavailable"}.`,
      `SEO score: ${pageSpeed.seoScore ?? "unavailable"}.`,
      pageSpeed.lcpMs ? `Largest Contentful Paint: ${Math.round(pageSpeed.lcpMs)}ms.` : null,
      ...pageSpeed.diagnostics.slice(0, 2),
    ].filter((signal): signal is string => Boolean(signal)),
    status: "ok",
  };
}

function buildPeerComparison(
  output: AuditCollectorOutput,
  yourScore: number
): AuditPeerComparison | null {
  const benchmark = output.peerBenchmark;
  if (!benchmark || benchmark.averagePeerScore === null) return null;

  const cohortLabel = [
    benchmark.cuisine ? `${benchmark.cuisine} restaurants` : "Restaurants",
    "in",
    benchmark.location,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    cohortLabel,
    cohortSize: benchmark.peers.length,
    averagePeerScore: benchmark.averagePeerScore,
    yourScore,
    diff: yourScore - benchmark.averagePeerScore,
  };
}

export function scoreAudit(output: AuditCollectorOutput): AuditScorecard {
  const seoScorecard = scoreSeoAnalysis({
    gbp: output.gbp,
    reviews: output.reviews,
    onPage: output.onPage,
    rankGrid: null,
    citations: output.citations,
    failures: output.failures,
    estimatedApifyCostUsd: output.estimatedApifyCostUsd,
  });

  // Replace SEO scorer's basic GBP score with the audit's more discriminating
  // version when we have GBP data. Falls back to the SEO version (which
  // already returns missingPillar shape) when GBP is missing entirely.
  const discoverability = output.gbp
    ? scoreGbpDiscriminating(output.gbp)
    : notAssessedPillar(
        "discoverability",
        "Google Business Profile",
        "We couldn't find your Google Business Profile to score it."
      );

  const pillars: AuditScorecard["pillars"] = {
    discoverability,
    reputation: mapPillar("reputation", seoScorecard.pillars.reviews),
    delivery: mapPillar("delivery", seoScorecard.pillars.citations),
    photo: scorePhoto(output),
    mobile: scoreMobile(output),
  };

  // If the SEO scorer flagged a pillar as missing (degraded with score=35),
  // promote that to status="not_assessed" so it's handled consistently.
  for (const key of ["reputation", "delivery"] as const) {
    if (pillars[key].degraded) {
      const label = pillars[key].label;
      pillars[key] = notAssessedPillar(
        key,
        label,
        `We couldn't collect enough ${label.toLowerCase()} data to score this pillar.`
      );
    }
  }

  // Weighted average over pillars that were actually assessed. Pillars marked
  // not_assessed don't drag the overall score down and aren't shown as
  // critical — instead the frontend renders them as neutral tiles.
  const assessed = Object.entries(pillars).filter(
    ([, pillar]) => pillar.status !== "not_assessed"
  );
  const totalWeight = assessed.reduce(
    (sum, [key]) => sum + WEIGHTS[key as AuditPillar],
    0
  );
  const overallScore = totalWeight
    ? clampScore(
        assessed.reduce(
          (sum, [key, pillar]) =>
            sum + pillar.score * (WEIGHTS[key as AuditPillar] / totalWeight),
          0
        )
      )
    : 0;

  return {
    overallScore,
    pillars,
    peerComparison: buildPeerComparison(output, overallScore),
  };
}
