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
const key = (name) => `setr-${runId}-${name}`;

const baseDraft = (overrides = {}) => ({
  property: {
    name: 'SET-R Property',
    code: `SETR-${runId.toUpperCase()}`,
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

async function deleteDraft(target, name, ifMatch) {
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

test('SET-R01 stale discard cannot erase newer edits', async () => {
  const property = await createProperty(`SETR01-${runId}`, 'R01');
  const created = await putDraft(property, baseDraft(), 'r01-create');
  expect(created.status).toBe(200);
  const etag1 = `"${created.body.draft.draft_id}:1"`;
  const updated = await putDraft(
    property,
    baseDraft({ property: { ...baseDraft().property, name: 'R01 v2' } }),
    'r01-update',
    etag1,
  );
  expect(updated.status).toBe(200);
  expect(updated.body.draft.revision).toBe(2);

  const staleDelete = await deleteDraft(property, 'r01-delete', etag1);
  expect(staleDelete.status).toBe(412);
  expect(staleDelete.body.code).toBe('SETUP_DRAFT_STALE');
  const current = await getDraft(property);
  expect(current.revision).toBe(2);
  expect(current.input.property.name).toBe('R01 v2');

  const correctDelete = await deleteDraft(
    property,
    'r01-delete-2',
    `"${created.body.draft.draft_id}:2"`,
  );
  expect(correctDelete.status).toBe(200);
  expect(correctDelete.body.removed).toBe(true);
});

test('SET-R02 old-generation requests and replays cannot touch a recreated draft', async () => {
  const property = await createProperty(`SETR02-${runId}`, 'R02');
  const genA = await putDraft(
    property,
    baseDraft({ property: { ...baseDraft().property, name: 'A property' } }),
    'r02-a',
  );
  expect(genA.status).toBe(200);
  const etagA = `"${genA.body.draft.draft_id}:1"`;
  const deleteA = await deleteDraft(property, 'r02-delete', etagA);
  expect(deleteA.status).toBe(200);
  expect(deleteA.body.removed).toBe(true);

  const genB = await putDraft(
    property,
    baseDraft({ property: { ...baseDraft().property, name: 'B property' } }),
    'r02-b',
  );
  expect(genB.status).toBe(200);
  expect(genB.body.draft.draft_id).not.toBe(genA.body.draft.draft_id);

  const replayA = await putDraft(
    property,
    baseDraft({ property: { ...baseDraft().property, name: 'A property' } }),
    'r02-a',
  );
  expect(replayA.status).toBe(409);
  expect(replayA.body.code).toBe('CONFLICT');
  expect(replayA.body.details.reason).toBe('draft_generation_changed');

  const oldWrite = await putDraft(
    property,
    baseDraft({ property: { ...baseDraft().property, name: 'A overwrite' } }),
    'r02-old-write',
    etagA,
  );
  expect(oldWrite.status).toBe(412);
  expect(oldWrite.body.code).toBe('SETUP_DRAFT_STALE');
  expect(oldWrite.body.details.reason).toBe('generation_mismatch');

  const current = await getDraft(property);
  expect(current.draft_id).toBe(genB.body.draft.draft_id);
  expect(current.input.property.name).toBe('B property');
});

test('SET-R03 server-returned partial input round-trips through save', async () => {
  const property = await createProperty(`SETR03-${runId}`, 'R03');
  const partial = await putDraft(
    property,
    { property: {}, unit_groups: [], operations: {} },
    'r03-partial',
  );
  expect(partial.status).toBe(200);
  const stored = await getDraft(property);
  expect(stored.input.pricing).toBeNull();
  const roundTrip = await putDraft(
    property,
    stored.input,
    'r03-roundtrip',
    `"${stored.draft_id}:${stored.revision}"`,
  );
  expect(roundTrip.status).toBe(200);
  expect(roundTrip.body.draft.revision).toBe(2);
  expect(roundTrip.body.draft.input.property.name).toBeNull();
});

test('SET-R04 apply persists property core fields and builds the rate plan', async () => {
  const property = await createProperty(`SETR04-${runId}`, 'R04 old');
  const draft = baseDraft({
    property: {
      name: 'R04 Renamed',
      code: `SETR04-${runId.toUpperCase()}`,
      country: 'Indonesia',
      timezone: 'Asia/Makassar',
      base_currency: 'USD',
      types: ['ROOM'],
    },
    pricing: {
      postponed: false,
      plan_name: 'R04 Plan',
      sell_from: '2026-10-01',
      sell_to: '2026-10-04',
      base_price: '1500000.000000',
    },
  });
  const saved = await putDraft(property, draft, 'r04-save');
  expect(saved.status).toBe(200);
  const etag = `"${saved.body.draft.draft_id}:1"`;
  const previewResult = await preview(property);
  expect(previewResult.body.blockers).toEqual([]);
  const applied = await apply(
    property,
    previewResult.body.preview_version,
    'r04-apply',
    etag,
  );
  expect(applied.status).toBe(200);
  expect(applied.body.result.created_rate_plan).toBeTruthy();
  expect(applied.body.result.follow_up_tasks).toEqual([
    'operations_policy_follow_up',
  ]);

  const propertyNow = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}`,
  );
  expect(propertyNow.body.property.name).toBe('R04 Renamed');
  expect(propertyNow.body.property.timezone).toBe('Asia/Makassar');
  expect(propertyNow.body.property.base_currency).toBe('USD');

  const plans = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans`,
  );
  expect(plans.status).toBe(200);
  expect(plans.body.items).toHaveLength(1);
  expect(plans.body.items[0].name).toBe('R04 Plan');
  expect(plans.body.items[0].status).toBe('DRAFT');
});

test('SET-R05 archived property cannot apply a ready draft', async () => {
  const property = await createProperty(`SETR05-${runId}`, 'R05');
  const saved = await putDraft(property, baseDraft(), 'r05-save');
  const etag = `"${saved.body.draft.draft_id}:1"`;
  const previewResult = await preview(property);
  expect(previewResult.body.blockers).toEqual([]);

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
    'r05-apply',
    etag,
  );
  expect(applied.status).toBe(409);
  expect(applied.body.code).toBe('PROPERTY_ARCHIVED');
  expect(await resources(property)).toEqual([]);
});

test('SET-R06 villa preview reports unknown room count instead of inventing three', async () => {
  const property = await createProperty(`SETR06-${runId}`, 'R06');
  await putDraft(
    property,
    baseDraft({
      property: { ...baseDraft().property, types: ['VILLA'] },
      unit_groups: [
        { template_code: 'VILLA', pattern: '1-1', rental_mode: 'EXCLUSIVE' },
      ],
    }),
    'r06-save',
  );
  const previewResult = await preview(property);
  expect(previewResult.status).toBe(200);
  const villa = previewResult.body.generated.by_template.find(
    (entry) => entry.template_code === 'VILLA',
  );
  expect(villa.units).toBe(1);
  expect(villa.rooms).toBe(0);
  expect(
    previewResult.body.warnings.some(
      (warning) => warning.code === 'parts_not_defined',
    ),
  ).toBe(true);
});

test('SET-R07 dorm and suite imports are refused until their package exists', async () => {
  const property = await createProperty(`SETR07-${runId}`, 'R07');
  const content = [
    'code,template,capacity,location',
    'D101,DORM,4,',
    'S101,SUITE,4,',
  ].join('\n');
  const dry = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/setup-unit-imports`,
    {
      body: { mode: 'DRY_RUN', file_name: 'dorm.csv', content },
      headers: { 'idempotency-key': key('r07-dry') },
    },
  );
  expect(dry.status).toBe(200);
  expect(dry.body.totals).toEqual({
    rows: 2,
    accepted: 0,
    rejected: 2,
    duplicates: 0,
    created: 0,
  });
  expect(dry.body.rows.map((row) => row.error_code)).toEqual([
    'TEMPLATE_UNSUPPORTED',
    'TEMPLATE_UNSUPPORTED',
  ]);
  const applied = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/setup-unit-imports`,
    {
      body: { mode: 'APPLY', file_name: 'dorm.csv', content },
      headers: { 'idempotency-key': key('r07-apply') },
    },
  );
  expect(applied.status).toBe(422);
  expect(applied.body.code).toBe('SETUP_IMPORT_INVALID');
  expect(applied.body.details.error).toBe('NO_VALID_ROWS');
  expect(await resources(property)).toEqual([]);
});
