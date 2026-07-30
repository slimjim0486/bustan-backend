import assert from "node:assert/strict";
import test from "node:test";
import {
  FEE_COUNTED_STATUSES,
  assertStatusTransition,
  buildBookingListWhere,
  computeNoShowRate,
} from "@/lib/booking-metrics";

test("fee-counted statuses are exactly confirmed/completed/no-show", () => {
  assert.deepEqual(FEE_COUNTED_STATUSES, ["CONFIRMED", "COMPLETED", "NO_SHOW"]);
});

test("resolution only allowed from CONFIRMED", () => {
  assert.doesNotThrow(() => assertStatusTransition("CONFIRMED", "COMPLETED"));
  assert.doesNotThrow(() => assertStatusTransition("CONFIRMED", "NO_SHOW"));
  assert.throws(() => assertStatusTransition("INQUIRY", "COMPLETED"), /Cannot mark/);
  assert.throws(() => assertStatusTransition("COMPLETED", "NO_SHOW"), /Cannot mark/);
  assert.throws(() => assertStatusTransition("EXPIRED", "NO_SHOW"), /Cannot mark/);
});

test("no-show rate is a rounded percent, null when nothing resolved", () => {
  assert.equal(computeNoShowRate(0, 0), null);
  assert.equal(computeNoShowRate(9, 1), 10);
  assert.equal(computeNoShowRate(2, 1), 33);
  assert.equal(computeNoShowRate(0, 3), 100);
});

test("list where-builder composes range and status filters", () => {
  const from = new Date("2026-07-29T20:00:00Z");
  const to = new Date("2026-08-05T20:00:00Z");
  assert.deepEqual(buildBookingListWhere("r1", { from, to, statuses: ["CONFIRMED"] }), {
    restaurantId: "r1",
    slotAt: { gte: from, lt: to },
    status: { in: ["CONFIRMED"] },
  });
  assert.deepEqual(buildBookingListWhere("r1", {}), { restaurantId: "r1" });
  assert.deepEqual(buildBookingListWhere("r1", { from }), {
    restaurantId: "r1",
    slotAt: { gte: from },
  });
});
