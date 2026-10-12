import { test, expect, afterEach } from '@jest/globals';
import { businessToday, clockNow, setClockForTests } from '@hotel/backend';

afterEach(() => {
  setClockForTests(null);
  delete process.env.HOTEL_CLOCK_NOW;
});

test('AT-28 the business date follows the property timezone at the midnight boundary', () => {
  // 16:59 UTC is 23:59 in Asia/Jakarta; one minute later Jakarta is already
  // on the next calendar day while UTC is still on the previous one.
  expect(businessToday('Asia/Jakarta', new Date('2026-09-16T16:59:00Z'))).toBe(
    '2026-09-16',
  );
  expect(businessToday('Asia/Jakarta', new Date('2026-09-16T17:00:00Z'))).toBe(
    '2026-09-17',
  );
  expect(businessToday('UTC', new Date('2026-09-16T18:30:00Z'))).toBe(
    '2026-09-16',
  );
  expect(businessToday('Asia/Jakarta', new Date('2026-09-16T18:30:00Z'))).toBe(
    '2026-09-17',
  );
});

test('AT-28 the frozen clock harness overrides the server clock for local runs', () => {
  process.env.HOTEL_CLOCK_NOW = '2026-09-16T17:05:00Z';
  expect(clockNow().toISOString()).toBe('2026-09-16T17:05:00.000Z');
  expect(businessToday('Asia/Jakarta')).toBe('2026-09-17');
  process.env.HOTEL_CLOCK_NOW = 'not-a-timestamp';
  const fallback = clockNow();
  expect(Number.isFinite(fallback.getTime())).toBe(true);
  setClockForTests(() => new Date('2026-09-16T16:00:00Z'));
  expect(businessToday('Asia/Jakarta')).toBe('2026-09-16');
});
