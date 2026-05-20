// Event-driven auto-staging for Ad Studio.
//
// The pure planning layer. Given today's date + a restaurant's country, returns
// which calendar moments should have a draft AdProject staged right now. The
// cron worker (queue/event-stager.ts) consumes this and writes the rows.
//
// Why a separate pure module: testability + reuse. Both the cron and the
// manual admin endpoint hit the same function so the staging logic is one
// source of truth.

import type { CalendarMoment, CountryCode } from "./types";
import { calendarMoments } from "./calendar";

/** Lead-time per moment kind. Drives when we stage the draft.
 *
 *  Tuned to match the prep window in the existing calendar-nudge UI so the
 *  owner sees the "act now" chip and the email arrive on the same day —
 *  Ramadan/Eid need 6 weeks because vendors, menu printing, and Meta learning
 *  all stack up; national days need ~3 weeks; weather/seasonal needs a month
 *  to budget the spend pivot. */
export const PREP_LEAD_DAYS_BY_KIND: Record<string, number> = {
  religious_lunar: 42,
  national_day: 21,
  shopping_festival: 21,
  cultural_global: 14,
  food_focused: 14,
  tourism_event: 14,
  weather_seasonal: 30,
  religious_fixed: 14,
};

/** A single planned staging — one (moment, year-specific occurrence) tuple
 *  that should have a draft AdProject for this restaurant if it doesn't yet.
 *  The cron worker turns this into a Prisma upsert. */
export interface PlannedStaging {
  moment: CalendarMoment;
  year: number;
  fromDate: Date;
  toDate: Date;
  prepDeadline: Date;
  daysOut: number;
  prepLeadDays: number;
}

/** Given the current date + a restaurant's country, return every staging
 *  target that's inside its prep lead window. The cron runs this daily;
 *  idempotency on the DB side (unique key on restaurant_id + moment_id + year)
 *  keeps re-staging cheap. */
export function planStagingsForCountry(args: {
  country: CountryCode;
  now: Date;
}): PlannedStaging[] {
  const { country, now } = args;
  const nowMs = now.getTime();
  const out: PlannedStaging[] = [];

  for (const moment of calendarMoments) {
    if (!moment.countries.includes(country)) continue;
    const prepLead = PREP_LEAD_DAYS_BY_KIND[moment.kind] ?? 21;

    for (const occ of moment.dates) {
      const fromDate = new Date(occ.from);
      const toDate = new Date(occ.to);
      // Skip past occurrences entirely — no point staging a draft for last
      // year's Ramadan.
      if (toDate.getTime() < nowMs) continue;
      const daysOut = Math.ceil((fromDate.getTime() - nowMs) / (1000 * 60 * 60 * 24));

      // Stage only when we're inside the prep window. The +14d tail catches
      // a moment that's already started — the owner still has runway to push
      // mid-event creative (e.g., last-week-of-Ramadan Eid pivot).
      if (daysOut > prepLead || daysOut < -14) continue;

      const prepDeadline = new Date(fromDate.getTime() - prepLead * 24 * 60 * 60 * 1000);
      out.push({
        moment,
        year: occ.year,
        fromDate,
        toDate,
        prepDeadline,
        daysOut,
        prepLeadDays: prepLead,
      });
    }
  }

  return out.sort((a, b) => a.fromDate.getTime() - b.fromDate.getTime());
}

/** Best-effort country inference from a restaurant's location string. Mirrors
 *  the frontend helper in lib/ad-studio-country.ts; kept duplicate (small)
 *  rather than wired through an API call since the cron runs server-side. */
export function inferCountryFromLocation(location: string | null | undefined): CountryCode {
  const loc = (location ?? "").toLowerCase();
  if (loc.includes("saudi") || loc.includes("riyadh") || loc.includes("jeddah") || loc.includes("ksa")) return "SA";
  if (loc.includes("qatar") || loc.includes("doha")) return "QA";
  if (loc.includes("kuwait")) return "KW";
  if (loc.includes("bahrain") || loc.includes("manama")) return "BH";
  if (loc.includes("oman") || loc.includes("muscat")) return "OM";
  if (loc.includes("egypt") || loc.includes("cairo")) return "EG";
  if (loc.includes("jordan") || loc.includes("amman")) return "JO";
  if (loc.includes("lebanon") || loc.includes("beirut")) return "LB";
  return "AE";
}

// =============================================================================
// Brief seeding — translates a moment into AdProject fields
// =============================================================================

/** Map a calendar moment to the KB campaign type that best fits it.
 *  Mirrors the frontend pickCampaignTypeForMoment so a manually-drafted
 *  campaign (clicking "Draft this campaign" on the calendar page) and an
 *  auto-staged campaign land on the same campaign type. */
export function pickCampaignTypeForMoment(moment: CalendarMoment): string {
  if (moment.id === "ramadan") return "iftar_fill_house";
  if (moment.id.startsWith("eid_")) return "weekend_brunch_hero";
  if (moment.kind === "shopping_festival") return "lto_menu_drop";
  if (moment.kind === "food_focused") return "lto_menu_drop";
  if (moment.kind === "weather_seasonal") return "weather_trigger_delivery";
  if (moment.kind === "tourism_event") return "premium_brand_defense";
  if (moment.kind === "national_day") return "lto_menu_drop";
  if (moment.kind === "cultural_global") return "weekend_brunch_hero";
  return "lto_menu_drop";
}

export function buildBrandVoiceFromMoment(moment: CalendarMoment): string {
  const angle = moment.creativeAngles[0];
  const dos = moment.doList.slice(0, 2).join("; ");
  const donts = moment.doNotList.slice(0, 2).join("; ");
  const parts: string[] = [];
  if (angle) parts.push(`Lead angle: ${angle}.`);
  if (dos) parts.push(`Do: ${dos}.`);
  if (donts) parts.push(`Avoid: ${donts}.`);
  return parts.join(" ").slice(0, 480);
}

export function pickGoalForMoment(moment: CalendarMoment): "tofu" | "mofu" | "bofu" | "retention" {
  // Burst/peak moments are conversion-driving (you need bookings NOW).
  // Build-up moments are mid-funnel — generate consideration ahead of peak.
  // Always-on (summer slump) leans retention since you're working existing demand.
  if (moment.spendPulse === "always_on") return "retention";
  if (moment.spendPulse === "build_up") return "mofu";
  return "bofu";
}
