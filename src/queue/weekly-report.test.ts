import assert from "node:assert/strict";
import test from "node:test";
import { lastCompletedWeekStartIso } from "@/queue/weekly-report";

// Monday 2026-07-06 07:00 GST = 2026-07-06T03:00:00Z. Last completed week began
// Monday 2026-06-29 (covers Mon 06-29 .. Sun 07-05).
test("on a Monday morning, weekStart is the previous Monday", () => {
  const ms = Date.parse("2026-07-06T03:00:00Z");
  assert.equal(lastCompletedWeekStartIso(ms), "2026-06-29");
});

// Sanity: a Wednesday still resolves to the previous completed week's Monday.
test("mid-week resolves to the previous completed week's Monday", () => {
  const ms = Date.parse("2026-07-08T03:00:00Z"); // Wed 2026-07-08
  assert.equal(lastCompletedWeekStartIso(ms), "2026-06-29");
});
