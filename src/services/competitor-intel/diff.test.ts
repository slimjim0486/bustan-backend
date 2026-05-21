// Unit tests for the week-over-week diff helper. Pure function — no DB,
// no LLM, fast feedback for the heuristic that powers every Inbox card.

import assert from "node:assert/strict";
import test from "node:test";
import { computeCompetitorChanges } from "./diff";
import type { MenuItemSignal, PromoSignal } from "./types";

function menu(name: string, price: number | null): MenuItemSignal {
  return { name, price, currency: "AED", isNew: false, source: null };
}

function promo(title: string, source = "https://example.com/promo"): PromoSignal {
  return {
    title,
    description: null,
    validUntil: null,
    source,
    publishedAt: null,
  };
}

function makeWeek(
  items: { name: string; price: number | null }[],
  promos: { title: string; source?: string }[] = []
) {
  return {
    menuItems: items.map((i) => menu(i.name, i.price)),
    promotions: promos.map((p) => promo(p.title, p.source)),
  };
}

test("computeCompetitorChanges — returns empty when no prior week", () => {
  const result = computeCompetitorChanges(
    makeWeek([{ name: "Falafel Wrap", price: 32 }]),
    null
  );
  assert.deepEqual(result, {
    addedDishes: [],
    removedDishes: [],
    priceChanges: [],
    newPromos: [],
  });
});

test("computeCompetitorChanges — flags newly added dishes", () => {
  const previous = makeWeek([
    { name: "Falafel Wrap", price: 32 },
    { name: "Hummus Plate", price: 24 },
    { name: "Tabbouleh", price: 18 },
    { name: "Mixed Grill", price: 95 },
    { name: "Mint Lemonade", price: 14 },
  ]);
  const current = makeWeek([
    { name: "Falafel Wrap", price: 32 },
    { name: "Hummus Plate", price: 24 },
    { name: "Tabbouleh", price: 18 },
    { name: "Mixed Grill", price: 95 },
    { name: "Mint Lemonade", price: 14 },
    { name: "Truffle Falafel Wrap", price: 48 },
  ]);
  const result = computeCompetitorChanges(current, previous);
  assert.equal(result.addedDishes.length, 1);
  assert.equal(result.addedDishes[0].name, "Truffle Falafel Wrap");
  assert.equal(result.addedDishes[0].isNew, true);
});

test("computeCompetitorChanges — price change ignored below 5% AND below 2 AED", () => {
  // 32 → 33 = 1 AED delta (3% ratio) → both thresholds fail → no flag.
  const previous = makeWeek([
    { name: "Falafel Wrap", price: 32 },
    { name: "Hummus Plate", price: 24 },
    { name: "Tabbouleh", price: 18 },
    { name: "Mixed Grill", price: 95 },
    { name: "Mint Lemonade", price: 14 },
  ]);
  const current = makeWeek([
    { name: "Falafel Wrap", price: 33 },
    { name: "Hummus Plate", price: 24 },
    { name: "Tabbouleh", price: 18 },
    { name: "Mixed Grill", price: 95 },
    { name: "Mint Lemonade", price: 14 },
  ]);
  const result = computeCompetitorChanges(current, previous);
  assert.equal(result.priceChanges.length, 0);
});

test("computeCompetitorChanges — flags meaningful price moves (>=5% AND >=2 AED)", () => {
  const previous = makeWeek([
    { name: "Falafel Wrap", price: 32 },
    { name: "Hummus Plate", price: 24 },
    { name: "Tabbouleh", price: 18 },
    { name: "Mixed Grill", price: 95 },
    { name: "Mint Lemonade", price: 14 },
  ]);
  const current = makeWeek([
    { name: "Falafel Wrap", price: 36 }, // +12.5%, +4 AED → flag
    { name: "Hummus Plate", price: 24 },
    { name: "Tabbouleh", price: 18 },
    { name: "Mixed Grill", price: 89 }, // -6.3%, -6 AED → flag
    { name: "Mint Lemonade", price: 14 },
  ]);
  const result = computeCompetitorChanges(current, previous);
  assert.equal(result.priceChanges.length, 2);
  const wrapChange = result.priceChanges.find((p) => p.name === "Falafel Wrap")!;
  assert.equal(wrapChange.oldPrice, 32);
  assert.equal(wrapChange.newPrice, 36);
});

test("computeCompetitorChanges — removal diff suppressed when either week is thin", () => {
  // Previous has 5 (minimum threshold met), current has only 2 (paginated
  // scrape probably). Should NOT flag the 3 absent items as removed.
  const previous = makeWeek([
    { name: "Falafel Wrap", price: 32 },
    { name: "Hummus Plate", price: 24 },
    { name: "Tabbouleh", price: 18 },
    { name: "Mixed Grill", price: 95 },
    { name: "Mint Lemonade", price: 14 },
  ]);
  const current = makeWeek([
    { name: "Falafel Wrap", price: 32 },
    { name: "Mint Lemonade", price: 14 },
  ]);
  const result = computeCompetitorChanges(current, previous);
  assert.equal(result.removedDishes.length, 0);
});

test("computeCompetitorChanges — flags removed dishes when both weeks have full menus", () => {
  const previous = makeWeek([
    { name: "Falafel Wrap", price: 32 },
    { name: "Hummus Plate", price: 24 },
    { name: "Tabbouleh", price: 18 },
    { name: "Mixed Grill", price: 95 },
    { name: "Mint Lemonade", price: 14 },
    { name: "Mansaf", price: 110 },
  ]);
  const current = makeWeek([
    { name: "Falafel Wrap", price: 32 },
    { name: "Hummus Plate", price: 24 },
    { name: "Tabbouleh", price: 18 },
    { name: "Mixed Grill", price: 95 },
    { name: "Mint Lemonade", price: 14 },
    // Mansaf gone
  ]);
  const result = computeCompetitorChanges(current, previous);
  assert.equal(result.removedDishes.length, 1);
  assert.equal(result.removedDishes[0].name, "Mansaf");
});

test("computeCompetitorChanges — newPromos keyed by source+title", () => {
  const previous = makeWeek(
    [{ name: "Falafel Wrap", price: 32 }],
    [{ title: "Lunch 25% off", source: "https://a.com/promo1" }]
  );
  const current = makeWeek(
    [{ name: "Falafel Wrap", price: 32 }],
    [
      { title: "Lunch 25% off", source: "https://a.com/promo1" }, // existing, skip
      { title: "Weekend brunch deal", source: "https://b.com/promo2" }, // new
    ]
  );
  const result = computeCompetitorChanges(current, previous);
  assert.equal(result.newPromos.length, 1);
  assert.equal(result.newPromos[0].title, "Weekend brunch deal");
});
