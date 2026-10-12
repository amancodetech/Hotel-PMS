import { beforeAll, afterAll, test, expect } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
  withRuntimeRole,
} from './support/harness.mjs';
let admin, reader, other, tenant;
const key = () => randomUUID();
const base = (p) => `/tenants/${tenant}/properties/${p.id}`;
const call = (p, method, path, body, session = admin, headers) =>
  apiRequest(session.context, method, `${base(p)}${path}`, { body, headers });
const day = (offset) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
async function property() {
  const r = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `ARC-${key().slice(0, 8)}`,
        name: 'Synthetic archive fixture',
        timezone: 'Asia/Makassar',
      },
    },
  );
  expect(r.status).toBe(201);
  return r.body.property;
}
async function location(p, extra = {}) {
  const r = await call(
    p,
    'POST',
    '/locations',
    {
      code: `L-${key().slice(0, 8)}`,
      name: 'Synthetic place',
      kind: 'BUILDING',
      ...extra,
    },
    admin,
    { 'idempotency-key': key() },
  );
  expect(r.status).toBe(201);
  return r.body.location;
}
async function resource(p, extra = {}) {
  const r = await call(p, 'POST', '/resources', {
    code: `R-${key().slice(0, 8)}`,
    type: 'ROOM',
    capacity: 2,
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body.resource;
}
async function snapshot(p, tables) {
  return withOwner(async (c) => {
    const result = {};
    for (const table of tables)
      result[table] = (
        await c.query(
          `select * from "${table}" t where tenant_id=$1 and ${table === 'property' ? 'id' : 'property_id'}=$2 order by to_jsonb(t)::text`,
          [tenant, p.id],
        )
      ).rows;
    return result;
  });
}
const protectedTables = [
  'product',
  'product_resource_candidate',
  'composition_version',
  'composition_leaf',
  'reservation',
  'reservation_item',
  'stay_segment',
  'room_assignment',
  'commitment',
  'plan_allocation',
  'exposure',
  'exposure_allocation',
  'journal',
  'journal_line',
];
async function wholeUnit() {
  const p = await property();
  const room = await resource(p);
  const product = await call(p, 'POST', '/products', {
    code: 'ROOM',
    name: 'Synthetic room',
    kind: 'ROOM',
    occupancy_adults_max: 2,
  });
  expect(product.status).toBe(201);
  expect(
    (
      await call(p, 'POST', `/products/${product.body.product.id}/candidates`, {
        resource_id: room.id,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call(p, 'PATCH', `/products/${product.body.product.id}`, {
        version: product.body.product.version,
        status: 'ACTIVE',
      })
    ).status,
  ).toBe(200);
  await withOwner((c) =>
    c.query(
      "update property set status='ACTIVE' where tenant_id=$1 and id=$2",
      [tenant, p.id],
    ),
  );
  return { p, room, product: product.body.product };
}
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  reader = await loginAs('auditor-a');
  other = await loginAs('owner-b');
  tenant = admin.session.body.session.active_tenant_id;
});
afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('T18 location preview is scoped, read-only and readable without management; children and units block direct PATCH', async () => {
  const p = await property(),
    q = await property(),
    parent = await location(p),
    foreign = await location(q);
  await location(p, { parent_id: parent.id });
  const before = await snapshot(p, [
    'property',
    'location',
    'resource',
    'audit_event',
  ]);
  const preview = await call(
    p,
    'GET',
    `/locations/${parent.id}/archive-preview`,
    undefined,
    reader,
  );
  expect(preview).toMatchObject({
    status: 200,
    body: {
      eligible: false,
      counts: { children: 1, resources: 0 },
      blockers: ['LOCATION_CHILDREN'],
    },
  });
  expect(
    await snapshot(p, ['property', 'location', 'resource', 'audit_event']),
  ).toEqual(before);
  expect(
    (
      await call(
        p,
        'PATCH',
        `/locations/${parent.id}`,
        { version: parent.version, status: 'INACTIVE' },
        reader,
      )
    ).status,
  ).toBe(403);
  const rejected = await call(p, 'PATCH', `/locations/${parent.id}`, {
    version: parent.version,
    status: 'INACTIVE',
  });
  expect(rejected).toMatchObject({
    status: 422,
    body: { code: 'LOCATION_IN_USE', details: { counts: { children: 1 } } },
  });
  expect(
    (await call(p, 'GET', `/locations/${foreign.id}/archive-preview`)).status,
  ).toBe(404);
  expect([403, 404]).toContain(
    (
      await call(
        p,
        'GET',
        `/locations/${parent.id}/archive-preview`,
        undefined,
        other,
      )
    ).status,
  );
  expect((await call(p, 'DELETE', `/locations/${parent.id}`)).status).toBe(404);
  expect(
    await snapshot(p, ['property', 'location', 'resource', 'audit_event']),
  ).toEqual(before);
  await withRuntimeRole('api', async (c) => {
    await c.query('begin');
    await c.query("select set_config('app.tenant_id',$1,true)", [tenant]);
    await expect(
      c.query(
        'delete from location where tenant_id=$1 and property_id=$2 and id=$3',
        [tenant, p.id, parent.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await c.query('rollback');
  });
  const used = await location(p);
  const r = await resource(p, { location_id: used.id });
  expect(
    (await call(p, 'GET', `/locations/${used.id}/archive-preview`)).body.counts
      .resources,
  ).toBe(1);
  expect(
    (
      await call(p, 'PATCH', `/locations/${used.id}`, {
        version: used.version,
        status: 'INACTIVE',
      })
    ).body.code,
  ).toBe('LOCATION_IN_USE');
  expect(
    (await call(p, 'GET', '/resources')).body.items.find((x) => x.id === r.id)
      .location_id,
  ).toBe(used.id);
});

test('T18 empty location preserves identity, rejects a stale version and rechecks relationships added after preview', async () => {
  const p = await property(),
    l = await location(p);
  const old = await call(p, 'GET', `/locations/${l.id}/archive-preview`);
  expect(old.body.eligible).toBe(true);
  const renamed = await call(p, 'PATCH', `/locations/${l.id}`, {
    version: l.version,
    name: 'Renamed synthetic place',
  });
  expect(renamed.status).toBe(200);
  const stale = await call(p, 'PATCH', `/locations/${l.id}`, {
    version: old.body.version,
    status: 'INACTIVE',
  });
  expect(stale).toMatchObject({ status: 412, body: { code: 'STALE_VERSION' } });
  const archived = await call(p, 'PATCH', `/locations/${l.id}`, {
    version: renamed.body.location.version,
    status: 'INACTIVE',
  });
  expect(archived).toMatchObject({
    status: 200,
    body: {
      location: {
        id: l.id,
        code: l.code,
        name: 'Renamed synthetic place',
        status: 'INACTIVE',
      },
    },
  });
  expect(
    (
      await call(
        p,
        'POST',
        '/locations',
        { code: 'BAD', name: 'Child', parent_id: l.id },
        admin,
        { 'idempotency-key': key() },
      )
    ).status,
  ).toBe(409);
  const raced = await location(p);
  const safe = await call(p, 'GET', `/locations/${raced.id}/archive-preview`);
  expect(safe.body.eligible).toBe(true);
  await resource(p, { location_id: raced.id });
  const before = await snapshot(p, [
    'property',
    'location',
    'resource',
    'audit_event',
  ]);
  expect(
    (
      await call(p, 'PATCH', `/locations/${raced.id}`, {
        version: safe.body.version,
        status: 'INACTIVE',
      })
    ).body.code,
  ).toBe('LOCATION_IN_USE');
  expect(
    await snapshot(p, ['property', 'location', 'resource', 'audit_event']),
  ).toEqual(before);
});

test('T18 resource live HOLD blocks INACTIVE and RETIRED; an expired HOLD and product history are preserved without blocking', async () => {
  const { p, room, product } = await wholeUnit();
  const originallySafe = await call(
    p,
    'GET',
    `/resources/${room.id}/archive-preview`,
  );
  expect(originallySafe.body.eligible).toBe(true);
  const version = (await call(p, 'GET', '')).body.property.inventory_version;
  const held = await call(
    p,
    'POST',
    '/holds',
    {
      items: [
        {
          product_id: product.id,
          period: { arrival: day(10), departure: day(12) },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      ],
      inventory_version: version,
      ttl_seconds: 300,
    },
    admin,
    { 'idempotency-key': key() },
  );
  expect(held.status).toBe(201);
  const before = await snapshot(p, [
    'property',
    'resource',
    'audit_event',
    ...protectedTables,
  ]);
  const preview = await call(
    p,
    'GET',
    `/resources/${room.id}/archive-preview`,
    undefined,
    reader,
  );
  expect(preview).toMatchObject({
    status: 200,
    body: { eligible: false, counts: { live_commitments: 1, products: 1 } },
  });
  for (const state of ['INACTIVE', 'RETIRED'])
    expect(
      (
        await call(p, 'PATCH', `/resources/${room.id}`, {
          version: room.version,
          state,
        })
      ).body.code,
    ).toBe('RESOURCE_IN_USE');
  expect((await call(p, 'DELETE', `/resources/${room.id}`)).status).toBe(404);
  expect(
    await snapshot(p, [
      'property',
      'resource',
      'audit_event',
      ...protectedTables,
    ]),
  ).toEqual(before);
  await withRuntimeRole('api', async (c) => {
    await c.query('begin');
    await c.query("select set_config('app.tenant_id',$1,true)", [tenant]);
    await expect(
      c.query(
        'delete from resource where tenant_id=$1 and property_id=$2 and id=$3',
        [tenant, p.id, room.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await c.query('rollback');
  });
  await withOwner((c) =>
    c.query(
      "update commitment set expires_at=now()-interval '1 second' where tenant_id=$1 and property_id=$2 and source_kind='HOLD'",
      [tenant, p.id],
    ),
  );
  const historical = await snapshot(p, protectedTables);
  const eligible = await call(
    p,
    'GET',
    `/resources/${room.id}/archive-preview`,
  );
  expect(eligible).toMatchObject({
    status: 200,
    body: {
      eligible: true,
      counts: { live_commitments: 0, allocations: 1, products: 1 },
    },
  });
  const archived = await call(p, 'PATCH', `/resources/${room.id}`, {
    version: eligible.body.version,
    state: 'RETIRED',
  });
  expect(archived).toMatchObject({
    status: 200,
    body: { resource: { id: room.id, code: room.code, state: 'RETIRED' } },
  });
  expect(await snapshot(p, protectedTables)).toEqual(historical);
  expect(
    (await call(p, 'GET', `/resources/${room.id}/archive-preview`)).body
      .blockers,
  ).toContain('ALREADY_ARCHIVED');
});

test('T18 UNKNOWN channel exposure blocks retirement even for a past window and never releases its quota', async () => {
  const { p, room, product } = await wholeUnit();
  const connection = key(),
    exposure = key();
  await withOwner(async (c) => {
    await c.query(
      "insert into distribution_connection(id,tenant_id,property_id,provider_key,environment,channel_key,external_property_id,secret_ref) values($1,$2,$3,'CHANNEX','STAGING','BOOKING_COM','synthetic-archive','local:synthetic')",
      [connection, tenant, p.id],
    );
    await c.query(
      "insert into exposure(id,tenant_id,property_id,connection_id,product_id,start_date,end_date,mode,state,inventory_version) values($1,$2,$3,$4,$5,$6,$7,'WHOLE','UNKNOWN',1)",
      [exposure, tenant, p.id, connection, product.id, day(-10), day(-8)],
    );
    await c.query(
      'insert into exposure_allocation(id,exposure_id,tenant_id,property_id,resource_id,start_date,end_date) values($1,$2,$3,$4,$5,$6,$7)',
      [key(), exposure, tenant, p.id, room.id, day(-10), day(-8)],
    );
  });
  const before = await snapshot(p, [
    'property',
    'resource',
    'audit_event',
    ...protectedTables,
  ]);
  const preview = await call(p, 'GET', `/resources/${room.id}/archive-preview`);
  expect(preview).toMatchObject({
    status: 200,
    body: {
      eligible: false,
      counts: { channel_exposures: 1 },
      blockers: ['CHANNEL_EXPOSURES'],
    },
  });
  expect(
    (
      await call(p, 'PATCH', `/resources/${room.id}`, {
        version: room.version,
        state: 'RETIRED',
      })
    ).body.code,
  ).toBe('RESOURCE_IN_USE');
  expect(
    await snapshot(p, [
      'property',
      'resource',
      'audit_event',
      ...protectedTables,
    ]),
  ).toEqual(before);
});

test('T18 resource version and new promises are rechecked after a safe preview; concurrent location archive cannot strand a child', async () => {
  const p = await property(),
    room = await resource(p);
  const foreignProperty = await property();
  const foreignResource = await resource(foreignProperty);
  expect(
    (await call(p, 'GET', `/resources/${foreignResource.id}/archive-preview`))
      .status,
  ).toBe(404);
  const safe = await call(p, 'GET', `/resources/${room.id}/archive-preview`);
  const renamed = await call(p, 'PATCH', `/resources/${room.id}`, {
    version: room.version,
    display_label: 'Current label',
  });
  expect(renamed.status).toBe(200);
  expect(
    (
      await call(p, 'PATCH', `/resources/${room.id}`, {
        version: safe.body.version,
        state: 'RETIRED',
      })
    ).body.code,
  ).toBe('STALE_VERSION');
  expect(
    (await call(p, 'GET', `/resources/${key()}/archive-preview`)).status,
  ).toBe(404);
  const l = await location(p);
  const [archive, child] = await Promise.all([
    call(p, 'PATCH', `/locations/${l.id}`, {
      version: l.version,
      status: 'INACTIVE',
    }),
    call(
      p,
      'POST',
      '/locations',
      { code: 'CHILD', name: 'Concurrent child', parent_id: l.id },
      admin,
      { 'idempotency-key': key() },
    ),
  ]);
  expect([
    [200, 409],
    [422, 201],
  ]).toContainEqual([archive.status, child.status]);
  const rows = await snapshot(p, ['location']);
  const parent = rows.location.find((x) => x.id === l.id),
    children = rows.location.filter((x) => x.parent_id === l.id);
  expect(parent.status === 'INACTIVE' && children.length > 0).toBe(false);
});

test('T18 API-confirmed and assigned future stay blocks retirement without changing its promise or allocation', async () => {
  const { p, room, product } = await wholeUnit();
  const rate = await call(p, 'POST', '/rate-plans', {
    code: 'ARC-RATE',
    name: 'Synthetic archive rate',
    product_id: product.id,
    currency: 'IDR',
  });
  expect(rate.status).toBe(201);
  const rateId = rate.body.rate_plan.id;
  expect(
    (
      await call(p, 'PATCH', `/rate-plans/${rateId}`, {
        version: rate.body.rate_plan.version,
        status: 'ACTIVE',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(p, 'POST', '/rates/batch', {
        cells: [10, 11].map((offset) => ({
          rate_plan_id: rateId,
          date: day(offset),
          occupancy: 2,
          money: { amount: '300000', currency: 'IDR' },
        })),
      })
    ).status,
  ).toBe(200);
  const period = { arrival: day(10), departure: day(12) },
    occupancy = { adults: 2, child_ages: [] };
  const draft = await call(p, 'POST', '/reservations/drafts', {
    source: 'DIRECT',
    items: [{ product_id: product.id, period, occupancy, quantity: 1 }],
  });
  expect(draft.status).toBe(201);
  const reservationId = draft.body.reservation.id;
  const detail = await call(p, 'GET', `/reservations/${reservationId}`);
  const itemId = detail.body.items[0].id;
  const quote = await call(p, 'POST', '/quotes', {
    product_id: product.id,
    rate_plan_id: rateId,
    period,
    occupancy,
    quantity: 1,
  });
  expect(quote.status).toBe(201);
  const calendar = await call(p, 'GET', `/rates?from=${day(10)}&to=${day(12)}`);
  expect(
    (
      await call(
        p,
        'POST',
        '/reservations',
        {
          reservation_id: reservationId,
          inventory_version: calendar.body.inventory_version,
          items: [{ item_id: itemId, price_snapshot_id: quote.body.quote.id }],
        },
        admin,
        { 'idempotency-key': key() },
      )
    ).status,
  ).toBe(200);
  const current = await call(p, 'GET', `/reservations/${reservationId}`);
  expect(
    (
      await call(
        p,
        'POST',
        `/reservations/${reservationId}/items/${itemId}/assignments`,
        { resource_id: room.id, version: current.body.items[0].version },
        admin,
        { 'idempotency-key': key() },
      )
    ).status,
  ).toBe(200);
  const before = await snapshot(p, [
    'property',
    'resource',
    'audit_event',
    ...protectedTables,
  ]);
  const preview = await call(p, 'GET', `/resources/${room.id}/archive-preview`);
  expect(preview).toMatchObject({
    status: 200,
    body: { eligible: false, counts: { live_commitments: 1, open_stays: 1 } },
  });
  expect(preview.body.blockers).toEqual(
    expect.arrayContaining(['LIVE_COMMITMENTS', 'OPEN_STAYS']),
  );
  expect(
    (
      await call(p, 'PATCH', `/resources/${room.id}`, {
        version: preview.body.version,
        state: 'RETIRED',
      })
    ).body.code,
  ).toBe('RESOURCE_IN_USE');
  expect(
    await snapshot(p, [
      'property',
      'resource',
      'audit_event',
      ...protectedTables,
    ]),
  ).toEqual(before);
});
