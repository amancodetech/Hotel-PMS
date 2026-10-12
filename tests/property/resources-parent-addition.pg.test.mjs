import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';
let admin, other, tenant;
const key = () => randomUUID();
const prefix = (p) => `/tenants/${tenant}/properties/${p.id}`;
const request = (p, method, suffix, body, k = key()) =>
  apiRequest(admin.context, method, prefix(p) + suffix, {
    body,
    headers: { 'idempotency-key': k },
  });
async function fixture(parts = true) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `CH-${key().slice(0, 12)}`,
        name: 'Synthetic child addition',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  const p = created.body.property;
  const input = {
    schema_version: 2,
    property: {
      name: 'Synthetic child addition',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['VILLA'],
    },
    locations: [],
    unit_groups: [
      {
        group_ref: 'v',
        physical_template: 'VILLA',
        booking_mode: parts ? 'WHOLE_AND_PARTS' : 'WHOLE_ONLY',
        selection_mode: 'EXACT',
        capacity: 6,
        privacy_ack: true,
        units: [{ unit_ref: 'v', code: 'V', display_label: 'Villa' }],
        ...(parts
          ? {
              parts: [
                {
                  part_ref: 'a',
                  code: 'R1',
                  display_label: 'Room 1',
                  capacity: 3,
                },
                {
                  part_ref: 'b',
                  code: 'R2',
                  display_label: 'Room 2',
                  capacity: 3,
                },
              ],
            }
          : {}),
        effective_from: '2026-10-01',
        effective_to: '2031-10-08',
      },
    ],
    operations: {
      check_in: '14:00',
      check_out: '12:00',
      explicit_states: true,
    },
    pricing: { postponed: true },
  };
  const draft = await request(p, 'PUT', '/setup-draft', input);
  expect(draft.status).toBe(200);
  const preview = await request(p, 'POST', '/setup-draft/preview');
  expect(preview.status).toBe(200);
  const applied = await apiRequest(
    admin.context,
    'POST',
    prefix(p) + '/setup-draft/apply',
    {
      body: { preview_version: preview.body.preview_version },
      headers: {
        'idempotency-key': key(),
        'if-match': `"${draft.body.draft.draft_id}:${draft.body.draft.revision}"`,
      },
    },
  );
  expect(applied.status).toBe(200);
  const rows = (await request(p, 'GET', '/resources?limit=100')).body.items;
  return { p, rows, parent: rows.find((r) => r.code === 'V') };
}
const child = (parent) => ({
  code: 'R3',
  type: 'ROOM',
  capacity: 3,
  parent_resource_id: parent.id,
  display_label: 'Room 3',
});
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  other = await loginAs('owner-b');
  tenant = admin.session.body.session.active_tenant_id;
});
afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('scoped child creation is concurrent-idempotent and preserves parent, old children, products and compositions', async () => {
  const { p, rows, parent } = await fixture();
  const body = child(parent),
    k = key();
  const before = await withOwner(
    async (c) =>
      (
        await c.query(
          'select inventory_version from property where tenant_id=$1 and id=$2',
          [tenant, p.id],
        )
      ).rows[0],
  );
  const products = (await request(p, 'GET', '/products')).body.items;
  const compositions = (await request(p, 'GET', '/compositions')).body.items;
  const replies = await Promise.all([
    request(p, 'POST', '/resources', body, k),
    request(p, 'POST', '/resources', body, k),
  ]);
  expect(replies.map((r) => r.status)).toEqual([201, 201]);
  expect(replies[0].body).toEqual(replies[1].body);
  expect(replies[0].body.resource.parent_resource_id).toBe(parent.id);
  const after = (await request(p, 'GET', '/resources?limit=100')).body.items;
  expect(after).toHaveLength(4);
  for (const old of rows)
    expect(after.find((r) => r.id === old.id)).toEqual(old);
  expect((await request(p, 'GET', '/products')).body.items).toEqual(products);
  expect((await request(p, 'GET', '/compositions')).body.items).toEqual(
    compositions,
  );
  const persisted = await withOwner(
    async (c) =>
      (
        await c.query(
          'select parent_resource_id from resource where tenant_id=$1 and property_id=$2 and id=$3',
          [tenant, p.id, replies[0].body.resource.id],
        )
      ).rows[0],
  );
  expect(persisted.parent_resource_id).toBe(parent.id);
  const rev = await withOwner(
    async (c) =>
      (
        await c.query(
          'select inventory_version from property where tenant_id=$1 and id=$2',
          [tenant, p.id],
        )
      ).rows[0],
  );
  expect(Number(rev.inventory_version)).toBe(
    Number(before.inventory_version) + 1,
  );
  expect(
    (await request(p, 'POST', '/resources', { ...body, capacity: 4 }, k))
      .status,
  ).toBe(409);
  expect(
    (
      await request(p, 'PATCH', `/resources/${replies[0].body.resource.id}`, {
        version: 1,
        parent_resource_id: null,
      })
    ).status,
  ).toBe(400);
  await withOwner((c) =>
    c.query(
      'update resource set state=$1 where tenant_id=$2 and property_id=$3 and id=$4',
      ['INACTIVE', tenant, p.id, parent.id],
    ),
  );
  const replay = await request(p, 'POST', '/resources', body, k);
  expect(replay.status).toBe(201);
  expect(replay.body).toEqual(replies[0].body);
});

test('child creation requires key and rejects atomic villa conversion and invalid child/parent kinds', async () => {
  const parts = await fixture(),
    atomic = await fixture(false);
  const missing = await apiRequest(
    admin.context,
    'POST',
    prefix(parts.p) + '/resources',
    { body: child(parts.parent), idempotency: false },
  );
  expect(missing.status).toBe(400);
  const denied = await request(
    atomic.p,
    'POST',
    '/resources',
    child(atomic.parent),
  );
  expect(denied.status).toBe(422);
  expect(denied.body.code).toBe('INVENTORY_TRANSFORMATION_REQUIRED');
  expect(
    (
      await request(parts.p, 'POST', '/resources', {
        ...child(parts.parent),
        type: 'BED',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request(parts.p, 'POST', '/resources', {
        ...child(parts.parent),
        parent_resource_id: parts.rows.find((r) => r.type === 'ROOM').id,
      })
    ).status,
  ).toBe(400);
  expect(
    (await request(atomic.p, 'GET', '/resources?limit=100')).body.items,
  ).toHaveLength(1);
});

test('parent scope and inactive/retired lifecycle are enforced without inserts', async () => {
  const a = await fixture(),
    b = await fixture();
  expect(
    (await request(a.p, 'POST', '/resources', child(b.parent))).status,
  ).toBe(404);
  const foreignTenant = other.session.body.session.active_tenant_id;
  const foreign = await apiRequest(
    other.context,
    'POST',
    `/tenants/${foreignTenant}/properties`,
    {
      body: {
        code: `FC-${key().slice(0, 12)}`,
        name: 'Foreign synthetic',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(foreign.status).toBe(403);
  // owner-b deliberately lacks property.create. Seed only this test's uniquely
  // owned foreign fixture, then exercise the real admin-a scoped create API.
  const foreignPropertyId = key(),
    foreignResourceId = key();
  await withOwner(async (c) => {
    await c.query(
      'insert into property (id,tenant_id,code,name,timezone) values ($1,$2,$3,$4,$5)',
      [
        foreignPropertyId,
        foreignTenant,
        `FC-${key().slice(0, 12)}`,
        'Foreign synthetic',
        'Asia/Jakarta',
      ],
    );
    await c.query(
      'insert into resource (id,tenant_id,property_id,code,resource_type,capacity) values ($1,$2,$3,$4,$5,$6)',
      [foreignResourceId, foreignTenant, foreignPropertyId, 'FV', 'VILLA', 3],
    );
  });
  expect(
    (await request(a.p, 'POST', '/resources', child({ id: foreignResourceId })))
      .status,
  ).toBe(404);
  for (const state of ['INACTIVE', 'RETIRED']) {
    await withOwner((c) =>
      c.query(
        'update resource set state=$1 where tenant_id=$2 and property_id=$3 and id=$4',
        [state, tenant, a.p.id, a.parent.id],
      ),
    );
    expect(
      (await request(a.p, 'POST', '/resources', child(a.parent))).status,
    ).toBe(409);
  }
  expect(
    (await request(a.p, 'GET', '/resources?limit=100')).body.items,
  ).toHaveLength(3);
});
