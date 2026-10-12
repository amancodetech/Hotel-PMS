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
let admin, tenant;
const key = () => randomUUID();
const base = (p) => `/tenants/${tenant}/properties/${p.id}`;
const input = (code = 'ADDED') => ({
  schema_version: 2,
  locations: [],
  unit_groups: [
    {
      group_ref: 'g',
      physical_template: 'VILLA',
      booking_mode: 'WHOLE_ONLY',
      selection_mode: 'EXACT',
      capacity: 4,
      units: [{ unit_ref: 'u', code, display_label: 'Private villa' }],
      details: { bedrooms_count: 2 },
    },
  ],
});
async function property() {
  const r = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `ADD-${key().slice(0, 8)}`,
        name: 'Addition fixture',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(r.status).toBe(201);
  return r.body.property;
}
const preview = (p, body = input()) =>
  apiRequest(admin.context, 'POST', `${base(p)}/setup-unit-additions/preview`, {
    body,
  });
const apply = (p, v, body = input(), k = key()) =>
  apiRequest(admin.context, 'POST', `${base(p)}/setup-unit-additions`, {
    body: { input: body, preview_version: v.preview_version },
    headers: { 'idempotency-key': k, 'if-match': v.property_etag },
  });
async function rows(p, table) {
  return withOwner(
    async (c) =>
      (
        await c.query(
          `select * from "${table}" where tenant_id=$1 and property_id=$2`,
          [tenant, p.id],
        )
      ).rows,
  );
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
test('independent addition preserves completed draft and property settings, replay creates once', async () => {
  const p = await property();
  const draftInput = {
    ...input('OLD'),
    property: {
      name: p.name,
      timezone: p.timezone,
      base_currency: p.base_currency,
      types: ['VILLA'],
    },
    operations: {
      check_in: '14:00',
      check_out: '12:00',
      explicit_states: true,
    },
    pricing: { postponed: true },
  };
  const save = await apiRequest(
    admin.context,
    'PUT',
    `${base(p)}/setup-draft`,
    { body: draftInput, headers: { 'idempotency-key': key() } },
  );
  expect(save.status).toBe(200);
  const d = save.body.draft;
  const pv = await apiRequest(
    admin.context,
    'POST',
    `${base(p)}/setup-draft/preview`,
  );
  const done = await apiRequest(
    admin.context,
    'POST',
    `${base(p)}/setup-draft/apply`,
    {
      body: { preview_version: pv.body.preview_version },
      headers: {
        'idempotency-key': key(),
        'if-match': `"${d.draft_id}:${d.revision}"`,
      },
    },
  );
  expect(done.status).toBe(200);
  const before = await rows(p, 'property_setup_draft');
  // Exercise addition on ACTIVE without claiming v2 activation is implemented.
  await withOwner((c) =>
    c.query(
      "update property set status='ACTIVE' where tenant_id=$1 and id=$2",
      [tenant, p.id],
    ),
  );
  const v = await preview(p);
  expect(v.status).toBe(200);
  expect(v.body.blockers).toEqual([]);
  expect(await rows(p, 'resource')).toHaveLength(1);
  const k = key();
  const added = await apply(p, v.body, input(), k);
  expect(added.status).toBe(200);
  expect((await apply(p, v.body, input(), k)).body.replayed).toBe(true);
  expect(await rows(p, 'resource')).toHaveLength(2);
  expect(await rows(p, 'property_setup_draft')).toEqual(before);
  const prop = await apiRequest(admin.context, 'GET', base(p));
  expect(prop.body.property.name).toBe(p.name);
  expect(prop.body.property.status).toBe('ACTIVE');
  expect(await rows(p, 'rate_plan')).toHaveLength(0);
  expect(await rows(p, 'property_operations_policy')).toHaveLength(0);
  const changed = await apply(p, v.body, input('DIFFERENT'), k);
  expect(changed.status).toBe(409);
});
test('concurrent additions with the same property snapshot allow one writer', async () => {
  const p = await property();
  const a = input('A');
  const b = input('B');
  const va = await preview(p, a);
  const vb = await preview(p, b);
  const results = await Promise.all([
    apply(p, va.body, a),
    apply(p, vb.body, b),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
  expect(await rows(p, 'resource')).toHaveLength(1);
  expect(await rows(p, 'property_setup_draft')).toHaveLength(0);
});

test('T16 whole villa with a hold and channel quota cannot be reinterpreted as parts', async () => {
  const p = await property();
  const whole = input('T16-VILLA');
  const firstPreview = await preview(p, whole);
  expect(firstPreview.status).toBe(200);
  const idempotencyKey = key();
  const firstApply = await apply(p, firstPreview.body, whole, idempotencyKey);
  expect(firstApply.status).toBe(200);
  await withOwner((c) =>
    c.query(
      "update property set status='ACTIVE' where tenant_id=$1 and id=$2",
      [tenant, p.id],
    ),
  );
  const resource = (await rows(p, 'resource'))[0];
  const product = (await rows(p, 'product'))[0];
  const currentProperty = await apiRequest(admin.context, 'GET', base(p));
  const held = await apiRequest(admin.context, 'POST', `${base(p)}/holds`, {
    body: {
      items: [
        {
          product_id: product.id,
          period: { arrival: day(10), departure: day(12) },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      ],
      inventory_version: currentProperty.body.property.inventory_version,
      ttl_seconds: 300,
    },
    headers: { 'idempotency-key': key() },
  });
  expect(held.status).toBe(201);
  const connectionId = key();
  const exposureId = key();
  await withOwner(async (c) => {
    await c.query(
      `insert into distribution_connection(id,tenant_id,property_id,provider_key,environment,channel_key,external_property_id,secret_ref)
       values($1,$2,$3,'CHANNEX','STAGING','BOOKING_COM','synthetic-t16','local:synthetic')`,
      [connectionId, tenant, p.id],
    );
    await c.query(
      `insert into exposure(id,tenant_id,property_id,connection_id,product_id,start_date,end_date,mode,state,inventory_version)
       values($1,$2,$3,$4,$5,$6,$7,'WHOLE','PUBLISHING',1)`,
      [exposureId, tenant, p.id, connectionId, product.id, day(40), day(42)],
    );
    await c.query(
      `insert into exposure_allocation(id,exposure_id,tenant_id,property_id,resource_id,start_date,end_date)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [key(), exposureId, tenant, p.id, resource.id, day(40), day(42)],
    );
  });
  const tables = [
    'resource',
    'product',
    'commitment',
    'plan_allocation',
    'exposure',
    'exposure_allocation',
    'audit_event',
  ];
  const before = new Map();
  for (const table of tables) before.set(table, await rows(p, table));
  const parts = input('T16-VILLA');
  parts.unit_groups[0].booking_mode = 'PARTS_ONLY';
  parts.unit_groups[0].parts = [
    { part_ref: 'a', code: 'A', display_label: 'A', capacity: 2 },
    { part_ref: 'b', code: 'B', display_label: 'B', capacity: 2 },
  ];
  const rejected = await preview(p, parts);
  expect(rejected.status).toBe(422);
  expect(rejected.body.code).toBe('INVENTORY_TRANSFORMATION_REQUIRED');
  expect(rejected.body.details.resource_id).toBe(resource.id);
  const freshSnapshot = await preview(p, input('T16-SNAPSHOT'));
  expect(freshSnapshot.status).toBe(200);
  // This fingerprint belongs to a different payload. Direct apply rejects
  // it as stale before planning; it cannot bypass the transformation guard.
  const directAttempt = await apply(p, freshSnapshot.body, parts);
  expect(directAttempt).toMatchObject({
    status: 412,
    body: { code: 'PREVIEW_STALE' },
  });
  const batchAttempt = await apiRequest(
    admin.context,
    'POST',
    `${base(p)}/setup-batches`,
    {
      body: {
        mode: 'ADDITION',
        input: parts,
        preview_version: freshSnapshot.body.preview_version,
      },
      headers: {
        'idempotency-key': key(),
        'if-match': freshSnapshot.body.property_etag,
      },
    },
  );
  expect(batchAttempt.status).toBe(422);
  expect(batchAttempt.body.code).toBe('INVENTORY_TRANSFORMATION_REQUIRED');
  expect(await rows(p, 'property_setup_batch')).toEqual([]);
  for (const table of tables)
    expect(await rows(p, table)).toEqual(before.get(table));
  const replay = await apply(p, firstPreview.body, whole, idempotencyKey);
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect((await rows(p, 'resource')).map((row) => row.id)).toEqual([
    resource.id,
  ]);
});

test('T16 existing parts cannot be reinterpreted as one whole villa', async () => {
  const p = await property();
  const parts = input('T16-PARTS');
  parts.unit_groups[0].booking_mode = 'PARTS_ONLY';
  parts.unit_groups[0].parts = [
    { part_ref: 'a', code: 'A', display_label: 'A', capacity: 2 },
    { part_ref: 'b', code: 'B', display_label: 'B', capacity: 2 },
  ];
  const firstPreview = await preview(p, parts);
  expect(firstPreview.status).toBe(200);
  expect((await apply(p, firstPreview.body, parts)).status).toBe(200);
  const before = await rows(p, 'resource');
  expect(before).toHaveLength(3);
  const rejected = await preview(p, input('T16-PARTS'));
  expect(rejected.status).toBe(422);
  expect(rejected.body.code).toBe('INVENTORY_TRANSFORMATION_REQUIRED');
  expect(await rows(p, 'resource')).toEqual(before);
});
test.each([
  ['APARTMENT', 'WHOLE_ONLY', 'PARTS_ONLY'],
  ['APARTMENT', 'PARTS_ONLY', 'WHOLE_ONLY'],
  ['HOUSE', 'WHOLE_ONLY', 'PARTS_ONLY'],
  ['HOUSE', 'PARTS_ONLY', 'WHOLE_ONLY'],
])(
  'T16 %s cannot change %s to %s even without commitments',
  async (template, from, to) => {
    const p = await property();
    const makeInput = (mode) => {
      const body = input(`T16-${template}`);
      body.unit_groups[0].physical_template = template;
      body.unit_groups[0].booking_mode = mode;
      if (mode === 'PARTS_ONLY')
        body.unit_groups[0].parts = [
          { part_ref: 'a', code: 'A', display_label: 'A', capacity: 2 },
          { part_ref: 'b', code: 'B', display_label: 'B', capacity: 2 },
        ];
      return body;
    };
    const original = makeInput(from);
    const first = await preview(p, original);
    expect(first.status).toBe(200);
    expect((await apply(p, first.body, original)).status).toBe(200);
    const beforeResources = await rows(p, 'resource');
    const beforeProducts = await rows(p, 'product');
    const rejected = await preview(p, makeInput(to));
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('INVENTORY_TRANSFORMATION_REQUIRED');
    expect(await rows(p, 'resource')).toEqual(beforeResources);
    expect(await rows(p, 'product')).toEqual(beforeProducts);
  },
);
test('stale snapshot, missing precondition, cross-property references and mass assignment reject without writes', async () => {
  const p = await property();
  const v = await preview(p);
  const missing = await apiRequest(
    admin.context,
    'POST',
    `${base(p)}/setup-unit-additions`,
    {
      body: { input: input(), preview_version: v.body.preview_version },
      headers: { 'idempotency-key': key() },
    },
  );
  expect(missing.status).toBe(412);
  expect(
    (await preview(p, { ...input(), property: { name: 'overwrite' } })).status,
  ).toBe(400);
  const bad = input();
  bad.locations = [
    {
      client_ref: 'outside',
      existing_location_id: key(),
      code: 'X',
      name: 'Other',
      kind: 'BUILDING',
      display_order: 0,
    },
  ];
  expect((await preview(p, bad)).status).not.toBe(200);
  expect(await rows(p, 'resource')).toHaveLength(0);
  const create = await apiRequest(
    admin.context,
    'POST',
    `${base(p)}/resources`,
    { body: { code: 'OTHER', type: 'ROOM', capacity: 2 } },
  );
  expect(create.status).toBe(201);
  expect((await apply(p, v.body)).status).toBe(412);
  expect(await rows(p, 'resource')).toHaveLength(1);
});
test('duplicate resource rolls back new locations and audit; reader cannot apply', async () => {
  const p = await property();
  const first = await preview(p);
  expect((await apply(p, first.body)).status).toBe(200);
  const body = input();
  body.locations = [
    {
      client_ref: 'new-place',
      code: 'NEW',
      name: 'New building',
      kind: 'BUILDING',
      display_order: 0,
    },
  ];
  const v = await preview(p, body);
  expect(v.status).toBe(200);
  expect((await apply(p, v.body, body)).status).toBe(409);
  expect(await rows(p, 'location')).toHaveLength(0);
  expect(await rows(p, 'resource')).toHaveLength(1);
  const reader = await loginAs('auditor-a');
  const denied = await apiRequest(
    reader.context,
    'POST',
    `${base(p)}/setup-unit-additions`,
    {
      body: { input: body, preview_version: v.body.preview_version },
      headers: { 'idempotency-key': key(), 'if-match': v.body.property_etag },
    },
  );
  expect([403, 404]).toContain(denied.status);
});

const day = (offset) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const simulate = (p, product, adults = 1) =>
  apiRequest(
    admin.context,
    'GET',
    `${base(p)}/setup-product-simulation?product_id=${product}&from=${day(10)}&to=${day(12)}&adults=${adults}&quantity=1`,
  );
test.each(['WHOLE_AND_PARTS', 'BEDS_AND_PRIVATE'])(
  'product simulation %s uses reservation exclusivity without writes',
  async (mode) => {
    const p = await property();
    const body = input();
    body.unit_groups[0] =
      mode === 'WHOLE_AND_PARTS'
        ? {
            ...body.unit_groups[0],
            booking_mode: mode,
            privacy_ack: true,
            parts: [
              { part_ref: 'a', code: 'A', display_label: 'A', capacity: 2 },
              { part_ref: 'b', code: 'B', display_label: 'B', capacity: 2 },
            ],
          }
        : {
            group_ref: 'bed',
            physical_template: 'DORM',
            booking_mode: mode,
            selection_mode: 'CATEGORY',
            pattern: '101-101',
            beds_per_unit: 2,
            capacity: 2,
            sharing_scope: 'MIXED',
          };
    Object.assign(body.unit_groups[0], {
      effective_from: day(0),
      effective_to: day(30),
    });
    const v = await preview(p, body);
    expect(v.status).toBe(200);
    expect(v.body.blockers).toEqual([]);
    expect((await apply(p, v.body, body)).status).toBe(200);
    const whole = (await rows(p, 'composition_version'))[0].product_id;
    const part = (await rows(p, 'product')).find((r) => r.id !== whole).id;
    const snapshot = await rows(p, 'resource');
    const first = await simulate(p, whole);
    expect(first.status).toBe(200);
    expect(first.body.result).toBe('AVAILABLE');
    expect(first.body.units.flatMap((u) => u.resources)).toHaveLength(2);
    expect(await rows(p, 'resource')).toEqual(snapshot);
    expect(await rows(p, 'commitment')).toHaveLength(0);
    const held = await apiRequest(admin.context, 'POST', `${base(p)}/holds`, {
      body: {
        items: [
          {
            product_id: part,
            quantity: 1,
            occupancy: { adults: 1, child_ages: [] },
            period: { arrival: day(10), departure: day(12) },
          },
        ],
        inventory_version: first.body.inventory_version,
        ttl_seconds: 300,
      },
      headers: { 'idempotency-key': key() },
    });
    expect(held.status).toBe(201);
    const commitments = await rows(p, 'commitment');
    const blocked = await simulate(p, whole);
    expect(blocked.body.result).toBe('UNAVAILABLE');
    expect(await rows(p, 'commitment')).toEqual(commitments);
    expect(await rows(p, 'resource')).toEqual(snapshot);
  },
);
test('category and connected-unit simulation resolve one alternative versus both leaves; scope is enforced', async () => {
  const p = await property();
  const body = input();
  body.unit_groups[0] = {
    group_ref: 'rooms',
    physical_template: 'ROOM',
    booking_mode: 'WHOLE_ONLY',
    selection_mode: 'CATEGORY',
    capacity: 2,
    pattern: '201-202',
  };
  let v = await preview(p, body);
  expect((await apply(p, v.body, body)).status).toBe(200);
  const category = (await rows(p, 'product'))[0].id;
  const available = await simulate(p, category);
  expect(available.body.result).toBe('AVAILABLE');
  expect(available.body.units[0].resources).toHaveLength(1);
  const connected = {
    schema_version: 2,
    locations: [],
    unit_groups: [
      {
        group_ref: 'suite',
        physical_template: 'SUITE_CONNECTED',
        booking_mode: 'CONNECTED_UNITS',
        selection_mode: 'EXACT',
        capacity: 4,
        connected_resource_ids: (await rows(p, 'resource')).map((r) => r.id),
        connection_ack: true,
        effective_from: day(0),
        effective_to: day(30),
      },
    ],
  };
  v = await preview(p, connected);
  expect((await apply(p, v.body, connected)).status).toBe(200);
  const suite = (await rows(p, 'composition_version'))[0].product_id;
  expect((await simulate(p, suite)).body.units[0].resources).toHaveLength(2);
  expect((await simulate(p, suite, 5)).body.result).toBe('UNAVAILABLE');
  const another = await property();
  expect((await simulate(another, suite)).status).toBe(404);
  const invalid = await apiRequest(
    admin.context,
    'GET',
    `${base(p)}/setup-product-simulation?product_id=${suite}&from=2026-02-30&to=2026-03-02&adults=1&quantity=1`,
  );
  expect(invalid.status).toBe(400);
});

test('later independent batches can reuse group references without product-code collision', async () => {
  const p = await property();
  for (const code of ['FIRST', 'SECOND']) {
    const body = input(code);
    const v = await preview(p, body);
    expect((await apply(p, v.body, body)).status).toBe(200);
  }
  expect(await rows(p, 'resource')).toHaveLength(2);
  expect(await rows(p, 'product')).toHaveLength(2);
});

test('batched addition preserves existing setup, revalidates each step and creates all nineteen units', async () => {
  const p = await property();
  const original = input('ORIGINAL');
  const v0 = await preview(p, original);
  expect((await apply(p, v0.body, original)).status).toBe(200);
  const body = input();
  body.unit_groups = [
    {
      group_ref: 'rooms',
      physical_template: 'ROOM',
      booking_mode: 'WHOLE_ONLY',
      selection_mode: 'EXACT',
      capacity: 2,
      pattern: '101-120',
      exclusions: ['113'],
    },
  ];
  const v = await preview(p, body);
  const start = await apiRequest(
    admin.context,
    'POST',
    `${base(p)}/setup-batches`,
    {
      body: {
        mode: 'ADDITION',
        input: body,
        preview_version: v.body.preview_version,
      },
      headers: { 'idempotency-key': key(), 'if-match': v.body.property_etag },
    },
  );
  expect(start.status).toBe(200);
  let b = start.body.batch;
  const step = () =>
    apiRequest(
      admin.context,
      'POST',
      `${base(p)}/setup-batches/${b.id}/advance`,
      {
        body: {
          index: b.completed_batches,
          preview_version: b.preview_version,
        },
        headers: { 'idempotency-key': key() },
      },
    );
  await apiRequest(admin.context, 'POST', `${base(p)}/resources`, {
    body: { code: 'EXTERNAL', type: 'ROOM', capacity: 2 },
  });
  expect((await step()).status).toBe(412);
  const fresh = await apiRequest(
    admin.context,
    'GET',
    `${base(p)}/setup-batches`,
  );
  b = fresh.body.batch;
  while (!b.completed) {
    const r = await step();
    expect(r.status).toBe(200);
    b = r.body.batch;
  }
  expect(await rows(p, 'resource')).toHaveLength(21);
  expect(await rows(p, 'product')).toHaveLength(20);
  expect(await rows(p, 'property_setup_draft')).toHaveLength(0);
  expect(await rows(p, 'property_operations_policy')).toHaveLength(0);
});
