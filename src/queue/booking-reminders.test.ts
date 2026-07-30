import assert from "node:assert/strict";
import test from "node:test";
import { computeReminderSchedule } from "./booking-reminders";

const slot = new Date("2026-08-06T14:00:00.000Z"); // Thu 6pm GST
test("both reminders when >24h out", () => {
  const s = computeReminderSchedule(slot, new Date("2026-08-04T10:00:00.000Z"));
  assert.deepEqual(s.map((x) => x.kind), ["T24H", "T2H"]);
  assert.equal(s[0].at.toISOString(), "2026-08-05T14:00:00.000Z");
  assert.equal(s[1].at.toISOString(), "2026-08-06T12:00:00.000Z");
});
test("inside 24h → only T2H; inside 2h → none", () => {
  assert.deepEqual(computeReminderSchedule(slot, new Date("2026-08-06T00:00:00.000Z")).map((x) => x.kind), ["T2H"]);
  assert.deepEqual(computeReminderSchedule(slot, new Date("2026-08-06T13:00:00.000Z")), []);
});
