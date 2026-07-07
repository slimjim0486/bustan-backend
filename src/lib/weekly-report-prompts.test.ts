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
