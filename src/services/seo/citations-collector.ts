import { runActor } from "@/lib/apify";
import { env } from "@/lib/env";
import { NAME_MATCH_THRESHOLD, isNameMatch, nameMatchConfidence } from "./name-match";
import type {
  CitationPlatformResult,
  CitationsData,
  GbpData,
  RestaurantSeoContext,
} from "./types";

const PLATFORM_DOMAINS: Record<CitationPlatformResult["platform"], string[]> = {
  Google: ["google.com", "google.ae"],
  Talabat: ["talabat.com"],
  Deliveroo: ["deliveroo.ae", "deliveroo.com"],
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalize(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/\+971/g, "0")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looseMatch(a: string | null | undefined, b: string | null | undefined) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return null;
  return left === right || left.includes(right) || right.includes(left);
}

function normalizePhone(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "").replace(/^971/, "0");
}

function phoneMatch(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  if (!left || !right) return null;
  return left.endsWith(right.slice(-7)) || right.endsWith(left.slice(-7));
}

function hostMatchesPlatform(url: string | null | undefined, platform: CitationPlatformResult["platform"]) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return PLATFORM_DOMAINS[platform].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function normalizePlatformItem(
  platform: CitationPlatformResult["platform"],
  url: string | null,
  item: Record<string, unknown> | null,
  restaurant: RestaurantSeoContext
): CitationPlatformResult {
  const name = text(item?.name) ?? text(item?.title) ?? text(item?.restaurantName);
  const address = text(item?.address) ?? text(item?.location) ?? text(item?.fullAddress);
  const phone = text(item?.phone) ?? text(item?.phoneNumber) ?? text(item?.telephone);
  const hours = item?.hours ?? item?.openingHours ?? null;

  return {
    platform,
    url,
    found: Boolean(item && (name || address || phone || hours)),
    name,
    address,
    phone,
    hours,
    matches: {
      name: isNameMatch(name, restaurant.name),
      address: looseMatch(address, restaurant.address ?? restaurant.location),
      phone: phoneMatch(phone, restaurant.phone),
      hours: hours && restaurant.operatingHours ? true : null,
    },
    nameConfidence: nameMatchConfidence(name, restaurant.name),
  };
}

function platformFromSavedUrl(
  platform: CitationPlatformResult["platform"],
  url: string,
  restaurant: RestaurantSeoContext
) {
  return normalizePlatformItem(
    platform,
    url,
    {
      name: restaurant.name,
    },
    restaurant
  );
}

function cityOrLocation(restaurant: RestaurantSeoContext) {
  const source = restaurant.location ?? restaurant.address ?? "Dubai";
  return source.split(",").map((part) => part.trim()).filter(Boolean).at(-1) ?? source;
}

function searchQueryForPlatform(
  platform: CitationPlatformResult["platform"],
  restaurant: RestaurantSeoContext
) {
  const domains = PLATFORM_DOMAINS[platform]
    .map((domain) => `site:${domain}`)
    .join(" OR ");
  // Unquoted terms: exact-phrase quoting around the name made Google return zero
  // results whenever the stored name differed at all from the listing title
  // (extra word, punctuation, transliteration). The confidence matcher below
  // does the filtering instead, so let Google surface near-name candidates.
  return `${domains} ${restaurant.name} ${cityOrLocation(restaurant)}`;
}

function organicResultsFromItems(items: Record<string, unknown>[]) {
  return items.flatMap((item) => {
    const organicResults = item.organicResults;
    if (Array.isArray(organicResults)) {
      return organicResults.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      );
    }
    return [item];
  });
}

async function discoverPlatformWithGoogleSearch(
  platform: CitationPlatformResult["platform"],
  restaurant: RestaurantSeoContext
) {
  const result = await runActor<Record<string, unknown>>(
    env.APIFY_ACTOR_GSEARCH,
    {
      queries: searchQueryForPlatform(platform, restaurant),
      resultsPerPage: 10,
      maxPagesPerQuery: 1,
      languageCode: "en",
      countryCode: "ae",
    },
    {
      timeoutMs: 120_000,
      estimateCostUsd: 0.03,
      maxItems: 1,
      maxTotalChargeUsd: 0.5,
      memoryMbytes: 4096,
    }
  );

  // Score every on-domain candidate and keep the most confident one above the
  // threshold, instead of accepting the first substring hit.
  const match = organicResultsFromItems(result.items)
    .map((item) => {
      const url = text(item.url) ?? text(item.link);
      const title = text(item.title) ?? text(item.name);
      const confidence = hostMatchesPlatform(url, platform)
        ? nameMatchConfidence(title, restaurant.name) ?? 0
        : 0;
      return { item, url, title, confidence };
    })
    .filter((candidate) => candidate.url && candidate.confidence >= NAME_MATCH_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)
    .at(0);

  const url = match?.url ?? null;
  return {
    platform: url
      ? normalizePlatformItem(
          platform,
          url,
          {
            name: match?.title ?? restaurant.name,
          },
          restaurant
        )
      : normalizePlatformItem(platform, null, null, restaurant),
    estimatedCostUsd: result.estimatedCostUsd,
  };
}

async function collectPlatform(
  platform: CitationPlatformResult["platform"],
  actorId: string | null | undefined,
  url: string | null,
  restaurant: RestaurantSeoContext
) {
  if (url && !actorId) {
    return {
      platform: platformFromSavedUrl(platform, url, restaurant),
      estimatedCostUsd: 0,
    };
  }

  if (!actorId) {
    return discoverPlatformWithGoogleSearch(platform, restaurant);
  }

  const result = await runActor<Record<string, unknown>>(
    actorId,
    {
      startUrls: url ? [{ url }] : undefined,
      searchStringsArray: url
        ? undefined
        : [[restaurant.name, restaurant.address ?? restaurant.location].filter(Boolean).join(" ")],
      maxItems: 1,
    },
    {
      timeoutMs: 90_000,
      estimateCostUsd: 0.06,
      maxItems: 1,
      maxTotalChargeUsd: 0.5,
      memoryMbytes: 4096,
    }
  );

  return {
    platform: normalizePlatformItem(platform, url, result.items[0] ?? null, restaurant),
    estimatedCostUsd: result.estimatedCostUsd,
  };
}

export async function collectCitationsData(
  restaurant: RestaurantSeoContext,
  gbp: GbpData | null
) {
  const google = normalizePlatformItem(
    "Google",
    restaurant.gbpConnection?.gbpUrl ?? null,
    gbp
      ? {
          name: gbp.name,
          address: gbp.address,
          phone: gbp.phone,
          hours: gbp.hours,
        }
      : null,
    restaurant
  );

  const platforms = await Promise.all([
    collectPlatform("Talabat", env.APIFY_ACTOR_TALABAT, restaurant.talabatUrl, restaurant),
    collectPlatform("Deliveroo", env.APIFY_ACTOR_DELIVEROO, restaurant.deliverooUrl, restaurant),
  ]);

  return {
    data: {
      platforms: [google, ...platforms.map((entry) => entry.platform)],
    } satisfies CitationsData,
    estimatedCostUsd: platforms.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0),
  };
}
