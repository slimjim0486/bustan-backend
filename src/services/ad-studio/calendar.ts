import type { CalendarMoment } from "./types";

// =============================================================================
// MENA RESTAURANT MARKETING CALENDAR — 2026 / early 2027
// =============================================================================
// Lunar dates (Ramadan, Eid) shift ~10-11 days earlier each year. Re-verify
// before Q4 2026 for 2027 confirmations.

export const calendarMoments: CalendarMoment[] = [
  {
    id: "ramadan",
    name: "Ramadan",
    kind: "religious_lunar",
    dates: [
      { year: 2026, from: "2026-02-18", to: "2026-03-18", notes: "First fast Wed Feb 18, 2026" },
      { year: 2027, from: "2027-02-07", to: "2027-03-08", notes: "Approximate — confirm closer to date" },
    ],
    countries: ["AE", "SA", "QA", "KW", "BH", "OM", "EG", "JO", "LB"],
    spendPulse: "build_up",
    creativeAngles: [
      "Iftar countdown to Maghrib",
      "Family table reveal",
      "Suhoor late-night menu (10pm-3am)",
      "Charity Iftar partnerships (Beit Al Khair / Ehsan / Tarahum / 1 Billion Meals)",
      "Pre-Ramadan early-bird booking",
      "Last-week Eid pivot",
    ],
    doList: [
      "Family-table imagery (multi-generational)",
      "Crescent moon, lantern (fanous), dates, laban",
      "Modesty norms in human imagery",
      "Reserved tone during Laylat al-Qadr (last 10 nights)",
    ],
    doNotList: [
      "Daytime food shots that imply eating during fasting hours",
      "Chewing on camera",
      "Loud club music",
      "Mixed-gender close physical contact",
      "Alcohol references entirely",
      "Solo-Iftar individual close-up at table",
    ],
    channelMixHint: { meta: 45, whatsapp: 25, tiktok: 20, snapchat: 10 },
    budgetMultiplierVsBaseline: 1.3,
  },
  {
    id: "eid_al_fitr",
    name: "Eid al-Fitr",
    kind: "religious_lunar",
    dates: [
      { year: 2026, from: "2026-03-19", to: "2026-03-22", notes: "UAE 4-day weekend; KSA 1 Shawwal Mar 20" },
      { year: 2027, from: "2027-03-09", to: "2027-03-12", notes: "Approximate" },
    ],
    countries: ["AE", "SA", "QA", "KW", "BH", "OM", "EG", "JO", "LB"],
    spendPulse: "peak",
    creativeAngles: [
      "Family-of-6+ lunch sets",
      "Eidiya (kids gifts) angle",
      "Henna and majlis aesthetic",
      "Eid mubarak greetings",
      "Brunch sets",
    ],
    doList: ["Family imagery", "Multi-generational tables", "Kids menu highlight"],
    doNotList: ["Pure couples/romance angles (use family)"],
    budgetMultiplierVsBaseline: 1.3,
  },
  {
    id: "eid_al_adha",
    name: "Eid al-Adha",
    kind: "religious_lunar",
    dates: [
      { year: 2026, from: "2026-05-26", to: "2026-05-29", notes: "Arafah Tue May 26; UAE Wed-Fri" },
      { year: 2027, from: "2027-05-16", to: "2027-05-19", notes: "Approximate" },
    ],
    countries: ["AE", "SA", "QA", "KW", "BH", "OM", "EG", "JO", "LB"],
    spendPulse: "peak",
    creativeAngles: [
      "Lamb hero (mansaf in Jordan, kabsa in KSA, ouzi in UAE)",
      "Slow-roasted meat",
      "Multi-generational table",
      "Tone: generosity, hospitality",
    ],
    doList: ["Lamb / sacrificial cuisine framing", "Family hospitality"],
    doNotList: ["Discount-led framing (signals decline)"],
    budgetMultiplierVsBaseline: 1.2,
  },
  {
    id: "saudi_founding_day",
    name: "Saudi Founding Day",
    kind: "national_day",
    dates: [
      { year: 2026, from: "2026-02-22", to: "2026-02-22", notes: "Sunday → 3-day weekend" },
      { year: 2027, from: "2027-02-22", to: "2027-02-22" },
    ],
    countries: ["SA"],
    spendPulse: "burst",
    creativeAngles: [
      "Najdi/historical aesthetic",
      "Muted earth palette (sand, terracotta, deep brown)",
      "Traditional dishes (Jareesh = state dish)",
      "Heritage script / mud-brick walls",
    ],
    doList: ["Najdi heritage", "Earth palette", "Traditional dishes"],
    doNotList: ["Saudi green flag-forward (save for National Day)", "Modern Vision-2030 imagery (different from National Day vibe)"],
    channelMixHint: { snapchat: 50, meta: 30, tiktok: 20 },
    budgetMultiplierVsBaseline: 1.2,
  },
  {
    id: "saudi_national_day",
    name: "Saudi National Day",
    kind: "national_day",
    dates: [
      { year: 2026, from: "2026-09-23", to: "2026-09-23" },
      { year: 2027, from: "2027-09-23", to: "2027-09-23" },
    ],
    countries: ["SA"],
    spendPulse: "burst",
    creativeAngles: [
      "Saudi green flag everywhere",
      "Modern Vision-2030 future-facing",
      "Riyadh Season tie-ins",
      "Bold patriotic",
    ],
    doList: ["Saudi green palette", "Vision-2030 modern aesthetic", "National pride"],
    doNotList: ["Misuse of flag (no cropping/distortion/overlay on food)", '"National Day Sale!" framing (disrespectful)', "Skip Arabic"],
    channelMixHint: { snapchat: 60, meta: 25, tiktok: 15 },
    budgetMultiplierVsBaseline: 1.3,
  },
  {
    id: "uae_national_day",
    name: "UAE National Day (Eid Al Etihad)",
    kind: "national_day",
    dates: [
      { year: 2026, from: "2026-12-01", to: "2026-12-04", notes: "Multi-day promo Dec 1-4 typical" },
    ],
    countries: ["AE"],
    spendPulse: "burst",
    creativeAngles: [
      "Falcon, oryx, palm tree, dhow",
      "UAE flag (red/green/white/black) tasteful",
      "AED 54 / 55 menu items (anniversary pricing)",
      "Emirati dishes (luqaimat, machboos, balaleet, harees)",
      "Arabic coffee + dates as gifting",
      "Live oud, Al-Ayyala stick-dance",
    ],
    doList: ["Limited-edition Emirati-fusion dish", "Arabic-first copy with English secondary", "UAE flag motif tastefully integrated"],
    doNotList: ["Misuse the flag", '"National Day Sale!" framing', "Sheikh portraits unless licensed/respectful"],
    budgetMultiplierVsBaseline: 1.3,
  },
  {
    id: "qatar_national_day",
    name: "Qatar National Day",
    kind: "national_day",
    dates: [
      { year: 2026, from: "2026-12-18", to: "2026-12-20", notes: "3-day weekend" },
    ],
    countries: ["QA"],
    spendPulse: "burst",
    creativeAngles: ["Maroon/white palette", "Al Bidda/Corniche imagery", "Family majlis tone"],
    doList: ["Maroon palette", "Family majlis"],
    doNotList: [],
    budgetMultiplierVsBaseline: 1.2,
  },
  {
    id: "kuwait_national_liberation_day",
    name: "Kuwait National Day + Liberation Day",
    kind: "national_day",
    dates: [
      { year: 2026, from: "2026-02-25", to: "2026-02-26" },
    ],
    countries: ["KW"],
    spendPulse: "burst",
    creativeAngles: ["National colors", "Diwaniya hosting angle"],
    doList: ["Diwaniya"],
    doNotList: [],
    budgetMultiplierVsBaseline: 1.2,
  },
  {
    id: "bahrain_national_day",
    name: "Bahrain National Day",
    kind: "national_day",
    dates: [{ year: 2026, from: "2026-12-16", to: "2026-12-17", notes: "4-day weekend with surrounding days" }],
    countries: ["BH"],
    spendPulse: "burst",
    creativeAngles: ["Lower-key but 4-day weekend = restaurant gold"],
    doList: [],
    doNotList: [],
    budgetMultiplierVsBaseline: 1.2,
  },
  {
    id: "oman_national_day",
    name: "Oman National Day",
    kind: "national_day",
    dates: [{ year: 2026, from: "2026-11-18", to: "2026-11-21", notes: "4-day weekend" }],
    countries: ["OM"],
    spendPulse: "burst",
    creativeAngles: ["Khanjar, frankincense, Omani halwa imagery", "Sultan Haitham respectful imagery"],
    doList: [],
    doNotList: ["Disrespectful framing of late Sultan Qaboos"],
    budgetMultiplierVsBaseline: 1.2,
  },
  {
    id: "mena_mothers_day",
    name: "Mother's Day MENA",
    kind: "cultural_global",
    dates: [
      { year: 2026, from: "2026-03-21", to: "2026-03-21", notes: "FIXED date — NOT US May date! Fell during Ramadan in 2026; pivot to Eid brunch" },
      { year: 2027, from: "2027-03-21", to: "2027-03-21" },
    ],
    countries: ["AE", "SA", "QA", "KW", "BH", "OM", "EG", "JO", "LB"],
    spendPulse: "burst",
    creativeAngles: ["Family brunch", "Jewelry/flowers tie-ins", "Multi-generational tables"],
    doList: ["Lock to March 21 across MENA"],
    doNotList: ["Use US 2nd-Sunday-of-May date — most-misfired by Western AI tools"],
    budgetMultiplierVsBaseline: 1.2,
  },
  {
    id: "valentines_day",
    name: "Valentine's Day",
    kind: "cultural_global",
    dates: [
      { year: 2026, from: "2026-02-14", to: "2026-02-14" },
      { year: 2027, from: "2027-02-14", to: "2027-02-14" },
    ],
    countries: ["AE", "SA", "QA", "KW", "BH", "OM", "EG", "JO", "LB"],
    spendPulse: "burst",
    creativeAngles: [
      "Romance angle (UAE/Lebanon/Egypt)",
      "Couples sets, 'table for 2'",
      "'Lavish Valentine's' (KSA — increasingly tolerated post-Vision 2030)",
    ],
    doList: ["Couples imagery (UAE/Lebanon/Egypt fully OK)", "Soft framing for KSA: 'romantic dinner', 'love language'"],
    doNotList: [
      "Imply unmarried mixed seating in KSA",
      "Public hearts/balloons in mall ads in Kuwait/Qatar/Bahrain/Oman",
      "Embracing imagery in KSA",
    ],
    budgetMultiplierVsBaseline: 1.2,
  },
  {
    id: "dubai_shopping_festival",
    name: "Dubai Shopping Festival (DSF)",
    kind: "shopping_festival",
    dates: [
      { year: 2026, from: "2026-12-15", to: "2027-01-29", notes: "31st edition" },
    ],
    countries: ["AE"],
    spendPulse: "build_up",
    creativeAngles: [
      "'Post-shopping bite' / 'DSF dinner break'",
      "Target 5km around Dubai Mall, MoE, City Walk, BurJuman, Festival City",
      "AED 99 mall-shopper menu",
    ],
    doList: ["Day-part 6pm-11pm peak", "Feature in DSF official directory"],
    doNotList: [],
    channelMixHint: { meta: 60, google: 25, tiktok: 15 },
    budgetMultiplierVsBaseline: 1.4,
  },
  {
    id: "summer_slump_uae_ksa",
    name: "Summer Slump (UAE/KSA/GCC)",
    kind: "weather_seasonal",
    dates: [
      { year: 2026, from: "2026-06-01", to: "2026-08-31", notes: "Outdoor temps 45°C+; patios dead; delivery surges" },
      { year: 2027, from: "2027-06-01", to: "2027-08-31" },
    ],
    countries: ["AE", "SA", "QA", "KW", "BH", "OM"],
    spendPulse: "always_on",
    creativeAngles: [
      "'Cool down' hero — gazpacho, ceviche, ice cream, cold mezze",
      "AC interior shots / indoor-tent terrace",
      "Family bundle delivery",
      "Dubai Summer Surprises (DSS) tie-ins",
      "Summer Restaurant Week (mid-Jul to mid-Aug)",
    ],
    doList: ["Indoor / cool / pool / brunch creative", "Delivery push 1-3pm and 7-10pm"],
    doNotList: ["Outdoor patio imagery", "Heavy meal imagery"],
    budgetMultiplierVsBaseline: 0.9, // Net: dine-in down, delivery up
  },
  {
    id: "f1_abu_dhabi",
    name: "F1 Abu Dhabi",
    kind: "tourism_event",
    dates: [{ year: 2026, from: "2026-12-03", to: "2026-12-06" }],
    countries: ["AE"],
    spendPulse: "burst",
    creativeAngles: ["Yas Island / Saadiyat / Corniche premium dining", "200%+ booking lifts in nearby zones"],
    doList: [],
    doNotList: [],
    budgetMultiplierVsBaseline: 1.3,
  },
  {
    id: "gitex_global",
    name: "GITEX Global",
    kind: "tourism_event",
    dates: [{ year: 2026, from: "2026-12-07", to: "2026-12-11", notes: "Now at Expo City Dubai" }],
    countries: ["AE"],
    spendPulse: "burst",
    creativeAngles: ["Business-traveller traffic in Dubai South / DIFC / Business Bay", "Group-booking creative for tech teams"],
    doList: [],
    doNotList: [],
    budgetMultiplierVsBaseline: 1.2,
  },
  {
    id: "back_to_school",
    name: "Back to School",
    kind: "weather_seasonal",
    dates: [
      { year: 2026, from: "2026-09-01", to: "2026-09-30", notes: "KSA school year starts late Aug" },
    ],
    countries: ["AE", "SA", "QA", "KW", "BH", "OM"],
    spendPulse: "build_up",
    creativeAngles: ["Family-chain promos", "Kids' meal upsell", "Family meal kits", "Weeknight dinners"],
    doList: ["Family / kids angles"],
    doNotList: [],
  },
  {
    id: "dubai_restaurant_week",
    name: "Dubai Restaurant Week",
    kind: "food_focused",
    dates: [{ year: 2026, from: "2026-05-01", to: "2026-05-17", notes: "125+ restaurants" }],
    countries: ["AE"],
    spendPulse: "burst",
    creativeAngles: ["Set menu offers", "Critic-picks framing"],
    doList: [],
    doNotList: [],
    budgetMultiplierVsBaseline: 1.2,
  },
  {
    id: "pink_october",
    name: "Pink October (Breast Cancer Awareness)",
    kind: "cultural_global",
    dates: [{ year: 2026, from: "2026-10-01", to: "2026-10-31" }],
    countries: ["AE", "SA"],
    spendPulse: "always_on",
    creativeAngles: ["Pink-themed dish with proceeds donation", "Prevention/community focus"],
    doList: ["Donation tie-in", "Prevention messaging"],
    doNotList: ["Female body imagery", "Trivial pink-washing"],
  },
];

// =============================================================================
// CALENDAR HELPER
// =============================================================================

export function getMomentsForCountry(country: string, fromIso: string, toIso: string): CalendarMoment[] {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  return calendarMoments.filter((moment) => {
    if (!moment.countries.includes(country as never)) return false;
    return moment.dates.some((d) => {
      const start = new Date(d.from);
      const end = new Date(d.to);
      return start <= to && end >= from;
    });
  });
}

export function getNextMomentForCountry(country: string, afterIso: string): CalendarMoment | null {
  const after = new Date(afterIso);
  let next: { moment: CalendarMoment; from: Date } | null = null;
  for (const moment of calendarMoments) {
    if (!moment.countries.includes(country as never)) continue;
    for (const d of moment.dates) {
      const start = new Date(d.from);
      if (start >= after) {
        if (!next || start < next.from) next = { moment, from: start };
      }
    }
  }
  return next?.moment ?? null;
}

export function getMomentById(momentId: string): CalendarMoment | null {
  return calendarMoments.find((m) => m.id === momentId) ?? null;
}

// Resolves the next-upcoming occurrence of a calendar moment. Returns the
// active occurrence if today falls inside one of the date ranges (so an
// owner promoting Mansaf mid-Eid still gets the current Eid window), else
// the next future occurrence. Used by Sous Chef when an owner asks to tie
// a promo to a named event without supplying explicit dates.
export function resolveUpcomingMomentOccurrence(
  momentId: string,
  fromIso: string
): { moment: CalendarMoment; year: number; from: string; to: string; notes?: string } | null {
  const moment = getMomentById(momentId);
  if (!moment) return null;

  const reference = new Date(fromIso);
  const sorted = [...moment.dates].sort((a, b) => (a.from < b.from ? -1 : 1));

  const active = sorted.find((d) => new Date(d.from) <= reference && new Date(d.to) >= reference);
  if (active) {
    return { moment, year: active.year, from: active.from, to: active.to, notes: active.notes };
  }

  const future = sorted.find((d) => new Date(d.from) >= reference);
  if (future) {
    return { moment, year: future.year, from: future.from, to: future.to, notes: future.notes };
  }

  return null;
}
