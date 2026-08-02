export class ClosedPayoutAccrualError extends Error {
  constructor() {
    super("Refusing to accrue funds into a payout record that is already PAID");
    this.name = "ClosedPayoutAccrualError";
  }
}

/** A payout may be transferred only after its half-open accounting period ends. */
export function isPayoutPeriodClosed(periodEnd: Date, now: Date): boolean {
  return periodEnd.getTime() <= now.getTime();
}

/**
 * Called inside the booking-confirmation transaction after the weekly upsert.
 * Throwing here rolls the upsert and booking transition back together, so a
 * PAID settlement can never be silently changed by a later confirmation.
 */
export function assertPayoutAccrualAllowed(status: string): void {
  if (status !== "PENDING") throw new ClosedPayoutAccrualError();
}
