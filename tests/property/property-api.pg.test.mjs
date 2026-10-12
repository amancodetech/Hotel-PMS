import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

const tenantB = process.env.IDENTITY_TENANT_B;
let tenantA;
let owner;
let admin;
let member;
let auditor;
let propertyB;
let propertyMain;
let propertySecondary;
let locationId;
let resourceId;

beforeAll(async () => {
  propertyB = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'PB-API', 'Property B API', 'Asia/Jakarta')`,
      [propertyB, tenantB],
    );
  });
  await startApi();
  owner = await loginAs('owner-a');
  admin = await loginAs('admin-a');
  member = await loginAs('member-a');
  auditor = await loginAs('auditor-a');
  tenantA = owner.session.body.session.active_tenant_id;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('deny by default for members and read-only access for auditors', async () => {
  const denied = await apiRequest(
    member.context,
    'GET',
    `/tenants/${tenantA}/properties`,
  );
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe('PERMISSION_DENIED');
  const forbiddenWrite = await apiRequest(
    auditor.context,
    'POST',
    `/tenants/${tenantA}/property-groups`,
    { body: { code: 'AUD-GRP', name: 'Auditor group' } },
  );
  expect(forbiddenWrite.status).toBe(403);
  expect(forbiddenWrite.body.code).toBe('PERMISSION_DENIED');
  const read = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties`,
  );
  expect(read.status).toBe(200);
  expect(Array.isArray(read.body.items)).toBe(true);
});

test('property.manage requires MFA even for the tenant owner', async () => {
  const response = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'NO-MFA',
        name: 'No MFA property',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('MFA_REQUIRED');
});

test('property groups accept one local code per tenant', async () => {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/property-groups`,
    { body: { code: 'GRP-API', name: 'Group API' } },
  );
  expect(created.status).toBe(201);
  expect(created.body.group.code).toBe('GRP-API');
  expect(created.body.group.version).toBe(1);
  const duplicate = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/property-groups`,
    { body: { code: 'GRP-API', name: 'Group API again' } },
  );
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe('CONFLICT');
  const list = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/property-groups`,
  );
  expect(list.status).toBe(200);
  expect(list.body.items).toHaveLength(1);
});

test('properties validate timezone and currency and start in SETUP', async () => {
  const invalid = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: { code: 'BAD-TZ', name: 'Bad timezone', timezone: 'Asia/Tokyo' },
    },
  );
  expect(invalid.status).toBe(400);
  expect(invalid.body.code).toBe('INVALID_REQUEST');
  const groups = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/property-groups`,
  );
  const groupId = groups.body.items[0].id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'NUSANTARA-P04',
        name: 'Nusantara P04',
        timezone: 'Asia/Jakarta',
        base_currency: 'IDR',
        group_id: groupId,
      },
    },
  );
  expect(created.status).toBe(201);
  propertyMain = created.body.property;
  expect(propertyMain.status).toBe('SETUP');
  expect(propertyMain.inventory_version).toBe(1);
  expect(propertyMain.group_id).toBe(groupId);
  expect(propertyMain.limits_profile_code).toBe('PERF-01');
  const secondary = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'BEACH-P04',
        name: 'Beach P04',
        timezone: 'Asia/Makassar',
        base_currency: 'USD',
      },
    },
  );
  expect(secondary.status).toBe(201);
  propertySecondary = secondary.body.property;
  expect(propertySecondary.base_currency).toBe('USD');
});

test('property reads stay inside the active tenant and the path scope', async () => {
  const read = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertyMain.id}`,
  );
  expect(read.status).toBe(200);
  expect(read.body.property.code).toBe('NUSANTARA-P04');
  const crossTenant = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertyB}`,
  );
  expect(crossTenant.status).toBe(404);
  expect(crossTenant.body.code).toBe('NOT_FOUND');
  const otherTenantPath = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantB}/properties`,
  );
  expect(otherTenantPath.status).toBe(403);
  expect(otherTenantPath.body.code).toBe('TENANT_CONTEXT_MISMATCH');
});

test('property lifecycle is versioned and archived is terminal', async () => {
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyMain.id}`,
    { body: { version: propertyMain.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  expect(activated.body.property.status).toBe('ACTIVE');
  expect(activated.body.property.version).toBe(propertyMain.version + 1);
  const stale = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyMain.id}`,
    { body: { version: propertyMain.version, status: 'SUSPENDED' } },
  );
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');
  const backwards = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyMain.id}`,
    { body: { version: activated.body.property.version, status: 'SETUP' } },
  );
  expect(backwards.status).toBe(409);
  expect(backwards.body.code).toBe('INVALID_STATE_TRANSITION');
  propertyMain = activated.body.property;
});

test('activating a property with an incomplete stored draft is refused server-side', async () => {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'SETUP-GATE',
        name: 'Setup gate property',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  const target = created.body.property;
  const saved = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
    {
      body: {
        property: {
          name: 'Setup gate property',
          code: 'SETUP-GATE',
          country: 'Indonesia',
          timezone: 'Asia/Jakarta',
          base_currency: 'IDR',
          types: ['ROOM'],
        },
        unit_groups: [],
        operations: {
          check_in: '14:00',
          check_out: '12:00',
          inspection_required: false,
          explicit_states: true,
        },
        pricing: { postponed: true },
      },
      headers: { 'idempotency-key': 'property-api-setup-gate' },
    },
  );
  expect(saved.status).toBe(200);
  expect(saved.body.draft.completed).toBe(false);

  const blocked = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${target.id}`,
    { body: { version: target.version, status: 'ACTIVE' } },
  );
  expect(blocked.status).toBe(422);
  expect(blocked.body.code).toBe('SETUP_READINESS_BLOCKED');
  expect(
    blocked.body.details.issues.some(
      (issue) => issue.code === 'units_required',
    ),
  ).toBe(true);
  const unchanged = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}`,
  );
  expect(unchanged.status).toBe(200);
  expect(unchanged.body.property.status).toBe('SETUP');
  expect(unchanged.body.property.version).toBe(target.version);

  const current = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
  );
  expect(current.status).toBe(200);
  const removed = await apiRequest(
    admin.context,
    'DELETE',
    `/tenants/${tenantA}/properties/${target.id}/setup-draft`,
    {
      headers: {
        'if-match': `"${current.body.draft.draft_id}:${current.body.draft.revision}"`,
      },
    },
  );
  expect(removed.status).toBe(200);
  expect(removed.body.removed).toBe(true);

  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${target.id}`,
    { body: { version: target.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  expect(activated.body.property.status).toBe('ACTIVE');
});

test('a completed draft rejects edits and preserves its activation readiness', async () => {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'SETUP-EDIT',
        name: 'Setup edit property',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  const target = created.body.property;
  const base = `/tenants/${tenantA}/properties/${target.id}`;
  const incomplete = {
    property: {
      name: 'Setup edit property',
      code: 'SETUP-EDIT',
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['ROOM'],
    },
    unit_groups: [],
    operations: {
      check_in: '14:00',
      check_out: '12:00',
      inspection_required: false,
      explicit_states: true,
    },
    pricing: { postponed: true },
  };
  const firstSave = await apiRequest(
    admin.context,
    'PUT',
    `${base}/setup-draft`,
    {
      body: incomplete,
      headers: { 'idempotency-key': 'setup-edit-incomplete' },
    },
  );
  expect(firstSave.status).toBe(200);
  expect(firstSave.body.draft.completed).toBe(false);

  const initiallyBlocked = await apiRequest(admin.context, 'PATCH', base, {
    body: { version: target.version, status: 'ACTIVE' },
  });
  expect(initiallyBlocked.body.code).toBe('SETUP_READINESS_BLOCKED');
  const complete = {
    ...incomplete,
    unit_groups: [
      {
        id: 'g1',
        template_code: 'ROOM',
        pattern: '101-102',
        exclusions: [],
        capacity: 2,
        rental_mode: 'EXCLUSIVE',
        guaranteed_specs: [],
        parts: [],
        connected_codes: [],
      },
    ],
  };
  const beforeComplete = await apiRequest(
    admin.context,
    'GET',
    `${base}/setup-draft`,
  );
  const savedComplete = await apiRequest(
    admin.context,
    'PUT',
    `${base}/setup-draft`,
    {
      body: complete,
      headers: {
        'idempotency-key': 'setup-edit-complete',
        'if-match': `"${beforeComplete.body.draft.draft_id}:${beforeComplete.body.draft.revision}"`,
      },
    },
  );
  expect(savedComplete.status).toBe(200);
  const preview = await apiRequest(
    admin.context,
    'POST',
    `${base}/setup-draft/preview`,
  );
  expect(preview.status).toBe(200);
  expect(preview.body.blockers).toEqual([]);
  const beforeApply = await apiRequest(
    admin.context,
    'GET',
    `${base}/setup-draft`,
  );
  const applied = await apiRequest(
    admin.context,
    'POST',
    `${base}/setup-draft/apply`,
    {
      body: { preview_version: preview.body.preview_version },
      headers: {
        'idempotency-key': 'setup-edit-apply',
        'if-match': `"${beforeApply.body.draft.draft_id}:${beforeApply.body.draft.revision}"`,
      },
    },
  );
  expect(applied.status).toBe(200);
  const afterApply = await apiRequest(
    admin.context,
    'GET',
    `${base}/setup-draft`,
  );
  expect(afterApply.body.draft.completed).toBe(true);

  const beforeEdit = await apiRequest(
    admin.context,
    'GET',
    `${base}/setup-draft`,
  );
  const edited = await apiRequest(admin.context, 'PUT', `${base}/setup-draft`, {
    body: incomplete,
    headers: {
      'idempotency-key': 'setup-edit-reopen',
      'if-match': `"${beforeEdit.body.draft.draft_id}:${beforeEdit.body.draft.revision}"`,
    },
  });
  expect(edited.status).toBe(409);
  expect(edited.body.code).toBe('CONFLICT');

  const readiness = await apiRequest(
    admin.context,
    'GET',
    `${base}/setup-readiness`,
  );
  expect(readiness.status).toBe(200);
  expect(readiness.body.ready).toBe(true);

  const currentProperty = await apiRequest(admin.context, 'GET', `${base}`);
  const blocked = await apiRequest(admin.context, 'PATCH', `${base}`, {
    body: { version: currentProperty.body.property.version, status: 'ACTIVE' },
  });
  expect(blocked.status).toBe(200);
  expect(blocked.body.property.status).toBe('ACTIVE');
});

test('locations and resources stay inside the property scope', async () => {
  const createdLocation = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyMain.id}/locations`,
    { body: { code: 'BLK-01', name: 'Block 01' } },
  );
  expect(createdLocation.status).toBe(201);
  locationId = createdLocation.body.location.id;
  const duplicateLocation = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyMain.id}/locations`,
    { body: { code: 'BLK-01', name: 'Block 01 duplicate' } },
  );
  expect(duplicateLocation.status).toBe(409);
  expect(duplicateLocation.body.code).toBe('CONFLICT');

  const created = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources`,
    {
      body: {
        code: '101',
        type: 'ROOM',
        capacity: 2,
        location_id: locationId,
      },
    },
  );
  expect(created.status).toBe(201);
  resourceId = created.body.resource.id;
  expect(created.body.resource.state).toBe('ACTIVE');
  expect(created.body.resource.location_id).toBe(locationId);
  const duplicate = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources`,
    { body: { code: '101', type: 'BED', capacity: 1 } },
  );
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe('CONFLICT');

  const foreignLocation = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertySecondary.id}/resources`,
    {
      body: {
        code: '201',
        type: 'ROOM',
        capacity: 2,
        location_id: locationId,
      },
    },
  );
  expect(foreignLocation.status).toBe(422);
  expect(foreignLocation.body.code).toBe('CROSS_SCOPE_REFERENCE');

  const denied = await apiRequest(
    member.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources`,
  );
  expect(denied.status).toBe(403);
  const readable = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources`,
  );
  expect(readable.status).toBe(200);
  expect(readable.body.items).toHaveLength(1);

  const types = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/resource-types`,
  );
  expect(types.status).toBe(200);
  expect(types.body.items.map((item) => item.code)).toEqual([
    'ROOM',
    'BED',
    'VILLA',
    'APARTMENT',
    'HOUSE',
    'SITE',
    'TENT',
    'CABIN',
  ]);
});

test('resource updates bump inventory_version and retired is terminal', async () => {
  const list = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources`,
  );
  const current = list.body.items.find((item) => item.id === resourceId);
  const updated = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources/${resourceId}`,
    { body: { version: current.version, capacity: 3 } },
  );
  expect(updated.status).toBe(200);
  expect(updated.body.resource.capacity).toBe(3);
  const property = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertyMain.id}`,
  );
  expect(property.body.property.inventory_version).toBe(3);

  const stale = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources/${resourceId}`,
    { body: { version: current.version, capacity: 4 } },
  );
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');

  const retired = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources/${resourceId}`,
    { body: { version: updated.body.resource.version, state: 'RETIRED' } },
  );
  expect(retired.status).toBe(200);
  expect(retired.body.resource.state).toBe('RETIRED');
  const afterRetire = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources/${resourceId}`,
    { body: { version: retired.body.resource.version, capacity: 5 } },
  );
  expect(afterRetire.status).toBe(409);
  expect(afterRetire.body.code).toBe('RESOURCE_RETIRED');
});

test('resource listing paginates with a stable cursor', async () => {
  for (const code of ['102', '103']) {
    const created = await apiRequest(
      owner.context,
      'POST',
      `/tenants/${tenantA}/properties/${propertyMain.id}/resources`,
      { body: { code, type: 'BED', capacity: 1 } },
    );
    expect(created.status).toBe(201);
  }
  const first = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources?limit=2`,
  );
  expect(first.status).toBe(200);
  expect(first.body.items).toHaveLength(2);
  expect(first.body.next_cursor).toBeTruthy();
  const second = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertyMain.id}/resources?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
  );
  expect(second.status).toBe(200);
  expect(second.body.items).toHaveLength(1);
  expect(second.body.next_cursor).toBeNull();
});

test('archived property freezes setup changes', async () => {
  const property = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertySecondary.id}`,
  );
  const archived = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertySecondary.id}`,
    { body: { version: property.body.property.version, status: 'ARCHIVED' } },
  );
  expect(archived.status).toBe(200);
  expect(archived.body.property.status).toBe('ARCHIVED');
  const frozen = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertySecondary.id}`,
    { body: { version: archived.body.property.version, name: 'Renamed' } },
  );
  expect(frozen.status).toBe(409);
  expect(frozen.body.code).toBe('PROPERTY_ARCHIVED');
  const blockedLocation = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertySecondary.id}/locations`,
    { body: { code: 'ARCH-01', name: 'Archived location' } },
  );
  expect(blockedLocation.status).toBe(409);
  expect(blockedLocation.body.code).toBe('PROPERTY_ARCHIVED');
});
