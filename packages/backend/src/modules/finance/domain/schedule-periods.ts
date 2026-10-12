export const scheduleIntervals = ['DAY', 'WEEK', 'MONTH'] as const;
export type ScheduleInterval = (typeof scheduleIntervals)[number];

/**
 * Advances one schedule period. Periods are property-local stay dates, so the
 * arithmetic is done on a UTC calendar date (same convention used by the
 * reservation dates) and month ends clamp to the last valid day.
 */
export function addInterval(date: string, interval: ScheduleInterval): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (interval === 'DAY') parsed.setUTCDate(parsed.getUTCDate() + 1);
  else if (interval === 'WEEK') parsed.setUTCDate(parsed.getUTCDate() + 7);
  else {
    const day = parsed.getUTCDate();
    parsed.setUTCDate(1);
    parsed.setUTCMonth(parsed.getUTCMonth() + 1);
    const daysInMonth = new Date(
      Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0),
    ).getUTCDate();
    parsed.setUTCDate(Math.min(day, daysInMonth));
  }
  return parsed.toISOString().slice(0, 10);
}
