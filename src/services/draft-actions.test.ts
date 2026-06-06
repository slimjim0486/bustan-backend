import assert from "node:assert/strict";
import test from "node:test";
import { APPROVE_TO_SHIP_GRACE_MS, getApproveToShipGraceMs } from "@/services/draft-actions";

test("default grace is 60s", () => {
  assert.equal(getApproveToShipGraceMs("promotion_create"), 60_000);
  assert.equal(APPROVE_TO_SHIP_GRACE_MS, 60_000);
});

test("whatsapp campaign sends get a 5-minute grace", () => {
  assert.equal(getApproveToShipGraceMs("whatsapp_campaign_send"), 300_000);
});
