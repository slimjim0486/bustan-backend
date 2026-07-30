import assert from "node:assert/strict";
import test from "node:test";
import { decideExpiryAction, decideNudgeAction, DEPOSIT_EXPIRY_MS, DEPOSIT_NUDGE_MS } from "./booking-expiry";

test("only DEPOSIT_SENT expires or nudges; everything else is a no-op", () => {
  assert.equal(decideExpiryAction("DEPOSIT_SENT"), "expire");
  assert.equal(decideNudgeAction("DEPOSIT_SENT"), "nudge");
  for (const s of ["INQUIRY", "CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED", "EXPIRED"]) {
    assert.equal(decideExpiryAction(s), "skip");
    assert.equal(decideNudgeAction(s), "skip");
  }
});
test("nudge fires before expiry", () => { assert.ok(DEPOSIT_NUDGE_MS < DEPOSIT_EXPIRY_MS); });
