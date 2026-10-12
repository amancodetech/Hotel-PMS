import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
} from './support/harness.mjs';
import { setOperations } from '../../apps/api/dist/property/set-operations.js';

let tenantA;
let admin;
let member;
let auditor;
let owner;
let ownerB;
let property;
let otherProperty;
let partialProperty;
let archivedProperty;

const runId = Date.now().toString(36);
const key = (name) => `set03-${runId}-${name}`;

const draft = (overrides = {}) => ({
  property: {
    name: 'SET-03 Draft Property',
    code: `SET03-${runId.toUpperCase()}`,
    country: 'Indonesia',
    timezone: 'Asia/Jakarta',
    base_currency: 'IDR',
    types: ['ROOM'],
  },
  unit_groups: [
    {
      template_code: 'ROOM',
      pattern: '101-116',
      exclusions: ['113'],
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

async function currentEtag(target) {
  const current = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
  );
  expect(current.status).toBe(200);
  expect(current.body.draft).toBeTruthy();
  return `"${current.body.draft.draft_id}:${current.body.draft.revision}"`;
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  member = await loginAs('member-a');
  auditor = await loginAs('auditor-a');
  owner = await loginAs('owner-a');
  ownerB = await loginAs('owner-b');
  tenantA = admin.session.body.session.active_tenant_id;
  property = await createProperty(`SET03-A-${runId}`, 'SET-03 main');
  otherProperty = await createProperty(`SET03-B-${runId}`, 'SET-03 other');
  partialProperty = await createProperty(`SET03-D-${runId}`, 'SET-03 partial');
  archivedProperty = await createProperty(
    `SET03-C-${runId}`,
    'SET-03 archived',
  );
  const archived = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${archivedProperty.id}`,
    { body: { version: archivedProperty.version, status: 'ARCHIVED' } },
  );
  expect(archived.status).toBe(200);
  expect(archived.body.property.status).toBe('ARCHIVED');
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('implemented SET routes are an exact subset of the design contract', () => {
  const contract = JSON.parse(
    readFileSync('docs/contracts/set.openapi.json', 'utf8'),
  );
  const contractById = new Map();
  for (const [path, item] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      contractById.set(operation.operationId, {
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: `/api/v1${path}`,
        access: 'permission',
        permission: operation['x-permission'],
        csrf: operation['x-csrf'] === true,
      });
    }
  }
  expect([...setOperations].map((entry) => entry.operationId).sort()).toEqual([
    'AdvanceSetupBatch',
    'ApplyCompositionChange',
    'ApplySetupDraft',
    'ApplySetupMigration',
    'ApplySetupUnitAddition',
    'DiscardSetupDraft',
    'GetSetupBatch',
    'GetSetupDraft',
    'GetSetupReadiness',
    'GetSetupReconciliation',
    'GetSetupSettings',
    'ImportSetupUnits',
    'ListSetupChanges',
    'ListSetupTemplates',
    'PreviewCompositionChange',
    'PreviewSetupApply',
    'PreviewSetupMigration',
    'PreviewSetupUnitAddition',
    'SaveSetupDraft',
    'SimulateSetupProduct',
    'SimulateSetupSale',
    'StartSetupBatch',
  ]);
  for (const operation of setOperations) {
    const expected = contractById.get(operation.operationId);
    expect(expected).toBeDefined();
    expect(operation.method).toBe(expected.method);
    expect(operation.path).toBe(expected.path);
    expect(operation.permission).toBe(expected.permission);
    expect(Boolean(operation.csrf)).toBe(expected.csrf);
  }
});

test('template catalog is server owned and explicit about parts and beds', async () => {
  const response = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/setup-templates`,
  );
  expect(response.status).toBe(200);
  expect(response.body.items).toHaveLength(8);
  const villa = response.body.items.find((item) => item.code === 'VILLA');
  expect(villa.supports_parts).toBe(true);
  expect(villa.default_rental_mode).toBe('WHOLE_OR_PARTS');
  const dorm = response.body.items.find((item) => item.code === 'DORM');
  expect(dorm.supports_beds).toBe(true);
  expect(dorm.resource_type).toBe('BED');
});

test('first draft save creates revision one and resume reads it back', async () => {
  const saved = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('create') } },
  );
  expect(saved.status).toBe(200);
  expect(saved.body.replayed).toBe(false);
  expect(saved.body.draft.revision).toBe(1);
  expect(saved.body.draft.completed).toBe(false);

  const resumed = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
  );
  expect(resumed.status).toBe(200);
  expect(resumed.body.draft.revision).toBe(1);
  expect(resumed.body.draft.input.property.name).toBe('SET-03 Draft Property');
  expect(resumed.body.draft.updated_by_user_id).toBeTruthy();
});

test('idempotent replay returns the stored draft and rejects different content', async () => {
  const replay = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('create') } },
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.draft.revision).toBe(1);

  const conflicting = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
    {
      body: draft({
        property: { ...draft().property, name: 'Changed silently' },
      }),
      headers: { 'idempotency-key': key('create') },
    },
  );
  expect(conflicting.status).toBe(409);
  expect(conflicting.body.code).toBe('CONFLICT');
  expect(conflicting.body.details.reason).toBe('idempotency_key_reused');
});

test('stale revision fails closed and never overwrites the stored draft', async () => {
  const etagBeforeUpdate = await currentEtag(property);
  const updated = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
    {
      body: draft({
        property: { ...draft().property, name: 'SET-03 updated' },
      }),
      headers: {
        'idempotency-key': key('update'),
        'if-match': etagBeforeUpdate,
      },
    },
  );
  expect(updated.status).toBe(200);
  expect(updated.body.draft.revision).toBe(2);

  const stale = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
    {
      body: draft({
        property: { ...draft().property, name: 'Stale overwrite' },
      }),
      headers: {
        'idempotency-key': key('stale'),
        'if-match': etagBeforeUpdate,
      },
    },
  );
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('SETUP_DRAFT_STALE');
  expect(stale.body.details.current_revision).toBe(2);

  const current = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
  );
  expect(current.body.draft.revision).toBe(2);
  expect(current.body.draft.input.property.name).toBe('SET-03 updated');
});

test('invalid drafts are rejected with field issues before any write', async () => {
  const invalidPattern = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    {
      body: draft({
        unit_groups: [
          {
            template_code: 'ROOM',
            pattern: 'ten-20',
            rental_mode: 'EXCLUSIVE',
          },
        ],
      }),
      headers: { 'idempotency-key': key('invalid-pattern') },
    },
  );
  expect(invalidPattern.status).toBe(422);
  expect(invalidPattern.body.code).toBe('SETUP_DRAFT_INVALID');
  expect(invalidPattern.body.details.issues[0].code).toBe('pattern_invalid');

  const duplicateAcross = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    {
      body: draft({
        unit_groups: [
          {
            template_code: 'ROOM',
            pattern: '101-102',
            rental_mode: 'EXCLUSIVE',
          },
          {
            template_code: 'ROOM',
            pattern: '102-103',
            rental_mode: 'EXCLUSIVE',
          },
        ],
      }),
      headers: { 'idempotency-key': key('invalid-duplicate') },
    },
  );
  expect(duplicateAcross.status).toBe(422);
  expect(
    duplicateAcross.body.details.issues.some(
      (entry) => entry.code === 'duplicate_across_groups',
    ),
  ).toBe(true);

  const wrongType = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    {
      body: draft({
        unit_groups: [
          {
            template_code: 'ROOM',
            pattern: '101-102',
            capacity: 'two',
            rental_mode: 'EXCLUSIVE',
          },
        ],
      }),
      headers: { 'idempotency-key': key('invalid-type') },
    },
  );
  expect(wrongType.status).toBe(400);

  const missing = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
  );
  expect(missing.status).toBe(200);
  expect(missing.body.draft).toBeNull();
});

test('incomplete drafts save as-is without inventing values', async () => {
  const partial = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${partialProperty.id}/setup-draft`,
    {
      body: { property: {}, unit_groups: [], operations: {} },
      headers: { 'idempotency-key': key('partial') },
    },
  );
  expect(partial.status).toBe(200);
  expect(partial.body.draft.revision).toBe(1);
  expect(partial.body.draft.input.property.name).toBeNull();
  expect(partial.body.draft.input.property.timezone).toBeNull();
  expect(partial.body.draft.input.unit_groups).toEqual([]);
  expect(partial.body.draft.input.operations.explicit_states).toBe(false);

  const resumed = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${partialProperty.id}/setup-draft`,
  );
  expect(resumed.status).toBe(200);
  expect(resumed.body.draft.input.property.name).toBeNull();
  expect(resumed.body.draft.input.unit_groups).toEqual([]);
});

test('tenant and permission boundaries hold for reads and writes', async () => {
  const crossTenantRead = await apiRequest(
    ownerB.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
  );
  expect(crossTenantRead.status).toBe(403);

  const memberWrite = await apiRequest(
    member.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('member-write') } },
  );
  expect(memberWrite.status).toBe(403);

  const ownerWithoutMfa = await apiRequest(
    owner.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('owner-write') } },
  );
  expect(ownerWithoutMfa.status).toBe(403);

  const auditorRead = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
  );
  expect(auditorRead.status).toBe(200);
  expect(auditorRead.body.draft).toBeNull();
});

test('permission loss before an idempotent replay is denied without side effects', async () => {
  const created = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('boundary') } },
  );
  expect(created.status).toBe(200);
  expect(created.body.draft.revision).toBe(1);

  const deniedReplay = await apiRequest(
    member.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('boundary') } },
  );
  expect(deniedReplay.status).toBe(403);

  const replay = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('boundary') } },
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.draft.revision).toBe(1);
});

test('concurrent save and discard leave one consistent final state', async () => {
  const concurrentEtag = await currentEtag(otherProperty);
  const [saved, discarded] = await Promise.all([
    apiRequest(
      admin.context,
      'PUT',
      `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
      {
        body: draft({ property: { ...draft().property, name: 'Concurrent' } }),
        headers: {
          'idempotency-key': key('concurrent'),
          'if-match': concurrentEtag,
        },
      },
    ),
    apiRequest(
      admin.context,
      'DELETE',
      `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
      { headers: { 'if-match': concurrentEtag } },
    ),
  ]);
  expect([200, 412]).toContain(saved.status);
  expect([200, 412]).toContain(discarded.status);

  const finalState = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
  );
  expect(finalState.status).toBe(200);
  if (discarded.status === 200) {
    expect(discarded.body.removed).toBe(true);
    if (saved.status === 200) expect(finalState.body.draft.revision).toBe(2);
    else expect(finalState.body.draft).toBeNull();
  } else {
    expect(discarded.body.code).toBe('SETUP_DRAFT_STALE');
    expect(saved.status).toBe(200);
    expect(finalState.body.draft.revision).toBe(2);
  }
});

test('discarded drafts reject old revisions and old idempotent replays, then recreate fresh', async () => {
  const existing = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
  );
  if (existing.body.draft) {
    await apiRequest(
      admin.context,
      'DELETE',
      `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
      {
        headers: {
          'if-match': `"${existing.body.draft.draft_id}:${existing.body.draft.revision}"`,
        },
      },
    );
  }
  const created = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('recreate') } },
  );
  expect(created.status).toBe(200);
  const etag1 = `"${created.body.draft.draft_id}:1"`;
  const updated = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    {
      body: draft({ property: { ...draft().property, name: 'v2' } }),
      headers: { 'idempotency-key': key('recreate-update'), 'if-match': etag1 },
    },
  );
  expect(updated.status).toBe(200);
  expect(updated.body.draft.revision).toBe(2);

  const staleWrite = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    {
      body: draft(),
      headers: { 'idempotency-key': key('after-discard'), 'if-match': etag1 },
    },
  );
  expect(staleWrite.status).toBe(412);
  expect(staleWrite.body.code).toBe('SETUP_DRAFT_STALE');
  expect(staleWrite.body.details.reason).toBe('revision_mismatch');

  const discarded = await apiRequest(
    admin.context,
    'DELETE',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    { headers: { 'if-match': `"${created.body.draft.draft_id}:2"` } },
  );
  expect(discarded.status).toBe(200);
  expect(discarded.body.removed).toBe(true);

  const oldGenerationWrite = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    {
      body: draft(),
      headers: {
        'idempotency-key': key('old-generation'),
        'if-match': `"${created.body.draft.draft_id}:2"`,
      },
    },
  );
  expect(oldGenerationWrite.status).toBe(412);
  expect(oldGenerationWrite.body.details.reason).toBe('draft_missing');

  const recreated = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${otherProperty.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('fresh') } },
  );
  expect(recreated.status).toBe(200);
  expect(recreated.body.draft.revision).toBe(1);
  expect(recreated.body.draft.draft_id).not.toBe(created.body.draft.draft_id);

  await apiRequest(
    admin.context,
    'DELETE',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
    { headers: { 'if-match': await currentEtag(property) } },
  );
  const phantomReplay = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('create') } },
  );
  expect(phantomReplay.status).toBe(409);
  expect(phantomReplay.body.code).toBe('CONFLICT');
  expect(phantomReplay.body.details.reason).toBe('draft_discarded');

  const afterReplay = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/setup-draft`,
  );
  expect(afterReplay.body.draft).toBeNull();
});

test('archived properties cannot hold setup drafts', async () => {
  const response = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${archivedProperty.id}/setup-draft`,
    { body: draft(), headers: { 'idempotency-key': key('archived') } },
  );
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('PROPERTY_ARCHIVED');
});
