import { proposeSetupDraftUpgrade } from '../packages/backend/src/modules/property/domain/setup-upgrade.js';
import type { SetupDraftInput } from '../packages/backend/src/modules/property/domain/setup.js';

function input(): SetupDraftInput {
  return {
    property: { name: null, timezone: null, base_currency: null },
    unit_groups: [
      {
        id: null,
        template_code: 'ROOM',
        pattern: '101-103',
        exclusions: ['102'],
        rental_mode: 'EXCLUSIVE',
        capacity: 2,
      },
    ],
    operations: { check_in: null, explicit_states: false },
    pricing: null,
  };
}

test('legacy whole units stay one category with exact exclusions and null/omitted semantics', () => {
  const source = input();
  const result = proposeSetupDraftUpgrade(source, false);
  expect(result.status).toBe('PROPOSED');
  if (result.status !== 'PROPOSED') throw new Error('proposal expected');
  expect(result.candidate.property).toEqual(source.property);
  expect(result.candidate.property).not.toHaveProperty('country');
  expect(result.candidate.pricing).toBeNull();
  expect(result.candidate.unit_groups[0]).toMatchObject({
    legacy_id: null,
    booking_mode: 'WHOLE_ONLY',
    selection_mode: 'CATEGORY',
    pattern: '101-103',
    exclusions: ['102'],
  });
  expect(result.candidate.unit_groups[0]).not.toHaveProperty('details');
  result.candidate.unit_groups[0]!.exclusions!.push('101');
  expect(source.unit_groups[0]!.exclusions).toEqual(['102']);
  expect(result.original).toEqual(source);
});

test('completed draft is read only even when incomplete or ambiguous', () => {
  const source = input();
  source.unit_groups[0]!.capacity = null;
  expect(proposeSetupDraftUpgrade(source, true)).toEqual({
    status: 'READ_ONLY',
    original: source,
    candidate: null,
    issues: [],
  });
});

test.each([null, undefined])(
  'legacy default capacity %s requires review without inventing a value',
  (capacity) => {
    const source = input();
    if (capacity === undefined) delete source.unit_groups[0]!.capacity;
    else source.unit_groups[0]!.capacity = capacity;
    const result = proposeSetupDraftUpgrade(source, false);
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.candidate).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'LEGACY_CAPACITY_REVIEW_REQUIRED' }),
    );
    expect(result.original).toEqual(source);
    expect(Object.hasOwn(result.original.unit_groups[0]!, 'capacity')).toBe(
      capacity !== undefined,
    );
  },
);

test('parts keep explicit leaves and full capacity without creating a whole resource', () => {
  const source = input();
  source.unit_groups = [
    {
      template_code: 'VILLA',
      pattern: '1-1',
      rental_mode: 'WHOLE_OR_PARTS',
      capacity: 4,
      privacy_ack: true,
      parts: [
        { label: 'A', capacity: 2 },
        { label: 'B', capacity: 2 },
      ],
    },
  ];
  const result = proposeSetupDraftUpgrade(source, false);
  expect(result.status).toBe('PROPOSED');
  expect(result.candidate?.unit_groups[0]).toMatchObject({
    physical_template: 'VILLA',
    booking_mode: 'WHOLE_AND_PARTS',
    selection_mode: 'EXACT',
    capacity: 4,
    parts: [
      { code: 'A', capacity: 2 },
      { code: 'B', capacity: 2 },
    ],
  });
});

test('multiroom legacy bed pool cannot silently split into per-room pools', () => {
  const source = input();
  source.unit_groups = [
    {
      template_code: 'DORM',
      pattern: '1-2',
      rental_mode: 'BEDS',
      capacity: 4,
      beds_per_unit: 4,
      sharing_scope: 'MIXED',
    },
  ];
  const result = proposeSetupDraftUpgrade(source, false);
  expect(result.status).toBe('REVIEW_REQUIRED');
  expect(result.candidate).toBeNull();
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: 'LEGACY_CROSS_ROOM_BED_POOL' }),
  );
});

test('single-room beds preserve private-room sale and explicit capacity', () => {
  const source = input();
  source.unit_groups = [
    {
      template_code: 'DORM',
      pattern: '1-1',
      rental_mode: 'BEDS',
      capacity: 4,
      beds_per_unit: 4,
      sharing_scope: 'MIXED',
    },
  ];
  const result = proposeSetupDraftUpgrade(source, false);
  expect(result.status).toBe('PROPOSED');
  expect(result.candidate?.unit_groups[0]).toMatchObject({
    booking_mode: 'BEDS_AND_PRIVATE',
    selection_mode: 'CATEGORY',
    capacity: 4,
    beds_per_unit: 4,
  });
});

test('legacy suite codes require scoped resolution and never become a standalone suite', () => {
  const source = input();
  source.unit_groups = [
    {
      template_code: 'SUITE',
      pattern: '1-1',
      rental_mode: 'EXCLUSIVE',
      capacity: 4,
      connected_codes: ['101', '102'],
    },
  ];
  const result = proposeSetupDraftUpgrade(source, false);
  expect(result.candidate).toBeNull();
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: 'CONNECTED_RESOURCE_RESOLUTION_REQUIRED' }),
  );
});

test('location codes require scoped lookup instead of fake UUIDs or dropping the location', () => {
  const source = input();
  source.unit_groups[0]!.location_code = 'MAIN';
  const result = proposeSetupDraftUpgrade(source, false);
  expect(result.candidate).toBeNull();
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: 'LOCATION_RESOLUTION_REQUIRED' }),
  );
});

test('restricted sharing never gets downgraded to MIXED', () => {
  const source = input();
  source.unit_groups = [
    {
      template_code: 'DORM',
      pattern: '1-1',
      rental_mode: 'BEDS',
      capacity: 4,
      beds_per_unit: 4,
      sharing_scope: 'FEMALE',
    },
  ];
  const result = proposeSetupDraftUpgrade(source, false);
  expect(result.candidate).toBeNull();
  expect(result.original.unit_groups[0]!.sharing_scope).toBe('FEMALE');
});

test('empty incomplete draft can be proposed but proposal is not readiness', () => {
  const source = input();
  source.unit_groups = [];
  delete source.pricing;
  const result = proposeSetupDraftUpgrade(source, false);
  expect(result.status).toBe('PROPOSED');
  expect(result.candidate).not.toHaveProperty('pricing');
  expect(result.candidate?.unit_groups).toEqual([]);
});
