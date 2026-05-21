// Compute week-over-week changes for one competitor.
//
// The diff is what makes a snapshot useful in the Sous Chef Inbox — owners
// don't want a static dump of "here's what your competitor sells," they
// want to know what CHANGED. We compute changes at write time (cheap join
// on placeId for the prior week) so readers don't have to.
//
// Heuristics intentionally simple in v1:
//   • addedDishes:    items in this week's menu whose name doesn't appear
//                     in last week's menu (case-insensitive substring).
//   • removedDishes:  inverse — last-week items missing this week. ONLY
//                     computed when both weeks fetched enough items
//                     (>= MIN_MENU_FOR_REMOVAL_DIFF). Otherwise a partial
//                     scrape (e.g. competitor site paginated, Exa returned
//                     a different page this week) would false-positive
//                     every "removed" item.
//   • priceChanges:   item present both weeks with price delta of at
//                     least 5% AND at least 2 AED. Small absolute
//                     differences on low-priced items (a 1 AED jiggle on
//                     a 12 AED side) are noise; 5% catches meaningful
//                     repricing on every range.
//   • newPromos:      promos whose URL or title weren't in last week.
//
// We don't try to be clever about fuzzy matching ("Truffle Wrap" vs
// "Truffle Falafel Wrap") yet. That's a Phase 3 task and needs an LLM.

/** Minimum items in BOTH weeks before we trust removal diffs. Below this,
 *  the dataset is too thin to distinguish "removed" from "didn't scrape." */
const MIN_MENU_FOR_REMOVAL_DIFF = 5;
const PRICE_CHANGE_MIN_DELTA_AED = 2;
const PRICE_CHANGE_MIN_RATIO = 0.05;

import type {
  CompetitorChanges,
  MenuItemSignal,
  PromoSignal,
} from "./types";

function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

interface PreviousSnapshot {
  menuItems: MenuItemSignal[];
  promotions: PromoSignal[];
}

export function computeCompetitorChanges(
  current: PreviousSnapshot,
  previous: PreviousSnapshot | null
): CompetitorChanges {
  const empty: CompetitorChanges = {
    addedDishes: [],
    removedDishes: [],
    priceChanges: [],
    newPromos: [],
  };

  if (!previous) {
    // First snapshot for this competitor — everything is "new" but flagging
    // it that way would spam owners. Return empty changes; the diff only
    // becomes meaningful from week 2 onward.
    return empty;
  }

  const prevMenuByName = new Map<string, MenuItemSignal>();
  for (const item of previous.menuItems) {
    prevMenuByName.set(normName(item.name), item);
  }

  const currMenuByName = new Map<string, MenuItemSignal>();
  for (const item of current.menuItems) {
    currMenuByName.set(normName(item.name), item);
  }

  const addedDishes: MenuItemSignal[] = [];
  const priceChanges: CompetitorChanges["priceChanges"] = [];
  for (const [name, item] of currMenuByName) {
    const prior = prevMenuByName.get(name);
    if (!prior) {
      addedDishes.push({ ...item, isNew: true });
      continue;
    }
    if (prior.price !== null && item.price !== null) {
      const delta = Math.abs(prior.price - item.price);
      const ratio = prior.price > 0 ? delta / prior.price : 0;
      if (delta >= PRICE_CHANGE_MIN_DELTA_AED && ratio >= PRICE_CHANGE_MIN_RATIO) {
        priceChanges.push({
          name: item.name,
          oldPrice: prior.price,
          newPrice: item.price,
        });
      }
    }
  }

  // Only compute removals when both weeks had a reasonably full menu pull.
  // Otherwise a paginated scrape returning a different page would flag the
  // entire previous page as "removed" — pure noise.
  const removedDishes: { name: string }[] = [];
  const bothWeeksFullEnough =
    previous.menuItems.length >= MIN_MENU_FOR_REMOVAL_DIFF &&
    current.menuItems.length >= MIN_MENU_FOR_REMOVAL_DIFF;
  if (bothWeeksFullEnough) {
    for (const [name, item] of prevMenuByName) {
      if (!currMenuByName.has(name)) {
        removedDishes.push({ name: item.name });
      }
    }
  }

  const prevPromoKeys = new Set(
    previous.promotions.map((p) => `${p.source ?? ""}|${normName(p.title)}`)
  );
  const newPromos = current.promotions.filter(
    (p) => !prevPromoKeys.has(`${p.source ?? ""}|${normName(p.title)}`)
  );

  return {
    addedDishes: addedDishes.slice(0, 10),
    removedDishes: removedDishes.slice(0, 10),
    priceChanges: priceChanges.slice(0, 10),
    newPromos: newPromos.slice(0, 5),
  };
}
