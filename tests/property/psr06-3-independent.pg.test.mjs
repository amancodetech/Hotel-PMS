import { beforeAll, afterAll, test, expect } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
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
        code: `RVW063-${key().slice(0, 8)}`,
        name: 'Synthetic archive fixture',
        timezone: 'Asia/Makassar',
      },
    },
  );
  expect(r.status).toBe(201);
  return r.body.property;
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

test('independent T18: racing a real HOLD against retirement never leaves a promise on a retired unit', async () => {
  const { p, room, product } = await wholeUnit();
  const preview = await call(p, 'GET', `/resources/${room.id}/archive-preview`);
  expect(preview.body.eligible).toBe(true);
  const version = (await call(p, 'GET', '')).body.property.inventory_version;
  const [held, retired] = await Promise.all([
    call(
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
    ),
    call(p, 'PATCH', `/resources/${room.id}`, {
      version: preview.body.version,
      state: 'RETIRED',
    }),
  ]);
  const after = await snapshot(p, [
    'resource',
    'commitment',
    'plan_allocation',
    'audit_event',
  ]);
  if (held.status === 201) {
    expect(retired).toMatchObject({
      status: 422,
      body: { code: 'RESOURCE_IN_USE' },
    });
    expect(after.resource[0].state).toBe('ACTIVE');
    expect(after.plan_allocation).toHaveLength(1);
    expect(after.commitment[0].state).toBe('ACTIVE');
  } else {
    expect([409, 412]).toContain(held.status);
    expect(retired.status).toBe(200);
    expect(after.resource[0].state).toBe('RETIRED');
    expect(after.plan_allocation).toEqual([]);
    expect(after.commitment).toEqual([]);
  }
  expect(
    after.audit_event.filter((event) => event.action === 'resource.updated'),
  ).toHaveLength(retired.status === 200 ? 1 : 0);
});

test('independent T18: retirement keeps active composition/product references and prevents their later sale', async () => {
  const p = await property();
  const input = {
    schema_version: 2,
    locations: [],
    unit_groups: [
      {
        group_ref: 'house',
        physical_template: 'HOUSE',
        booking_mode: 'WHOLE_AND_PARTS',
        selection_mode: 'EXACT',
        capacity: 4,
        privacy_ack: true,
        units: [
          { unit_ref: 'u', code: 'HOUSE', display_label: 'Synthetic house' },
        ],
        parts: [
          { part_ref: 'a', code: 'A', display_label: 'A', capacity: 2 },
          { part_ref: 'b', code: 'B', display_label: 'B', capacity: 2 },
        ],
        effective_from: day(1),
        effective_to: day(60),
      },
    ],
  };
  const planned = await call(p, 'POST', '/setup-unit-additions/preview', input);
  expect(planned.status).toBe(200);
  expect(planned.body.blockers).toEqual([]);
  expect(
    (
      await call(
        p,
        'POST',
        '/setup-unit-additions',
        { input, preview_version: planned.body.preview_version },
        admin,
        { 'idempotency-key': key(), 'if-match': planned.body.property_etag },
      )
    ).status,
  ).toBe(200);
  const before = await snapshot(p, ['resource', ...protectedTables]);
  const leaf = before.resource.find((row) => row.code === 'HOUSE-A');
  const whole = before.product.find((row) => row.kind === 'HOUSE');
  const impact = await call(
    p,
    'GET',
    `/resources/${leaf.id}/archive-preview`,
    undefined,
    reader,
  );
  expect(impact.body).toMatchObject({
    eligible: true,
    counts: { products: 1, compositions: 1 },
  });
  const protectedBefore = await snapshot(p, protectedTables);
  const retired = await call(p, 'PATCH', `/resources/${leaf.id}`, {
    version: impact.body.version,
    state: 'RETIRED',
  });
  expect(retired.status).toBe(200);
  expect(await snapshot(p, protectedTables)).toEqual(protectedBefore);
  const currentProperty = await call(p, 'GET', '');
  const booking = await call(
    p,
    'POST',
    '/holds',
    {
      items: [
        {
          product_id: whole.id,
          period: { arrival: day(10), departure: day(12) },
          occupancy: { adults: 4, child_ages: [] },
          quantity: 1,
        },
      ],
      inventory_version: currentProperty.body.property.inventory_version,
      ttl_seconds: 300,
    },
    admin,
    { 'idempotency-key': key() },
  );
  expect(booking.status).toBe(409);
  expect(booking.body.code).toBe('RESOURCE_UNAVAILABLE');
  expect((await snapshot(p, ['plan_allocation'])).plan_allocation).toEqual([]);
  const after = (await snapshot(p, ['resource'])).resource;
  expect(after.map((row) => row.id).sort()).toEqual(
    before.resource.map((row) => row.id).sort(),
  );
  for (const prior of before.resource.filter((row) => row.id !== leaf.id))
    expect(after.find((row) => row.id === prior.id)).toEqual(prior);
});

test('independent T18: overdue ACTIVE assignment blocks while completed history remains immutable during retirement', async () => {
  const { p, room, product } = await wholeUnit();
  // Persist an exceptional overdue stay fixture; no clock or past check-in is
  // exposed by the API. The archive operation itself uses the normal HTTP path.
  const assignmentId = key();
  await withOwner(async (c) => {
    const reservationId = key(),
      itemId = key(),
      segmentId = key();
    await c.query(
      "insert into reservation(id,tenant_id,property_id,source,state) values($1,$2,$3,'DIRECT','IN_HOUSE')",
      [reservationId, tenant, p.id],
    );
    await c.query(
      "insert into reservation_item(id,tenant_id,property_id,reservation_id,product_id,arrival,departure,state) values($1,$2,$3,$4,$5,$6,$7,'IN_HOUSE')",
      [itemId, tenant, p.id, reservationId, product.id, day(-4), day(-2)],
    );
    await c.query(
      "insert into stay_segment(id,tenant_id,property_id,item_id,start_date,end_date,state) values($1,$2,$3,$4,$5,$6,'IN_HOUSE')",
      [segmentId, tenant, p.id, itemId, day(-4), day(-2)],
    );
    await c.query(
      "insert into room_assignment(id,tenant_id,property_id,item_id,segment_id,resource_id,start_date,end_date,state) values($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE')",
      [
        assignmentId,
        tenant,
        p.id,
        itemId,
        segmentId,
        room.id,
        day(-4),
        day(-2),
      ],
    );
  });
  const before = await snapshot(p, [
    'property',
    'resource',
    'audit_event',
    ...protectedTables,
  ]);
  const preview = await call(p, 'GET', `/resources/${room.id}/archive-preview`);
  expect(preview.body).toMatchObject({
    eligible: false,
    blockers: ['OPEN_STAYS'],
    counts: { live_commitments: 0, open_stays: 1, stays: 1 },
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
  // Switch the synthetic fixture to completed history, then take a fresh snapshot.
  await withOwner(async (c) => {
    await c.query("update room_assignment set state='COMPLETED' where id=$1", [
      assignmentId,
    ]);
    await c.query(
      "update stay_segment set state='CHECKED_OUT' where tenant_id=$1 and property_id=$2",
      [tenant, p.id],
    );
    await c.query(
      "update reservation_item set state='CHECKED_OUT' where tenant_id=$1 and property_id=$2",
      [tenant, p.id],
    );
    await c.query(
      "update reservation set state='CHECKED_OUT' where tenant_id=$1 and property_id=$2",
      [tenant, p.id],
    );
  });
  const history = await snapshot(p, protectedTables);
  const eligible = await call(
    p,
    'GET',
    `/resources/${room.id}/archive-preview`,
  );
  expect(eligible.body).toMatchObject({
    eligible: true,
    counts: { open_stays: 0, stays: 1 },
  });
  expect(
    (
      await call(p, 'PATCH', `/resources/${room.id}`, {
        version: eligible.body.version,
        state: 'RETIRED',
      })
    ).status,
  ).toBe(200);
  expect(await snapshot(p, protectedTables)).toEqual(history);
});

test('independent T18: released exposure with a reserved allocation still blocks; fully released quota stays as history', async () => {
  const { p, room, product } = await wholeUnit();
  const connectionId = key(),
    exposureId = key();
  await withOwner(async (c) => {
    await c.query(
      "insert into distribution_connection(id,tenant_id,property_id,provider_key,environment,channel_key,external_property_id,secret_ref) values($1,$2,$3,'CHANNEX','STAGING','BOOKING_COM','synthetic-review-archive','local:synthetic')",
      [connectionId, tenant, p.id],
    );
    await c.query(
      "insert into exposure(id,tenant_id,property_id,connection_id,product_id,start_date,end_date,mode,state,inventory_version) values($1,$2,$3,$4,$5,$6,$7,'WHOLE','RELEASED',1)",
      [exposureId, tenant, p.id, connectionId, product.id, day(-6), day(-5)],
    );
    await c.query(
      'insert into exposure_allocation(id,exposure_id,tenant_id,property_id,resource_id,start_date,end_date) values($1,$2,$3,$4,$5,$6,$7)',
      [key(), exposureId, tenant, p.id, room.id, day(-6), day(-5)],
    );
  });
  const original = await snapshot(p, ['resource', ...protectedTables]);
  expect(
    (await call(p, 'GET', `/resources/${room.id}/archive-preview`)).body,
  ).toMatchObject({
    eligible: false,
    counts: { exposures: 1, channel_exposures: 1 },
    blockers: ['CHANNEL_EXPOSURES'],
  });
  expect(
    (
      await call(p, 'PATCH', `/resources/${room.id}`, {
        version: room.version,
        state: 'INACTIVE',
      })
    ).body.code,
  ).toBe('RESOURCE_IN_USE');
  expect(await snapshot(p, ['resource', ...protectedTables])).toEqual(original);
  await withOwner((c) =>
    c.query(
      "update exposure_allocation set state='RELEASED' where tenant_id=$1 and property_id=$2 and exposure_id=$3",
      [tenant, p.id, exposureId],
    ),
  );
  const history = await snapshot(p, protectedTables);
  const preview = await call(p, 'GET', `/resources/${room.id}/archive-preview`);
  expect(preview.body).toMatchObject({
    eligible: true,
    counts: { exposures: 1, channel_exposures: 0 },
  });
  const unauthorized = await call(
    p,
    'PATCH',
    `/resources/${room.id}`,
    { version: preview.body.version, state: 'RETIRED' },
    reader,
  );
  expect(unauthorized.status).toBe(403);
  expect([403, 404]).toContain(
    (
      await call(
        p,
        'GET',
        `/resources/${room.id}/archive-preview`,
        undefined,
        other,
      )
    ).status,
  );
  expect(
    (
      await call(p, 'PATCH', `/resources/${room.id}`, {
        version: preview.body.version,
        state: 'RETIRED',
      })
    ).status,
  ).toBe(200);
  expect(await snapshot(p, protectedTables)).toEqual(history);
});
