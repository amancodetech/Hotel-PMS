import { setupBatchChunks } from '../packages/backend/src/modules/property/domain/setup-batch-plan.js';
import { parseSetupV2 } from '../packages/backend/src/modules/property/domain/setup-v2.js';
import { buildSetupPlanV2 } from '../packages/backend/src/modules/property/domain/setup-plan-v2.js';
const input = (unit_groups: unknown[]) =>
  parseSetupV2({
    schema_version: 2,
    property: {},
    operations: {},
    locations: [],
    unit_groups,
  });
const group = {
  group_ref: 'g',
  physical_template: 'ROOM',
  booking_mode: 'WHOLE_ONLY',
  selection_mode: 'EXACT',
  capacity: 2,
  pattern: '101-120',
  exclusions: ['113'],
};
test('batch boundaries preserve nineteen codes, product identity and source data', () => {
  const source = input([group]),
    before = structuredClone(source),
    chunks = setupBatchChunks(source, 20)!;
  expect(chunks).toHaveLength(2);
  const plans = chunks.map(buildSetupPlanV2),
    whole = buildSetupPlanV2(source);
  expect(plans.map((p) => p.counts.resources)).toEqual([10, 9]);
  expect(plans.flatMap((p) => p.resources)).toEqual(whole.resources);
  expect(plans.flatMap((p) => p.products)).toEqual(whole.products);
  expect(source).toEqual(before);
});
test('categories and compositions remain whole even among mixed groups', () => {
  const source = input([
    group,
    {
      ...group,
      group_ref: 'category',
      selection_mode: 'CATEGORY',
      pattern: '201-204',
      exclusions: [],
    },
    {
      group_ref: 'villa',
      physical_template: 'VILLA',
      booking_mode: 'WHOLE_AND_PARTS',
      selection_mode: 'EXACT',
      capacity: 4,
      pattern: '301-301',
      parts: [
        { part_ref: 'a', code: 'A', display_label: 'A', capacity: 2 },
        { part_ref: 'b', code: 'B', display_label: 'B', capacity: 2 },
      ],
      privacy_ack: true,
      effective_from: '2026-01-01',
      effective_to: '2026-12-31',
    },
  ]);
  const chunks = setupBatchChunks(source, 20)!;
  const all = chunks.flatMap((c) => buildSetupPlanV2(c).products);
  expect(all).toEqual(buildSetupPlanV2(source).products);
  expect(
    chunks
      .flatMap((c) => c.unit_groups)
      .filter((g) => g.group_ref === 'category'),
  ).toHaveLength(1);
  expect(
    chunks.flatMap((c) => c.unit_groups).filter((g) => g.group_ref === 'villa'),
  ).toHaveLength(1);
});
test('an indivisible category above budget stays blocked instead of becoming smaller sale products', () => {
  expect(
    setupBatchChunks(
      input([{ ...group, selection_mode: 'CATEGORY', pattern: '101-150' }]),
      20,
    ),
  ).toBeNull();
});
