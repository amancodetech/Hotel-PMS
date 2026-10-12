/**
 * Local clock indirection. The property business date must follow the
 * property timezone policy, never the server clock (AT-28). `HOTEL_CLOCK_NOW`
 * is a local development/test harness only: the stack refuses to start in
 * production (see config.ts), so a frozen clock cannot be used in production.
 */
let overrideNow: (() => Date) | null = null;

export function setClockForTests(now: (() => Date) | null): void {
  overrideNow = now;
}

export function parseClockOverride(
  value: string | undefined | null,
): Date | null {
  if (!value) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(
      value,
    )
  )
    return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function clockNow(): Date {
  if (overrideNow) return overrideNow();
  return parseClockOverride(process.env.HOTEL_CLOCK_NOW) ?? new Date();
}
