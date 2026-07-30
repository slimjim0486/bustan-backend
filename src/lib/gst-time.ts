// Dubai (GST, UTC+4, no DST) calendar-boundary helpers shared by the
// booking dashboard, owner-chat tools, and report queues.
export const GST_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfTodayGst(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + GST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - GST_OFFSET_MS);
}

export function startOfWeekGst(now: Date = new Date()): Date {
  const dayStart = startOfTodayGst(now);
  const shifted = new Date(dayStart.getTime() + GST_OFFSET_MS);
  const daysBack = (shifted.getUTCDay() + 6) % 7; // Monday-start week
  return new Date(dayStart.getTime() - daysBack * DAY_MS);
}

export function startOfMonthGst(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + GST_OFFSET_MS);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - GST_OFFSET_MS);
}

export function startOfNextMonthGst(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + GST_OFFSET_MS);
  shifted.setUTCDate(1);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCMonth(shifted.getUTCMonth() + 1);
  return new Date(shifted.getTime() - GST_OFFSET_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
