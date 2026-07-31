export const RELATIONSHIP_STATUSES = ["CONFIRMED", "COMPLETED", "NO_SHOW"] as const;
export const NEW_CUSTOMER_EPSILON_MS = 60_000;

export function isNewCustomer(input: {
  priorRelationshipBookings: number;
  customerCreatedAt: Date;
  conversationCreatedAt: Date | null;
}): boolean {
  if (input.priorRelationshipBookings > 0) return false;
  if (!input.conversationCreatedAt) return false;
  if (input.customerCreatedAt.getTime() < input.conversationCreatedAt.getTime() - NEW_CUSTOMER_EPSILON_MS) return false;
  return true;
}

export function computeBookingFee(input: {
  source: string;
  isNewCustomer: boolean;
  tenantFeeAed: number | null;
}): number {
  if (input.source === "MANUAL") return 0;
  if (!input.isNewCustomer) return 0;
  return Math.max(0, input.tenantFeeAed ?? 0);
}

export type DepositConfigValidation =
  | { ok: true }
  | { ok: false; reason: "deposit_not_configured" | "deposit_below_fee" };

/**
 * Review fix (Important 2): `restaurant.depositAed ?? 0` in createBooking
 * silently produced a booking with a AED-0 deposit and a Stripe Checkout
 * session with unit_amount 0 (which Stripe rejects) whenever a tenant left
 * depositAed unset. The DB CHECK constraint
 * (deposit_aed IS NULL OR new_customer_fee_aed IS NULL OR deposit_aed >=
 * new_customer_fee_aed) only guards the *columns*, not the ?? 0 fallback the
 * app applies on read — so it never caught this case.
 *
 * Pure gate: a deposit config is usable only if it's a real positive amount
 * that covers the fee actually being charged on this booking. Call BEFORE
 * creating the Booking row so a misconfigured tenant never gets a dead pay
 * link — the caller escalates to the owner instead.
 */
export function validateDepositConfig(input: {
  depositAed: number;
  feeAed: number;
}): DepositConfigValidation {
  if (input.depositAed <= 0) return { ok: false, reason: "deposit_not_configured" };
  if (input.feeAed > input.depositAed) return { ok: false, reason: "deposit_below_fee" };
  return { ok: true };
}
