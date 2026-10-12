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
let property;
let secondProperty;

const runId = Date.now().toString(36);
const key = (name) => `set04-${runId}-${name}`;

const draft = (overrides = {}) => ({
  property: {
    name: 'SET-04 Draft Property',
    code: `SET04-${runId.toUpperCase()}`,
    country: 'Indonesia',
    timezone: 'Asia/Jakarta',
    base_currency: 'IDR',
    types: ['ROOM'],
  },
  unit_groups: [
    {
      template_code: 'ROOM',
      pattern: '101-105',
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

async function saveDraft(target, body, name, ifMatch = null) {
  const headers = { 'idempotency-key': key(name) };
  if (ifMatch !== null) {
    const current = await apiRequest(
      admin.context,
      'GET',
      `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
    );
    expect(current.status).toBe(200);
    expect(current.body.draft).toBeTruthy();
    headers['if-match'] = `"${current.body.draft.draft_id}:${ifMatch}"`;
  }
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
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft/preview`,
  );
}

async function apply(target, previewVersion, name, revision, idempotencyName) {
  const current = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
  );
  expect(current.status).toBe(200);
  expect(current.body.draft).toBeTruthy();
  const etag = `"${current.body.draft.draft_id}:${revision}"`;
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft/apply`,
    {
      body: { preview_version: previewVersion },
      headers: {
        'idempotency-key': key(idempotencyName ?? name),
        'if-match': etag,
      },
    },
  );
}

async function resourceCodes(target) {
  const response = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/resources?limit=100`,
  );
  expect(response.status).toBe(200);
  return response.body.items.map((item) => item.code).sort();
}

async function productItems(target) {
  const response = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/products`,
  );
  expect(response.status).toBe(200);
  return response.body.items;
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  auditor = await loginAs('auditor-a');
  tenantA = admin.session.body.session.active_tenant_id;
  property = await createProperty(`SET04-A-${runId}`, 'SET-04 main');
  secondProperty = await createProperty(`SET04-B-${runId}`, 'SET-04 second');
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('preview requires a stored draft and writes nothing', async () => {
  const missing = await preview(property);
  expect(missing.status).toBe(404);
  expect(missing.body.code).toBe('SETUP_DRAFT_MISSING');

  await saveDraft(property, draft(), 'preview');
  const result = await preview(property);
  expect(result.status).toBe(200);
  expect(result.body.draft_revision).toBe(1);
  expect(result.body.generated.total_units).toBe(5);
  expect(result.body.generated.codes_preview).toEqual([
    '101',
    '102',
    '103',
    '104',
    '105',
  ]);
  expect(result.body.limits.max_units_inline).toBe(20);
  expect(result.body.limits.resource_capacity_remaining).toBe(500);
  expect(result.body.preview_version).toMatch(/^[a-f0-9]{64}$/);
  expect(result.body.blockers).toEqual([]);
  expect(await resourceCodes(property)).toEqual([]);
});

test('any material draft save invalidates the previous preview digest', async () => {
  const result = await preview(property);
  await saveDraft(
    property,
    draft({ property: { ...draft().property, name: 'SET-04 renamed' } }),
    'rename',
    1,
  );
  const stale = await apply(property, result.body.preview_version, 'stale', 2);
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('PREVIEW_STALE');
  expect(await resourceCodes(property)).toEqual([]);
});

test('incomplete drafts preview blockers and never apply', async () => {
  const incomplete = draft({
    operations: {
      check_in: '14:00',
      check_out: '12:00',
      inspection_required: false,
      explicit_states: false,
    },
  });
  await saveDraft(secondProperty, incomplete, 'incomplete');
  const result = await preview(secondProperty);
  expect(result.status).toBe(200);
  expect(
    result.body.blockers.some(
      (issue) => issue.code === 'explicit_states_required',
    ),
  ).toBe(true);
  const blocked = await apply(
    secondProperty,
    result.body.preview_version,
    'incomplete-apply',
    1,
  );
  expect(blocked.status).toBe(422);
  expect(blocked.body.code).toBe('SETUP_READINESS_BLOCKED');
  expect(await resourceCodes(secondProperty)).toEqual([]);
});

test('batches above the inline limit fail closed before any write', async () => {
  await saveDraft(
    secondProperty,
    draft({
      unit_groups: [
        { template_code: 'ROOM', pattern: '1-25', rental_mode: 'EXCLUSIVE' },
      ],
    }),
    'too-large',
    1,
  );
  const result = await preview(secondProperty);
  expect(result.body.generated.total_units).toBe(25);
  const rejected = await apply(
    secondProperty,
    result.body.preview_version,
    'too-large-apply',
    2,
  );
  expect(rejected.status).toBe(422);
  expect(rejected.body.code).toBe('SETUP_BATCH_TASK_REQUIRED');
  expect(await resourceCodes(secondProperty)).toEqual([]);
});

test('existing unit codes stop the whole batch without partial creation', async () => {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${secondProperty.id}/resources`,
    {
      body: {
        code: '1',
        type: 'ROOM',
        capacity: 2,
      },
      headers: { 'idempotency-key': key('seed-resource') },
    },
  );
  expect(created.status).toBe(201);
  await saveDraft(
    secondProperty,
    draft({
      unit_groups: [
        { template_code: 'ROOM', pattern: '1-3', rental_mode: 'EXCLUSIVE' },
      ],
    }),
    'codes',
    2,
  );
  const blocked = await apply(
    secondProperty,
    (await preview(secondProperty)).body.preview_version,
    'codes-conflict',
    3,
  );
  expect(blocked.status).toBe(409);
  expect(blocked.body.code).toBe('CONFLICT');
  expect(blocked.body.details.reason).toBe('setup_codes_exist');
  const codes = await resourceCodes(secondProperty);
  expect(codes).toEqual(['1']);
});

test('whole-or-parts needs explicit user parts before apply', async () => {
  await saveDraft(
    secondProperty,
    draft({
      unit_groups: [
        {
          template_code: 'VILLA',
          pattern: '1-2',
          rental_mode: 'WHOLE_OR_PARTS',
          privacy_ack: true,
        },
      ],
    }),
    'parts',
    3,
  );
  const result = await preview(secondProperty);
  expect(
    result.body.blockers.some((issue) => issue.code === 'parts_required'),
  ).toBe(true);
  const rejected = await apply(
    secondProperty,
    result.body.preview_version,
    'parts-apply',
    4,
  );
  expect(rejected.status).toBe(422);
  expect(rejected.body.code).toBe('SETUP_READINESS_BLOCKED');
  expect(await resourceCodes(secondProperty)).toEqual(['1']);

  await saveDraft(
    secondProperty,
    draft({
      unit_groups: [
        {
          template_code: 'VILLA',
          pattern: '1-2',
          rental_mode: 'WHOLE_OR_PARTS',
          privacy_ack: true,
          parts: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    }),
    'parts-declared',
    4,
  );
  const ready = await preview(secondProperty);
  expect(ready.body.blockers).toEqual([]);
  expect(ready.body.generated.by_template[0]).toMatchObject({
    template_code: 'VILLA',
    units: 2,
    parts: 4,
    compositions: 2,
  });
  const applied = await apply(
    secondProperty,
    ready.body.preview_version,
    'parts-ready',
    5,
  );
  expect(applied.status).toBe(200);
  expect(applied.body.result.created_compositions).toBe(2);
  expect(await resourceCodes(secondProperty)).toEqual([
    '1',
    '1-A',
    '1-B',
    '2-A',
    '2-B',
  ]);
});

test('unknown locations are refused before any unit is created', async () => {
  const isolated = await createProperty(
    `SET04-LOC-${runId}`,
    'Unknown location',
  );
  await saveDraft(
    isolated,
    draft({
      unit_groups: [
        {
          template_code: 'ROOM',
          pattern: '2-4',
          location_code: 'NOPE',
          rental_mode: 'EXCLUSIVE',
        },
      ],
    }),
    'location',
  );
  const result = await preview(isolated);
  const rejected = await apply(
    isolated,
    result.body.preview_version,
    'location-apply',
    1,
  );
  expect(rejected.status).toBe(422);
  expect(rejected.body.code).toBe('CROSS_SCOPE_REFERENCE');
  expect(await resourceCodes(isolated)).toEqual([]);
});

test('apply creates exactly the previewed units and sellable products', async () => {
  const fresh = await createProperty(`SET04-C-${runId}`, 'SET-04 fresh');
  await saveDraft(
    fresh,
    draft({ property: { ...draft().property, code: null } }),
    'fresh',
    null,
  );
  const result = await preview(fresh);
  expect(result.body.generated.total_units).toBe(5);
  const applied = await apply(
    fresh,
    result.body.preview_version,
    'fresh-apply',
    result.body.draft_revision,
  );
  expect(applied.status).toBe(200);
  expect(applied.body.replayed).toBe(false);
  expect(applied.body.result.created_units).toBe(5);
  expect(applied.body.result.created_products).toBe(1);
  expect(applied.body.result.inventory_version).toBe(
    result.body.inventory_version + 1,
  );
  expect(applied.body.result.follow_up_tasks).toEqual([
    'rate_plan_follow_up',
    'operations_policy_follow_up',
  ]);

  const codes = await resourceCodes(fresh);
  expect(codes).toEqual(['101', '102', '103', '104', '105']);
  const products = await productItems(fresh);
  expect(products).toHaveLength(1);
  expect(products[0].status).toBe('ACTIVE');
  expect(products[0].kind).toBe('ROOM');
  const candidates = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${fresh.id}/products/${products[0].id}/candidates`,
  );
  expect(candidates.status).toBe(200);
  expect(candidates.body.items).toHaveLength(5);

  const state = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${fresh.id}/setup-draft`,
  );
  expect(state.body.draft.completed).toBe(true);
});

test('idempotent replay returns the stored apply result without duplicates', async () => {
  const fresh = await createProperty(`SET04-D-${runId}`, 'SET-04 replay');
  await saveDraft(
    fresh,
    draft({ property: { ...draft().property, code: null } }),
    'replay',
    null,
  );
  const result = await preview(fresh);
  const applied = await apply(
    fresh,
    result.body.preview_version,
    'replay-apply',
    result.body.draft_revision,
  );
  expect(applied.status).toBe(200);
  const replay = await apply(
    fresh,
    result.body.preview_version,
    'replay-apply',
    result.body.draft_revision,
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.result.created_units).toBe(5);
  expect(await resourceCodes(fresh)).toHaveLength(5);
});

test('concurrent applies create one batch and reject the loser safely', async () => {
  const fresh = await createProperty(`SET04-E-${runId}`, 'SET-04 concurrent');
  await saveDraft(
    fresh,
    draft({ property: { ...draft().property, code: null } }),
    'concurrent',
    null,
  );
  const result = await preview(fresh);
  const [first, second] = await Promise.all([
    apply(
      fresh,
      result.body.preview_version,
      'concurrent-a',
      result.body.draft_revision,
    ),
    apply(
      fresh,
      result.body.preview_version,
      'concurrent-b',
      result.body.draft_revision,
    ),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(statuses[0]).toBe(200);
  expect([409, 412]).toContain(statuses[1]);
  expect(await resourceCodes(fresh)).toHaveLength(5);
});
