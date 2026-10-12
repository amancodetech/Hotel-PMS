import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let tenantA;
let admin;
let auditor;

const runId = Date.now().toString(36);
const key = (name) => `set05-${runId}-${name}`;

const baseDraft = (overrides = {}) => ({
  property: {
    name: 'SET-05 Property',
    code: `SET05-${runId.toUpperCase()}`,
    country: 'Indonesia',
    timezone: 'Asia/Jakarta',
    base_currency: 'IDR',
    types: ['ROOM'],
  },
  unit_groups: [
    {
      template_code: 'ROOM',
      pattern: '101-102',
      exclusions: [],
      capacity: 2,
      rental_mode: 'EXCLUSIVE',
    },
  ],
  operations: {
    check_in: '14:00',
    check_out: '12:00',
    inspection_required: false,
    explicit_states: true,
  },
  pricing: { postponed: true },
  ...overrides,
});

function addDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createProperty(code, name) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    { body: { code, name, timezone: 'Asia/Jakarta' } },
  );
  expect(created.status).toBe(201);
  return created.body.property;
}

async function getDraft(target) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
  );
  expect(response.status).toBe(200);
  return response.body.draft;
}

async function saveDraft(target, body, name, ifMatch = undefined) {
  const headers = { 'idempotency-key': key(name) };
  if (ifMatch !== undefined) headers['if-match'] = ifMatch;
  const response = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
    { body, headers },
  );
  expect(response.status).toBe(200);
  return response.body.draft;
}

async function preview(target) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft/preview`,
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function apply(target, previewVersion, name, revision) {
  const draft = await getDraft(target);
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft/apply`,
    {
      body: { preview_version: previewVersion },
      headers: {
        'idempotency-key': key(name),
        'if-match': `"${draft.draft_id}:${revision}"`,
      },
    },
  );
  return response;
}

async function applyDraft(target, body, name) {
  const draft = await saveDraft(target, body, `${name}-save`);
  const ready = await preview(target);
  expect(ready.blockers).toEqual([]);
  const applied = await apply(
    target,
    ready.preview_version,
    `${name}-apply`,
    draft.revision,
  );
  expect(applied.status).toBe(200);
  return applied.body.result;
}

async function resources(target) {
  const response = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/resources?limit=100`,
  );
  expect(response.status).toBe(200);
  return response.body.items;
}

async function products(target) {
  const response = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/products`,
  );
  expect(response.status).toBe(200);
  return response.body.items;
}

async function inventoryVersion(target) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/rates?from=${addDays(1)}&to=${addDays(2)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function hold(target, productId, name, options = {}) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/holds`,
    {
      body: {
        items: [
          {
            product_id: productId,
            period: {
              arrival: options.arrival ?? addDays(10),
              departure: options.departure ?? addDays(12),
            },
            occupancy: { adults: options.adults ?? 2, child_ages: [] },
            quantity: 1,
          },
        ],
        inventory_version:
          options.version !== undefined
            ? options.version
            : await inventoryVersion(target),
        ttl_seconds: 300,
      },
      headers: { 'idempotency-key': key(name) },
    },
  );
}

async function releaseHold(target, holdId) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/holds/${holdId}/release`,
  );
  expect(response.status).toBe(200);
}

async function activeHolds(target) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/holds`,
  );
  expect(response.status).toBe(200);
  return response.body.items.filter((hold) => hold.state === 'ACTIVE');
}

async function blockResource(target, resourceId, name, period) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/blocks`,
    {
      body: {
        resource_ids: [resourceId],
        period,
        reason: `SET-05 ${name}`,
        mode: 'PLANNED',
      },
    },
  );
}

async function releaseBlock(target, blockId) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/blocks/${blockId}/release`,
    { body: { reason: `SET-05 release ${blockId.slice(0, 8)}` } },
  );
  expect(response.status).toBe(200);
  return response;
}

async function setMaintenance(target, resourceId, version, state) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/resources/${resourceId}/maintenance`,
    {
      body: {
        version,
        state,
        reason: `SET-05 ${state} synthetic check`,
      },
    },
  );
}

async function createEmergencyWorkOrder(target, resourceId, name, period) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/work-orders`,
    {
      body: {
        resource_id: resourceId,
        category: 'SAFETY',
        severity: 'CRITICAL',
        impact: 'OOO',
        emergency: true,
        description: `SET-05 ${name}`,
        period,
      },
      headers: { 'idempotency-key': key(`work-order-${name}`) },
    },
  );
}

async function addCandidate(target, productId, resourceId) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/products/${productId}/candidates`,
    { body: { resource_id: resourceId } },
  );
}

async function readiness(target) {
  return apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/setup-readiness`,
  );
}

async function simulate(
  target,
  scope,
  unitCode,
  from = addDays(10),
  to = addDays(12),
) {
  return apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/setup-simulation?scope=${scope}&unit_code=${encodeURIComponent(unitCode)}&from=${from}&to=${to}`,
  );
}

const villaPartsDraft = (property, groupOverrides = {}) =>
  baseDraft({
    property: {
      name: property.name,
      code: property.code.toUpperCase(),
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['VILLA'],
    },
    unit_groups: [
      {
        template_code: 'VILLA',
        pattern: '1-2',
        capacity: 4,
        rental_mode: 'WHOLE_OR_PARTS',
        privacy_ack: true,
        parts: [
          { label: 'A', capacity: 2 },
          { label: 'B', capacity: 2 },
        ],
        ...groupOverrides,
      },
    ],
  });

const dormRaceDraft = (property) =>
  baseDraft({
    property: {
      name: property.name,
      code: property.code.toUpperCase(),
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['DORM'],
    },
    unit_groups: [
      {
        template_code: 'DORM',
        pattern: '101-101',
        capacity: 3,
        rental_mode: 'BEDS',
        sharing_scope: 'MIXED',
        beds_per_unit: 3,
      },
    ],
  });

const dormDraft = (property) =>
  baseDraft({
    property: {
      name: property.name,
      code: property.code.toUpperCase(),
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['DORM'],
    },
    unit_groups: [
      {
        template_code: 'DORM',
        pattern: '101-102',
        capacity: 3,
        rental_mode: 'BEDS',
        sharing_scope: 'MIXED',
        beds_per_unit: 3,
      },
    ],
  });

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  auditor = await loginAs('auditor-a');
  tenantA = admin.session.body.session.active_tenant_id;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('parts: explicit components create compositions without a phantom whole resource', async () => {
  const property = await createProperty(`SET05-P1-${runId}`, 'SET-05 parts');
  const ready = await preview(
    await (async () => {
      await saveDraft(property, villaPartsDraft(property), 'parts-save');
      return property;
    })(),
  );
  expect(ready.blockers).toEqual([]);
  expect(ready.warnings).toEqual([]);
  const template = ready.generated.by_template.find(
    (entry) => entry.template_code === 'VILLA',
  );
  expect(template).toMatchObject({
    units: 2,
    parts: 4,
    rooms: 4,
    compositions: 2,
  });
  const draft = await getDraft(property);
  const applied = await apply(
    property,
    ready.preview_version,
    'parts',
    draft.revision,
  );
  expect(applied.status).toBe(200);
  expect(applied.body.result).toMatchObject({
    created_units: 4,
    created_compositions: 2,
    created_products: 6,
  });
  const codes = (await resources(property)).map((row) => row.code).sort();
  expect(codes).toEqual(['1-A', '1-B', '2-A', '2-B']);
  const items = products(property);
  const whole = (await items).find((row) => row.code === 'SETUP-VILLA-1');
  const part = (await items).find((row) => row.code === 'SETUP-VILLA-1-A');
  expect(whole).toBeTruthy();
  expect(part).toBeTruthy();

  const wholeHold = await hold(property, whole.id, 'parts-whole', {
    adults: 4,
  });
  expect(wholeHold.status).toBe(201);
  const partHold = await hold(property, part.id, 'parts-part');
  expect(partHold.status).toBe(409);
  expect(partHold.body.code).toBe('RESOURCE_UNAVAILABLE');
  const sibling = (await items).find((row) => row.code === 'SETUP-VILLA-1-B');
  const siblingHold = await hold(property, sibling.id, 'parts-sibling');
  expect(siblingHold.status).toBe(409);
});

test('parts: concurrent whole and part holds leave exactly one active hold', async () => {
  const property = await createProperty(`SET05-P2-${runId}`, 'SET-05 race');
  await applyDraft(property, villaPartsDraft(property), 'parts-race');
  const items = await products(property);
  const whole = items.find((row) => row.code === 'SETUP-VILLA-1');
  const part = items.find((row) => row.code === 'SETUP-VILLA-1-A');
  const version = await inventoryVersion(property);
  const [wholeHold, partHold] = await Promise.all([
    hold(property, whole.id, 'race-whole', { adults: 4, version }),
    hold(property, part.id, 'race-part', { version }),
  ]);
  const statuses = [wholeHold.status, partHold.status].sort();
  expect(statuses[0]).toBe(201);
  expect([409, 412]).toContain(statuses[1]);
  expect(await activeHolds(property)).toHaveLength(1);
  const loser = wholeHold.status === 201 ? part : whole;
  const retry = await hold(property, loser.id, 'race-loser-retry', {
    adults: loser === whole ? 4 : 2,
  });
  expect(retry.status).toBe(409);
  expect(retry.body.code).toBe('RESOURCE_UNAVAILABLE');
});

test('parts: one blocked night blocks the whole composition for the full stay', async () => {
  const property = await createProperty(`SET05-P3-${runId}`, 'SET-05 block');
  await applyDraft(property, villaPartsDraft(property), 'parts-block');
  const items = await products(property);
  const whole = items.find((row) => row.code === 'SETUP-VILLA-1');
  const partResource = (await resources(property)).find(
    (row) => row.code === '1-A',
  );
  const blocked = await blockResource(property, partResource.id, 'part-night', {
    arrival: addDays(11),
    departure: addDays(12),
  });
  expect(blocked.status).toBe(201);
  const wholeHold = await hold(property, whole.id, 'parts-blocked', {
    adults: 4,
  });
  expect(wholeHold.status).toBe(409);
  expect(wholeHold.body.code).toBe('RESOURCE_UNAVAILABLE');
  expect(wholeHold.body.details.reason_codes).toContain('BLOCKED');
});

test('beds: parent rooms hold real sellable beds without doubling inventory', async () => {
  const property = await createProperty(`SET05-P4-${runId}`, 'SET-05 beds');
  const applied = await applyDraft(property, dormDraft(property), 'beds');
  expect(applied).toMatchObject({
    created_units: 8,
    created_compositions: 2,
    created_products: 3,
  });
  const codes = (await resources(property)).map((row) => row.code).sort();
  expect(codes).toEqual([
    '101',
    '101-B1',
    '101-B2',
    '101-B3',
    '102',
    '102-B1',
    '102-B2',
    '102-B3',
  ]);
  const items = await products(property);
  expect(new Set(items.map((row) => row.kind))).toEqual(
    new Set(['BED', 'ROOM']),
  );
  const bedProduct = items.find((row) => row.code === 'SETUP-BED-101');
  expect(bedProduct.sharing_scope).toBe('MIXED');
  expect(bedProduct.occupancy_adults_max).toBe(1);
  const roomProduct = items.find((row) => row.code === 'SETUP-DORM-101');

  const roomHold = await hold(property, roomProduct.id, 'beds-room', {
    adults: 3,
  });
  expect(roomHold.status).toBe(201);
  const bedHold = await hold(property, bedProduct.id, 'beds-bed');
  expect(bedHold.status).toBe(409);
  const roomTwo = items.find((row) => row.code === 'SETUP-DORM-102');
  const roomTwoHold = await hold(property, roomTwo.id, 'beds-room-2', {
    adults: 2,
  });
  expect(roomTwoHold.status).toBe(201);
  const sibling = await hold(property, bedProduct.id, 'beds-sibling', {
    adults: 1,
  });
  expect(sibling.status).toBe(409);
});

test('beds: concurrent bed and whole-room holds leave exactly one active hold', async () => {
  const property = await createProperty(
    `SET05-P5-${runId}`,
    'SET-05 beds race',
    ['DORM'],
  );
  await applyDraft(property, dormRaceDraft(property), 'beds-race');
  const items = await products(property);
  const bedProduct = items.find((row) => row.code === 'SETUP-BED-101');
  const roomProduct = items.find((row) => row.code === 'SETUP-DORM-101');
  const version = await inventoryVersion(property);
  const [room, bed] = await Promise.all([
    hold(property, roomProduct.id, 'race-room', { adults: 3, version }),
    hold(property, bedProduct.id, 'race-bed', { adults: 1, version }),
  ]);
  const statuses = [room.status, bed.status].sort();
  expect(statuses[0]).toBe(201);
  expect([409, 412]).toContain(statuses[1]);
  expect(await activeHolds(property)).toHaveLength(1);
  const loser = room.status === 201 ? bedProduct : roomProduct;
  const retry = await hold(
    property,
    loser.id,
    'race-loser-retry',
    loser === roomProduct ? { adults: 3 } : { adults: 1 },
  );
  expect(retry.status).toBe(409);
  expect(retry.body.code).toBe('RESOURCE_UNAVAILABLE');
});

// Existing inventory fixtures are created independently: a completed setup
// draft is immutable under PSR and must not be recycled to add suites.
async function existingInventory(target, unitSpecs, productSpecs) {
  const ids = new Map();
  for (const spec of unitSpecs) {
    const created = await apiRequest(
      admin.context,
      'POST',
      `/tenants/${tenantA}/properties/${target.id}/resources`,
      { body: { code: spec.code, type: spec.type, capacity: spec.capacity } },
    );
    expect(created.status).toBe(201);
    ids.set(spec.code, created.body.resource.id);
    if (spec.parent) {
      await withOwner((client) =>
        client.query(
          'update resource set parent_resource_id=$1 where id=$2 and tenant_id=$3 and property_id=$4',
          [ids.get(spec.parent), created.body.resource.id, tenantA, target.id],
        ),
      );
    }
  }
  for (const spec of productSpecs) {
    const created = await apiRequest(
      admin.context,
      'POST',
      `/tenants/${tenantA}/properties/${target.id}/products`,
      {
        body: {
          code: spec.code,
          name: spec.code,
          kind: spec.kind,
          occupancy_adults_max: spec.capacity,
        },
      },
    );
    expect(created.status).toBe(201);
    const product = created.body.product;
    for (const code of spec.candidates)
      expect(
        (await addCandidate(target, product.id, ids.get(code))).status,
      ).toBe(201);
    const active = await apiRequest(
      admin.context,
      'PATCH',
      `/tenants/${tenantA}/properties/${target.id}/products/${product.id}`,
      { body: { version: product.version, status: 'ACTIVE' } },
    );
    expect(active.status).toBe(200);
  }
}

test('suite: links existing rooms, creates no resource and shares exclusivity', async () => {
  const property = await createProperty(`SET05-P6-${runId}`, 'SET-05 suite');
  await existingInventory(
    property,
    ['201', '202', '203'].map((code) => ({ code, type: 'ROOM', capacity: 2 })),
    [
      {
        code: 'SETUP-ROOM-201',
        kind: 'ROOM',
        capacity: 2,
        candidates: ['201', '202', '203'],
      },
    ],
  );
  const before = (await resources(property)).map((row) => row.code).sort();
  const suiteDraft = baseDraft({
    property: {
      name: property.name,
      code: property.code.toUpperCase(),
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['SUITE'],
    },
    unit_groups: [
      {
        template_code: 'SUITE',
        pattern: '1-1',
        capacity: 4,
        rental_mode: 'EXCLUSIVE',
        connected_codes: ['201', '202'],
      },
      {
        template_code: 'SUITE',
        pattern: '3-3',
        capacity: 4,
        rental_mode: 'EXCLUSIVE',
        connected_codes: ['202', '203'],
      },
    ],
  });
  await saveDraft(property, suiteDraft, 'suite-save');
  const ready = await preview(property);
  expect(ready.blockers).toEqual([]);
  const draft = await getDraft(property);
  const applied = await apply(
    property,
    ready.preview_version,
    'suite',
    draft.revision,
  );
  expect(applied.status).toBe(200);
  expect(applied.body.result.created_units).toBe(0);
  expect(applied.body.result.created_compositions).toBe(2);
  expect((await resources(property)).map((row) => row.code).sort()).toEqual(
    before,
  );
  const items = await products(property);
  const suiteOne = items.find((row) => row.code === 'SETUP-SUITE-1');
  const suiteThree = items.find((row) => row.code === 'SETUP-SUITE-3');
  const room201 = items.find((row) => row.code === 'SETUP-ROOM-201');

  const suiteHold = await hold(property, suiteOne.id, 'suite-hold', {
    adults: 4,
  });
  expect(suiteHold.status).toBe(201);
  const groupHold = await hold(property, room201.id, 'suite-room');
  expect(groupHold.status).toBe(201);
  const exhausted = await hold(property, room201.id, 'suite-exhausted');
  expect(exhausted.status).toBe(409);
  await releaseHold(property, suiteHold.body.hold.id);
  const suiteThreeHold = await hold(property, suiteThree.id, 'suite-three', {
    adults: 4,
  });
  expect(suiteThreeHold.status).toBe(409);
  const blockedSuite = await simulate(property, 'WHOLE', '3');
  expect(blockedSuite.body.allowed).toBe(false);
  await releaseHold(property, groupHold.body.hold.id);
  const roomHold = await hold(property, room201.id, 'suite-room-again');
  expect(roomHold.status).toBe(201);
  const suiteOneAgain = await hold(property, suiteOne.id, 'suite-one-again', {
    adults: 4,
  });
  expect(suiteOneAgain.status).toBe(409);
});

test('suite: missing and cross-property codes are refused before any write', async () => {
  const property = await createProperty(`SET05-P7-${runId}`, 'SET-05 links');
  const other = await createProperty(`SET05-P7B-${runId}`, 'SET-05 other');
  await applyDraft(
    other,
    baseDraft({
      property: {
        name: other.name,
        code: other.code.toUpperCase(),
        country: 'Indonesia',
        timezone: 'Asia/Jakarta',
        base_currency: 'IDR',
        types: ['ROOM'],
      },
      unit_groups: [
        {
          template_code: 'ROOM',
          pattern: '301-302',
          capacity: 2,
          rental_mode: 'EXCLUSIVE',
        },
      ],
    }),
    'links-other',
  );
  const suiteDraft = baseDraft({
    property: {
      name: property.name,
      code: property.code.toUpperCase(),
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['SUITE'],
    },
    unit_groups: [
      {
        template_code: 'SUITE',
        pattern: '1-1',
        capacity: 4,
        rental_mode: 'EXCLUSIVE',
        connected_codes: ['301', '303'],
      },
    ],
  });
  await saveDraft(property, suiteDraft, 'links-save');
  const ready = await preview(property);
  const draft = await getDraft(property);
  const rejected = await apply(
    property,
    ready.preview_version,
    'links-apply',
    draft.revision,
  );
  expect(rejected.status).toBe(422);
  expect(rejected.body.code).toBe('CROSS_SCOPE_REFERENCE');
  expect(rejected.body.details.codes).toEqual(['301', '303']);
  expect(await resources(property)).toEqual([]);

  const duplicate = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
    {
      body: baseDraft({
        property: {
          name: property.name,
          code: property.code.toUpperCase(),
          country: 'Indonesia',
          timezone: 'Asia/Jakarta',
          base_currency: 'IDR',
          types: ['SUITE'],
        },
        unit_groups: [
          {
            template_code: 'SUITE',
            pattern: '1-1',
            rental_mode: 'EXCLUSIVE',
            connected_codes: ['301', '301'],
          },
        ],
      }),
      headers: {
        'idempotency-key': key('links-duplicate'),
        'if-match': `"${draft.draft_id}:${draft.revision}"`,
      },
    },
  );
  expect(duplicate.status).toBe(422);
  expect(duplicate.body.code).toBe('SETUP_DRAFT_INVALID');
  expect(
    duplicate.body.details.issues.some(
      (issue) => issue.code === 'connection_duplicate',
    ),
  ).toBe(true);
});

test('readiness reports gaps without writing or changing state', async () => {
  const property = await createProperty(`SET05-P8-${runId}`, 'SET-05 ready');
  const before = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}`,
  );
  await saveDraft(
    property,
    baseDraft({
      property: {
        name: property.name,
        code: property.code.toUpperCase(),
        country: 'Indonesia',
        timezone: null,
        base_currency: null,
        types: ['VILLA'],
      },
      unit_groups: [
        {
          template_code: 'VILLA',
          pattern: '1-1',
          rental_mode: 'WHOLE_OR_PARTS',
          privacy_ack: true,
        },
      ],
    }),
    'ready-partial',
  );
  const gaps = await readiness(property);
  expect(gaps.status).toBe(200);
  expect(gaps.body.ready).toBe(false);
  expect(gaps.body.checked_at).toBeTruthy();
  expect(gaps.body.draft_revision).toBe(1);
  expect(gaps.body.missing.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(['timezone_required', 'parts_required']),
  );
  const after = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}`,
  );
  expect(after.body.property.inventory_version).toBe(
    before.body.property.inventory_version,
  );

  const empty = await createProperty(`SET05-P9-${runId}`, 'SET-05 no draft');
  const noDraft = await readiness(empty);
  expect(noDraft.status).toBe(404);
  expect(noDraft.body.code).toBe('SETUP_DRAFT_MISSING');
});

test('simulation is read-only and reports whole, part and bed exclusivity', async () => {
  const villa = await createProperty(`SET05-PA-${runId}`, 'SET-05 sim');
  await applyDraft(villa, villaPartsDraft(villa), 'sim-villa');
  const villaVersionBefore = await inventoryVersion(villa);
  const whole = await simulate(villa, 'WHOLE', '1');
  expect(whole.status).toBe(200);
  expect(whole.body).toMatchObject({ allowed: true, available_after: [] });
  expect(whole.body.blocked.map((row) => row.code).sort()).toEqual([
    '1-A',
    '1-B',
  ]);
  const part = await simulate(villa, 'PART', '1-A');
  expect(part.status).toBe(200);
  expect(part.body.allowed).toBe(true);
  expect(part.body.blocked).toEqual([{ kind: 'WHOLE', code: '1' }]);
  expect(part.body.available_after).toEqual(['1-B']);
  expect(await inventoryVersion(villa)).toBe(villaVersionBefore);
  expect(await activeHolds(villa)).toHaveLength(0);

  const items = await products(villa);
  const partProduct = items.find((row) => row.code === 'SETUP-VILLA-1-A');
  const held = await hold(villa, partProduct.id, 'sim-part');
  expect(held.status).toBe(201);
  const blockedPart = await simulate(villa, 'PART', '1-A');
  expect(blockedPart.body.allowed).toBe(false);
  expect(blockedPart.body.available_after).toEqual([]);
  const blockedWhole = await simulate(villa, 'WHOLE', '1');
  expect(blockedWhole.body.allowed).toBe(false);

  const dorm = await createProperty(`SET05-PB-${runId}`, 'SET-05 sim beds');
  await applyDraft(dorm, dormDraft(dorm), 'sim-beds');
  const bed = await simulate(dorm, 'BED', '101-B1');
  expect(bed.status).toBe(200);
  expect(bed.body.allowed).toBe(true);
  expect(bed.body.blocked).toEqual([{ kind: 'ROOM', code: '101' }]);
  expect(bed.body.available_after).toEqual(['101-B2', '101-B3']);

  const missing = await simulate(dorm, 'PART', 'does-not-exist');
  expect(missing.status).toBe(404);
  expect(missing.body.code).toBe('NOT_FOUND');
});

test('import: templates that CSV cannot represent stay explicitly refused', async () => {
  const property = await createProperty(`SET05-PC-${runId}`, 'SET-05 import');
  const content = [
    'code,template,capacity,location',
    'V901,VILLA,4,',
    'D901,DORM,4,',
    'S901,SUITE,4,',
  ].join('\n');
  const dry = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/setup-unit-imports`,
    {
      body: { mode: 'DRY_RUN', file_name: 'set05.csv', content },
      headers: { 'idempotency-key': key('import-dry') },
    },
  );
  expect(dry.status).toBe(200);
  expect(dry.body.totals).toEqual({
    rows: 3,
    accepted: 1,
    rejected: 2,
    duplicates: 0,
    created: 0,
  });
  expect(dry.body.rows.map((row) => row.error_code)).toEqual([
    null,
    'TEMPLATE_UNSUPPORTED',
    'TEMPLATE_UNSUPPORTED',
  ]);
});

test('SET05-R2-R01 parent rooms cannot be reused as suite units or candidates', async () => {
  const property = await createProperty(`SET05-R1-${runId}`, 'SET-05 R01');
  await existingInventory(
    property,
    [
      { code: '101', type: 'ROOM', capacity: 2 },
      { code: '101-B1', type: 'BED', capacity: 1, parent: '101' },
      { code: '101-B2', type: 'BED', capacity: 1, parent: '101' },
      { code: '201', type: 'ROOM', capacity: 2 },
    ],
    [
      {
        code: 'SETUP-ROOM-201',
        kind: 'ROOM',
        capacity: 2,
        candidates: ['201'],
      },
      {
        code: 'SETUP-BED-101',
        kind: 'BED',
        capacity: 1,
        candidates: ['101-B1', '101-B2'],
      },
    ],
  );
  const items = await products(property);
  const room201 = items.find((row) => row.code === 'SETUP-ROOM-201');
  const bedProduct = items.find((row) => row.code === 'SETUP-BED-101');
  const rows = await resources(property);
  const parent = rows.find((row) => row.code === '101');

  const suiteDraft = baseDraft({
    property: {
      name: property.name,
      code: property.code.toUpperCase(),
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['SUITE'],
    },
    unit_groups: [
      {
        template_code: 'SUITE',
        pattern: '9-9',
        capacity: 4,
        rental_mode: 'EXCLUSIVE',
        connected_codes: ['101', '201'],
      },
    ],
  });
  await saveDraft(property, suiteDraft, 'r01-suite-save');
  const ready = await preview(property);
  const draft = await getDraft(property);
  const rejected = await apply(
    property,
    ready.preview_version,
    'r01-suite-apply',
    draft.revision,
  );
  expect(rejected.status).toBe(409);
  expect(rejected.body.code).toBe('RESOURCE_HAS_CHILDREN');

  const candidate = await addCandidate(property, room201.id, parent.id);
  expect(candidate.status).toBe(409);
  expect(candidate.body.code).toBe('RESOURCE_HAS_CHILDREN');

  const bedHold = await hold(property, bedProduct.id, 'r01-bed', {
    adults: 1,
  });
  expect(bedHold.status).toBe(201);
});

test('SET05-R2-R02 blocking or maintaining the parent room controls its beds', async () => {
  const property = await createProperty(`SET05-R2-${runId}`, 'SET-05 R02');
  await applyDraft(property, dormRaceDraft(property), 'r02-base');
  const items = await products(property);
  const bedProduct = items.find((row) => row.code === 'SETUP-BED-101');
  const rows = await resources(property);
  const parent = rows.find((row) => row.code === '101');
  const bedTwo = rows.find((row) => row.code === '101-B2');

  const parentBlock = await blockResource(property, parent.id, 'parent', {
    arrival: addDays(10),
    departure: addDays(12),
  });
  expect(parentBlock.status).toBe(201);
  const blockedHold = await hold(property, bedProduct.id, 'r02-hold', {
    adults: 1,
  });
  expect(blockedHold.status).toBe(409);
  expect(blockedHold.body.code).toBe('RESOURCE_UNAVAILABLE');
  expect(blockedHold.body.details.reason_codes).toContain('BLOCKED');

  const bedBlock = await blockResource(property, bedTwo.id, 'bed-two', {
    arrival: addDays(20),
    departure: addDays(22),
  });
  expect(bedBlock.status).toBe(201);
  const siblingSim = await simulate(
    property,
    'BED',
    '101-B1',
    addDays(20),
    addDays(22),
  );
  expect(siblingSim.body.allowed).toBe(true);
  const blockedBedSim = await simulate(
    property,
    'BED',
    '101-B2',
    addDays(20),
    addDays(22),
  );
  expect(blockedBedSim.body.allowed).toBe(false);
  const parentSim = await simulate(
    property,
    'WHOLE',
    '101',
    addDays(20),
    addDays(22),
  );
  expect(parentSim.body.allowed).toBe(false);

  const released = await releaseBlock(property, parentBlock.body.block.id);
  expect(released.status).toBe(200);
  const parentNow = (await resources(property)).find(
    (row) => row.code === '101',
  );
  const maintenance = await setMaintenance(
    property,
    parentNow.id,
    parentNow.version,
    'OOO',
  );
  expect(maintenance.status).toBe(200);
  const maintenanceHold = await hold(property, bedProduct.id, 'r02-maint', {
    adults: 1,
  });
  expect(maintenanceHold.status).toBe(409);
  expect(maintenanceHold.body.details.reason_codes).toContain('MAINTENANCE');
});

test('SET05-R2-R02 emergency work order on a parent covers allocated beds', async () => {
  const property = await createProperty(
    `SET05-R2E-${runId}`,
    'SET-05 R02 emergency',
  );
  await applyDraft(property, dormRaceDraft(property), 'r02e-base');
  const items = await products(property);
  const bedProduct = items.find((row) => row.code === 'SETUP-BED-101');
  const parent = (await resources(property)).find((row) => row.code === '101');
  const occupied = await hold(property, bedProduct.id, 'r02e-bed', {
    adults: 1,
  });
  expect(occupied.status).toBe(201);

  const emergency = await createEmergencyWorkOrder(
    property,
    parent.id,
    'parent emergency',
    { arrival: addDays(10), departure: addDays(12) },
  );
  expect(emergency.status).toBe(201);
  expect(emergency.body.work_order.block_id).toBeTruthy();

  const evidence = await withOwner(async (client) => {
    const blocked = await client.query(
      `select r."code"
         from "inventory_block_resource" br
         join "resource" r on r."id" = br."resource_id"
        where br."block_id" = $1
        order by r."code"`,
      [emergency.body.work_order.block_id],
    );
    const disruptions = await client.query(
      `select count(*)::int as "count"
         from "inventory_disruption"
        where "block_id" = $1`,
      [emergency.body.work_order.block_id],
    );
    return {
      codes: blocked.rows.map((row) => row.code),
      disruptionCount: disruptions.rows[0].count,
    };
  });
  expect(evidence.codes).toEqual(['101', '101-B1', '101-B2', '101-B3']);
  expect(evidence.disruptionCount).toBeGreaterThanOrEqual(1);
});

test('SET05-R2-R03 simulation available_after excludes blocked or maintained siblings', async () => {
  const villa = await createProperty(`SET05-R3-${runId}`, 'SET-05 R03');
  await applyDraft(villa, villaPartsDraft(villa), 'r03-villa');
  const villaRows = await resources(villa);
  const partB = villaRows.find((row) => row.code === '1-B');
  const blocked = await blockResource(villa, partB.id, 'part-b', {
    arrival: addDays(10),
    departure: addDays(12),
  });
  expect(blocked.status).toBe(201);
  const part = await simulate(villa, 'PART', '1-A');
  expect(part.body.allowed).toBe(true);
  expect(part.body.available_after).toEqual([]);

  const dorm = await createProperty(`SET05-R3B-${runId}`, 'SET-05 R03 beds');
  await applyDraft(dorm, dormDraft(dorm), 'r03-dorm');
  const dormRows = await resources(dorm);
  const bedThree = dormRows.find((row) => row.code === '101-B3');
  const bedBlock = await blockResource(dorm, bedThree.id, 'bed-three', {
    arrival: addDays(10),
    departure: addDays(12),
  });
  expect(bedBlock.status).toBe(201);
  const bedSim = await simulate(dorm, 'BED', '101-B1');
  expect(bedSim.body.available_after).toEqual(['101-B2']);
  const bedTwo = dormRows.find((row) => row.code === '101-B2');
  const maintenance = await setMaintenance(
    dorm,
    bedTwo.id,
    bedTwo.version,
    'OOS',
  );
  expect(maintenance.status).toBe(200);
  const bedSimTwo = await simulate(dorm, 'BED', '101-B1');
  expect(bedSimTwo.body.available_after).toEqual([]);
});

test('SET05-R2-O01 whole capacity cannot exceed declared part capacities', async () => {
  const property = await createProperty(`SET05-R4-${runId}`, 'SET-05 O01');
  const saved = await saveDraft(
    property,
    villaPartsDraft(property, {
      capacity: 4,
      parts: [
        { label: 'A', capacity: 1 },
        { label: 'B', capacity: 1 },
      ],
    }),
    'o01-save',
  );
  const ready = await preview(property);
  expect(
    ready.blockers.some((issue) => issue.code === 'capacity_exceeds_parts'),
  ).toBe(true);
  const rejected = await apply(
    property,
    ready.preview_version,
    'o01-apply',
    saved.revision,
  );
  expect(rejected.status).toBe(422);
  expect(rejected.body.code).toBe('SETUP_READINESS_BLOCKED');
  expect(await resources(property)).toEqual([]);
});

test('SET-07.6 restricted sharing scopes are accepted and enforced at sale', async () => {
  const property = await createProperty(
    `SET05-POL-${runId}`,
    'SET-05 restricted sharing policy',
  );
  const draft = dormDraft(property);
  draft.unit_groups[0].sharing_scope = 'FEMALE';
  const saved = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
    {
      body: draft,
      headers: { 'idempotency-key': key('policy-female') },
    },
  );
  expect(saved.status).toBe(200);

  const legacyProperty = await createProperty(
    `SET05-POL2-${runId}`,
    'SET-05 legacy restricted policy',
  );
  await applyDraft(legacyProperty, dormDraft(legacyProperty), 'policy-legacy');
  const bedProduct = (await products(legacyProperty)).find(
    (row) => row.code === 'SETUP-BED-101',
  );
  await withOwner((client) =>
    client.query(
      `update "product" set "sharing_scope" = 'FEMALE' where "id" = $1`,
      [bedProduct.id],
    ),
  );

  // Guest-less availability no longer claims the policy is unenforceable; the
  // binding sale (reservation intake) is where the gender is verified.
  const availableHold = await hold(
    legacyProperty,
    bedProduct.id,
    'policy-legacy-hold',
    { adults: 1 },
  );
  expect(availableHold.status).toBe(201);

  const guest = async (name, gender) => {
    const response = await apiRequest(
      admin.context,
      'POST',
      `/tenants/${tenantA}/guests`,
      {
        body: { full_name: name, ...(gender ? { gender } : {}) },
        headers: { 'idempotency-key': key(`guest-${name}`) },
      },
    );
    expect(response.status).toBe(201);
    return response.body.guest;
  };
  const draftFor = async (guestId, name) =>
    apiRequest(
      admin.context,
      'POST',
      `/tenants/${tenantA}/properties/${legacyProperty.id}/reservations/drafts`,
      {
        body: {
          source: 'DIRECT',
          items: [
            {
              product_id: bedProduct.id,
              period: { arrival: addDays(10), departure: addDays(12) },
              occupancy: { adults: 1, child_ages: [] },
              quantity: 1,
            },
          ],
          guests: guestId ? [{ guest_id: guestId }] : [],
        },
        headers: { 'idempotency-key': key(name) },
      },
    );

  const noGuest = await draftFor(null, 'policy-no-guest');
  expect(noGuest.status).toBe(422);
  expect(noGuest.body.code).toBe('GUEST_GENDER_REQUIRED');

  const unknown = await guest(`SET07 Unknown ${runId}`);
  const unknownDraft = await draftFor(unknown.id, 'policy-unknown');
  expect(unknownDraft.status).toBe(422);
  expect(unknownDraft.body.code).toBe('GUEST_GENDER_REQUIRED');
  expect(unknownDraft.body.details.reason).toBe('gender_unknown');

  const male = await guest(`SET07 Male ${runId}`, 'MALE');
  const maleDraft = await draftFor(male.id, 'policy-male');
  expect(maleDraft.status).toBe(422);
  expect(maleDraft.body.code).toBe('SHARING_POLICY_VIOLATION');
  expect(maleDraft.body.details.scope).toBe('FEMALE');

  const female = await guest(`SET07 Female ${runId}`, 'FEMALE');
  const femaleDraft = await draftFor(female.id, 'policy-female-guest');
  expect(femaleDraft.status).toBe(201);

  // MIXED stays sellable to any declared guest (male here).
  const mixedProperty = await createProperty(
    `SET05-MIX-${runId}`,
    'SET-05 mixed policy',
  );
  await applyDraft(mixedProperty, dormDraft(mixedProperty), 'policy-mixed');
  const mixedBed = (await products(mixedProperty)).find(
    (row) => row.code === 'SETUP-BED-101',
  );
  const mixedDraft = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${mixedProperty.id}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: [
          {
            product_id: mixedBed.id,
            period: { arrival: addDays(10), departure: addDays(12) },
            occupancy: { adults: 1, child_ages: [] },
            quantity: 1,
          },
        ],
        guests: [{ guest_id: male.id }],
      },
      headers: { 'idempotency-key': key('policy-mixed-guest') },
    },
  );
  expect(mixedDraft.status).toBe(201);
});
