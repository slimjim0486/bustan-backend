import type { CollectorOutput, ScorecardPillar, SeoScorecard } from "./types";

const WEIGHTS = {
  gbp: 0.25,
  onPage: 0.2,
  rankGrid: 0.2,
  citations: 0.2,
  reviews: 0.15,
} as const;

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function missingPillar(key: ScorecardPillar["key"], label: string): ScorecardPillar {
  return {
    key,
    label,
    score: 35,
    summary: `${label} data was unavailable, so this pillar is marked degraded.`,
    signals: ["Collector did not return enough usable data."],
    degraded: true,
  };
}

function scoreGbp(output: CollectorOutput): ScorecardPillar {
  const gbp = output.gbp;
  if (!gbp) return missingPillar("gbp", "Google Business Profile");

  const signals: string[] = [];
  let score = 35;

  if (gbp.name) score += 10;
  else signals.push("Google profile name was not found.");

  if (gbp.address) score += 10;
  else signals.push("Google address was not found.");

  if (gbp.phone) score += 10;
  else signals.push("Google phone number was not found.");

  if (gbp.website) score += 10;
  else signals.push("Google website link is missing.");

  if (gbp.hours) score += 10;
  else signals.push("Opening hours were not returned.");

  if (gbp.categories.length) score += 10;
  else signals.push("Business categories are missing.");

  if (gbp.photosCount >= 10) score += 5;
  else signals.push("Profile has fewer than 10 visible photos.");

  const summary =
    score >= 80
      ? "Google listing has the core discovery signals in place."
      : "Google listing has gaps that can suppress local discovery.";

  return {
    key: "gbp",
    label: "Google Business Profile",
    score: clampScore(score),
    summary,
    signals: signals.length ? signals : ["Name, address, phone, hours, categories, and photos are present."],
  };
}

function scoreOnPage(output: CollectorOutput): ScorecardPillar {
  const onPage = output.onPage;
  if (!onPage) return missingPillar("onPage", "On-Page SEO");

  const signals: string[] = [];
  let score = onPage.url ? 35 : 15;

  if (onPage.title && onPage.title.length <= 70) score += 15;
  else signals.push("Homepage title is missing or too long.");

  if (onPage.metaDescription && onPage.metaDescription.length <= 170) score += 15;
  else signals.push("Meta description is missing or too long.");

  if (onPage.hasRestaurantSchema) score += 20;
  else signals.push("Restaurant/LocalBusiness schema was not detected.");

  if (onPage.mobileFriendly !== false) score += 5;
  else signals.push("Mobile-friendly signal is negative.");

  if (onPage.lcpEstimateMs === null || onPage.lcpEstimateMs <= 2500) score += 5;
  else signals.push("Largest Contentful Paint estimate is slower than 2.5 seconds.");

  if (onPage.missingImageAltCount === 0) score += 5;
  else signals.push(`${onPage.missingImageAltCount} image${onPage.missingImageAltCount === 1 ? "" : "s"} appear to be missing alt text.`);

  return {
    key: "onPage",
    label: "On-Page SEO",
    score: clampScore(score),
    summary:
      score >= 80
        ? "Website basics support branded and local search."
        : "Website metadata and structured data need attention.",
    signals,
  };
}

function scoreRankGrid(output: CollectorOutput): ScorecardPillar {
  const rankGrid = output.rankGrid;
  if (!rankGrid) return missingPillar("rankGrid", "Local Rank Grid");

  const allRanks = rankGrid.keywords.flatMap((keyword) =>
    keyword.cells.map((cell) => cell.rank).filter((rank): rank is number => rank !== null)
  );
  const totalCells = rankGrid.keywords.reduce((sum, keyword) => sum + keyword.cells.length, 0);
  const coverage = totalCells ? allRanks.length / totalCells : 0;
  const averageRank = allRanks.length
    ? allRanks.reduce((sum, rank) => sum + rank, 0) / allRanks.length
    : null;
  const rankScore = averageRank === null ? 20 : Math.max(0, 100 - (averageRank - 1) * 8);
  const coverageScore = coverage * 100;
  const score = clampScore(rankScore * 0.7 + coverageScore * 0.3);

  return {
    key: "rankGrid",
    label: "Local Rank Grid",
    score,
    summary:
      averageRank === null
        ? "Restaurant was not found in tracked local search results."
        : `Average tracked rank is ${averageRank.toFixed(1)} across the local grid.`,
    signals: [
      `${Math.round(coverage * 100)}% of tracked grid cells found the restaurant.`,
      averageRank === null ? "No rank positions found." : `Average rank: ${averageRank.toFixed(1)}.`,
    ],
  };
}

function scoreCitations(output: CollectorOutput): ScorecardPillar {
  const citations = output.citations;
  if (!citations) return missingPillar("citations", "Delivery Citations");

  const matchValues = citations.platforms.flatMap((platform) =>
    Object.values(platform.matches).filter((value): value is boolean => value !== null)
  );
  const foundCount = citations.platforms.filter((platform) => platform.found).length;
  const matchRate = matchValues.length
    ? matchValues.filter(Boolean).length / matchValues.length
    : 0;
  const foundRate = citations.platforms.length ? foundCount / citations.platforms.length : 0;
  const score = clampScore(matchRate * 70 + foundRate * 30);
  const inconsistent = citations.platforms
    .filter((platform) => Object.values(platform.matches).some((value) => value === false))
    .map((platform) => platform.platform);
  const likely = citations.platforms
    .filter((platform) => platform.found && (platform.nameConfidence ?? 1) < 0.85)
    .map((platform) => platform.platform);

  return {
    key: "citations",
    label: "Delivery Citations",
    score,
    summary:
      inconsistent.length === 0
        ? "Delivery and Google listings are broadly consistent."
        : `NAP mismatches detected on ${inconsistent.join(", ")}.`,
    signals: [
      `${foundCount}/${citations.platforms.length} tracked platforms found.`,
      `${Math.round(matchRate * 100)}% of comparable NAP fields match.`,
      ...(likely.length ? [`Likely (unverified) match on ${likely.join(", ")} — confirm the listing.`] : []),
    ],
  };
}

function scoreReviews(output: CollectorOutput): ScorecardPillar {
  const reviews = output.reviews;
  if (!reviews) return missingPillar("reviews", "Review Intelligence");

  const reviewCount = reviews.reviews.length;
  const average = reviews.averageRating ?? 0;
  const responseRate = reviews.responseRate ?? 0;
  const score = clampScore(average * 14 + Math.min(reviewCount, 50) * 0.4 + responseRate * 10);

  return {
    key: "reviews",
    label: "Review Intelligence",
    score,
    summary:
      reviews.averageRating === null
        ? "No recent review sample was available."
        : `Recent review sample averages ${average.toFixed(1)} stars with ${Math.round(responseRate * 100)}% owner response rate.`,
    signals: [
      `${reviewCount} reviews sampled.`,
      `${reviews.themes.length} recurring review theme${reviews.themes.length === 1 ? "" : "s"} detected.`,
    ],
  };
}

export function scoreSeoAnalysis(output: CollectorOutput): SeoScorecard {
  const pillars = {
    gbp: scoreGbp(output),
    onPage: scoreOnPage(output),
    rankGrid: scoreRankGrid(output),
    citations: scoreCitations(output),
    reviews: scoreReviews(output),
  };
  const overallScore = clampScore(
    pillars.gbp.score * WEIGHTS.gbp +
      pillars.onPage.score * WEIGHTS.onPage +
      pillars.rankGrid.score * WEIGHTS.rankGrid +
      pillars.citations.score * WEIGHTS.citations +
      pillars.reviews.score * WEIGHTS.reviews
  );

  return {
    overallScore,
    pillars,
  };
}
