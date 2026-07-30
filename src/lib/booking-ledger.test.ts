import assert from "node:assert/strict";
import test from "node:test";
import { applyToLedger, weeklyPeriodFor } from "./booking-ledger";

test("weekly period is Monday 00:00 GST inclusive to next Monday exclusive", () => {
  // Thu 2026-07-30 12:00 GST = 08:00 UTC → week Mon 2026-07-27 00:00 GST (= Sun 26th 20:00 UTC)
  const p = weeklyPeriodFor(new Date("2026-07-30T08:00:00.000Z"));
  assert.equal(p.periodStart.toISOString(), "2026-07-26T20:00:00.000Z");
  assert.equal(p.periodEnd.toISOString(), "2026-08-02T20:00:00.000Z");
  // A Monday-morning GST instant maps to its own week
  const mon = weeklyPeriodFor(new Date("2026-07-26T20:30:00.000Z")); // Mon 00:30 GST
  assert.equal(mon.periodStart.toISOString(), "2026-07-26T20:00:00.000Z");
});

test("ledger invariant: due = deposits - fees", () => {
  const d = applyToLedger({ depositAed: 50, feeAed: 50 });
  assert.deepEqual(d, { depositsDelta: 50, feesDelta: 50, dueDelta: 0 });
  const repeat = applyToLedger({ depositAed: 50, feeAed: 0 });
  assert.deepEqual(repeat, { depositsDelta: 50, feesDelta: 0, dueDelta: 50 });
});
