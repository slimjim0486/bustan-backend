import assert from "node:assert/strict";
import test from "node:test";
import {
  GST_OFFSET_MS,
  addDays,
  startOfMonthGst,
  startOfNextMonthGst,
  startOfTodayGst,
  startOfWeekGst,
  toGstDateString,
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

test("startOfNextMonthGst returns Dubai 1st-of-next-month midnight in UTC", () => {
  const d = startOfNextMonthGst(new Date("2026-07-30T10:00:00Z"));
  assert.equal(d.toISOString(), "2026-07-31T20:00:00.000Z");
});

test("startOfNextMonthGst rolls over the December to January year boundary", () => {
  const d = startOfNextMonthGst(new Date("2026-12-15T10:00:00Z"));
  assert.equal(d.toISOString(), "2026-12-31T20:00:00.000Z");
});

test("addDays adds whole days", () => {
  assert.equal(
    addDays(new Date("2026-07-29T20:00:00.000Z"), 7).toISOString(),
    "2026-08-05T20:00:00.000Z"
  );
  assert.equal(GST_OFFSET_MS, 4 * 60 * 60 * 1000);
});

// Regression: a plain `.toISOString().slice(0, 10)` on a GST-midnight Date
// (the output of startOfTodayGst et al.) reports the PREVIOUS calendar day,
// because that instant is 20:00 UTC the day before Dubai midnight.
test("toGstDateString reports the correct Dubai calendar date at a GST-midnight boundary", () => {
  const todayStart = startOfTodayGst(new Date("2026-07-30T01:30:00Z"));
  assert.equal(todayStart.toISOString().slice(0, 10), "2026-07-29"); // the trap
  assert.equal(toGstDateString(todayStart), "2026-07-30"); // the fix
});

test("toGstDateString matches the naive slice away from midnight boundaries", () => {
  assert.equal(toGstDateString(new Date("2026-07-30T10:00:00Z")), "2026-07-30");
});
