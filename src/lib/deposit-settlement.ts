export type DepositSettlementRejection =
  | "restaurant_mismatch"
  | "session_mismatch"
  | "amount_mismatch"
  | "currency_mismatch"
  | "missing_payment_intent";

export function validateDepositSettlement(input: {
  bookingRestaurantId: string;
  relayedRestaurantId: string;
  expectedStripeSessionId: string | null;
  relayedStripeSessionId: string;
  depositAed: number;
  amountTotalMinor: number;
  currency: string;
  paymentIntentId: string | null;
}): DepositSettlementRejection | null {
  if (input.bookingRestaurantId !== input.relayedRestaurantId) return "restaurant_mismatch";
  if (!input.expectedStripeSessionId || input.expectedStripeSessionId !== input.relayedStripeSessionId) {
    return "session_mismatch";
  }
  if (input.amountTotalMinor !== input.depositAed * 100) return "amount_mismatch";
  if (input.currency.toLowerCase() !== "aed") return "currency_mismatch";
  if (!input.paymentIntentId) return "missing_payment_intent";
  return null;
}
