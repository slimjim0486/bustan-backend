/**
 * Confidence-scored restaurant-name matching.
 *
 * Replaces the old substring-only `looseMatch` used when reconciling scraped
 * delivery/listing results against a restaurant. Substring matching silently
 * rejected real listings whenever the scraped title carried an extra word, a
 * branch/area suffix, an ampersand, or a spacing variant — which is the common
 * case on Talabat/Deliveroo. This returns a 0..1 confidence instead, so callers
 * can both decide a match (via a threshold) and surface "likely vs confirmed".
 */

// Generic words that carry no identifying signal for a UAE restaurant name.
// Kept in sync conceptually with rank-grid-collector's NAME_STOP_WORDS.
const NAME_STOP_WORDS = new Set([
  "abu",
  "and",
  "best",
  "cafe",
  "dhabi",
  "dubai",
  "in",
  "me",
  "near",
  "restaurant",
  "restaurants",
  "the",
  "uae",
]);

/**
 * Minimum confidence at which we treat two names as the same restaurant.
 * Tuned for balance: recovers near-name variants while rejecting listings that
 * only share a generic stop word. Below this we report "not a match".
 */
export const NAME_MATCH_THRESHOLD = 0.5;

function normalize(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(normalized: string) {
  return normalized
    .split(" ")
    .filter((token) => token.length > 1 && !NAME_STOP_WORDS.has(token));
}

/**
 * Confidence (0..1) that `candidate` and `target` name the same restaurant.
 * Returns `null` when either side is empty (not comparable) so callers can
 * distinguish "no data" from "genuine mismatch", matching the old null-semantics
 * the SEO scorer relies on.
 */
export function nameMatchConfidence(
  candidate: string | null | undefined,
  target: string | null | undefined
): number | null {
  const left = normalize(candidate);
  const right = normalize(target);
  if (!left || !right) return null;

  if (left === right) return 1;
  // Spacing/diacritic variants, e.g. "Al Mallah" vs "Almallah".
  if (left.replace(/ /g, "") === right.replace(/ /g, "")) return 0.97;
  // One title fully contains the other (branch/area suffix, extra descriptor).
  const substring = left.includes(right) || right.includes(left) ? 0.92 : 0;

  // Distinctive-token overlap (Dice coefficient) for the cases where neither
  // string nests inside the other, e.g. "The Grill" vs "Grill House".
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  const leftSet = leftTokens.length ? new Set(leftTokens) : new Set(left.split(" ").filter(Boolean));
  const rightArr = rightTokens.length ? rightTokens : right.split(" ").filter(Boolean);

  let tokenScore = 0;
  if (rightArr.length && leftSet.size) {
    const shared = rightArr.filter((token) => leftSet.has(token)).length;
    // Require at least one distinctive shared token; otherwise the overlap is
    // only stop words and means nothing.
    if (shared > 0) {
      tokenScore = (2 * shared) / (leftSet.size + rightArr.length);
    }
  }

  return Math.max(substring, tokenScore);
}

/**
 * Boolean match decision. Returns `null` when names aren't comparable (one side
 * empty), `true`/`false` otherwise — a drop-in replacement for `looseMatch`.
 */
export function isNameMatch(
  candidate: string | null | undefined,
  target: string | null | undefined
): boolean | null {
  const confidence = nameMatchConfidence(candidate, target);
  if (confidence === null) return null;
  return confidence >= NAME_MATCH_THRESHOLD;
}
