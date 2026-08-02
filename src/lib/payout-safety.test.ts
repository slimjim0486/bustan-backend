import assert from "node:assert/strict";
import test from "node:test";
import {
  ClosedPayoutAccrualError,
  assertPayoutAccrualAllowed,
  isPayoutPeriodClosed,
} from "./payout-safety";

test("an open payout period cannot be settled", () => {
  const now = new Date("2026-08-02T12:00:00.000Z");
  const periodEnd = new Date("2026-08-02T12:00:00.001Z");
  assert.equal(isPayoutPeriodClosed(periodEnd, now), false);
});

test("a payout period becomes settleable at its exact end instant", () => {
  const instant = new Date("2026-08-03T20:00:00.000Z");
  assert.equal(isPayoutPeriodClosed(instant, instant), true);
});

test("ledger accrual is allowed only while the payout is pending", () => {
  assert.doesNotThrow(() => assertPayoutAccrualAllowed("PENDING"));
  assert.throws(
    () => assertPayoutAccrualAllowed("PAID"),
    (error: unknown) => error instanceof ClosedPayoutAccrualError
  );
});
