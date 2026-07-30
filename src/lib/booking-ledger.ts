const GST_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Monday-to-Monday GST week containing `instant`, expressed as UTC instants. */
export function weeklyPeriodFor(instant: Date): { periodStart: Date; periodEnd: Date } {
  const gst = instant.getTime() + GST_OFFSET_MS;
  const dayStart = Math.floor(gst / DAY_MS) * DAY_MS;
  const dow = new Date(dayStart).getUTCDay(); // 0=Sun..6=Sat at GST midnight
  const daysSinceMonday = (dow + 6) % 7;
  const mondayGst = dayStart - daysSinceMonday * DAY_MS;
  return { periodStart: new Date(mondayGst - GST_OFFSET_MS), periodEnd: new Date(mondayGst + WEEK_MS - GST_OFFSET_MS) };
}

/** Ledger deltas for one confirmed booking. Invariant: dueDelta = depositsDelta - feesDelta. */
export function applyToLedger(add: { depositAed: number; feeAed: number }): {
  depositsDelta: number; feesDelta: number; dueDelta: number;
} {
  const depositsDelta = Math.max(0, add.depositAed);
  const feesDelta = Math.max(0, add.feeAed);
  return { depositsDelta, feesDelta, dueDelta: depositsDelta - feesDelta };
}
