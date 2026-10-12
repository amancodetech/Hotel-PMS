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

let admin, reader, member, other, tenant, p, room, origin, destination;
const key = () => randomUUID();
const base = () => `/tenants/${tenant}/properties/${p.id}`;
const request = (method, path, body, session = admin, headers) =>
  apiRequest(session.context, method, `${base()}${path}`, { body, headers });
const day = (offset) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
async function property(session = admin) {
  const scope = session.session.body.session.active_tenant_id;
  const response = await apiRequest(
    session.context,
    'POST',
    `/tenants/${scope}/properties`,
    {
      body: {
        code: `PSR061-${key().slice(0, 8)}`,
        name: 'Independent synthetic review',
        timezone: 'Asia/Makassar',
      },
    },
  );
  expect(response.status).toBe(201);
  return response.body.property;
}
async function location(propertyId = p.id, session = admin) {
  const scope = session.session.body.session.active_tenant_id;
  const response = await apiRequest(
    session.context,
    'POST',
    `/tenants/${scope}/properties/${propertyId}/locations`,
    {
      body: {
        code: `L-${key().slice(0, 8)}`,
        name: 'Synthetic building',
        kind: 'BUILDING',
      },
      headers: { 'idempotency-key': key() },
    },
  );
  expect(response.status).toBe(201);
  return response.body.location;
}
async function snapshot(tables) {
  return withOwner(async (client) => {
    const result = {};
    for (const table of tables)
      result[table] = (
        await client.query(
          `select * from "${table}" t where tenant_id=$1 and property_id=$2 order by to_jsonb(t)::text`,
          [tenant, p.id],
        )
      ).rows;
    return result;
  });
}
const protectedTables = [
  'reservation',
  'reservation_item',
  'stay_segment',
  'room_assignment',
  'commitment',
  'plan_allocation',
  'price_quote',
  'product',
  'product_resource_candidate',
  'composition_version',
  'composition_leaf',
  'exposure',
  'exposure_allocation',
  'journal',
  'journal_line',
];
const resource = async () =>
  (await request('GET', '/resources')).body.items.find(
    (item) => item.id === room.id,
  );
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  reader = await loginAs('auditor-a');
  member = await loginAs('member-a');
  other = await loginAs('owner-b');
  tenant = admin.session.body.session.active_tenant_id;
  p = await property();
  origin = await location();
  destination = await location();
  const response = await request('POST', '/resources', {
    code: 'PROMISED-ROOM',
    type: 'ROOM',
    capacity: 2,
    display_label: 'Original room',
    location_id: origin.id,
  });
  expect(response.status).toBe(201);
  room = response.body.resource;
});
afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('independent T17: API-confirmed and assigned future stay preserves all promises and historic audit after rename/move', async () => {
  const product = await request('POST', '/products', {
    code: 'PROMISED',
    name: 'Promised room',
    kind: 'ROOM',
    occupancy_adults_max: 2,
  });
  expect(product.status).toBe(201);
  const productId = product.body.product.id;
  expect(
    (
      await request('POST', `/products/${productId}/candidates`, {
        resource_id: room.id,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await request('PATCH', `/products/${productId}`, {
        version: product.body.product.version,
        status: 'ACTIVE',
      })
    ).status,
  ).toBe(200);
  const rate = await request('POST', '/rate-plans', {
    code: 'PROMISED-RATE',
    name: 'Review rate',
    product_id: productId,
    currency: 'IDR',
  });
  expect(rate.status).toBe(201);
  const rateId = rate.body.rate_plan.id;
  expect(
    (
      await request('PATCH', `/rate-plans/${rateId}`, {
        version: rate.body.rate_plan.version,
        status: 'ACTIVE',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request('POST', '/rates/batch', {
        cells: [10, 11].map((offset) => ({
          rate_plan_id: rateId,
          date: day(offset),
          occupancy: 2,
          money: { amount: '300000', currency: 'IDR' },
        })),
      })
    ).status,
  ).toBe(200);
  const period = { arrival: day(10), departure: day(12) };
  const occupancy = { adults: 2, child_ages: [] };
  const draft = await request('POST', '/reservations/drafts', {
    source: 'DIRECT',
    items: [{ product_id: productId, period, occupancy, quantity: 1 }],
  });
  expect(draft.status).toBe(201);
  const reservationId = draft.body.reservation.id;
  const detail = await request('GET', `/reservations/${reservationId}`);
  const itemId = detail.body.items[0].id;
  const quote = await request('POST', '/quotes', {
    product_id: productId,
    rate_plan_id: rateId,
    period,
    occupancy,
    quantity: 1,
  });
  expect(quote.status).toBe(201);
  const calendar = await request('GET', `/rates?from=${day(10)}&to=${day(12)}`);
  const confirmed = await request(
    'POST',
    '/reservations',
    {
      reservation_id: reservationId,
      inventory_version: calendar.body.inventory_version,
      items: [{ item_id: itemId, price_snapshot_id: quote.body.quote.id }],
    },
    admin,
    { 'idempotency-key': key() },
  );
  expect(confirmed.status).toBe(200);
  const current = await request('GET', `/reservations/${reservationId}`);
  const assigned = await request(
    'POST',
    `/reservations/${reservationId}/items/${itemId}/assignments`,
    { resource_id: room.id, version: current.body.items[0].version },
    admin,
    { 'idempotency-key': key() },
  );
  expect(assigned.status).toBe(200);
  expect(assigned.body.assignment.state).toBe('PLANNED');
  const before = await snapshot(protectedTables);
  expect(before.reservation_item[0].state).toBe('CONFIRMED');
  expect(before.plan_allocation).toHaveLength(1);
  expect(before.room_assignment).toHaveLength(1);
  const history = (await snapshot(['audit_event'])).audit_event;
  const changed = await request('PATCH', `/resources/${room.id}`, {
    version: room.version,
    display_label: 'Garden room',
    location_id: destination.id,
  });
  expect(changed.status).toBe(200);
  expect(changed.body.resource).toMatchObject({
    id: room.id,
    code: room.code,
    display_label: 'Garden room',
    location_id: destination.id,
    version: room.version + 1,
  });
  expect(await snapshot(protectedTables)).toEqual(before);
  const afterHistory = (await snapshot(['audit_event'])).audit_event;
  expect(afterHistory).toHaveLength(history.length + 1);
  for (const entry of history)
    expect(afterHistory.find((row) => row.id === entry.id)).toEqual(entry);
  const added = afterHistory.find(
    (row) => !history.some((entry) => entry.id === row.id),
  );
  expect(added.action).toBe('resource.updated');
  expect(added.before_safe).toMatchObject({
    display_label: 'Original room',
    location_id: origin.id,
  });
  expect(added.after_safe).toMatchObject({
    display_label: 'Garden room',
    location_id: destination.id,
  });
});

test('independent T17: racing metadata writers have one winner, one stale rejection and one audit; no historical mutations', async () => {
  const current = await resource();
  const before = await snapshot([...protectedTables, 'audit_event']);
  const writes = await Promise.all(
    ['Writer A', 'Writer B'].map((label) =>
      request('PATCH', `/resources/${room.id}`, {
        version: current.version,
        display_label: label,
      }),
    ),
  );
  expect(writes.map((response) => response.status).sort()).toEqual([200, 412]);
  const winner = writes.find((response) => response.status === 200).body
    .resource;
  expect(await resource()).toEqual(winner);
  expect(winner.version).toBe(current.version + 1);
  const after = await snapshot([...protectedTables, 'audit_event']);
  expect(after.audit_event).toHaveLength(before.audit_event.length + 1);
  delete before.audit_event;
  delete after.audit_event;
  expect(after).toEqual(before);
});

test('independent T17: reader, wrong-property member, foreign tenant and foreign destinations cannot mutate or reveal unit data', async () => {
  const current = await resource();
  const outside = await property();
  // owner-b intentionally lacks the administrative API role in this harness.
  // Seed only the unrelated destination, never the reservation being reviewed.
  const foreignLocation = await withOwner(async (client) => {
    const foreignTenant = other.session.body.session.active_tenant_id;
    const foreignProperty = (
      await client.query(
        `insert into property(tenant_id,code,name,timezone) values($1,$2,'Foreign synthetic property','Asia/Makassar') returning id`,
        [foreignTenant, `PSR061-${key().slice(0, 8)}`],
      )
    ).rows[0];
    return (
      await client.query(
        `insert into location(tenant_id,property_id,code,name) values($1,$2,'FOREIGN','Foreign synthetic location') returning id,name`,
        [foreignTenant, foreignProperty.id],
      )
    ).rows[0];
  });
  const destinations = [await location(outside.id), foreignLocation];
  const before = await snapshot([
    ...protectedTables,
    'resource',
    'audit_event',
  ]);
  for (const session of [reader, member, other]) {
    const response = await request(
      'PATCH',
      `/resources/${room.id}`,
      { version: current.version, display_label: 'Forbidden' },
      session,
    );
    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain(current.display_label);
  }
  for (const target of destinations) {
    const response = await request('PATCH', `/resources/${room.id}`, {
      version: current.version,
      location_id: target.id,
    });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CROSS_SCOPE_REFERENCE');
    expect(JSON.stringify(response.body)).not.toContain(target.name);
  }
  const after = await snapshot([...protectedTables, 'resource', 'audit_event']);
  // Denials may add security audit; they must never add a successful unit update.
  expect(
    after.audit_event.filter((row) => row.action === 'resource.updated'),
  ).toEqual(
    before.audit_event.filter((row) => row.action === 'resource.updated'),
  );
  delete before.audit_event;
  delete after.audit_event;
  expect(after).toEqual(before);
});

test('independent T17: omitted metadata survives while explicit null clears only presentation and location', async () => {
  const current = await resource();
  const before = await snapshot(protectedTables);
  const labelOnly = await request('PATCH', `/resources/${room.id}`, {
    version: current.version,
    display_label: 'Same destination',
  });
  expect(labelOnly.status).toBe(200);
  expect(labelOnly.body.resource.location_id).toBe(current.location_id);
  const cleared = await request('PATCH', `/resources/${room.id}`, {
    version: labelOnly.body.resource.version,
    display_label: null,
    location_id: null,
  });
  expect(cleared.status).toBe(200);
  expect(cleared.body.resource).toMatchObject({
    id: room.id,
    code: room.code,
    display_label: null,
    location_id: null,
  });
  expect(await snapshot(protectedTables)).toEqual(before);
});
