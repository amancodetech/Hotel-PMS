import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  getBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
  withRuntimeRole,
} from './support/harness.mjs';

const tenantB = process.env.IDENTITY_TENANT_B;
let tenantA;
let owner;
let admin;
let member;
let auditor;
let propertyA;
let propertyB2;
let propertyB;
let resourceA;
let resourceB2;
let scopedGrantId;
let connectionId;

async function createResource(context, propertyId, body) {
  return apiRequest(
    context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyId}/resources`,
    { body },
  );
}

async function createComposition(context, body) {
  return apiRequest(
    context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/compositions`,
    { body },
  );
}

async function activateComposition(context, compositionId) {
  return apiRequest(
    context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/compositions/${compositionId}/activate`,
    { body: { reason: 'adversarial probe activation' } },
  );
}

async function probeFail(client, tenantId, sql, params, code) {
  await client.query('begin');
  try {
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    await expect(client.query(sql, params)).rejects.toMatchObject({ code });
  } finally {
    await client.query('rollback');
  }
}

beforeAll(async () => {
  await startApi();
  owner = await loginAs('owner-a');
  admin = await loginAs('admin-a');
  member = await loginAs('member-a');
  auditor = await loginAs('auditor-a');
  tenantA = owner.session.body.session.active_tenant_id;

  const createdA = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'ADV-A',
        name: 'Adversarial A',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(createdA.status).toBe(201);
  propertyA = createdA.body.property.id;
  const createdB2 = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'ADV-B2',
        name: 'Adversarial B2',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(createdB2.status).toBe(201);
  propertyB2 = createdB2.body.property.id;

  propertyB = randomUUID();
  const resources = await createResource(owner.context, propertyA, {
    code: 'ADV-R1',
    type: 'ROOM',
    capacity: 2,
  });
  expect(resources.status).toBe(201);
  resourceA = resources.body.resource.id;
  const resourceOther = await createResource(owner.context, propertyB2, {
    code: 'ADV-RB2',
    type: 'ROOM',
    capacity: 2,
  });
  expect(resourceOther.status).toBe(201);
  resourceB2 = resourceOther.body.resource.id;

  await withOwner(async (client) => {
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'ADV-TB', 'Adversarial tenant B', 'Asia/Jakarta')
       on conflict do nothing`,
      [propertyB, tenantB],
    );
    await client.query(
      `insert into "resource"
         ("tenant_id", "property_id", "code", "resource_type", "capacity")
       select $1, $2, 'ADV-L' || lpad(g::text, 2, '0'), 'ROOM', 2
         from generate_series(1, 34) g
       on conflict do nothing`,
      [tenantA, propertyA],
    );
    const membership = await client.query(
      `select m."id" from "membership" m
        join "app_user" u on u."id" = m."user_id"
       where m."tenant_id" = $1 and u."email" like 'member-a%'
       limit 1`,
      [tenantA],
    );
    const role = await client.query(
      `insert into "role" ("tenant_id", "code", "name", "is_system")
       values ($1, 'ADV_SCOPED', 'Adversarial scoped', false)
       returning "id"`,
      [tenantA],
    );
    await client.query(
      `insert into "role_permission" ("role_id", "permission_code")
       values ($1, 'property.resource.manage')`,
      [role.rows[0].id],
    );
    const grant = await client.query(
      `insert into "role_grant"
         ("tenant_id", "membership_id", "role_id", "effect", "scope_type")
       values ($1, $2, $3, 'GRANT', 'PROPERTIES')
       returning "id"`,
      [tenantA, membership.rows[0].id, role.rows[0].id],
    );
    scopedGrantId = grant.rows[0].id;
    await client.query(
      `insert into "grant_property" ("grant_id", "tenant_id", "property_ref")
       values ($1, $2, $3)`,
      [scopedGrantId, tenantA, propertyA],
    );
  });
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('ADV-01: anonymous, missing CSRF and foreign origin fail closed', async () => {
  const browser = await getBrowser();
  const anonymous = await browser.newContext();
  const noSession = await apiRequest(
    anonymous,
    'GET',
    `/tenants/${tenantA}/properties`,
  );
  expect(noSession.status).toBe(401);
  expect(noSession.body.code).toBe('AUTH_REQUIRED');
  await anonymous.close();

  const noCsrf = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/resources`,
    { body: { code: 'ADV-NOCSRF', type: 'ROOM', capacity: 1 }, csrf: false },
  );
  expect(noCsrf.status).toBe(403);
  expect(noCsrf.body.code).toBe('CSRF_INVALID');

  const badOrigin = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/resources`,
    {
      body: { code: 'ADV-ORIGIN', type: 'ROOM', capacity: 1 },
      headers: { origin: 'https://evil.example' },
    },
  );
  expect(badOrigin.status).toBe(403);
  expect(badOrigin.body.code).toBe('ORIGIN_INVALID');
});

test('ADV-02: tenant and property identifiers cannot be swapped', async () => {
  const otherTenant = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantB}/properties`,
  );
  expect(otherTenant.status).toBe(403);
  expect(otherTenant.body.code).toBe('TENANT_CONTEXT_MISMATCH');

  const foreignProperty = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertyB}`,
  );
  expect(foreignProperty.status).toBe(404);
  expect(foreignProperty.body.code).toBe('NOT_FOUND');

  const foreignWrite = await createResource(owner.context, propertyB, {
    code: 'ADV-XT',
    type: 'ROOM',
    capacity: 1,
  });
  expect(foreignWrite.status).toBe(404);

  const crossLocation = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyB2}/locations`,
    { body: { code: 'ADV-LOC-B2', name: 'Adversarial location B2' } },
  );
  expect(crossLocation.status).toBe(201);
  const crossPropertyLocation = await createResource(owner.context, propertyA, {
    code: 'ADV-XP',
    type: 'ROOM',
    capacity: 1,
    location_id: crossLocation.body.location.id,
  });
  expect(crossPropertyLocation.status).toBe(422);
  expect(crossPropertyLocation.body.code).toBe('CROSS_SCOPE_REFERENCE');
});

test('ADV-03: MFA gates cannot be bypassed by headers or body hints', async () => {
  const propertyWrite = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: { code: 'ADV-MFA1', name: 'No MFA', timezone: 'Asia/Jakarta' },
    },
  );
  expect(propertyWrite.status).toBe(403);
  expect(propertyWrite.body.code).toBe('MFA_REQUIRED');

  const compositionWrite = await createComposition(owner.context, {
    product_id: randomUUID(),
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: [resourceA],
    nested_version_ids: [],
  });
  expect(compositionWrite.status).toBe(403);
  expect(compositionWrite.body.code).toBe('MFA_REQUIRED');

  const connectionWrite = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/connections`,
    {
      body: {
        provider_key: 'channex',
        environment: 'simulator',
        channel_key: 'tiket-com',
        secret_ref: 'secret:adv-mfa',
      },
    },
  );
  expect(connectionWrite.status).toBe(403);
  expect(connectionWrite.body.code).toBe('MFA_REQUIRED');

  const mappingWrite = await apiRequest(
    owner.context,
    'PUT',
    `/tenants/${tenantA}/properties/${propertyA}/connections/${randomUUID()}/mapping`,
    {
      body: {
        channel_key: 'tiket-com',
        external_room_ref: 'X',
        external_rate_ref: 'Y',
        occupancy: 1,
      },
    },
  );
  expect(mappingWrite.status).toBe(403);
  expect(mappingWrite.body.code).toBe('MFA_REQUIRED');

  const fakeApproval = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'ADV-MFA2',
        name: 'Fake approval',
        timezone: 'Asia/Jakarta',
      },
      headers: { 'x-approval-id': randomUUID() },
    },
  );
  expect(fakeApproval.status).toBe(403);
  expect(fakeApproval.body.code).toBe('MFA_REQUIRED');
});

test('ADV-04: member and auditor roles cannot escalate writes', async () => {
  const memberRead = await apiRequest(
    member.context,
    'GET',
    `/tenants/${tenantA}/properties`,
  );
  expect(memberRead.status).toBe(403);
  const memberWrite = await createResource(member.context, propertyA, {
    code: 'ADV-MEMBER',
    type: 'ROOM',
    capacity: 1,
  });
  expect(memberWrite.status).toBe(403);
  expect(memberWrite.body.code).toBe('PERMISSION_DENIED');

  const auditorRead = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties`,
  );
  expect(auditorRead.status).toBe(200);
  const auditorProduct = await apiRequest(
    auditor.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/products`,
    { body: { code: 'ADV-AUD', name: 'Nope', kind: 'ROOM' } },
  );
  expect(auditorProduct.status).toBe(403);
  const auditorConnection = await apiRequest(
    auditor.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/connections`,
    {
      body: {
        provider_key: 'channex',
        environment: 'simulator',
        channel_key: 'tiket-com',
        secret_ref: 'secret:aud',
      },
    },
  );
  expect(auditorConnection.status).toBe(403);
});

test('ADV-05: property-scoped grants cannot be widened or spoofed by the header', async () => {
  const allowed = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/resources`,
    {
      body: { code: 'ADV-SCOPE-A', type: 'ROOM', capacity: 1 },
      headers: { 'x-property-ref': propertyA },
    },
  );
  expect(allowed.status).toBe(201);

  const otherPropertyNoHeader = await createResource(
    member.context,
    propertyB2,
    {
      code: 'ADV-SCOPE-B1',
      type: 'ROOM',
      capacity: 1,
    },
  );
  expect(otherPropertyNoHeader.status).toBe(403);

  const otherPropertyWithHeader = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyB2}/resources`,
    {
      body: { code: 'ADV-SCOPE-B2', type: 'ROOM', capacity: 1 },
      headers: { 'x-property-ref': propertyB2 },
    },
  );
  expect(otherPropertyWithHeader.status).toBe(403);

  const spoofedHeaderOnGranted = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/resources`,
    {
      body: { code: 'ADV-SCOPE-B3', type: 'ROOM', capacity: 1 },
      headers: { 'x-property-ref': propertyB2 },
    },
  );
  expect(spoofedHeaderOnGranted.status).toBe(403);
  expect(spoofedHeaderOnGranted.body.code).toBe('PERMISSION_DENIED');

  await withOwner(async (client) => {
    await client.query(
      `update "role_grant" set "revoked_at" = now() where "id" = $1`,
      [scopedGrantId],
    );
  });
  const afterRevoke = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/resources`,
    {
      body: { code: 'ADV-SCOPE-AFTER', type: 'ROOM', capacity: 1 },
      headers: { 'x-property-ref': propertyA },
    },
  );
  expect(afterRevoke.status).toBe(403);
});

test('ADV-06: strict input validation rejects mass assignment and malformed values', async () => {
  const extraField = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'ADV-EXTRA',
        name: 'Extra field',
        timezone: 'Asia/Jakarta',
        status: 'ACTIVE',
      },
    },
  );
  expect(extraField.status).toBe(400);
  expect(extraField.body.code).toBe('INVALID_REQUEST');

  const extraResourceField = await createResource(owner.context, propertyA, {
    code: 'ADV-EXTRA-R',
    type: 'ROOM',
    capacity: 1,
    inventory_version: 9999,
  });
  expect(extraResourceField.status).toBe(400);

  const versionMassAssignment = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyA}`,
    { body: { version: 1, inventory_version: 9999 } },
  );
  expect(versionMassAssignment.status).toBe(400);

  const malformedUuid = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/not-a-uuid`,
  );
  expect(malformedUuid.status).toBe(400);

  for (const capacity of [-1, 2.5, 1000]) {
    const bad = await createResource(owner.context, propertyA, {
      code: `ADV-CAP-${String(capacity).replace('.', '_')}`,
      type: 'ROOM',
      capacity,
    });
    expect(bad.status).toBe(400);
  }

  const oversized = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/resources`,
    {
      body: {
        code: 'ADV-BIG',
        type: 'ROOM',
        capacity: 1,
        note: 'x'.repeat(17 * 1024),
      },
    },
  );
  expect(oversized.status).toBe(413);
});

test('ADV-07: injection and XSS payloads are stored safely and never executed', async () => {
  const name = `"><img src=x onerror=alert(1)> OR 1=1--`;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    { body: { code: 'ADV-XSS', name, timezone: 'Asia/Jakarta' } },
  );
  expect(created.status).toBe(201);
  expect(created.body.property.name).toBe(name);
  const read = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${created.body.property.id}`,
  );
  expect(read.status).toBe(200);
  expect(read.body.property.name).toBe(name);
  const intact = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties`,
  );
  expect(intact.status).toBe(200);

  const injectCode = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: "A'; drop table property; --",
        name: 'SQLi code',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(injectCode.status).toBe(400);

  const injectResource = await createResource(owner.context, propertyA, {
    code: "R' OR '1'='1",
    type: 'ROOM',
    capacity: 1,
  });
  expect(injectResource.status).toBe(400);
});

test('ADV-08: secret references never leak into responses, listings or audit', async () => {
  const secretRef = 'secret:adv-connection-secret';
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/connections`,
    {
      body: {
        provider_key: 'channex',
        environment: 'simulator',
        channel_key: 'tiket-com',
        external_property_id: 'ADV-EXT',
        secret_ref: secretRef,
      },
    },
  );
  expect(created.status).toBe(201);
  connectionId = created.body.connection.id;
  expect(JSON.stringify(created.body)).not.toContain('adv-connection-secret');

  const list = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${propertyA}/connections`,
  );
  expect(list.status).toBe(200);
  expect(JSON.stringify(list.body)).not.toContain('adv-connection-secret');

  const audit = await withOwner(async (client) => {
    const result = await client.query(
      `select "before_safe", "after_safe" from "audit_event"
        where "tenant_id" = $1 and "action" = 'connection.draft_created'
        order by "created_at" desc limit 1`,
      [tenantA],
    );
    return JSON.stringify(result.rows);
  });
  expect(audit).not.toContain('adv-connection-secret');
  expect(audit).toMatch(/provider_key/);
  expect(audit).not.toMatch(/secret/i);

  const rawSecret = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/connections`,
    {
      body: {
        provider_key: 'channex',
        environment: 'simulator',
        channel_key: 'tiket-com',
        external_property_id: 'ADV-RAW',
        secret_ref: 'sk_live_abcd1234',
      },
    },
  );
  expect(rawSecret.status).toBe(400);
});

test('ADV-09: mappings cannot claim another channel or a rate plan outside the property', async () => {
  const wrongChannel = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${propertyA}/connections/${connectionId}/mapping`,
    {
      body: {
        channel_key: 'agoda',
        external_room_ref: 'ADV-ROOM',
        external_rate_ref: 'ADV-RATE',
        occupancy: 2,
      },
    },
  );
  expect(wrongChannel.status).toBe(400);
  expect(wrongChannel.body.code).toBe('INVALID_REQUEST');

  const ratePlan = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${propertyA}/connections/${connectionId}/mapping`,
    {
      body: {
        channel_key: 'tiket-com',
        external_room_ref: 'ADV-ROOM',
        external_rate_ref: 'ADV-RATE',
        occupancy: 2,
        internal_rate_ref: randomUUID(),
      },
    },
  );
  expect(ratePlan.status).toBe(422);
  expect(ratePlan.body.code).toBe('CROSS_SCOPE_REFERENCE');

  const saved = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${propertyA}/connections/${connectionId}/mapping`,
    {
      body: {
        channel_key: 'tiket-com',
        external_room_ref: 'ADV-ROOM',
        external_rate_ref: 'ADV-RATE',
        occupancy: 2,
      },
    },
  );
  expect(saved.status).toBe(200);
  expect(saved.body.mapping.status).toBe('DRAFT');
  expect(saved.body.mapping.internal_rate_ref).toBeNull();
});

test('ADV-10: runtime roles cannot delete, truncate or re-tenant phase 4 rows', async () => {
  const product = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/products`,
    { body: { code: 'ADV-DEL', name: 'Delete probe', kind: 'ROOM' } },
  );
  expect(product.status).toBe(201);
  const productId = product.body.product.id;

  await withRuntimeRole('api', async (client) => {
    await probeFail(
      client,
      tenantA,
      'delete from "product" where "id" = $1',
      [productId],
      '42501',
    );
    await probeFail(
      client,
      tenantA,
      'delete from "composition_leaf" where "version_id" = $1',
      [randomUUID()],
      '42501',
    );
    await probeFail(
      client,
      tenantA,
      'update "composition_edge" set "position" = 99 where "id" = $1',
      [randomUUID()],
      '42501',
    );
    await probeFail(
      client,
      tenantA,
      'truncate table "composition_version"',
      [],
      '42501',
    );
    await probeFail(
      client,
      tenantA,
      `insert into "product"
         ("tenant_id", "property_id", "code", "name", "kind")
       values ($1, $2, 'ADV-XTEN', 'Cross tenant', 'ROOM')`,
      [tenantB, propertyA],
      '42501',
    );
    await probeFail(
      client,
      tenantA,
      'update "product" set "tenant_id" = $1 where "id" = $2',
      [tenantB, productId],
      '42501',
    );
  });

  await withRuntimeRole('worker', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    const visible = await client.query(
      `select count(*)::int as "count" from "product" where "id" = $1`,
      [productId],
    );
    expect(visible.rows[0].count).toBe(1);
    await client.query('rollback');
    await probeFail(
      client,
      tenantA,
      `insert into "product"
         ("tenant_id", "property_id", "code", "name", "kind")
       values ($1, $2, 'ADV-W', 'Worker write', 'ROOM')`,
      [tenantA, propertyA],
      '42501',
    );
  });
});

test('ADV-11: retired and archived states cannot be bypassed', async () => {
  const resource = await createResource(owner.context, propertyA, {
    code: 'ADV-RETIRE',
    type: 'ROOM',
    capacity: 1,
  });
  expect(resource.status).toBe(201);
  const retired = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyA}/resources/${resource.body.resource.id}`,
    {
      body: {
        version: resource.body.resource.version,
        state: 'RETIRED',
      },
    },
  );
  expect(retired.status).toBe(200);

  const product = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/products`,
    { body: { code: 'ADV-RET-P', name: 'Retired probe', kind: 'ROOM' } },
  );
  expect(product.status).toBe(201);
  const candidate = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/products/${product.body.product.id}/candidates`,
    { body: { resource_id: resource.body.resource.id } },
  );
  expect(candidate.status).toBe(409);
  expect(candidate.body.code).toBe('RESOURCE_RETIRED');

  const reactivate = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyA}/resources/${resource.body.resource.id}`,
    { body: { version: retired.body.resource.version, state: 'ACTIVE' } },
  );
  expect(reactivate.status).toBe(409);
  expect(reactivate.body.code).toBe('RESOURCE_RETIRED');

  const archived = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${propertyB2}`,
    { body: { version: 1, status: 'ARCHIVED' } },
  );
  expect(archived.status).toBe(200);
  const compositionOnArchived = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyB2}/compositions`,
    {
      body: {
        product_id: product.body.product.id,
        effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
        resource_ids: [resourceB2],
        nested_version_ids: [],
      },
    },
  );
  expect(compositionOnArchived.status).toBe(409);
  expect(compositionOnArchived.body.code).toBe('PROPERTY_ARCHIVED');
  const resourceOnArchived = await createResource(owner.context, propertyB2, {
    code: 'ADV-ARCH',
    type: 'ROOM',
    capacity: 1,
  });
  expect(resourceOnArchived.status).toBe(409);
});

test('ADV-12: composition limits and duplicate leaves resist oversized graphs', async () => {
  const seeded = await withOwner(async (client) => {
    const result = await client.query(
      `select "id", "code" from "resource"
        where "tenant_id" = $1 and "property_id" = $2
          and "code" like 'ADV-L%'
        order by "code"`,
      [tenantA, propertyA],
    );
    return result.rows;
  });
  const left = seeded.slice(0, 17).map((row) => row.id);
  const right = seeded.slice(17, 34).map((row) => row.id);
  const product = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/products`,
    { body: { code: 'ADV-LIMIT', name: 'Limit probe', kind: 'VILLA' } },
  );
  expect(product.status).toBe(201);
  const productId = product.body.product.id;

  const childOne = await createComposition(admin.context, {
    product_id: productId,
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: left,
    nested_version_ids: [],
  });
  const childTwo = await createComposition(admin.context, {
    product_id: productId,
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: right,
    nested_version_ids: [],
  });
  expect(childOne.status).toBe(201);
  expect(childTwo.status).toBe(201);
  expect(
    (await activateComposition(admin.context, childOne.body.composition.id))
      .status,
  ).toBe(200);
  expect(
    (await activateComposition(admin.context, childTwo.body.composition.id))
      .status,
  ).toBe(200);

  const parent = await createComposition(admin.context, {
    product_id: productId,
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: [],
    nested_version_ids: [
      childOne.body.composition.id,
      childTwo.body.composition.id,
    ],
  });
  expect(parent.status).toBe(201);
  const tooManyLeaves = await activateComposition(
    admin.context,
    parent.body.composition.id,
  );
  expect(tooManyLeaves.status).toBe(422);
  expect(tooManyLeaves.body.code).toBe('LIMIT_EXCEEDED');

  const depthOne = await createComposition(admin.context, {
    product_id: productId,
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: [seeded[0].id],
    nested_version_ids: [],
  });
  expect(
    (await activateComposition(admin.context, depthOne.body.composition.id))
      .status,
  ).toBe(200);
  let chain = depthOne.body.composition.id;
  for (const level of [2, 3, 4]) {
    const next = await createComposition(admin.context, {
      product_id: productId,
      effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
      resource_ids: [],
      nested_version_ids: [chain],
    });
    expect(next.status).toBe(201);
    const activated = await activateComposition(
      admin.context,
      next.body.composition.id,
    );
    expect(activated.status).toBe(200);
    expect(Math.max(...activated.body.leaves.map((leaf) => leaf.depth))).toBe(
      level,
    );
    chain = next.body.composition.id;
  }
  const tooDeep = await createComposition(admin.context, {
    product_id: productId,
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: [],
    nested_version_ids: [chain],
  });
  expect(tooDeep.status).toBe(201);
  const deepActivation = await activateComposition(
    admin.context,
    tooDeep.body.composition.id,
  );
  expect(deepActivation.status).toBe(422);
  expect(deepActivation.body.code).toBe('LIMIT_EXCEEDED');
});

test('ADV-13: concurrent commands resolve with a single winner', async () => {
  const [first, second] = await Promise.all([
    apiRequest(admin.context, 'POST', `/tenants/${tenantA}/properties`, {
      body: { code: 'ADV-RACE', name: 'Race one', timezone: 'Asia/Jakarta' },
    }),
    apiRequest(admin.context, 'POST', `/tenants/${tenantA}/properties`, {
      body: { code: 'ADV-RACE', name: 'Race two', timezone: 'Asia/Jakarta' },
    }),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([201, 409]);

  const product = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyA}/products`,
    { body: { code: 'ADV-RACE-C', name: 'Race composition', kind: 'ROOM' } },
  );
  const composition = await createComposition(admin.context, {
    product_id: product.body.product.id,
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: [resourceA],
    nested_version_ids: [],
  });
  expect(composition.status).toBe(201);
  const activationResults = await Promise.all([
    activateComposition(admin.context, composition.body.composition.id),
    activateComposition(admin.context, composition.body.composition.id),
  ]);
  expect(activationResults.map((result) => result.status).sort()).toEqual([
    200, 409,
  ]);
  const winner = activationResults.find((result) => result.status === 200);
  expect(winner.body.leaves).toHaveLength(1);

  const resource = await createResource(owner.context, propertyA, {
    code: 'ADV-RACE-R',
    type: 'ROOM',
    capacity: 1,
  });
  const version = resource.body.resource.version;
  const patch = (capacity) =>
    apiRequest(
      owner.context,
      'PATCH',
      `/tenants/${tenantA}/properties/${propertyA}/resources/${resource.body.resource.id}`,
      { body: { version, capacity } },
    );
  const [left, right] = await Promise.all([patch(3), patch(4)]);
  expect([left.status, right.status].sort()).toEqual([200, 412]);
});
