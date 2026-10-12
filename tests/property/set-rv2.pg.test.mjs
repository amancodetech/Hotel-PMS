import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
} from './support/harness.mjs';

let tenantA;
let admin;
let auditor;

const runId = Date.now().toString(36);
const key = (name) => `setrv2-${runId}-${name}`;

const baseDraft = (overrides = {}) => ({
  property: {
    name: 'SET-R2 Property',
    code: `SETR2-${runId.toUpperCase()}`,
    country: 'Indonesia',
    timezone: 'Asia/Jakarta',
    base_currency: 'IDR',
    types: ['ROOM'],
  },
  unit_groups: [
    {
      template_code: 'ROOM',
      pattern: '101-103',
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

async function putDraft(target, body, name, ifMatch = undefined) {
  const headers = { 'idempotency-key': key(name) };
  if (ifMatch !== undefined) headers['if-match'] = ifMatch;
  return apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
    { body, headers },
  );
}

async function deleteDraft(target, name, ifMatch = undefined) {
  const headers = { 'idempotency-key': key(name) };
  if (ifMatch !== undefined) headers['if-match'] = ifMatch;
  return apiRequest(
    admin.context,
    'DELETE',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
    { headers },
  );
}

async function preview(target) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft/preview`,
  );
}

async function apply(target, previewVersion, name, ifMatch) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft/apply`,
    {
      body: { preview_version: previewVersion },
      headers: { 'idempotency-key': key(name), 'if-match': ifMatch },
    },
  );
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

async function propertyView(target) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}`,
  );
  expect(response.status).toBe(200);
  return response.body.property;
}

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

test('R2-R01 missing, malformed and stale If-Match never discard or overwrite', async () => {
  const property = await createProperty(`SETR2A-${runId}`, 'R2A');
  const created = await putDraft(property, baseDraft(), 'r01a-create');
  expect(created.status).toBe(200);
  const etag1 = `"${created.body.draft.draft_id}:1"`;
  const updated = await putDraft(
    property,
    baseDraft({ property: { ...baseDraft().property, name: 'R2A v2' } }),
    'r01a-update',
    etag1,
  );
  expect(updated.status).toBe(200);

  const malformed = await deleteDraft(property, 'r01a-bad', 'not-an-version');
  expect(malformed.status).toBe(400);
  expect(malformed.body.code).toBe('INVALID_REQUEST');
  expect(malformed.body.details.field).toBe('if-match');

  const noMatch = await deleteDraft(property, 'r01a-none');
  expect(noMatch.status).toBe(412);
  expect(noMatch.body.code).toBe('SETUP_DRAFT_STALE');
  expect(noMatch.body.details.reason).toBe('if_match_required');
  expect((await getDraft(property)).revision).toBe(2);

  const noMatchWrite = await putDraft(
    property,
    baseDraft({ property: { ...baseDraft().property, name: 'R2A v3' } }),
    'r01a-write-none',
  );
  expect(noMatchWrite.status).toBe(412);
  expect(noMatchWrite.body.details.reason).toBe('if_match_required');
  expect((await getDraft(property)).input.property.name).toBe('R2A v2');

  const fresh = await createProperty(`SETR2B-${runId}`, 'R2B');
  const createWithMatch = await putDraft(
    fresh,
    baseDraft(),
    'r01b-create',
    `"${created.body.draft.draft_id}:1"`,
  );
  expect(createWithMatch.status).toBe(412);
  expect(createWithMatch.body.details.reason).toBe('draft_missing');

  const removed = await deleteDraft(
    property,
    'r01a-delete',
    `"${created.body.draft.draft_id}:2"`,
  );
  expect(removed.status).toBe(200);
  expect(removed.body.removed).toBe(true);
  const replayedDelete = await deleteDraft(
    property,
    'r01a-delete-again',
    `"${created.body.draft.draft_id}:2"`,
  );
  expect(replayedDelete.status).toBe(200);
  expect(replayedDelete.body.removed).toBe(false);
});

test('R2-R01 concurrent save and discard leave one consistent winner', async () => {
  const property = await createProperty(`SETR2C-${runId}`, 'R2C');
  const created = await putDraft(property, baseDraft(), 'r01c-create');
  expect(created.status).toBe(200);
  const etag = `"${created.body.draft.draft_id}:1"`;

  const [saved, discarded] = await Promise.all([
    putDraft(
      property,
      baseDraft({ property: { ...baseDraft().property, name: 'R2C race' } }),
      'r01c-race',
      etag,
    ),
    deleteDraft(property, 'r01c-race', etag),
  ]);
  const statuses = [saved.status, discarded.status].sort();
  expect(statuses).toEqual([200, 412]);

  const finalState = await getDraft(property);
  if (saved.status === 200) {
    expect(finalState.revision).toBe(2);
    expect(finalState.input.property.name).toBe('R2C race');
  } else {
    expect(finalState).toBeNull();
  }
});

test('R2-R02 old generation cannot preview, discard or apply over the new one', async () => {
  const property = await createProperty(`SETR2D-${runId}`, 'R2D');
  const genA = await putDraft(
    property,
    baseDraft({
      property: { ...baseDraft().property, name: 'A property' },
      unit_groups: [
        {
          template_code: 'ROOM',
          pattern: '101-101',
          capacity: 2,
          rental_mode: 'EXCLUSIVE',
        },
      ],
    }),
    'r02d-a',
  );
  if (genA.status !== 200)
    console.log('R2-R02 genA', JSON.stringify(genA.body));
  expect(genA.status).toBe(200);
  const etagA = `"${genA.body.draft.draft_id}:1"`;
  const deletedA = await deleteDraft(property, 'r02d-delete-a', etagA);
  expect(deletedA.status).toBe(200);

  const genB = await putDraft(
    property,
    baseDraft({
      property: { ...baseDraft().property, name: 'B property' },
      unit_groups: [
        {
          template_code: 'ROOM',
          pattern: '201-202',
          capacity: 2,
          rental_mode: 'EXCLUSIVE',
        },
      ],
    }),
    'r02d-b',
  );
  expect(genB.status).toBe(200);
  expect(genB.body.draft.draft_id).not.toBe(genA.body.draft.draft_id);

  const previewB = await preview(property);
  expect(previewB.status).toBe(200);
  expect(previewB.body.generated.codes_preview).toEqual(['201', '202']);
  expect(previewB.body.generated.codes_preview).not.toContain('101');

  const staleDelete = await deleteDraft(property, 'r02d-stale-delete', etagA);
  expect(staleDelete.status).toBe(412);
  expect(staleDelete.body.details.reason).toBe('generation_mismatch');
  expect((await getDraft(property)).draft_id).toBe(genB.body.draft.draft_id);

  const staleApply = await apply(
    property,
    previewB.body.preview_version,
    'r02d-stale-apply',
    etagA,
  );
  expect(staleApply.status).toBe(412);
  expect(staleApply.body.details.reason).toBe('generation_mismatch');
  expect(await resources(property)).toEqual([]);
});

test('R2-R03 explicit nulls across every draft field round-trip', async () => {
  const property = await createProperty(`SETR2E-${runId}`, 'R2E');
  const partial = {
    property: {
      name: null,
      code: null,
      country: null,
      timezone: null,
      base_currency: null,
      types: [],
    },
    unit_groups: [
      {
        id: null,
        template_code: 'ROOM',
        pattern: '301-301',
        capacity: null,
        location_code: null,
        rental_mode: 'EXCLUSIVE',
        sharing_scope: null,
        beds_per_unit: null,
      },
    ],
    operations: { check_in: null, check_out: null },
    pricing: null,
  };
  const saved = await putDraft(property, partial, 'r03e-null');
  if (saved.status !== 200)
    console.log('R2-R03a body', JSON.stringify(saved.body));
  expect(saved.status).toBe(200);
  const stored = await getDraft(property);
  const roundTrip = await putDraft(
    property,
    stored.input,
    'r03e-null-roundtrip',
    `"${stored.draft_id}:${stored.revision}"`,
  );
  if (roundTrip.status !== 200)
    console.log('R2-R03a roundtrip', JSON.stringify(roundTrip.body));
  expect(roundTrip.status).toBe(200);
  expect(roundTrip.body.draft.input.unit_groups[0].capacity).toBeNull();
});

test('R2-R03 server echo of a group without capacity round-trips', async () => {
  const property = await createProperty(`SETR2F-${runId}`, 'R2F');
  const saved = await putDraft(
    property,
    baseDraft({
      unit_groups: [
        { template_code: 'VILLA', pattern: '1-1', rental_mode: 'EXCLUSIVE' },
      ],
    }),
    'r03f-save',
  );
  expect(saved.status).toBe(200);
  const stored = await getDraft(property);
  expect(stored.input.unit_groups[0].capacity).toBeNull();
  const roundTrip = await putDraft(
    property,
    stored.input,
    'r03f-roundtrip',
    `"${stored.draft_id}:${stored.revision}"`,
  );
  if (roundTrip.status !== 200)
    console.log('R2-R03b body', JSON.stringify(roundTrip.body));
  expect(roundTrip.status).toBe(200);
  expect(roundTrip.body.draft.revision).toBe(2);
});

test('R2-R04 postponed pricing records the rate follow-up and no plan', async () => {
  const property = await createProperty(`SETR2G-${runId}`, 'R2G');
  const saved = await putDraft(property, baseDraft(), 'r04g-save');
  expect(saved.status).toBe(200);
  const etag = `"${saved.body.draft.draft_id}:1"`;
  const previewResult = await preview(property);
  expect(previewResult.body.blockers).toEqual([]);
  const applied = await apply(
    property,
    previewResult.body.preview_version,
    'r04g-apply',
    etag,
  );
  expect(applied.status).toBe(200);
  expect(applied.body.result.created_rate_plan).toBeNull();
  expect(applied.body.result.follow_up_tasks).toContain('rate_plan_follow_up');
  const plans = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans`,
  );
  expect(plans.body.items).toEqual([]);
});

test('R2-R04 nightly prices are readable and apply replay does not duplicate', async () => {
  const property = await createProperty(`SETR2H-${runId}`, 'R2H');
  const draft = baseDraft({
    pricing: {
      postponed: false,
      plan_name: 'R2 Plan',
      sell_from: '2026-10-01',
      sell_to: '2026-10-04',
      base_price: '1250000.000000',
    },
  });
  const saved = await putDraft(property, draft, 'r04h-save');
  expect(saved.status).toBe(200);
  const etag = `"${saved.body.draft.draft_id}:1"`;
  const previewResult = await preview(property);
  expect(previewResult.body.blockers).toEqual([]);
  const applied = await apply(
    property,
    previewResult.body.preview_version,
    'r04h-apply',
    etag,
  );
  expect(applied.status).toBe(200);
  expect(applied.body.result.created_rate_plan).toBeTruthy();
  expect(applied.body.result.created_units).toBe(3);

  const plans = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans`,
  );
  expect(plans.body.items).toHaveLength(1);
  expect(plans.body.items[0].name).toBe('R2 Plan');
  expect(plans.body.items[0].currency).toBe('IDR');

  const calendar = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/rates?from=2026-10-01&to=2026-10-04`,
  );
  expect(calendar.status).toBe(200);
  expect(calendar.body.prices).toHaveLength(3);
  expect(calendar.body.prices.map((price) => price.money.amount)).toEqual([
    '1250000',
    '1250000',
    '1250000',
  ]);

  const replayed = await apply(
    property,
    previewResult.body.preview_version,
    'r04h-apply',
    etag,
  );
  expect(replayed.status).toBe(200);
  expect(replayed.body.replayed).toBe(true);
  expect(replayed.body.result.created_units).toBe(3);
  expect(await resources(property)).toHaveLength(3);
});

test('R2-R04 completed draft rejects edits while apply replay returns the original result', async () => {
  const property = await createProperty(`SETR2I-${runId}`, 'R2I');
  const saved = await putDraft(property, baseDraft(), 'r04i-save');
  const etag = `"${saved.body.draft.draft_id}:1"`;
  const previewResult = await preview(property);
  const applied = await apply(
    property,
    previewResult.body.preview_version,
    'r04i-apply',
    etag,
  );
  expect(applied.status).toBe(200);

  const edited = await putDraft(
    property,
    baseDraft({ property: { ...baseDraft().property, name: 'R2I edited' } }),
    'r04i-edit',
    etag,
  );
  expect(edited.status).toBe(409);
  expect(edited.body.code).toBe('CONFLICT');
  expect((await getDraft(property)).completed).toBe(true);

  const replayed = await apply(
    property,
    previewResult.body.preview_version,
    'r04i-apply',
    etag,
  );
  expect(replayed.status).toBe(200);
  expect(replayed.body.replayed).toBe(true);
  expect(replayed.body.result).toEqual(applied.body.result);
  expect(await resources(property)).toHaveLength(3);
});

test('R2-R04 non-SETUP property cannot apply and core fields stay untouched', async () => {
  const property = await createProperty(`SETR2J-${runId}`, 'R2J');
  const draft = baseDraft({
    property: {
      name: 'R2J Renamed',
      code: `SETR2J-${runId.toUpperCase()}`,
      country: 'Indonesia',
      timezone: 'Asia/Jayapura',
      base_currency: 'USD',
      types: ['ROOM'],
    },
  });
  const saved = await putDraft(property, draft, 'r04j-save');
  const etag = `"${saved.body.draft.draft_id}:1"`;
  const previewResult = await preview(property);
  expect(previewResult.body.blockers).toEqual([]);

  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}`,
    { body: { version: property.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);

  const applied = await apply(
    property,
    previewResult.body.preview_version,
    'r04j-apply',
    etag,
  );
  expect(applied.status).toBe(409);
  expect(applied.body.code).toBe('INVALID_STATE_TRANSITION');

  const propertyNow = await propertyView(property);
  expect(propertyNow.name).toBe('R2J');
  expect(propertyNow.timezone).toBe('Asia/Jakarta');
  expect(propertyNow.base_currency).toBe('IDR');
  expect(await resources(property)).toEqual([]);
});

test('R2-R05 archive mid-flow fails closed for apply, replay and import', async () => {
  const property = await createProperty(`SETR2K-${runId}`, 'R2K');
  const saved = await putDraft(property, baseDraft(), 'r05k-save');
  const etag = `"${saved.body.draft.draft_id}:1"`;
  const previewResult = await preview(property);
  expect(previewResult.body.blockers).toEqual([]);
  const inventoryBefore = await propertyView(property);

  const archived = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}`,
    { body: { version: property.version, status: 'ARCHIVED' } },
  );
  expect(archived.status).toBe(200);

  const applied = await apply(
    property,
    previewResult.body.preview_version,
    'r05k-apply',
    etag,
  );
  expect(applied.status).toBe(409);
  expect(applied.body.code).toBe('PROPERTY_ARCHIVED');
  expect(await resources(property)).toEqual([]);

  const imported = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/setup-unit-imports`,
    {
      body: {
        mode: 'DRY_RUN',
        file_name: 'r2k.csv',
        content: 'code,template,capacity,location\nR2K1,ROOM,2,',
      },
      headers: { 'idempotency-key': key('r05k-import') },
    },
  );
  expect(imported.status).toBe(409);
  expect(imported.body.code).toBe('PROPERTY_ARCHIVED');
  expect((await propertyView(property)).inventory_version).toBe(
    inventoryBefore.inventory_version,
  );
});

test('R2-R05 replay after archive fails closed without another inventory bump', async () => {
  const property = await createProperty(`SETR2L-${runId}`, 'R2L');
  const saved = await putDraft(property, baseDraft(), 'r05l-save');
  const etag = `"${saved.body.draft.draft_id}:1"`;
  const previewResult = await preview(property);
  const applied = await apply(
    property,
    previewResult.body.preview_version,
    'r05l-apply',
    etag,
  );
  expect(applied.status).toBe(200);
  const afterApply = await propertyView(property);
  expect(afterApply.inventory_version).toBe(
    applied.body.result.inventory_version,
  );

  const archived = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}`,
    { body: { version: afterApply.version, status: 'ARCHIVED' } },
  );
  expect(archived.status).toBe(200);

  const replayed = await apply(
    property,
    previewResult.body.preview_version,
    'r05l-apply',
    etag,
  );
  expect(replayed.status).toBe(409);
  expect(replayed.body.code).toBe('PROPERTY_ARCHIVED');
  expect((await propertyView(property)).inventory_version).toBe(
    afterApply.inventory_version,
  );
  expect(await resources(property)).toHaveLength(3);
});

test('R2-R06 villa and apartment never invent room counts', async () => {
  const property = await createProperty(`SETR2M-${runId}`, 'R2M');
  const saved = await putDraft(
    property,
    baseDraft({
      property: {
        ...baseDraft().property,
        types: ['VILLA', 'APARTMENT'],
      },
      unit_groups: [
        { template_code: 'VILLA', pattern: '1-1', rental_mode: 'EXCLUSIVE' },
        {
          template_code: 'APARTMENT',
          pattern: '2-2',
          rental_mode: 'EXCLUSIVE',
        },
      ],
    }),
    'r06m-save',
  );
  expect(saved.status).toBe(200);
  const previewResult = await preview(property);
  expect(previewResult.status).toBe(200);
  expect(previewResult.body.blockers).toEqual([]);
  expect(previewResult.body.generated.total_units).toBe(2);
  for (const templateCode of ['VILLA', 'APARTMENT']) {
    const entry = previewResult.body.generated.by_template.find(
      (row) => row.template_code === templateCode,
    );
    expect(entry.units).toBe(1);
    expect(entry.rooms).toBe(0);
    expect(entry.beds).toBe(0);
  }
  const partsWarnings = previewResult.body.warnings.filter(
    (warning) => warning.code === 'parts_not_defined',
  );
  expect(partsWarnings).toHaveLength(2);
});

test('R2-R07 mixed import accepts valid rows and refuses dorm and suite', async () => {
  const property = await createProperty(`SETR2N-${runId}`, 'R2N');
  const content = [
    'code,template,capacity,location',
    'RN201,ROOM,2,',
    'D101,DORM,4,',
    'S101,SUITE,4,',
  ].join('\n');
  const importCall = (mode, name, body = content) =>
    apiRequest(
      admin.context,
      'POST',
      `/tenants/${tenantA}/properties/${property.id}/setup-unit-imports`,
      {
        body: { mode, file_name: 'r2n.csv', content: body },
        headers: { 'idempotency-key': key(name) },
      },
    );

  const dry = await importCall('DRY_RUN', 'r07n-dry');
  expect(dry.status).toBe(200);
  expect(dry.body.totals).toEqual({
    rows: 3,
    accepted: 1,
    rejected: 2,
    duplicates: 0,
    created: 0,
  });
  expect(dry.body.preflight).toEqual({
    code_conflicts: [],
    inline_limit_exceeded: false,
    resource_capacity_exceeded: false,
  });
  expect(dry.body.rows.map((row) => row.error_code)).toEqual([
    null,
    'TEMPLATE_UNSUPPORTED',
    'TEMPLATE_UNSUPPORTED',
  ]);

  const dryReplay = await importCall('DRY_RUN', 'r07n-dry');
  expect(dryReplay.status).toBe(200);
  expect(dryReplay.body.totals).toEqual(dry.body.totals);
  expect(await resources(property)).toEqual([]);

  const applied = await importCall('APPLY', 'r07n-apply');
  expect(applied.status).toBe(200);
  expect(applied.body.totals.created).toBe(1);
  const createdResources = await resources(property);
  expect(createdResources).toHaveLength(1);
  expect(createdResources[0].code).toBe('RN201');

  const dormOnly = await importCall(
    'APPLY',
    'r07n-dorm-only',
    'code,template,capacity,location\nD101,DORM,4,',
  );
  expect(dormOnly.status).toBe(422);
  expect(dormOnly.body.code).toBe('SETUP_IMPORT_INVALID');
  expect(dormOnly.body.details.error).toBe('NO_VALID_ROWS');
  expect(await resources(property)).toHaveLength(1);
});
