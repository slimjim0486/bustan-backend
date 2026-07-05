import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVE_TO_SHIP_GRACE_MS,
  getApproveToShipGraceMs,
  resolveDraftDefaults,
} from "@/services/draft-actions";

test("default grace is 60s", () => {
  assert.equal(getApproveToShipGraceMs("promotion_create"), 60_000);
  assert.equal(APPROVE_TO_SHIP_GRACE_MS, 60_000);
});

test("whatsapp campaign sends get a 5-minute grace", () => {
  assert.equal(getApproveToShipGraceMs("whatsapp_campaign_send"), 300_000);
});

test("createDraft defaults: dashboard channel, tier 2, no idempotency", () => {
  const d = resolveDraftDefaults({});
  assert.equal(d.channel, "dashboard_chat");
  assert.equal(d.autonomyTier, 2);
  assert.equal(d.idempotencyKey, null);
});

test("createDraft honors explicit channel + tier", () => {
  const d = resolveDraftDefaults({ channel: "owner_whatsapp", autonomyTier: 1, idempotencyKey: "abc" });
  assert.equal(d.channel, "owner_whatsapp");
  assert.equal(d.autonomyTier, 1);
  assert.equal(d.idempotencyKey, "abc");
});
