import assert from "node:assert/strict";
import test from "node:test";
import { computeAvailableSlots, type OperatingHoursConfig } from "./booking-availability";

// Tue 2026-08-04. GST = UTC+4, so 09:00 GST = 05:00 UTC.
const HOURS: OperatingHoursConfig = {
  timezone: "Asia/Dubai",
  schedule: [
    { dayOfWeek: 0, isClosed: true, periods: [] },
    { dayOfWeek: 1, isClosed: false, periods: [{ open: "09:00", close: "12:00" }] },
    { dayOfWeek: 2, isClosed: false, periods: [{ open: "09:00", close: "12:00" }] },
    { dayOfWeek: 3, isClosed: true, periods: [] },
    { dayOfWeek: 4, isClosed: true, periods: [] },
    { dayOfWeek: 5, isClosed: true, periods: [] },
    { dayOfWeek: 6, isClosed: true, periods: [] },
  ],
};
const TUE_9_GST = new Date("2026-08-04T05:00:00.000Z");
const base = {
  hours: HOURS, durationMinutes: 60, granularityMinutes: 30, parallelCapacity: 2,
  existing: [], from: new Date("2026-08-04T00:00:00.000Z"), to: new Date("2026-08-05T00:00:00.000Z"),
  now: new Date("2026-08-03T05:00:00.000Z"), minLeadMinutes: 120,
};

test("emits slots on the granularity grid, last start fits before close", () => {
  const slots = computeAvailableSlots(base);
  assert.equal(slots[0].toISOString(), TUE_9_GST.toISOString());
  // 09:00..11:00 starts inclusive at 30-min steps = 5 slots (11:00+60min = close)
  assert.equal(slots.length, 5);
  assert.equal(slots[4].toISOString(), new Date("2026-08-04T07:00:00.000Z").toISOString());
});

test("closed day yields nothing", () => {
  const slots = computeAvailableSlots({ ...base, from: new Date("2026-08-05T00:00:00.000Z"), to: new Date("2026-08-06T00:00:00.000Z") });
  assert.equal(slots.length, 0);
});

test("capacity 2 blocks a slot only at 2 overlapping bookings", () => {
  const one = computeAvailableSlots({ ...base, existing: [{ slotAt: TUE_9_GST, durationMinutes: 60 }] });
  assert.ok(one.some((s) => s.getTime() === TUE_9_GST.getTime()), "1 overlap still offerable");
  const two = computeAvailableSlots({ ...base, existing: [
    { slotAt: TUE_9_GST, durationMinutes: 60 }, { slotAt: TUE_9_GST, durationMinutes: 60 },
  ] });
  assert.ok(!two.some((s) => s.getTime() === TUE_9_GST.getTime()), "2 overlaps blocks 09:00");
  // 09:30 overlaps both 09:00-10:00 bookings → also blocked; 10:00 is free
  assert.ok(!two.some((s) => s.getTime() === new Date("2026-08-04T05:30:00.000Z").getTime()));
  assert.ok(two.some((s) => s.getTime() === new Date("2026-08-04T06:00:00.000Z").getTime()));
});

test("min lead time hides near slots", () => {
  const slots = computeAvailableSlots({ ...base, now: new Date("2026-08-04T04:30:00.000Z") }); // 08:30 GST
  // 09:00 + lead 120min → first offerable start is 10:30 GST
  assert.equal(slots[0].toISOString(), new Date("2026-08-04T06:30:00.000Z").toISOString());
});
