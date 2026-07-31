import assert from "node:assert/strict";
import test from "node:test";
import { computeBookingFee, isNewCustomer, validateDepositConfig } from "./booking-fee";

const t0 = new Date("2026-07-01T10:00:00Z");
const sameMoment = new Date(t0.getTime() + 1500); // webhook tx skew < 60s

test("first-contact customer is new", () => {
  assert.equal(isNewCustomer({ priorRelationshipBookings: 0, customerCreatedAt: sameMoment, conversationCreatedAt: t0 }), true);
});
test("re-imported dead-list contact is NOT new", () => {
  const imported = new Date("2026-05-01T00:00:00Z");
  assert.equal(isNewCustomer({ priorRelationshipBookings: 0, customerCreatedAt: imported, conversationCreatedAt: t0 }), false);
});
test("prior confirmed relationship is NOT new", () => {
  assert.equal(isNewCustomer({ priorRelationshipBookings: 1, customerCreatedAt: sameMoment, conversationCreatedAt: t0 }), false);
});
test("prior EXPIRED-only inquiry stays new (relationship bookings exclude EXPIRED)", () => {
  // caller counts only RELATIONSHIP_STATUSES; an expired inquiry contributes 0
  assert.equal(isNewCustomer({ priorRelationshipBookings: 0, customerCreatedAt: sameMoment, conversationCreatedAt: t0 }), true);
});
test("no conversation (manual path) is NOT new", () => {
  assert.equal(isNewCustomer({ priorRelationshipBookings: 0, customerCreatedAt: t0, conversationCreatedAt: null }), false);
});
test("fee: new + WHATSAPP → tenant fee; repeat → 0; MANUAL always 0; null fee config → 0", () => {
  assert.equal(computeBookingFee({ source: "WHATSAPP", isNewCustomer: true, tenantFeeAed: 50 }), 50);
  assert.equal(computeBookingFee({ source: "WHATSAPP", isNewCustomer: false, tenantFeeAed: 50 }), 0);
  assert.equal(computeBookingFee({ source: "MANUAL", isNewCustomer: true, tenantFeeAed: 50 }), 0);
  assert.equal(computeBookingFee({ source: "AD", isNewCustomer: true, tenantFeeAed: null }), 0);
});

// Review fix (Important 2): depositAed=0 (from the `restaurant.depositAed ?? 0`
// fallback on an unset/NULL column) must be refused before a booking + dead
// Stripe pay link is ever created, and a configured fee above the deposit
// must be refused too — the DB CHECK only catches the second case when both
// columns are non-null, never the fallback-to-0 case.
test("validateDepositConfig: deposit=0 is refused (dead pay link)", () => {
  assert.deepEqual(validateDepositConfig({ depositAed: 0, feeAed: 0 }), {
    ok: false,
    reason: "deposit_not_configured",
  });
});
test("validateDepositConfig: negative deposit is refused", () => {
  assert.deepEqual(validateDepositConfig({ depositAed: -10, feeAed: 0 }), {
    ok: false,
    reason: "deposit_not_configured",
  });
});
test("validateDepositConfig: fee above deposit is refused even when deposit > 0", () => {
  assert.deepEqual(validateDepositConfig({ depositAed: 30, feeAed: 50 }), {
    ok: false,
    reason: "deposit_below_fee",
  });
});
test("validateDepositConfig: deposit >= fee > 0 is ok", () => {
  assert.deepEqual(validateDepositConfig({ depositAed: 50, feeAed: 50 }), { ok: true });
  assert.deepEqual(validateDepositConfig({ depositAed: 100, feeAed: 0 }), { ok: true });
});
