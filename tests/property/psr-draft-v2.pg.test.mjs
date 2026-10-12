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
let admin, auditor, otherOwner, tenant;
let count = 0;
const run = Date.now().toString(36);
const key = () => `psr-${run}-${++count}-${randomUUID()}`;
const etag = (d) => `"${d.draft_id}:${d.revision}"`;
const payload = () => ({
  schema_version: 2,
  property: { name: null, timezone: null },
  locations: [],
  unit_groups: [
    {
      group_ref: 'g1',
      physical_template: 'VILLA',
      booking_mode: 'WHOLE_ONLY',
      selection_mode: 'EXACT',
      units: [{ unit_ref: 'v1', code: 'V1', display_label: 'Villa 1' }],
      capacity: null,
      details: { bedrooms_count: 4, bathrooms_count: 0 },
    },
  ],
  operations: { check_in: null },
  pricing: null,
});
const path = (p) => `/tenants/${tenant}/properties/${p.id}/setup-draft`;
async function property() {
  const r = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `PSR-${run}-${++count}`,
        name: 'PSR synthetic',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(r.status).toBe(201);
  return r.body.property;
}
async function save(p, body, match, idempotencyKey = key(), actor = admin) {
  return apiRequest(actor.context, 'PUT', path(p), {
    body,
    headers: {
      'idempotency-key': idempotencyKey,
      ...(match ? { 'if-match': match } : {}),
    },
  });
}
async function read(p) {
  const r = await apiRequest(admin.context, 'GET', path(p));
  expect(r.status).toBe(200);
  return r.body.draft;
}
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  auditor = await loginAs('auditor-a');
  otherOwner = await loginAs('owner-b');
  tenant = admin.session.body.session.active_tenant_id;
});
afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('v2 roundtrip preserves null, omitted, zero and descriptive bedrooms without inventory writes', async () => {
  const p = await property();
  const body = payload();
  const r = await save(p, body);
  expect(r.status).toBe(200);
  expect(r.body.draft.input).toEqual(body);
  const current = await read(p);
  expect(current.input).toEqual(body);
  expect(current.input.property).not.toHaveProperty('country');
  const resources = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenant}/properties/${p.id}/resources`,
  );
  expect(resources.status).toBe(200);
  expect(resources.body.items).toHaveLength(0);
  const echo = await save(p, current.input, etag(current));
  expect(echo.status).toBe(200);
  expect(echo.body.draft.revision).toBe(2);
});

test('v2 replay is exact and changed content with same key conflicts', async () => {
  const p = await property(),
    body = payload(),
    k = key();
  body.locations = ['b', 'a'].map((client_ref) => ({
    client_ref,
    code: client_ref.toUpperCase(),
    name: client_ref,
    kind: 'BUILDING',
    display_order: 0,
  }));
  const first = await save(p, body, undefined, k);
  const replay = await save(
    p,
    { ...body, locations: [...body.locations].reverse() },
    undefined,
    k,
  );
  expect(first.status).toBe(200);
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.draft).toEqual(first.body.draft);
  expect((await save(p, body, undefined, k, auditor)).status).toBe(403);
  body.property.name = 'Changed';
  expect((await save(p, body, undefined, k)).status).toBe(409);
  expect((await read(p)).revision).toBe(1);
});

test('two writers race with one ETag and only one succeeds', async () => {
  const p = await property();
  const first = await save(p, payload());
  const match = etag(first.body.draft);
  const a = payload(),
    b = payload();
  a.property.name = 'Writer A';
  b.property.name = 'Writer B';
  const results = await Promise.all([save(p, a, match), save(p, b, match)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
  expect((await read(p)).revision).toBe(2);
});

test('discard/recreate rejects old generation and old replay', async () => {
  const p = await property(),
    k = key();
  const first = await save(p, payload(), undefined, k);
  const old = etag(first.body.draft);
  const removed = await apiRequest(admin.context, 'DELETE', path(p), {
    headers: { 'if-match': old },
  });
  expect(removed.status).toBe(200);
  const second = await save(p, payload());
  expect(second.status).toBe(200);
  expect(second.body.draft.draft_id).not.toBe(first.body.draft.draft_id);
  expect((await save(p, payload(), old)).status).toBe(412);
  expect((await save(p, payload(), undefined, k)).status).toBe(409);
});

test('foreign references, reader writes and cross-tenant reads are denied', async () => {
  const p = await property(),
    body = payload();
  expect((await save(p, body, undefined, key(), auditor)).status).toBe(403);
  const cross = await apiRequest(otherOwner.context, 'GET', path(p));
  expect([403, 404]).toContain(cross.status);
  const foreignProperty = await property();
  const foreignLocation = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties/${foreignProperty.id}/locations`,
    { body: { code: 'OTHER', name: 'Other property location' } },
  );
  expect(foreignLocation.status).toBe(201);
  body.locations = [
    {
      client_ref: 'l1',
      existing_location_id: foreignLocation.body.location.id,
      code: 'L1',
      name: 'Foreign',
      kind: 'BUILDING',
      display_order: 0,
    },
  ];
  const bad = await save(p, body);
  expect(bad.status).toBe(422);
  expect(bad.body.code).toBe('CROSS_SCOPE_REFERENCE');
  expect(await read(p)).toBeNull();
  const connected = payload();
  connected.unit_groups = [
    {
      group_ref: 's',
      physical_template: 'SUITE_CONNECTED',
      booking_mode: 'CONNECTED_UNITS',
      connected_resource_ids: [randomUUID(), randomUUID()],
    },
  ];
  expect((await save(p, connected)).body.code).toBe('CROSS_SCOPE_REFERENCE');
  expect(await read(p)).toBeNull();
});

test('structural contradictions, unknown fields and cycles reject before storage', async () => {
  const p = await property();
  for (const mutate of [
    (b) => {
      b.unit_groups[0].pattern = '1-2';
    },
    (b) => {
      b.completed = true;
    },
    (b) => {
      b.schema_version = 3;
    },
    (b) => {
      b.unit_groups[0].booking_mode = 'BEDS_ONLY';
    },
    (b) => {
      b.unit_groups[0].units.push({
        unit_ref: 'v2',
        code: 'v1',
        display_label: 'Other',
      });
    },
    (b) => {
      b.locations = [
        {
          client_ref: 'a',
          parent_ref: 'b',
          code: 'A',
          name: 'A',
          kind: 'BUILDING',
          display_order: 0,
        },
        {
          client_ref: 'b',
          parent_ref: 'a',
          code: 'B',
          name: 'B',
          kind: 'FLOOR',
          display_order: 0,
        },
      ];
    },
  ]) {
    const body = payload();
    mutate(body);
    const r = await save(p, body);
    expect(r.body.code).toBe('SETUP_DRAFT_INVALID');
  }
  expect(await read(p)).toBeNull();
});

test('incomplete v2 previews blockers, rejects stale apply and still blocks activation', async () => {
  const p = await property();
  const saved = await save(p, payload());
  expect(saved.status).toBe(200);
  const preview = await apiRequest(
    admin.context,
    'POST',
    `${path(p)}/preview`,
    {},
  );
  expect(preview.status).toBe(200);
  expect(preview.body.blockers.length).toBeGreaterThan(0);
  const apply = await apiRequest(admin.context, 'POST', `${path(p)}/apply`, {
    headers: { 'idempotency-key': key(), 'if-match': etag(saved.body.draft) },
    body: { preview_version: 'a'.repeat(64) },
  });
  expect(apply.body.code).toBe('PREVIEW_STALE');
  const ready = await apiRequest(
    admin.context,
    'GET',
    path(p).replace('setup-draft', 'setup-readiness'),
  );
  expect(ready.status).toBe(200);
  expect(ready.body.ready).toBe(false);
  const active = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenant}/properties/${p.id}`,
    { body: { version: p.version, status: 'ACTIVE' } },
  );
  expect(active.status).toBe(422);
  expect(active.body.code).toBe('SETUP_READINESS_BLOCKED');
  expect(active.body.details.issues).toEqual(ready.body.missing);
  expect((await read(p)).completed).toBe(false);
});

const completeV2 = () => ({
  ...payload(),
  property: {
    name: 'V2 activation synthetic',
    timezone: 'Asia/Jakarta',
    base_currency: 'IDR',
    types: ['VILLA'],
  },
  unit_groups: [
    {
      ...payload().unit_groups[0],
      capacity: 4,
      booking_mode: 'WHOLE_AND_PARTS',
      privacy_ack: true,
      effective_from: new Date(Date.now() + 86400000)
        .toISOString()
        .slice(0, 10),
      effective_to: new Date(Date.now() + 30 * 86400000)
        .toISOString()
        .slice(0, 10),
      parts: [
        { part_ref: 'a', code: 'A', display_label: 'Room A', capacity: 2 },
        { part_ref: 'b', code: 'B', display_label: 'Room B', capacity: 2 },
      ],
    },
  ],
  operations: { check_in: '14:00', check_out: '12:00', explicit_states: true },
  pricing: { postponed: true },
});
const propertyPath = (p) => `/tenants/${tenant}/properties/${p.id}`;
async function completedV2() {
  const p = await property();
  const saved = await save(p, completeV2());
  expect(saved.status).toBe(200);
  const preview = await apiRequest(admin.context, 'POST', `${path(p)}/preview`);
  expect(preview.status).toBe(200);
  expect(preview.body.blockers).toEqual([]);
  const applied = await apiRequest(admin.context, 'POST', `${path(p)}/apply`, {
    headers: { 'idempotency-key': key(), 'if-match': etag(saved.body.draft) },
    body: { preview_version: preview.body.preview_version },
  });
  expect(applied.status).toBe(200);
  expect((await read(p)).completed).toBe(true);
  const current = await apiRequest(admin.context, 'GET', propertyPath(p));
  expect(current.status).toBe(200);
  return current.body.property;
}
async function activationSnapshot(p) {
  return withOwner(async (client) => {
    const result = {};
    for (const table of [
      'property_setup_draft',
      'location',
      'resource',
      'product',
      'product_resource_candidate',
      'composition_version',
      'composition_edge',
      'composition_leaf',
      'rate_plan',
      'nightly_price',
      'distribution_connection',
      'exposure',
    ])
      result[table] = (
        await client.query(
          `select * from "${table}" t where tenant_id=$1 and property_id=$2
            order by to_jsonb(t)::text`,
          [tenant, p.id],
        )
      ).rows;
    return result;
  });
}
test('ready completed v2 activates without changing inventory or opening channel sales', async () => {
  const p = await completedV2();
  const ready = await apiRequest(
    admin.context,
    'GET',
    `${propertyPath(p)}/setup-readiness`,
  );
  expect(ready.status).toBe(200);
  expect(ready.body.ready).toBe(true);
  expect(ready.body.missing).toEqual([]);
  const before = await activationSnapshot(p);
  expect(before.resource).toHaveLength(3);
  expect(before.composition_version).toHaveLength(1);
  expect(before.nightly_price).toEqual([]);
  expect(before.distribution_connection).toEqual([]);
  expect(before.exposure).toEqual([]);
  const forbidden = await apiRequest(
    otherOwner.context,
    'PATCH',
    propertyPath(p),
    { body: { version: p.version, status: 'ACTIVE' } },
  );
  expect([403, 404]).toContain(forbidden.status);
  const stale = await apiRequest(admin.context, 'PATCH', propertyPath(p), {
    body: { version: p.version - 1, status: 'ACTIVE' },
  });
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');
  expect(await activationSnapshot(p)).toEqual(before);
  const active = await apiRequest(admin.context, 'PATCH', propertyPath(p), {
    body: { version: p.version, status: 'ACTIVE' },
  });
  expect(active.status).toBe(200);
  expect(active.body.property.status).toBe('ACTIVE');
  expect(active.body.property.version).toBe(p.version + 1);
  expect(active.body.property.inventory_version).toBe(p.inventory_version);
  expect(await activationSnapshot(p)).toEqual(before);
});
test.each(['operations', 'composition'])(
  'completed v2 with stale %s gaps still rejects activation without writes',
  async (gap) => {
    const p = await completedV2();
    const draft = await read(p);
    const input = globalThis.structuredClone(draft.input);
    if (gap === 'operations') input.operations.explicit_states = false;
    else delete input.unit_groups[0].effective_to;
    // Synthetic stored-data corruption: completed must never bypass readiness.
    await withOwner((client) =>
      client.query(
        `update property_setup_draft set input=$1::jsonb
          where tenant_id=$2 and property_id=$3`,
        [JSON.stringify(input), tenant, p.id],
      ),
    );
    const before = await activationSnapshot(p);
    expect(before.property_setup_draft[0].completed).toBe(true);
    const ready = await apiRequest(
      admin.context,
      'GET',
      `${propertyPath(p)}/setup-readiness`,
    );
    expect(ready.status).toBe(200);
    expect(ready.body.ready).toBe(false);
    expect(
      ready.body.missing.some(
        (issue) =>
          issue.code ===
          (gap === 'operations'
            ? 'explicit_states_required'
            : 'period_required'),
      ),
    ).toBe(true);
    const active = await apiRequest(admin.context, 'PATCH', propertyPath(p), {
      body: { version: p.version, status: 'ACTIVE' },
    });
    expect(active.status).toBe(422);
    expect(active.body.code).toBe('SETUP_READINESS_BLOCKED');
    expect(active.body.details.issues).toEqual(ready.body.missing);
    expect(await activationSnapshot(p)).toEqual(before);
    const after = await apiRequest(admin.context, 'GET', propertyPath(p));
    expect(after.body.property).toEqual(p);
  },
);

test('v1 can explicitly upgrade with current ETag; v2 cannot silently downgrade', async () => {
  const p = await property();
  const legacy = {
    property: { name: null },
    unit_groups: [],
    operations: {},
    pricing: null,
  };
  const first = await save(p, legacy);
  expect(first.status).toBe(200);
  const upgraded = await save(p, payload(), etag(first.body.draft));
  expect(upgraded.status).toBe(200);
  expect((await save(p, legacy, etag(upgraded.body.draft))).body.code).toBe(
    'CONFLICT',
  );
  expect((await read(p)).input.schema_version).toBe(2);
});

test('a completed v1 draft cannot be rewritten, upgraded or discarded, even on replay', async () => {
  const p = await property(),
    k = key();
  const body = {
    property: {
      name: 'Completed synthetic',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['ROOM'],
    },
    unit_groups: [
      {
        template_code: 'ROOM',
        rental_mode: 'EXCLUSIVE',
        pattern: '101-101',
        capacity: 2,
      },
    ],
    operations: {
      check_in: '14:00',
      check_out: '12:00',
      explicit_states: true,
    },
    pricing: { postponed: true },
  };
  const saved = await save(p, body, undefined, k);
  expect(saved.status).toBe(200);
  const preview = await apiRequest(
    admin.context,
    'POST',
    `${path(p)}/preview`,
    {},
  );
  expect(preview.status).toBe(200);
  const applied = await apiRequest(admin.context, 'POST', `${path(p)}/apply`, {
    headers: { 'idempotency-key': key(), 'if-match': etag(saved.body.draft) },
    body: { preview_version: preview.body.preview_version },
  });
  expect(applied.status).toBe(200);
  const done = await read(p);
  expect(done.completed).toBe(true);
  expect((await save(p, payload(), etag(done))).body.code).toBe('CONFLICT');
  expect((await save(p, body, undefined, k)).body.code).toBe('CONFLICT');
  const discard = await apiRequest(admin.context, 'DELETE', path(p), {
    headers: { 'if-match': etag(done) },
  });
  expect(discard.body.code).toBe('CONFLICT');
  expect(await read(p)).toEqual(done);
});
