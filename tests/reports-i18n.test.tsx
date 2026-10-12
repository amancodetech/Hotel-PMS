/** @jest-environment jsdom */
import { expect, test } from '@jest/globals';
import { createI18n, locales } from '../packages/i18n/src/index.js';
import { metricLabel } from '../apps/web/src/reports/ReportsPage.js';

const HOUSEKEEPING_STATES = ['CLEAN', 'DIRTY', 'CLEANING', 'INSPECTED'];
const MAINTENANCE_STATES = ['NONE', 'OOO', 'OOS'];
const ITEM_STATES = [
  'INQUIRY',
  'TENTATIVE',
  'WAITLIST',
  'CONFIRMED',
  'IN_HOUSE',
  'CHECKED_OUT',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];
const RESOURCE_TYPES = ['ROOM', 'BED', 'SITE', 'TENT', 'CABIN', 'DORM'];

function reportMetricKeys() {
  const keys = [
    'resources_not_ready_current.ROOM',
    'resource_nights_paid.ROOM',
    'adr.ROOM',
    'revpar_physical.ROOM',
    'revpar_operational.ROOM',
    'stay_revenue_journal',
    'stay_revenue_charges',
    'stay_revenue_unattributed',
    'stay_revenue_unattributed_charges',
    'stay_revenue_delta',
    'stay_revenue_reconciled',
    'arrivals_total',
    'departures_total',
  ];
  for (const type of RESOURCE_TYPES) {
    for (const state of HOUSEKEEPING_STATES)
      keys.push(`housekeeping_${state.toLowerCase()}.${type}`);
    for (const state of MAINTENANCE_STATES)
      keys.push(`maintenance_${state.toLowerCase()}.${type}`);
  }
  for (const state of ITEM_STATES) {
    keys.push(`arrivals_state_${state.toLowerCase()}`);
    keys.push(`departures_state_${state.toLowerCase()}`);
  }
  return keys;
}

for (const locale of locales) {
  test(`every declared report metric resolves a label in ${locale}`, () => {
    const i18n = createI18n(locale);
    const t = i18n.t.bind(i18n) as unknown as (
      key: string,
      options?: Record<string, unknown>,
    ) => string;
    for (const key of reportMetricKeys()) {
      const rendered = metricLabel(t, key, `RAW:${key}`);
      expect(rendered).not.toBe(`RAW:${key}`);
      expect(rendered.startsWith('RAW:')).toBe(false);
    }
  });
}

test('structured report labels keep their declared base and state', () => {
  const i18n = createI18n('ar');
  const t = i18n.t.bind(i18n) as unknown as (
    key: string,
    options?: Record<string, unknown>,
  ) => string;
  expect(metricLabel(t, 'housekeeping_dirty.ROOM', 'RAW')).toBe(
    'حالة النظافة · متسخة · ROOM',
  );
  expect(metricLabel(t, 'arrivals_state_in_house', 'RAW')).toBe(
    'الوصول حسب الحالة · مقيم',
  );
});
