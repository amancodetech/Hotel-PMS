import { expect, test } from '@jest/globals';
import { assertReservationAriPolicy, deriveReservationAriCells } from '../packages/backend/dist/modules/inventory/domain/reservation-ari-policy.js';

const id = (value) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(value).padStart(12, '0')}`;
export function policyFixture(mode = 'PARTS') {
  const binding = (value, resources) => ({
    productId: id(value), resourceIds: resources.map(id), mappingId: id(value + 20),
    mappingVersion: 1, mappingStatus: 'DRAFT', externalRoomRef: `ROOM-${value}`, externalRateRef: `RATE-${value}`,
  });
  return { databaseName: 'hotel_test_ari_property', tenantId: id(100), propertyId: id(101),
    connectionId: id(102), connectionVersion: 1, connectionStatus: 'DRAFT', externalPropertyId: 'SYNTHETIC-VILLA',
    date: '2026-10-15', departure: '2026-10-16', mode, compositionVersionId: id(103), whole: binding(1, [10, 11, 12]),
    parts: [binding(2, [10]), binding(3, [11]), binding(4, [12])] };
}
const facts = (policy) => [policy.whole, ...policy.parts].map((binding) => ({ productId: binding.productId, reasonCodes: [] }));

test.each(['WHOLE', 'PARTS'])('finite %s mode never opens whole and rooms together', (mode) => {
  const policy = policyFixture(mode);
  const cells = deriveReservationAriCells(policy, facts(policy), 17);
  expect(cells.map((cell) => cell.available)).toEqual(mode === 'WHOLE' ? [1, 0, 0, 0] : [0, 1, 1, 1]);
  expect(cells.every((cell) => cell.date === policy.date && cell.inventory_version === 17)).toBe(true);
});

test.each(['COMMITTED', 'BLOCKED', 'EXPOSURE_PROTECTED', 'STOP_SELL_RETAINED', 'RESOURCE_NOT_READY'])('cancellation cannot reopen a cell retaining %s', (reason) => {
  const policy = policyFixture();
  const evidence = facts(policy);
  evidence[1].reasonCodes.push(reason);
  const cells = deriveReservationAriCells(policy, evidence, 18);
  expect(cells[1]).toMatchObject({ available: 0, stop_sell: true, reason_codes: [reason] });
  expect(cells[2].available).toBe(1);
});

test('unknown/missing/duplicate canonical evidence closes instead of inferring opening', () => {
  const policy = policyFixture();
  const evidence = facts(policy);
  evidence[1].reasonCodes = null;
  evidence.splice(2, 1);
  evidence.push(evidence[2]);
  expect(deriveReservationAriCells(policy, evidence, 19).every((cell) => cell.available === 0)).toBe(true);
});

test.each([
  (policy) => { policy.databaseName = 'hotel'; },
  (policy) => { policy.departure = '2026-10-17'; },
  (policy) => { policy.date = '2026-02-30'; },
  (policy) => { policy.date = '2027-02-28'; policy.departure = '2027-02-29'; },
  (policy) => { policy.parts[1].resourceIds = policy.parts[0].resourceIds; },
  (policy) => { policy.parts.push(policy.parts[0]); },
  (policy) => { policy.whole.resourceIds = [id(10), id(11), id(13)]; },
])('rejects an unbounded or overlapping invalid policy', (change) => {
  const policy = policyFixture();
  change(policy);
  expect(() => assertReservationAriPolicy(policy)).toThrow('RESERVATION_ARI_POLICY_INVALID');
});
