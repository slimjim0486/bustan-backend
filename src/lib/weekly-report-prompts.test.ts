import assert from "node:assert/strict";
import test from "node:test";
import { computeWeeklyTiles, weeklyDeltaPct } from "@/lib/owner-chat-prompts";

test("weeklyDeltaPct returns rounded integer percent", () => {
  assert.equal(weeklyDeltaPct(112, 100), 12);
  assert.equal(weeklyDeltaPct(96, 100), -4);
});

test("weeklyDeltaPct returns null when last week is a zero baseline", () => {
  assert.equal(weeklyDeltaPct(50, 0), null);
  assert.equal(weeklyDeltaPct(0, 0), null);
});

test("computeWeeklyTiles builds four tiles with direction", () => {
  const tiles = computeWeeklyTiles({
    scans: { thisWeek: 1240, lastWeek: 1100 },
    revenueAed: { thisWeek: 8400, lastWeek: 8400 },
    orders: { thisWeek: 88, lastWeek: 92 },
    whatsappClicks: { thisWeek: 30, lastWeek: 0 },
  });
  assert.deepEqual(
    tiles.map((t) => [t.key, t.value, t.deltaPct, t.direction]),
    [
      ["scans", 1240, 13, "up"],
      ["revenue", 8400, 0, "flat"],
      ["orders", 88, -4, "down"],
      ["whatsapp", 30, null, "up"],
    ]
  );
});

import {
  buildEventNudgePrompt,
  buildWeeklyReportPrompt,
  parseEventNudgeResponse,
  parseWeeklyReportResponse,
  type EventNudgeSnapshot,
  type WeeklyReportSnapshot,
} from "@/lib/owner-chat-prompts";

const SNAP: WeeklyReportSnapshot = {
  weekStartLocal: "2026-06-29",
  weekEndLocal: "2026-07-05",
  restaurantName: "Zaytoun",
  tiles: [
    { key: "scans", label: "Scans", value: 1240, deltaPct: 12, direction: "up" },
    { key: "revenue", label: "Revenue", value: 8400, deltaPct: 6, direction: "up" },
    { key: "orders", label: "Orders", value: 88, deltaPct: -4, direction: "down" },
    { key: "whatsapp", label: "WhatsApp", value: 30, deltaPct: null, direction: "up" },
  ],
  topLikedItem: { name: "Lamb Ouzi", likes: 48 },
  topViewedPath: { path: "/menu", views: 900 },
  pendingReplies: 4,
  menuHealth: { itemsMissingImages: 6, itemsMissingDescriptions: 2 },
  hadTraffic: true,
};

test("buildWeeklyReportPrompt embeds the restaurant, JSON snapshot, and demands JSON out", () => {
  const prompt = buildWeeklyReportPrompt(SNAP, []);
  assert.match(prompt, /Zaytoun/);
  assert.match(prompt, /"weekStartLocal": "2026-06-29"/);
  assert.match(prompt, /narrative/);
  assert.match(prompt, /actions/);
});

test("parseWeeklyReportResponse parses narrative + actions and clamps to 3", () => {
  const raw = JSON.stringify({
    narrative: "Strong week — footfall up, Tuesdays quiet.",
    actions: [
      { label: "Run a Tuesday promo", seedPrompt: "Create a Tuesday lunch promo", kind: "promo" },
      { label: "Add 6 photos", seedPrompt: "Add photos to the 6 dishes missing them", kind: "menu" },
      { label: "Clear inbox", seedPrompt: "Help me reply to the 4 unread WhatsApp chats", kind: "inbox" },
      { label: "Fourth", seedPrompt: "extra", kind: "ads" },
    ],
  });
  const parsed = parseWeeklyReportResponse(raw);
  assert.ok(parsed);
  assert.equal(parsed?.actions.length, 3);
  assert.equal(parsed?.narrative, "Strong week — footfall up, Tuesdays quiet.");
});

test("parseWeeklyReportResponse drops actions with an invalid kind", () => {
  const raw = JSON.stringify({
    narrative: "ok",
    actions: [
      { label: "bad", seedPrompt: "x", kind: "nonsense" },
      { label: "good", seedPrompt: "y", kind: "promo" },
    ],
  });
  const parsed = parseWeeklyReportResponse(raw);
  assert.equal(parsed?.actions.length, 1);
  assert.equal(parsed?.actions[0].kind, "promo");
});

test("parseWeeklyReportResponse tolerates a fenced code block and returns null on garbage", () => {
  const fenced = "```json\n" + JSON.stringify({ narrative: "hi", actions: [] }) + "\n```";
  assert.equal(parseWeeklyReportResponse(fenced)?.narrative, "hi");
  assert.equal(parseWeeklyReportResponse("not json at all"), null);
});

const NUDGE_SNAP: EventNudgeSnapshot = {
  restaurantName: "Zaytoun",
  adProjectId: "ad_123",
  moment: {
    id: "uae_national_day",
    name: "UAE National Day",
    kind: "national_day",
    year: 2026,
    from: "2026-12-02",
    to: "2026-12-03",
    daysOut: 21,
    spendPulse: "burst",
    creativeAngles: ["Limited-edition Emirati-fusion dish"],
    doList: ["Arabic-first copy"],
    doNotList: ["Generic flag spam"],
  },
};

test("buildEventNudgePrompt grounds the nudge in the staged campaign and calendar facts", () => {
  const prompt = buildEventNudgePrompt(NUDGE_SNAP, []);
  assert.match(prompt, /PROACTIVE EVENT NUDGE/);
  assert.match(prompt, /UAE National Day/);
  assert.match(prompt, /ad_123/);
  assert.match(prompt, /already-staged campaign/);
});

test("parseEventNudgeResponse requires at least one valid clamped action", () => {
  const raw = JSON.stringify({
    narrative: "National Day is coming up, and I have the brief ready.",
    actions: [
      { label: "Build campaign", seedPrompt: "Build out the National Day campaign you drafted", kind: "ads" },
      { label: "Bad", seedPrompt: "Do a weird thing", kind: "calendar" },
      { label: "Menu prep", seedPrompt: "Suggest a National Day menu special", kind: "menu" },
      { label: "Inbox", seedPrompt: "Draft replies for National Day enquiries", kind: "inbox" },
      { label: "Extra", seedPrompt: "extra", kind: "promo" },
    ],
  });
  const parsed = parseEventNudgeResponse(raw);
  assert.ok(parsed);
  assert.equal(parsed?.actions.length, 3);
  assert.deepEqual(parsed?.actions.map((a) => a.kind), ["ads", "menu", "inbox"]);
  assert.equal(parseEventNudgeResponse(JSON.stringify({ narrative: "hi", actions: [] })), null);
});
