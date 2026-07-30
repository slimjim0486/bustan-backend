// Pure slot-grid math. GST is fixed UTC+4 (no DST) — matches the dashboard's date math.
export interface TimePeriod { open: string; close: string } // "HH:MM" local (GST)
export interface DaySchedule { dayOfWeek: number; isClosed: boolean; periods: TimePeriod[] } // 0=Sunday
export interface OperatingHoursConfig { timezone: string; schedule: DaySchedule[] }
export interface ExistingBooking { slotAt: Date; durationMinutes: number }
export interface AvailabilityInput {
  hours: OperatingHoursConfig | null;
  durationMinutes: number;
  granularityMinutes: number;
  parallelCapacity: number;
  existing: ExistingBooking[]; // DEPOSIT_SENT + CONFIRMED bookings in [from, to)
  from: Date; // inclusive UTC instant
  to: Date;   // exclusive UTC instant
  now: Date;
  minLeadMinutes?: number; // default 120
}

export const GST_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseHm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes < 24 * 60 ? minutes : null;
}

export function computeAvailableSlots(input: AvailabilityInput): Date[] {
  const { hours, durationMinutes, granularityMinutes, parallelCapacity, existing, from, to, now } = input;
  if (!hours?.schedule?.length || durationMinutes <= 0 || granularityMinutes <= 0 || parallelCapacity <= 0) return [];
  const leadMs = (input.minLeadMinutes ?? 120) * 60_000;
  const earliest = Math.max(from.getTime(), now.getTime() + leadMs);
  const durMs = durationMinutes * 60_000;
  const stepMs = granularityMinutes * 60_000;
  const slots: Date[] = [];

  // Walk GST-local days covering [from, to)
  const firstDayGst = Math.floor((from.getTime() + GST_OFFSET_MS) / DAY_MS) * DAY_MS;
  for (let dayGst = firstDayGst; dayGst - GST_OFFSET_MS < to.getTime(); dayGst += DAY_MS) {
    const dayStartUtc = dayGst - GST_OFFSET_MS;
    const dow = new Date(dayGst).getUTCDay(); // GST-shifted instant → local weekday
    const day = hours.schedule.find((d) => d.dayOfWeek === dow);
    if (!day || day.isClosed) continue;
    for (const period of day.periods ?? []) {
      const openMin = parseHm(period.open);
      const closeMin = parseHm(period.close);
      if (openMin === null || closeMin === null || closeMin <= openMin) continue;
      const openUtc = dayStartUtc + openMin * 60_000;
      const closeUtc = dayStartUtc + closeMin * 60_000;
      for (let start = openUtc; start + durMs <= closeUtc; start += stepMs) {
        if (start < earliest || start >= to.getTime()) continue;
        const end = start + durMs;
        const overlapping = existing.filter((b) => {
          const bStart = b.slotAt.getTime();
          const bEnd = bStart + b.durationMinutes * 60_000;
          return bStart < end && bEnd > start;
        }).length;
        if (overlapping >= parallelCapacity) continue;
        slots.push(new Date(start));
      }
    }
  }
  return slots.sort((a, b) => a.getTime() - b.getTime());
}
