/**
 * Diner-concierge eval suite (spec §9). Targets the SHARED brain
 * (`runConciergeTurn`), so it covers the web widget + WhatsApp concierge in one
 * pass. Unlike the sous-chef harness, assertions check CONTENT, not just tool
 * selection — factual prices, allergen caveats, escalation, injection defence.
 *
 * FULLY IN-MEMORY: every concierge tool reads off the fixture restaurant object.
 * There is NO database access anywhere in this harness (a live Railway worker
 * shares the real DB and must not be touched).
 *
 * Spends real Anthropic tokens — run manually:
 *   npm run eval:concierge                 # full run (~59 cases)
 *   npx tsx evals/concierge/run-evals.ts --subset 3
 *   npx tsx evals/concierge/run-evals.ts --only menu
 *   npx tsx evals/concierge/run-evals.ts --only inject-ar
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runConciergeTurn } from "../../src/lib/concierge";
import type {
  ConciergeChannel,
  ConciergeLanguage,
  ConciergeTurnResult,
} from "../../src/lib/concierge/types";
import { evalRestaurant, itemPrices } from "./fixture";

const CUSTOMER_PHONE = "+971501234567";

type ContentCheck =
  | { type: "price-accuracy" }
  | { type: "must-include"; values: string[]; anyOf?: boolean }
  | { type: "must-not-include"; values: string[] }
  | { type: "must-include-or-escalate"; values: string[] }
  | { type: "language"; value: "ar" }
  | { type: "mentions-order"; orderNumber: string };

interface GoldenCase {
  id: string;
  category: string;
  channel?: ConciergeChannel;
  language?: "en" | "ar";
  message: string;
  history?: { role: "user" | "assistant"; content: string }[];
  expect: {
    // Single action, or an array when either outcome is acceptable (e.g.
    // allergen uncertainty: a caveated reply and an escalation are both safe).
    action?: "reply" | "escalate" | Array<"reply" | "escalate">;
    contentChecks: ContentCheck[];
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Map Arabic-Indic and Eastern-Arabic-Indic digits to ASCII so prices parse. */
function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

function allIndexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

const CONTAINS_ARABIC = /[؀-ۿ]/;

/**
 * Scan a reply for AED amounts adjacent to fixture item names and compare to
 * the known price. Only currency-tagged numbers ("AED 28", "28 AED", "28
 * dirham", "٢٨ درهم") are considered, to avoid false positives on order
 * numbers or item counts. A number within 80 chars of an item name that does
 * not match that item's price is a failure.
 */
function checkPriceAccuracy(reply: string): string | null {
  const text = normalizeDigits(reply);
  const lower = text.toLowerCase();

  const priceTokens: { value: number; index: number }[] = [];
  const numThenCur = /(\d{1,4}(?:\.\d{1,2})?)\s*(?:aed|dirhams?|dhs?|درهم)/gi;
  const curThenNum = /(?:aed|درهم)\s*(\d{1,4}(?:\.\d{1,2})?)/gi;
  for (const re of [numThenCur, curThenNum]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      priceTokens.push({ value: Number(m[1]), index: m.index });
    }
  }
  if (priceTokens.length === 0) return null;

  const itemPositions = Object.entries(itemPrices).flatMap(([name, price]) =>
    allIndexesOf(lower, name.toLowerCase()).map((index) => ({ name, price, index }))
  );
  if (itemPositions.length === 0) return null;

  for (const token of priceTokens) {
    let nearest: { name: string; price: number; dist: number } | null = null;
    for (const pos of itemPositions) {
      const dist = Math.abs(pos.index - token.index);
      if (!nearest || dist < nearest.dist) {
        nearest = { name: pos.name, price: pos.price, dist };
      }
    }
    if (nearest && nearest.dist <= 80 && Math.abs(token.value - nearest.price) > 0.5) {
      return `stated AED ${token.value} near "${nearest.name}" (fixture price ${nearest.price})`;
    }
  }
  return null;
}

/** Returns a failure reason string, or null if the check passes. */
function runContentCheck(
  check: ContentCheck,
  result: ConciergeTurnResult
): string | null {
  const reply = result.reply ?? "";
  const lower = reply.toLowerCase();

  switch (check.type) {
    case "price-accuracy":
      return checkPriceAccuracy(reply);

    case "must-include": {
      const values = check.values.map((v) => v.toLowerCase());
      if (check.anyOf) {
        return values.some((v) => lower.includes(v))
          ? null
          : `none of [${check.values.join(", ")}] present`;
      }
      const missing = values.filter((v) => !lower.includes(v));
      return missing.length ? `missing [${missing.join(", ")}]` : null;
    }

    case "must-not-include": {
      const hit = check.values.filter((v) => lower.includes(v.toLowerCase()));
      return hit.length ? `must not include [${hit.join(", ")}]` : null;
    }

    case "must-include-or-escalate": {
      if (result.action === "escalate") return null;
      const values = check.values.map((v) => v.toLowerCase());
      return values.some((v) => lower.includes(v))
        ? null
        : `not escalated and none of [${check.values.join(", ")}] present`;
    }

    case "language":
      // Arabic-script presence counts as pass; bilingual replies still pass.
      return CONTAINS_ARABIC.test(reply) ? null : "no Arabic script in reply";

    case "mentions-order":
      return lower.includes(check.orderNumber.toLowerCase())
        ? null
        : `order ${check.orderNumber} not mentioned`;

    default:
      return `unknown check type ${(check as { type: string }).type}`;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  let subset: number | null = null;
  let only: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--subset") {
      subset = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--only") {
      only = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return { subset, only };
}

async function main() {
  const { subset, only } = parseArgs(process.argv.slice(2));

  const allCases = JSON.parse(
    readFileSync(join(__dirname, "golden-cases.json"), "utf8")
  ) as GoldenCase[];

  let selected = allCases;
  if (only) selected = selected.filter((c) => c.id.startsWith(only) || c.category === only);
  if (subset != null && !Number.isNaN(subset)) selected = selected.slice(0, subset);

  // --- Cost estimate (printed before running; no interactive prompt) ---
  // Haiku 4.5 pricing: ~$1.00 / 1M input, ~$5.00 / 1M output. Warm cache reads
  // are ~$0.10 / 1M. Rough per-case budget: one model call, ~1800 input tokens
  // (system + serialized menu prefix, mostly cache-read after the first call in
  // a restaurant) and ~180 output tokens. Guard-tripped cases (injection /
  // human-request pre-filters) cost 0 tokens, so this is an upper bound.
  const perCaseInput = 1800;
  const perCaseOutput = 180;
  const estInput = selected.length * perCaseInput;
  const estOutput = selected.length * perCaseOutput;
  const estUsd = (estInput / 1_000_000) * 1.0 + (estOutput / 1_000_000) * 5.0;
  console.log("=".repeat(64));
  console.log(`Concierge eval — ${selected.length}/${allCases.length} cases selected`);
  console.log(
    `Rough upper-bound spend: ~${estInput.toLocaleString()} in + ~${estOutput.toLocaleString()} out tokens ≈ $${estUsd.toFixed(3)} (Haiku, cold cache)`
  );
  console.log("(Guard-tripped cases cost 0 tokens; warm-cache runs cost far less.)");
  console.log("=".repeat(64));

  let passed = 0;
  let failed = 0;
  const byCategory = new Map<string, { pass: number; fail: number }>();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  const bump = (category: string, ok: boolean) => {
    const row = byCategory.get(category) ?? { pass: 0, fail: 0 };
    if (ok) row.pass += 1;
    else row.fail += 1;
    byCategory.set(category, row);
  };

  for (const testCase of selected) {
    const errors: string[] = [];
    let result: ConciergeTurnResult | null = null;

    try {
      result = await runConciergeTurn({
        restaurant: evalRestaurant,
        channel: testCase.channel ?? "whatsapp",
        message: testCase.message,
        history: testCase.history,
        language: (testCase.language ?? null) as ConciergeLanguage,
        customerPhone: CUSTOMER_PHONE,
      });

      totalInput += result.inputTokens;
      totalOutput += result.outputTokens;
      totalCacheRead += result.cacheReadInputTokens ?? 0;
      totalCacheWrite += result.cacheCreationInputTokens ?? 0;

      const expectedActions = testCase.expect.action
        ? Array.isArray(testCase.expect.action)
          ? testCase.expect.action
          : [testCase.expect.action]
        : null;
      if (expectedActions && !expectedActions.includes(result.action)) {
        errors.push(`action ${result.action} not in [${expectedActions.join(", ")}]`);
      }
      for (const check of testCase.expect.contentChecks) {
        const reason = runContentCheck(check, result);
        if (reason) errors.push(`${check.type}: ${reason}`);
      }
    } catch (error) {
      errors.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
    }

    const ok = errors.length === 0;
    if (ok) {
      passed += 1;
      console.log(`PASS ${testCase.id}`);
    } else {
      failed += 1;
      console.log(`FAIL ${testCase.id}: ${errors.join(" | ")}`);
      if (result) console.log(`     reply: ${JSON.stringify(result.reply)}`);
    }
    bump(testCase.category, ok);
  }

  console.log("\n" + "-".repeat(64));
  console.log("Category rollup:");
  for (const [category, row] of [...byCategory.entries()].sort()) {
    console.log(`  ${category.padEnd(20)} ${row.pass}/${row.pass + row.fail}`);
  }
  console.log("-".repeat(64));
  console.log(`TOTAL: ${passed}/${passed + failed} passed`);
  console.log(
    `Tokens: ${totalInput.toLocaleString()} in (${totalCacheRead.toLocaleString()} cache-read, ${totalCacheWrite.toLocaleString()} cache-write) / ${totalOutput.toLocaleString()} out`
  );

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
