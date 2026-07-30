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
