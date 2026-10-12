import {
  parseSetupV2,
  setupV2HashInput,
} from '../packages/backend/src/modules/property/domain/setup-v2.js';

const input = () => ({
  schema_version: 2,
  property: { name: null },
  locations: [],
  unit_groups: [],
  operations: {},
  pricing: null,
});
test('v2 leaves omitted values unknown and preserves explicit zero/null', () => {
  const source = {
    ...input(),
    unit_groups: [
      {
        group_ref: 'a',
        physical_template: 'VILLA',
        details: { bedrooms_count: 0 },
        capacity: null,
      },
    ],
  };
  expect(parseSetupV2(source)).toEqual(source);
  expect(parseSetupV2(source).unit_groups[0]).not.toHaveProperty(
    'booking_mode',
  );
});
test.each([
  ['ROOM', 'WHOLE_ONLY', 'CATEGORY'],
  ['HOUSE', 'WHOLE_ONLY', 'EXACT'],
  ['SUITE_STANDALONE', 'WHOLE_ONLY', 'EXACT'],
  ['VILLA', 'PARTS_ONLY', 'EXACT'],
  ['APARTMENT', 'WHOLE_AND_PARTS', 'EXACT'],
  ['DORM', 'BEDS_ONLY', 'CATEGORY'],
  ['DORM', 'BEDS_AND_PRIVATE', 'CATEGORY'],
  ['SUITE_CONNECTED', 'CONNECTED_UNITS', 'EXACT'],
])(
  'draft accepts supported matrix %s/%s/%s without claiming readiness',
  (physical_template, booking_mode, selection_mode) => {
    expect(() =>
      parseSetupV2({
        ...input(),
        unit_groups: [
          { group_ref: 'g', physical_template, booking_mode, selection_mode },
        ],
      }),
    ).not.toThrow();
  },
);
test.each([
  ['ROOM', 'BEDS_ONLY', 'CATEGORY'],
  ['DORM', 'WHOLE_ONLY', 'EXACT'],
  ['TENT', 'PARTS_ONLY', 'EXACT'],
  ['SUITE_STANDALONE', 'CONNECTED_UNITS', 'EXACT'],
  ['SUITE_CONNECTED', 'WHOLE_ONLY', 'EXACT'],
  ['VILLA', 'WHOLE_AND_PARTS', 'CATEGORY'],
  ['DORM', 'BEDS_ONLY', 'EXACT'],
])(
  'contradictory matrix %s/%s/%s fails closed',
  (physical_template, booking_mode, selection_mode) => {
    expect(() =>
      parseSetupV2({
        ...input(),
        unit_groups: [
          { group_ref: 'g', physical_template, booking_mode, selection_mode },
        ],
      }),
    ).toThrow('SETUP_DRAFT_INVALID');
  },
);
test('null count and explicit beds are still mutually exclusive', () => {
  expect(() =>
    parseSetupV2({
      ...input(),
      unit_groups: [
        {
          group_ref: 'g',
          physical_template: 'DORM',
          beds_per_unit: null,
          beds: [],
        },
      ],
    }),
  ).toThrow('SETUP_DRAFT_INVALID');
});
test('duplicate generated codes across explicit and numbered groups are rejected', () => {
  expect(() =>
    parseSetupV2({
      ...input(),
      unit_groups: [
        { group_ref: 'a', physical_template: 'ROOM', pattern: '101-102' },
        {
          group_ref: 'b',
          physical_template: 'ROOM',
          units: [{ unit_ref: 'u', code: '102', display_label: '102' }],
        },
      ],
    }),
  ).toThrow('SETUP_DRAFT_INVALID');
});
test('unknown server fields, unsupported versions and invalid calendar dates are rejected', () => {
  for (const extra of [
    { completed: true },
    { schema_version: 1 },
    { draft_id: 'fake' },
    { pricing: { postponed: false, sell_from: '2026-02-30' } },
  ])
    expect(() => parseSetupV2({ ...input(), ...extra })).toThrow(
      'SETUP_DRAFT_INVALID',
    );
});

test('hash canonicalizes location order without changing stored input or explicit display order', () => {
  const source = parseSetupV2({
    ...input(),
    locations: ['b', 'a'].map((client_ref) => ({
      client_ref,
      code: client_ref,
      name: client_ref,
      kind: 'BUILDING',
      display_order: 0,
    })),
  });
  const reversed = { ...source, locations: [...source.locations].reverse() };
  expect(setupV2HashInput(source)).toEqual(setupV2HashInput(reversed));
  expect(source.locations.map((l) => l.client_ref)).toEqual(['b', 'a']);
  expect(setupV2HashInput(source)).not.toEqual(
    setupV2HashInput({
      ...source,
      locations: source.locations.map((l) => ({ ...l, display_order: 2 })),
    }),
  );
});
