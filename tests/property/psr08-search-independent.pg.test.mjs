import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
} from './support/harness.mjs';

let admin, tenant;
const key = () => randomUUID();
const base = (p) => `/tenants/${tenant}/properties/${p.id}`;
const query = (input) => new URLSearchParams(input).toString();
const call = (p, method, path, body) =>
  apiRequest(admin.context, method, base(p) + path, {
    ...(body ? { body } : {}),
    headers: { 'idempotency-key': key() },
  });
async function property() {
  const r = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `S08-${key().slice(0, 12)}`,
        name: 'Search independent synthetic',
        timezone: 'Asia/Makassar',
      },
    },
  );
  expect(r.status).toBe(201);
  return r.body.property;
}
async function resource(p, code, label, capacity = 2, details = {}) {
  const r = await call(p, 'POST', '/resources', {
    code,
    type: 'ROOM',
    display_label: label,
    capacity,
    unit_details: details,
  });
  expect(r.status).toBe(201);
  return r.body.resource;
}
async function location(p, code, name, parent_id) {
  const r = await call(p, 'POST', '/locations', {
    code,
    name,
    kind: 'BUILDING',
    ...(parent_id ? { parent_id } : {}),
  });
  expect(r.status).toBe(201);
  return r.body.location;
}
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
});
afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('R01 independent resource search filters all pages within the property with literal text and stable sorting', async () => {
  const p = await property(),
    other = await property();
  const beta = await resource(p, 'Z-B', 'Search Beta', 4, {
    bedrooms_count: 2,
    bathrooms_count: 1,
  });
  const alpha = await resource(p, 'Z-A', 'Search Alpha', 3, {
    bedrooms_count: 2,
    bathrooms_count: 1,
  });
  await resource(p, 'OTHER', 'Unrelated', 5);
  const literal = await resource(p, 'PERCENT', 'Literal% room', 2);
  const arabic = await resource(p, 'ARABIC', 'وحدة النخيل', 2);
  await resource(other, 'Z-FOREIGN', 'Search Alpha', 4, {
    bedrooms_count: 2,
    bathrooms_count: 1,
  });
  const filters = {
    q: 'sEaRcH',
    sort: 'label',
    type: 'ROOM',
    min_capacity: '3',
    bedrooms_count: '2',
    bathrooms_count: '1',
    limit: '1',
  };
  const first = await call(p, 'GET', `/resources?${query(filters)}`);
  expect(first.status).toBe(200);
  expect(first.body.items.map((r) => r.id)).toEqual([alpha.id]);
  expect(first.body.next_cursor).toBeTruthy();
  const second = await call(
    p,
    'GET',
    `/resources?${query({ ...filters, cursor: first.body.next_cursor })}`,
  );
  expect(second.status).toBe(200);
  expect(second.body.items.map((r) => r.id)).toEqual([beta.id]);
  if (second.body.next_cursor) {
    const last = await call(
      p,
      'GET',
      `/resources?${query({ ...filters, cursor: second.body.next_cursor })}`,
    );
    expect(last.status).toBe(200);
    expect(last.body.items).toEqual([]);
    expect(last.body.next_cursor).toBeNull();
  }
  for (const [q, expected] of [
    ['%', literal.id],
    ['النخيل', arabic.id],
    ['Z-A', alpha.id],
  ]) {
    const response = await call(
      p,
      'GET',
      `/resources?${query({ q, sort: 'code' })}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.items.map((r) => r.id)).toEqual([expected]);
  }
});

test('R01 independent search cursor cannot be reused with another property, query, sort or attributes', async () => {
  const p = await property(),
    other = await property();
  await resource(p, 'A1', 'Needle A');
  await resource(p, 'A2', 'Needle B');
  const filters = { q: 'Needle', sort: 'label', limit: '1' };
  const first = await call(p, 'GET', `/resources?${query(filters)}`);
  expect(first.status).toBe(200);
  const cursor = first.body.next_cursor;
  expect(cursor).toBeTruthy();
  for (const changed of [
    { q: 'Other' },
    { sort: 'capacity' },
    { min_capacity: '3' },
  ]) {
    const rejected = await call(
      p,
      'GET',
      `/resources?${query({ ...filters, ...changed, cursor })}`,
    );
    expect(rejected.status).toBe(400);
  }
  const scoped = await call(
    other,
    'GET',
    `/resources?${query({ ...filters, cursor })}`,
  );
  expect(scoped.status).toBe(400);
  const tampered = await call(
    p,
    'GET',
    `/resources?${query({ ...filters, cursor: cursor + 'x' })}`,
  );
  expect(tampered.status).toBe(400);
});

test('R01 independent resource mutation invalidates a search cursor and restart reflects the new matching set', async () => {
  const p = await property();
  const firstResource = await resource(p, 'A1', 'Match A');
  const changedResource = await resource(p, 'A2', 'Match B');
  const filters = { q: 'Match', sort: 'label', limit: '1' };
  const first = await call(p, 'GET', `/resources?${query(filters)}`);
  expect(first.status).toBe(200);
  expect(first.body.items.map((r) => r.id)).toEqual([firstResource.id]);
  expect(first.body.next_cursor).toBeTruthy();
  const changed = await call(p, 'PATCH', `/resources/${changedResource.id}`, {
    version: changedResource.version,
    display_label: 'Renamed outside result',
  });
  expect(changed.status).toBe(200);
  expect(changed.body.resource.id).toBe(changedResource.id);
  const stale = await call(
    p,
    'GET',
    `/resources?${query({ ...filters, cursor: first.body.next_cursor })}`,
  );
  expect(stale.status).toBe(412);
  const refreshed = await call(
    p,
    'GET',
    `/resources?${query({ ...filters, limit: '25' })}`,
  );
  expect(refreshed.status).toBe(200);
  expect(refreshed.body.items.map((r) => r.id)).toEqual([firstResource.id]);
});

test('R01 independent tree search retains parent scope, binds filters and rejects mutation before the next sorted page', async () => {
  const p = await property();
  const root = await location(p, 'ROOT', 'Root');
  const otherRoot = await location(p, 'OTHER', 'Other');
  const beta = await location(p, 'B', 'Search Beta', root.id);
  const alpha = await location(p, 'A', 'Search Alpha', root.id);
  await location(p, 'FOREIGN', 'Search hidden sibling', otherRoot.id);
  const filters = {
    tree: 'true',
    parent_id: root.id,
    q: 'Search',
    kind: 'BUILDING',
    sort: 'name',
    limit: '1',
  };
  const first = await call(p, 'GET', `/locations?${query(filters)}`);
  expect(first.status).toBe(200);
  expect(first.body.items.map((r) => r.id)).toEqual([alpha.id]);
  const cursor = first.body.next_cursor;
  expect(cursor).toBeTruthy();
  const next = await call(
    p,
    'GET',
    `/locations?${query({ ...filters, cursor })}`,
  );
  expect(next.status).toBe(200);
  expect(next.body.items.map((r) => r.id)).toEqual([beta.id]);
  for (const changed of [
    { parent_id: otherRoot.id },
    { q: 'Other' },
    { sort: 'code' },
    { kind: 'FLOOR' },
  ]) {
    expect(
      (
        await call(
          p,
          'GET',
          `/locations?${query({ ...filters, ...changed, cursor })}`,
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await call(p, 'PATCH', `/locations/${beta.id}`, {
        version: beta.version,
        name: 'Changed',
      })
    ).status,
  ).toBe(200);
  expect(
    (await call(p, 'GET', `/locations?${query({ ...filters, cursor })}`))
      .status,
  ).toBe(412);
  const refreshed = await call(
    p,
    'GET',
    `/locations?${query({ ...filters, limit: '25' })}`,
  );
  expect(refreshed.status).toBe(200);
  expect(refreshed.body.items.map((r) => r.id)).toEqual([alpha.id]);
});
