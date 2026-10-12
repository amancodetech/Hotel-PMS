import {
  buildSetupPlanV2,
  assertSetupPlanReady,
} from '../packages/backend/src/modules/property/domain/setup-plan-v2.js';

const group = (extra = {}) => ({
  group_ref: 'main',
  physical_template: 'ROOM',
  booking_mode: 'WHOLE_ONLY',
  selection_mode: 'EXACT',
  capacity: 2,
  pattern: '101-120',
  exclusions: ['113'],
  ...extra,
});
const input = (...groups: unknown[]) => ({
  schema_version: 2,
  property: {},
  locations: [],
  unit_groups: groups,
  operations: {},
});
const single = (extra = {}) =>
  group({
    pattern: undefined,
    exclusions: undefined,
    units: [{ unit_ref: 'one', code: 'V1', display_label: 'Villa One' }],
    ...extra,
  });
const parts = [
  { part_ref: 'a', code: 'A', display_label: 'Room A', capacity: 2 },
  { part_ref: 'b', code: 'B', display_label: 'Room B', capacity: 2 },
  { part_ref: 'c', code: 'C', display_label: 'Room C', capacity: 2 },
];

test('T01 plan: nineteen exact products; no compositions or source mutations', () => {
  const source = input(group());
  const before = structuredClone(source);
  const plan = buildSetupPlanV2(source);
  expect(plan.blockers).toEqual([]);
  expect(plan.counts).toEqual({
    resources: 19,
    sellableResources: 19,
    containers: 0,
    products: 19,
    compositions: 0,
    leaves: 0,
    candidates: 19,
  });
  expect(plan.resources.map((r) => r.code)).not.toContain('113');
  expect(source).toEqual(before);
  expect(buildSetupPlanV2(source)).toEqual(plan);
});
test('T02 plan: category consists of alternatives, not a composition', () => {
  const plan = buildSetupPlanV2(input(group({ selection_mode: 'CATEGORY' })));
  expect(plan.products).toHaveLength(1);
  expect(plan.products[0]!.candidates).toHaveLength(19);
  expect(plan.products[0]!.leaves).toEqual([]);
});
test.each([
  'VILLA',
  'APARTMENT',
  'HOUSE',
  'SUITE_STANDALONE',
  'TENT',
  'SITE',
  'CABIN',
])(
  'T03/T04/T28 plan: %s descriptive rooms create no inventory',
  (physical_template) => {
    const plan = buildSetupPlanV2(
      input(
        single({
          physical_template,
          capacity: 6,
          details: {
            bedrooms_count: 4,
            bathrooms_count: 0,
            notes: 'Shared pool; cot available',
          },
        }),
      ),
    );
    expect(plan.resources).toHaveLength(1);
    expect(plan.resources[0]!.capacity).toBe(6);
    expect(plan.resources[0]!.details.bedrooms_count).toBe(4);
    expect(plan.resources[0]!.kind).toBe(
      physical_template === 'SUITE_STANDALONE' ? 'ROOM' : physical_template,
    );
    expect(plan.counts.compositions).toBe(0);
  },
);
test.each(['PARTS_ONLY', 'WHOLE_AND_PARTS'])(
  'T05/T06 plan: %s never sells parent',
  (booking_mode) => {
    const plan = buildSetupPlanV2(
      input(
        single({
          physical_template: 'VILLA',
          booking_mode,
          parts,
          capacity: booking_mode === 'PARTS_ONLY' ? null : 4,
          privacy_ack: true,
          effective_from: '2026-10-01',
        }),
      ),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.counts.resources).toBe(4);
    expect(plan.counts.sellableResources).toBe(3);
    expect(plan.resources[0]!.sellable).toBe(false);
    expect(
      plan.products.flatMap((p) => [...p.leaves, ...p.candidates]),
    ).not.toContainEqual({ code: 'V1' });
    expect(plan.counts.compositions).toBe(
      booking_mode === 'PARTS_ONLY' ? 0 : 1,
    );
    if (booking_mode === 'WHOLE_AND_PARTS') {
      const whole = plan.products.find((p) => p.leaves.length)!;
      expect(whole.capacity).toBe(4); // Not the sum of six places in the parts.
      expect(whole.leaves).toEqual(
        plan.products
          .filter((p) => !p.leaves.length)
          .flatMap((p) => p.candidates),
      );
    }
  },
);
test.each(['BEDS_ONLY', 'BEDS_AND_PRIVATE'])(
  'T07 plan: %s preserves exactly six beds',
  (booking_mode) => {
    const plan = buildSetupPlanV2(
      input(
        single({
          physical_template: 'DORM',
          booking_mode,
          selection_mode: 'CATEGORY',
          beds_per_unit: 6,
          capacity: booking_mode === 'BEDS_ONLY' ? null : 6,
          sharing_scope: 'MIXED',
          effective_from: '2026-10-01',
        }),
      ),
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.resources.filter((r) => r.kind === 'BED')).toHaveLength(6);
    expect(plan.counts.containers).toBe(1);
    expect(plan.products[0]!.sharingScope).toBe('MIXED');
    expect(plan.counts.compositions).toBe(booking_mode === 'BEDS_ONLY' ? 0 : 1);
  },
);
test('T04 plan: connected suite refers to existing IDs and creates no resources', () => {
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ];
  const plan = buildSetupPlanV2(
    input(
      group({
        pattern: undefined,
        exclusions: undefined,
        physical_template: 'SUITE_CONNECTED',
        booking_mode: 'CONNECTED_UNITS',
        connected_resource_ids: ids,
        connection_ack: true,
        effective_from: '2026-10-01',
      }),
    ),
  );
  expect(plan.blockers).toEqual([]);
  expect(plan.resources).toEqual([]);
  expect(plan.products[0]!.leaves).toEqual(
    ids.map((existingResourceId) => ({ existingResourceId })),
  );
});
test('incomplete group prevents executable writes for the entire batch', () => {
  const plan = buildSetupPlanV2(
    input(group(), single({ group_ref: 'bad', capacity: null })),
  );
  expect(plan.blockers).toContainEqual({
    code: 'required',
    field_path: 'unit_groups.1.capacity',
    group_ref: 'bad',
  });
  expect(plan.resources).toEqual([]);
  expect(plan.products).toEqual([]);
  expect(() => assertSetupPlanReady(plan)).toThrow();
});
test('generated child code colliding with another unit blocks the whole plan', () => {
  const plan = buildSetupPlanV2(
    input(
      single({ physical_template: 'VILLA', booking_mode: 'PARTS_ONLY', parts }),
      single({
        group_ref: 'other',
        units: [{ unit_ref: 'two', code: 'V1-A', display_label: 'Other' }],
      }),
    ),
  );
  expect(plan.blockers.some((i) => i.code === 'generated_code_duplicate')).toBe(
    true,
  );
  expect(plan.counts.resources).toBe(0);
});
test('explicit bed codes and labels survive unchanged; beds remain capacity one', () => {
  const plan = buildSetupPlanV2(
    input(
      single({
        physical_template: 'DORM',
        booking_mode: 'BEDS_ONLY',
        selection_mode: 'CATEGORY',
        sharing_scope: 'MIXED',
        beds: [
          { bed_ref: 'lower', code: 'L', display_label: 'Lower bunk' },
          { bed_ref: 'upper', code: 'U', display_label: 'Upper bunk' },
        ],
      }),
    ),
  );
  expect(
    plan.resources
      .filter((r) => r.sellable)
      .map((r) => [r.code, r.displayLabel, r.capacity]),
  ).toEqual([
    ['V1-L', 'Lower bunk', 1],
    ['V1-U', 'Upper bunk', 1],
  ]);
});
test.each([
  {
    sharing_scope: 'FEMALE',
    physical_template: 'DORM',
    booking_mode: 'BEDS_ONLY',
    selection_mode: 'CATEGORY',
  },
  { booking_mode: 'HOURLY' },
  { physical_template: 'SITE', pooled_capacity: 100 },
  {
    physical_template: 'VILLA',
    booking_mode: 'WHOLE_AND_PARTS',
    selection_mode: 'CATEGORY',
  },
])(
  'unsupported policy/mode rejects instead of silently approximating %j',
  (extra) => {
    expect(() => buildSetupPlanV2(input(single(extra)))).toThrow();
  },
);
test('connected suite rejects missing acknowledgement and accidentally supplied units', () => {
  const plan = buildSetupPlanV2(
    input(
      single({
        physical_template: 'SUITE_CONNECTED',
        booking_mode: 'CONNECTED_UNITS',
      }),
    ),
  );
  expect(plan.blockers.map((b) => b.code)).toEqual(
    expect.arrayContaining([
      'minimum_two',
      'required',
      'connections_do_not_create_units',
    ]),
  );
  expect(plan.resources).toEqual([]);
});
