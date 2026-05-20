import { test } from "node:test";
import assert from "node:assert/strict";
import { planDailyBrief } from "./daily-brief";

function snapshotWithOrders() {
  return {
    forDateLocal: "2026-05-18",
    scans: { yesterday: 120, weekdayAvg: 100 },
    revenue: { yesterdayAed: 4820, weekdayAvgAed: 4300 },
    orders: { count: 87 },
    whatsapp: { clicks: 12, cartOrders: 3, pendingReplies24h: 0 },
    topLikedItem: { name: "Hummus Beiruti", likes: 14 },
    topViewedPath: { path: "/karama", views: 80 },
    menuHealth: { itemsMissingImages: 0, itemsMissingDescriptions: 0, dietaryTagCoverage: 0.9 },
    hadTrafficYesterday: true,
  };
}

function snapshotNoOrders() {
  return {
    ...snapshotWithOrders(),
    orders: { count: 0 },
    revenue: { yesterdayAed: 0, weekdayAvgAed: 0 },
  };
}

test("planDailyBrief picks FULL when orders flow has data", () => {
  const plan = planDailyBrief({
    restaurantId: "r1",
    ownerFirstName: "Saleem",
    restaurantName: "Karama",
    locale: "en",
    snapshot: snapshotWithOrders(),
    ordersV1Enabled: true,
    googleRating: 4.6,
    googleReviewCount: 238,
    itemsMissingImages: 0,
    itemsMissingDescriptions: 0,
  });
  assert.ok(plan);
  assert.equal(plan.template.name, "coworker_daily_brief_full");
  assert.match(plan.preview, /Good morning Saleem/);
  assert.match(plan.preview, /AED 4,820/);
  assert.match(plan.preview, /▲12%/); // (4820-4300)/4300 = 12.09%
  assert.match(plan.preview, /87 orders/);
});

test("planDailyBrief picks LITE when orders are disabled", () => {
  const plan = planDailyBrief({
    restaurantId: "r1",
    ownerFirstName: "Saleem",
    restaurantName: "Karama",
    locale: "en",
    snapshot: snapshotWithOrders(),
    ordersV1Enabled: false,
    googleRating: 4.6,
    googleReviewCount: 238,
    itemsMissingImages: 3,
    itemsMissingDescriptions: 0,
  });
  assert.ok(plan);
  assert.equal(plan.template.name, "coworker_daily_brief_lite");
  assert.match(plan.preview, /Google rating 4.6 \(238 reviews\)/);
  assert.match(plan.preview, /3 menu items missing photos/);
});

test("planDailyBrief picks LITE when orders enabled but zero yesterday", () => {
  const plan = planDailyBrief({
    restaurantId: "r1",
    ownerFirstName: "Saleem",
    restaurantName: "Karama",
    locale: "en",
    snapshot: snapshotNoOrders(),
    ordersV1Enabled: true,
    googleRating: null,
    googleReviewCount: null,
    itemsMissingImages: 0,
    itemsMissingDescriptions: 0,
  });
  assert.ok(plan);
  assert.equal(plan.template.name, "coworker_daily_brief_lite");
});

test("Arabic locale renders Arabic body and ▲/▼ deltas correctly", () => {
  const plan = planDailyBrief({
    restaurantId: "r1",
    ownerFirstName: "سليم",
    restaurantName: "كرامة",
    locale: "ar",
    snapshot: snapshotWithOrders(),
    ordersV1Enabled: true,
    googleRating: 4.6,
    googleReviewCount: 238,
    itemsMissingImages: 0,
    itemsMissingDescriptions: 0,
  });
  assert.ok(plan);
  assert.equal(plan.template.locale, "ar");
  assert.match(plan.preview, /صباح الخير سليم/);
  // Western digits intentional (Meta approval reliability)
  assert.match(plan.preview, /4,820 درهم/);
});

test("alert prioritizes unanswered WA conversations", () => {
  const snap = snapshotWithOrders();
  snap.whatsapp.pendingReplies24h = 3;
  const plan = planDailyBrief({
    restaurantId: "r1",
    ownerFirstName: "Saleem",
    restaurantName: "Karama",
    locale: "en",
    snapshot: snap,
    ordersV1Enabled: true,
    googleRating: 4.6,
    googleReviewCount: 238,
    itemsMissingImages: 5,
    itemsMissingDescriptions: 5,
  });
  assert.ok(plan);
  assert.match(plan.preview, /3 WhatsApp convs unanswered > 24h/);
});

test("revenue-down alert fires below 70% of weekday avg", () => {
  const snap = snapshotWithOrders();
  snap.revenue.yesterdayAed = 1500; // <70% of 4300
  const plan = planDailyBrief({
    restaurantId: "r1",
    ownerFirstName: "Saleem",
    restaurantName: "Karama",
    locale: "en",
    snapshot: snap,
    ordersV1Enabled: true,
    googleRating: 4.6,
    googleReviewCount: 238,
    itemsMissingImages: 0,
    itemsMissingDescriptions: 0,
  });
  assert.ok(plan);
  assert.match(plan.preview, /Revenue \d+% below your typical day/);
});

test("no variable contains a literal placeholder", () => {
  const plan = planDailyBrief({
    restaurantId: "r1",
    ownerFirstName: "Saleem",
    restaurantName: "Karama",
    locale: "en",
    snapshot: snapshotWithOrders(),
    ordersV1Enabled: true,
    googleRating: 4.6,
    googleReviewCount: 238,
    itemsMissingImages: 0,
    itemsMissingDescriptions: 0,
  });
  assert.ok(plan);
  assert.doesNotMatch(plan.preview, /\{\{\d+\}\}/);
});
