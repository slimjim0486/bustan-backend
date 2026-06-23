import assert from "node:assert/strict";
import test from "node:test";

import { NAME_MATCH_THRESHOLD, isNameMatch, nameMatchConfidence } from "./name-match.js";

test("returns null when either side is empty (not comparable)", () => {
  assert.equal(nameMatchConfidence("", "Allo Beirut"), null);
  assert.equal(nameMatchConfidence("Allo Beirut", null), null);
  assert.equal(nameMatchConfidence(null, undefined), null);
});

test("exact and normalized-equal names score 1", () => {
  assert.equal(nameMatchConfidence("Allo Beirut", "Allo Beirut"), 1);
  assert.equal(nameMatchConfidence("ALLO  BEIRUT!!", "allo beirut"), 1);
});

test("spacing variants are caught (the strict substring matcher missed these)", () => {
  // "Al Mallah" listing vs "Almallah" stored name — previously failed completely.
  assert.ok((nameMatchConfidence("Al Mallah", "Almallah") ?? 0) >= NAME_MATCH_THRESHOLD);
  assert.ok((nameMatchConfidence("Zaatar w Zeit", "ZaatarWZeit") ?? 0) >= NAME_MATCH_THRESHOLD);
});

test("trailing/extra descriptor tokens still match (the common Talabat case)", () => {
  // Talabat appends branch/area; stored name has an extra 'Restaurant'.
  assert.ok((nameMatchConfidence("Allo Beirut - Business Bay", "Allo Beirut") ?? 0) >= NAME_MATCH_THRESHOLD);
  assert.ok((nameMatchConfidence("Allo Beirut", "Allo Beirut Restaurant") ?? 0) >= NAME_MATCH_THRESHOLD);
  assert.ok((nameMatchConfidence("Operation Falafel JBR", "Operation Falafel") ?? 0) >= NAME_MATCH_THRESHOLD);
});

test("token overlap matches where neither string contains the other", () => {
  // "The Grill" vs "Grill House" — substring-only logic rejected this.
  const score = nameMatchConfidence("Grill House", "The Grill") ?? 0;
  assert.ok(score >= NAME_MATCH_THRESHOLD, `expected >= threshold, got ${score}`);
});

test("ampersand normalizes to 'and'", () => {
  assert.ok((nameMatchConfidence("Fish & Chips Co", "Fish and Chips Co") ?? 0) >= NAME_MATCH_THRESHOLD);
});

test("genuinely different restaurants do NOT match", () => {
  assert.ok((nameMatchConfidence("Pizza Hut", "Al Mallah") ?? 1) < NAME_MATCH_THRESHOLD);
  assert.ok((nameMatchConfidence("Operation Falafel", "Zaatar w Zeit") ?? 1) < NAME_MATCH_THRESHOLD);
  assert.equal(isNameMatch("Pizza Hut", "Al Mallah"), false);
});

test("isNameMatch exposes the boolean decision and preserves null for no-data", () => {
  assert.equal(isNameMatch("Allo Beirut", "Allo Beirut Restaurant"), true);
  assert.equal(isNameMatch("", "Allo Beirut"), null);
});

test("a single shared generic token alone is not enough to be confident", () => {
  // Shared 'restaurant' is a stop word; nothing distinctive in common.
  assert.ok((nameMatchConfidence("Marina Restaurant", "Downtown Restaurant") ?? 1) < NAME_MATCH_THRESHOLD);
});
