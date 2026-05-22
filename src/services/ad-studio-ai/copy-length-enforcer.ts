// Last-line-of-defense character-limit enforcer for Ad Studio copy.
//
// The COPY_TOOL_SCHEMA's maxLength + the prompt's HARD LIMIT language catch
// most over-length output at the SDK boundary. This module catches the rest:
//   1. Scan each variant's English + Arabic fields against META_COPY_LIMITS.
//   2. If anything is over, call Claude once to rewrite just the over-length
//      fields, asking for shorter copy that preserves intent / brand voice.
//   3. If a field is STILL over after rewrite (rare — usually means Claude
//      gave up), smart-truncate at the last word boundary with an ellipsis.
//
// The first two steps preserve quality (a 43-char headline rewritten by Claude
// reads like a copywriter wrote it). Step 3 ensures we never ship a creative
// that fails Meta export, even when the model misbehaves twice in a row.

import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@/lib/errors";
import { getAnthropicClient } from "@/services/claude";
import { META_COPY_LIMITS } from "./prompts";
import type { CopyVariant } from "./types";

type CopyField = "headline" | "primaryText" | "ctaText";
type CopyLanguage = "en" | "ar";

interface Overage {
  variant: number;
  field: CopyField;
  language: CopyLanguage;
  current: string;
  length: number;
  max: number;
}

const REWRITE_MODEL = "claude-sonnet-4-6";
const SONNET_INPUT_USD_PER_TOKEN = 0.000003;
const SONNET_OUTPUT_USD_PER_TOKEN = 0.000015;

const REWRITE_TOOL_NAME = "rewrite_overlong_copy";
const REWRITE_TOOL_SCHEMA = {
  name: REWRITE_TOOL_NAME,
  description:
    "Return shortened versions of the listed over-length fields so each fits within its hard Meta limit.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      fixes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["variant", "field", "language", "rewritten"],
          properties: {
            variant: { type: "integer", minimum: 1 },
            field: { type: "string", enum: ["headline", "primaryText", "ctaText"] },
            language: { type: "string", enum: ["en", "ar"] },
            rewritten: { type: "string" },
          },
        },
      },
    },
    required: ["fixes"],
  },
} as const;

export interface EnforceResult {
  variants: CopyVariant[];
  /** Fields we had to truncate at the word boundary because rewrite failed. */
  truncated: Array<{ variant: number; field: CopyField; language: CopyLanguage }>;
  /** Whether we needed to call Claude for a rewrite. */
  rewriteRan: boolean;
}

/**
 * Walk every variant's English + Arabic fields and return a list of fields
 * that exceed their META_COPY_LIMITS cap. Arabic fields are optional — only
 * included if present.
 */
function findOverages(variants: CopyVariant[]): Overage[] {
  const overages: Overage[] = [];
  const fields: Array<{ field: CopyField; max: number }> = [
    { field: "headline", max: META_COPY_LIMITS.headline },
    { field: "primaryText", max: META_COPY_LIMITS.primaryText },
    { field: "ctaText", max: META_COPY_LIMITS.ctaText },
  ];

  for (const v of variants) {
    for (const { field, max } of fields) {
      const enValue = v[field];
      if (enValue && enValue.length > max) {
        overages.push({
          variant: v.variant,
          field,
          language: "en",
          current: enValue,
          length: enValue.length,
          max,
        });
      }
      const arField = `${field}Ar` as `${CopyField}Ar`;
      const arValue = v[arField];
      if (arValue && arValue.length > max) {
        overages.push({
          variant: v.variant,
          field,
          language: "ar",
          current: arValue,
          length: arValue.length,
          max,
        });
      }
    }
  }
  return overages;
}

/**
 * Cut at the last word boundary at or before max-1 chars, then add an ellipsis.
 * Falls back to a hard mid-word cut if there's no whitespace within the window
 * (rare: a single very long word, or no whitespace in Arabic — but Arabic does
 * use spaces between words). The ellipsis is a single Unicode char ("…") so it
 * costs 1 character toward the budget.
 */
export function smartTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const ellipsis = "…";
  const target = max - ellipsis.length;
  if (target <= 0) return text.slice(0, max);

  // Trim to target then chop the trailing partial word.
  const window = text.slice(0, target);
  const boundaryMatch = window.match(/^(.*?)([\s\-,،؛]+\S*)$/u);
  const trimmed = boundaryMatch?.[1]?.trimEnd() ?? window.trimEnd();
  // If trimming left us with nothing (single huge word), accept a mid-word cut.
  const safe = trimmed.length > 0 ? trimmed : window;
  return `${safe}${ellipsis}`;
}

function applyFix(
  variants: CopyVariant[],
  variantNumber: number,
  field: CopyField,
  language: CopyLanguage,
  value: string
): void {
  const v = variants.find((x) => x.variant === variantNumber);
  if (!v) return;
  if (language === "en") {
    v[field] = value;
  } else {
    const arField = `${field}Ar` as `${CopyField}Ar`;
    v[arField] = value;
  }
}

function buildRewritePrompt(overages: Overage[]): string {
  const lines = overages.map((o) => {
    const overBy = o.length - o.max;
    return `- variant ${o.variant} ${o.field} (${o.language}): currently ${o.length} chars, ${overBy} over the ${o.max} cap. Original: ${JSON.stringify(o.current)}`;
  });
  return [
    "The following ad copy fields exceed their Meta character limits and would fail export. Rewrite each one so it fits, preserving brand voice, dialect, and the value prop. Keep the same language as the original (English or Arabic). Use natural shortening — drop filler words, swap long words for shorter synonyms, contract phrases. Do NOT add ellipsis; produce clean, complete copy.",
    "",
    "## Over-length fields",
    ...lines,
    "",
    'Return ALL fixes in a single call to `rewrite_overlong_copy`. Each "rewritten" string MUST be at or below its cap — count characters before submitting.',
  ].join("\n");
}

interface UsageAddable {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/**
 * Main entry. Returns the (possibly-mutated) variants plus a record of which
 * fields had to fall back to truncation — callers can log that as a signal
 * the prompt or model output drifted.
 */
export async function enforceCopyLimits(args: {
  variants: CopyVariant[];
  totals: UsageAddable;
}): Promise<EnforceResult> {
  const overages = findOverages(args.variants);
  if (overages.length === 0) {
    return { variants: args.variants, truncated: [], rewriteRan: false };
  }

  // Step 1: ask Claude to rewrite the over-length fields.
  const client = getAnthropicClient();
  if (!client) {
    // No API key — skip rewrite and go straight to truncation. This branch
    // only fires in dev / misconfigured environments; production has the key.
    return truncateRemaining(args.variants);
  }

  let rewriteRan = false;
  try {
    const response = await client.messages.create({
      model: REWRITE_MODEL,
      max_tokens: 1500,
      system:
        "You are an ad copywriter shortening over-length variants to fit Meta's hard character limits. Preserve the original voice, dialect, and value prop. Return clean, complete sentences — no ellipses.",
      tools: [REWRITE_TOOL_SCHEMA as Anthropic.Tool],
      tool_choice: { type: "tool", name: REWRITE_TOOL_NAME },
      messages: [{ role: "user", content: buildRewritePrompt(overages) }],
    });

    rewriteRan = true;
    args.totals.tokensIn += response.usage.input_tokens ?? 0;
    args.totals.tokensOut += response.usage.output_tokens ?? 0;
    args.totals.costUsd +=
      (response.usage.input_tokens ?? 0) * SONNET_INPUT_USD_PER_TOKEN +
      (response.usage.output_tokens ?? 0) * SONNET_OUTPUT_USD_PER_TOKEN;

    const toolBlock = response.content.find(
      (entry): entry is Anthropic.ToolUseBlock =>
        entry.type === "tool_use" && entry.name === REWRITE_TOOL_NAME
    );
    if (toolBlock) {
      const { fixes } = toolBlock.input as {
        fixes: Array<{ variant: number; field: CopyField; language: CopyLanguage; rewritten: string }>;
      };
      for (const fix of fixes) {
        const cap = META_COPY_LIMITS[fix.field];
        // Only apply the rewrite if it's actually shorter than the cap; otherwise
        // we'll truncate in Step 2 (rewrite that's still over is worse than the
        // original — keeps Claude from making it longer by accident).
        if (fix.rewritten.length <= cap) {
          applyFix(args.variants, fix.variant, fix.field, fix.language, fix.rewritten);
        }
      }
    }
  } catch (error) {
    // Rewrite is a quality-of-life pass; never bubble an Anthropic outage up
    // to the caller. Fall through to truncation so the project still ships.
    console.warn(
      "[copy-length-enforcer] rewrite call failed; falling back to truncation:",
      error instanceof Error ? error.message : error
    );
  }

  // Step 2: anything still over after rewrite gets smart-truncated.
  const result = truncateRemaining(args.variants);
  return { ...result, rewriteRan };
}

function truncateRemaining(variants: CopyVariant[]): EnforceResult {
  const remaining = findOverages(variants);
  const truncated: EnforceResult["truncated"] = [];
  for (const o of remaining) {
    const cut = smartTruncate(o.current, o.max);
    applyFix(variants, o.variant, o.field, o.language, cut);
    truncated.push({ variant: o.variant, field: o.field, language: o.language });
  }
  if (truncated.length > 0) {
    console.warn(
      `[copy-length-enforcer] truncated ${truncated.length} field(s) after rewrite — ${truncated
        .map((t) => `v${t.variant}.${t.field}.${t.language}`)
        .join(", ")}`
    );
  }
  return { variants, truncated, rewriteRan: false };
}

// =============================================================================
// Sanity check helper for the orchestrator — assert the post-enforcement
// invariant so we never ship a variant that would fail Meta export. Throws if
// any field is somehow still over (only possible if META_COPY_LIMITS is
// misconfigured, since smart-truncate is guaranteed to bring length ≤ max).
// =============================================================================
export function assertLimitsRespected(variants: CopyVariant[]): void {
  const remaining = findOverages(variants);
  if (remaining.length > 0) {
    throw new ApiError(
      `Internal: copy limit enforcer failed to bring all fields under cap (${remaining
        .map((r) => `v${r.variant}.${r.field}=${r.length}/${r.max}`)
        .join(", ")})`,
      500
    );
  }
}
