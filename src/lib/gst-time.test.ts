import assert from "node:assert/strict";
import test from "node:test";
import {
  GST_OFFSET_MS,
  addDays,
  startOfMonthGst,
  startOfTodayGst,
  startOfWeekGst,
} from "@/lib/gst-time";

// 2026-07-30 is a Thursday. 01:30 UTC = 05:30 Dubai (same calendar day);
// 22:30 UTC = 02:30 Dubai on the 31st (next calendar day).
test("startOfTodayGst returns Dubai midnight in UTC", () => {
  const morning = startOfTodayGst(new Date("2026-07-30T01:30:00Z"));
  assert.equal(morning.toISOString(), "2026-07-29T20:00:00.000Z");
  const lateNight = startOfTodayGst(new Date("2026-07-30T22:30:00Z"));
  assert.equal(lateNight.toISOString(), "2026-07-30T20:00:00.000Z");
});

test("startOfWeekGst returns the Dubai Monday of the current week", () => {
  // Thursday 2026-07-30 Dubai → Monday 2026-07-27 Dubai midnight
  const d = startOfWeekGst(new Date("2026-07-30T10:00:00Z"));
  assert.equal(d.toISOString(), "2026-07-26T20:00:00.000Z");
  // A Monday early morning Dubai stays on the same Monday
  const mon = startOfWeekGst(new Date("2026-07-26T21:00:00Z")); // 01:00 Dubai Mon
  assert.equal(mon.toISOString(), "2026-07-26T20:00:00.000Z");
});

test("startOfMonthGst returns Dubai 1st-of-month midnight in UTC", () => {
  const d = startOfMonthGst(new Date("2026-07-30T10:00:00Z"));
  assert.equal(d.toISOString(), "2026-06-30T20:00:00.000Z");
});

test("addDays adds whole days", () => {
  assert.equal(
    addDays(new Date("2026-07-29T20:00:00.000Z"), 7).toISOString(),
    "2026-08-05T20:00:00.000Z"
  );
  assert.equal(GST_OFFSET_MS, 4 * 60 * 60 * 1000);
});
