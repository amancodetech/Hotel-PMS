/**
 * Date-only helpers for tests that mix a facility's business date (property
 * timezone) with relative offsets. Never derive a business date from the
 * process clock in UTC: `new Date()` + `toISOString()` is an instant-based UTC
 * date and can equal the local business date around midnight in the property
 * timezone, collapsing a one-night period into `date_from == date_to`.
 */

export function addBusinessDays(isoDate, days) {
  const base = new Date(`${isoDate}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || Number.isNaN(base.getTime()))
    throw new Error(
      `addBusinessDays expects an ISO date, received: ${isoDate}`,
    );
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function todayInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
