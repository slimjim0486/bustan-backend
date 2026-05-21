// Exa.ai client wrapper.
//
// Exa is the agent-native web search backbone we use for Market Pulse
// (weekly competitor data pull) and the GTM lead-gen pipeline. Two
// endpoints in v1:
//   • POST /search   — semantic + keyword search across the web. Used for
//                       promo discovery, press mentions, deep-web reviews.
//   • POST /contents — fetch full text/highlights for a set of result IDs.
//                       Used for menu extraction (needs page text, not
//                       just snippets).
//
// Cost model (verified May 2026):
//   • Standard search: $7 per 1k requests           → $0.007/call
//   • Contents:        $1 per 1k results returned   → $0.001/result
//   • Deep search:     $12-15 per 1k (NOT USED v1 — far more expensive)
//
// Kill switch + cap handling:
//   • `env.EXA_ENABLED=false` short-circuits every call with `disabled`.
//   • `env.EXA_API_KEY` absent → behave the same as disabled (lets local
//     dev boot without the key).
//   • Callers are expected to check restaurant-level monthly spend BEFORE
//     calling this module — that lives in `competitor-intel/budget.ts` so
//     this file stays generic and reusable (lead-gen, future agents…).
//
// Retry:
//   • 429 / 5xx → up to 3 attempts with jittered exponential backoff
//     (200ms, 800ms, 2000ms).
//   • Other errors bubble up; the orchestrator's settleCollector wraps
//     them so one bad competitor never poisons the batch.

import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";

const EXA_API_BASE = "https://api.exa.ai";
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 3;

// Per-call cost in USD. Used by callers to record into ai_usage_logs.
// Refresh if Exa pricing changes — the constants live here so we don't
// hardcode dollars in collector code.
export const EXA_COST_USD = {
  searchPerCall: 0.007,
  contentsPerResult: 0.001,
} as const;

export type ExaSearchCategory =
  | "company"
  | "research paper"
  | "news"
  | "github"
  | "linkedin profile"
  | "pdf";

export interface ExaSearchOptions {
  query: string;
  numResults?: number;
  /** Restrict to a category. "news" is heavily curated; "company" maps to
   *  business homepages and is best for menu/promo discovery. */
  category?: ExaSearchCategory;
  /** ISO date — only return results published on/after this date. */
  startPublishedDate?: string;
  /** ISO date — only return results published on/before this date. */
  endPublishedDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  /** Per-result text inclusion. When true, results carry `text` already so
   *  you don't need a separate /contents call (cheaper for 1-2 results). */
  includeText?: boolean;
  /** Force keyword search mode. Defaults to "auto" which Exa picks. */
  type?: "auto" | "neural" | "keyword";
}

export interface ExaSearchResult {
  id: string;
  url: string;
  title: string | null;
  publishedDate: string | null;
  author: string | null;
  text: string | null;
  highlights: string[] | null;
  score: number | null;
}

export interface ExaCallResult<T> {
  /** "ok" → call succeeded. "disabled" → kill switch / missing key (no
   *  cost incurred). Callers should treat disabled as a soft no-op and
   *  return empty data, not an error. */
  status: "ok" | "disabled";
  data: T;
  estimatedCostUsd: number;
}

function isEnabled(): boolean {
  return env.EXA_ENABLED && Boolean(env.EXA_API_KEY);
}

async function exaFetch(
  path: string,
  body: unknown,
  attempt = 1
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${EXA_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "x-api-key": env.EXA_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.ok) {
      return await response.json();
    }

    // Retry on rate-limit and server errors with jittered backoff. Anything
    // else (4xx mostly) is a client bug; throw immediately.
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) {
      const baseDelayMs = attempt === 1 ? 200 : attempt === 2 ? 800 : 2000;
      const jitter = Math.random() * 200;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs + jitter));
      return exaFetch(path, body, attempt + 1);
    }

    const text = await response.text().catch(() => "");
    throw new ApiError(
      `Exa ${path} failed with ${response.status}${text ? `: ${text.slice(0, 240)}` : ""}`,
      response.status >= 500 ? 502 : 400
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (attempt < MAX_ATTEMPTS) {
        return exaFetch(path, body, attempt + 1);
      }
      throw new ApiError(`Exa ${path} timed out after ${MAX_ATTEMPTS} attempts`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSearchResult(raw: Record<string, unknown>): ExaSearchResult {
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    url: typeof raw.url === "string" ? raw.url : "",
    title: typeof raw.title === "string" ? raw.title : null,
    publishedDate:
      typeof raw.publishedDate === "string" ? raw.publishedDate : null,
    author: typeof raw.author === "string" ? raw.author : null,
    text: typeof raw.text === "string" ? raw.text : null,
    highlights: Array.isArray(raw.highlights)
      ? (raw.highlights as unknown[]).filter(
          (h): h is string => typeof h === "string"
        )
      : null,
    score: typeof raw.score === "number" ? raw.score : null,
  };
}

export async function exaSearch(
  options: ExaSearchOptions
): Promise<ExaCallResult<ExaSearchResult[]>> {
  if (!isEnabled()) {
    return { status: "disabled", data: [], estimatedCostUsd: 0 };
  }

  const body: Record<string, unknown> = {
    query: options.query,
    numResults: options.numResults ?? 5,
    type: options.type ?? "auto",
  };
  if (options.category) body.category = options.category;
  if (options.startPublishedDate) body.startPublishedDate = options.startPublishedDate;
  if (options.endPublishedDate) body.endPublishedDate = options.endPublishedDate;
  if (options.includeDomains?.length) body.includeDomains = options.includeDomains;
  if (options.excludeDomains?.length) body.excludeDomains = options.excludeDomains;
  if (options.includeText) {
    body.contents = { text: { maxCharacters: 4000 } };
  }

  const payload = (await exaFetch("/search", body)) as {
    results?: Record<string, unknown>[];
  };
  const results = (payload.results ?? []).map(normalizeSearchResult);

  // /search is one billable call regardless of result count. If contents
  // were inlined (includeText=true), each returned result also incurs the
  // contents per-result fee.
  const contentsCost = options.includeText
    ? results.length * EXA_COST_USD.contentsPerResult
    : 0;

  return {
    status: "ok",
    data: results,
    estimatedCostUsd: EXA_COST_USD.searchPerCall + contentsCost,
  };
}

export interface ExaContentsOptions {
  ids: string[];
  /** Char ceiling per page. Exa charges per result returned, not per char. */
  maxCharacters?: number;
}

export async function exaContents(
  options: ExaContentsOptions
): Promise<ExaCallResult<ExaSearchResult[]>> {
  if (!isEnabled() || options.ids.length === 0) {
    return { status: isEnabled() ? "ok" : "disabled", data: [], estimatedCostUsd: 0 };
  }

  const body = {
    ids: options.ids,
    text: { maxCharacters: options.maxCharacters ?? 4000 },
  };

  const payload = (await exaFetch("/contents", body)) as {
    results?: Record<string, unknown>[];
  };
  const results = (payload.results ?? []).map(normalizeSearchResult);

  return {
    status: "ok",
    data: results,
    estimatedCostUsd: results.length * EXA_COST_USD.contentsPerResult,
  };
}

export function exaIsEnabled(): boolean {
  return isEnabled();
}
