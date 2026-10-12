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
const payload = (extra = {}) => ({
  schema_version: 2,
  property: {
    name: 'PSR v2 synthetic',
    timezone: 'Asia/Jakarta',
    base_currency: 'IDR',
    types: ['ROOM'],
  },
  locations: [],
  unit_groups: [
    {
      group_ref: 'g',
      physical_template: 'VILLA',
      booking_mode: 'WHOLE_ONLY',
      selection_mode: 'EXACT',
      capacity: 6,
      units: [{ unit_ref: 'v', code: 'V1', display_label: 'Villa One' }],
      details: { bedrooms_count: 4 },
    },
  ],
  operations: { check_in: '14:00', check_out: '12:00', explicit_states: true },
  pricing: { postponed: true },
  ...extra,
});
async function setup(body = payload()) {
  const p = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P-${key().slice(0, 12)}`,
        name: 'Synthetic',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(p.status).toBe(201);
  const property = p.body.property;
  const d = await apiRequest(
    admin.context,
    'PUT',
    `${base(property)}/setup-draft`,
    { body, headers: { 'idempotency-key': key() } },
  );
  expect(d.status).toBe(200);
  const preview = await apiRequest(
    admin.context,
    'POST',
    `${base(property)}/setup-draft/preview`,
  );
  expect(preview.status).toBe(200);
  return { property, draft: d.body.draft, preview: preview.body };
}
const apply = (s, k = key()) =>
  apiRequest(admin.context, 'POST', `${base(s.property)}/setup-draft/apply`, {
    body: { preview_version: s.preview.preview_version },
    headers: {
      'idempotency-key': k,
      'if-match': `"${s.draft.draft_id}:${s.draft.revision}"`,
    },
  });
async function rows(s, table) {
  return withOwner(
    async (c) =>
      (
        await c.query(
          `select * from "${table}" where tenant_id=$1 and property_id=$2`,
          [tenant, s.property.id],
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

test('whole villa: read-only preview, one resource, replay, completed protection', async () => {
  const s = await setup();
  expect(s.preview.blockers).toEqual([]);
  expect(await rows(s, 'resource')).toEqual([]);
  const k = key();
  const first = await apply(s, k);
  expect(first.status).toBe(200);
  expect(first.body.result.created_units).toBe(1);
  expect((await rows(s, 'resource'))[0].unit_details).toEqual({
    bedrooms_count: 4,
  });
  const replay = await apply(s, k);
  expect(replay.status).toBe(200);
  expect(replay.body.result).toEqual(first.body.result);
  expect(await rows(s, 'resource')).toHaveLength(1);
  expect((await apply(s)).status).toBe(409);
});
test.each(['EXACT', 'CATEGORY'])(
  'independent rooms %s preserve alternative selection',
  async (selection_mode) => {
    const s = await setup(
      payload({
        unit_groups: [
          {
            group_ref: 'r',
            physical_template: 'ROOM',
            booking_mode: 'WHOLE_ONLY',
            selection_mode,
            pattern: '101-104',
            exclusions: ['103'],
            capacity: 2,
          },
        ],
      }),
    );
    expect((await apply(s)).status).toBe(200);
    expect(await rows(s, 'resource')).toHaveLength(3);
    expect(await rows(s, 'product')).toHaveLength(
      selection_mode === 'EXACT' ? 3 : 1,
    );
    expect(await rows(s, 'composition_version')).toHaveLength(0);
    if (selection_mode === 'CATEGORY') {
      const product = (await rows(s, 'product'))[0];
      expect((await hold(s, product.id, await version(s))).status).toBe(201);
      expect(
        (await rows(s, 'plan_allocation')).filter((r) => r.state === 'ACTIVE'),
      ).toHaveLength(1);
    }
  },
);
test.each(['PARTS_ONLY', 'WHOLE_AND_PARTS'])(
  'parts %s have an unsold parent and shared leaves',
  async (booking_mode) => {
    const s = await setup(
      payload({
        unit_groups: [
          {
            ...payload().unit_groups[0],
            booking_mode,
            privacy_ack: true,
            parts: [
              { part_ref: 'a', code: 'A', display_label: 'A', capacity: 2 },
              { part_ref: 'b', code: 'B', display_label: 'B', capacity: 2 },
            ],
            effective_from: '2026-10-01',
            effective_to: '2026-12-01',
          },
        ],
      }),
    );
    const result = await apply(s);
    expect(result.status).toBe(200);
    const r = await rows(s, 'resource');
    expect(r).toHaveLength(3);
    const parent = r.find((r) => r.code === 'V1');
    expect(r.filter((r) => r.parent_resource_id === parent.id)).toHaveLength(2);
    expect(
      (await rows(s, 'composition_leaf')).some(
        (l) => l.resource_id === parent.id,
      ),
    ).toBe(false);
    expect(await rows(s, 'composition_version')).toHaveLength(
      booking_mode === 'PARTS_ONLY' ? 0 : 1,
    );
  },
);
test.each(['BEDS_ONLY', 'BEDS_AND_PRIVATE'])(
  'beds %s do not duplicate physical inventory',
  async (booking_mode) => {
    const s = await setup(
      payload({
        unit_groups: [
          {
            group_ref: 'bed',
            physical_template: 'DORM',
            booking_mode,
            selection_mode: 'CATEGORY',
            pattern: '101-101',
            beds_per_unit: 3,
            capacity: 3,
            sharing_scope: 'MIXED',
            effective_from: '2026-10-01',
            effective_to: '2026-12-01',
          },
        ],
      }),
    );
    const result = await apply(s);
    expect(result.status).toBe(200);
    expect(
      (await rows(s, 'resource')).filter((r) => r.resource_type === 'BED'),
    ).toHaveLength(3);
    expect(await rows(s, 'composition_leaf')).toHaveLength(
      booking_mode === 'BEDS_ONLY' ? 0 : 3,
    );
  },
);
test('location tree is inserted in dependency order with labels retained', async () => {
  const body = payload();
  body.locations = [
    {
      client_ref: 'floor',
      parent_ref: 'building',
      code: 'F1',
      name: 'Floor',
      kind: 'FLOOR',
      display_order: 1,
    },
    {
      client_ref: 'building',
      code: 'B1',
      name: 'Building',
      kind: 'BUILDING',
      display_order: 0,
    },
  ];
  body.unit_groups[0].location_ref = 'floor';
  const s = await setup(body);
  expect((await apply(s)).status).toBe(200);
  const locations = await rows(s, 'location');
  const floor = locations.find((l) => l.code === 'F1');
  expect(floor.parent_id).toBe(locations.find((l) => l.code === 'B1').id);
  expect((await rows(s, 'resource'))[0].location_id).toBe(floor.id);
});
test('changed inventory after preview is rejected before writing', async () => {
  const s = await setup();
  await withOwner((c) =>
    c.query(
      'update property set inventory_version=inventory_version+1 where id=$1',
      [s.property.id],
    ),
  );
  expect((await apply(s)).body.code).toBe('PREVIEW_STALE');
  expect(await rows(s, 'resource')).toEqual([]);
});
test('concurrent applies create one inventory batch', async () => {
  const s = await setup();
  const results = await Promise.all([apply(s), apply(s)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await rows(s, 'resource')).toHaveLength(1);
});
test('last product failure rolls back locations/resources/products and can retry', async () => {
  const body = payload();
  body.locations = [
    {
      client_ref: 'l',
      code: 'L',
      name: 'Synthetic location',
      kind: 'ZONE',
      display_order: 0,
    },
  ];
  body.unit_groups[0].units.push({
    unit_ref: 'v2',
    code: 'V2',
    display_label: 'Villa Two',
  });
  body.unit_groups[0].location_ref = 'l';
  const s = await setup(body);
  await withOwner((c) =>
    c.query(
      `create function psr_test_fail_product() returns trigger language plpgsql as $$ begin if NEW.property_id = '${s.property.id}'::uuid and exists(select 1 from product where property_id=NEW.property_id) then raise exception 'synthetic last product failure'; end if; return NEW; end $$; create trigger psr_test_fail before insert on product for each row execute function psr_test_fail_product()`,
    ),
  );
  try {
    expect((await apply(s)).status).toBeGreaterThanOrEqual(400);
    expect(await rows(s, 'resource')).toEqual([]);
    expect(await rows(s, 'product')).toEqual([]);
    expect(await rows(s, 'location')).toEqual([]);
  } finally {
    await withOwner((c) =>
      c.query(
        'drop trigger psr_test_fail on product; drop function psr_test_fail_product()',
      ),
    );
  }
  expect((await apply(s)).status).toBe(200);
});

test('connected suite creates only a composition over scoped existing rooms', async () => {
  const s = await setup();
  const ids = [];
  for (const code of ['201', '202']) {
    const r = await apiRequest(
      admin.context,
      'POST',
      `${base(s.property)}/resources`,
      { body: { code, type: 'ROOM', capacity: 2 } },
    );
    expect(r.status).toBe(201);
    ids.push(r.body.resource.id);
  }
  const body = payload({
    unit_groups: [
      {
        group_ref: 'suite',
        physical_template: 'SUITE_CONNECTED',
        booking_mode: 'CONNECTED_UNITS',
        selection_mode: 'EXACT',
        connected_resource_ids: ids,
        connection_ack: true,
        capacity: 4,
        effective_from: '2026-10-01',
        effective_to: '2026-12-01',
      },
    ],
  });
  const saved = await apiRequest(
    admin.context,
    'PUT',
    `${base(s.property)}/setup-draft`,
    {
      body,
      headers: {
        'idempotency-key': key(),
        'if-match': `"${s.draft.draft_id}:${s.draft.revision}"`,
      },
    },
  );
  expect(saved.status).toBe(200);
  s.draft = saved.body.draft;
  const preview = await apiRequest(
    admin.context,
    'POST',
    `${base(s.property)}/setup-draft/preview`,
  );
  expect(preview.status).toBe(200);
  s.preview = preview.body;
  expect((await apply(s)).status).toBe(200);
  expect((await rows(s, 'resource')).map((r) => r.id).sort()).toEqual(
    ids.sort(),
  );
  expect(
    (await rows(s, 'composition_leaf')).map((r) => r.resource_id).sort(),
  ).toEqual(ids.sort());
});
test('nightly prices are persisted for every product and night', async () => {
  const s = await setup(
    payload({
      pricing: {
        postponed: false,
        plan_name: 'Standard',
        sell_from: '2026-10-01',
        sell_to: '2026-10-03',
        base_price: '125000',
      },
    }),
  );
  const result = await apply(s);
  expect(result.status).toBe(200);
  expect(result.body.result.created_rate_plan).toBeTruthy();
  const prices = await withOwner((c) =>
    c.query(
      'select amount::text from nightly_price where tenant_id=$1 and property_id=$2',
      [tenant, s.property.id],
    ),
  );
  expect(prices.rows).toHaveLength(2);
  expect(prices.rows.every((r) => Number(r.amount) === 125000)).toBe(true);
});
test('resource limit change invalidates a preview, and an oversized plan writes nothing', async () => {
  const s = await setup(
    payload({
      unit_groups: [
        {
          group_ref: 'large',
          physical_template: 'ROOM',
          booking_mode: 'WHOLE_ONLY',
          selection_mode: 'EXACT',
          pattern: '1-21',
          capacity: 2,
        },
      ],
    }),
  );
  expect(
    s.preview.blockers.some((b) => b.code === 'SETUP_BATCH_TASK_REQUIRED'),
  ).toBe(true);
  expect((await apply(s)).body.code).toBe('SETUP_BATCH_TASK_REQUIRED');
  expect(await rows(s, 'resource')).toEqual([]);
});

const day = (offset) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
async function version(s) {
  const result = await apiRequest(
    admin.context,
    'GET',
    `${base(s.property)}/rates?from=${day(1)}&to=${day(2)}`,
  );
  expect(result.status).toBe(200);
  return result.body.inventory_version;
}
async function hold(s, productId, inventoryVersion) {
  return apiRequest(admin.context, 'POST', `${base(s.property)}/holds`, {
    body: {
      items: [
        {
          product_id: productId,
          quantity: 1,
          occupancy: { adults: 1, child_ages: [] },
          period: { arrival: day(10), departure: day(12) },
        },
      ],
      inventory_version: inventoryVersion,
      ttl_seconds: 300,
    },
    headers: { 'idempotency-key': key() },
  });
}
test.each(['WHOLE_AND_PARTS', 'BEDS_AND_PRIVATE'])(
  'real hold race %s preserves exclusivity',
  async (booking_mode) => {
    const beds = booking_mode === 'BEDS_AND_PRIVATE';
    const g = beds
      ? {
          group_ref: 'beds',
          physical_template: 'DORM',
          booking_mode,
          selection_mode: 'CATEGORY',
          pattern: '101-101',
          capacity: 3,
          beds_per_unit: 3,
          sharing_scope: 'MIXED',
        }
      : {
          ...payload().unit_groups[0],
          capacity: 4,
          booking_mode,
          privacy_ack: true,
          parts: [
            { part_ref: 'a', code: 'A', display_label: 'A', capacity: 2 },
            { part_ref: 'b', code: 'B', display_label: 'B', capacity: 2 },
          ],
        };
    const s = await setup(
      payload({
        unit_groups: [{ ...g, effective_from: day(0), effective_to: day(30) }],
      }),
    );
    expect((await apply(s)).status).toBe(200);
    const whole = (await rows(s, 'composition_version'))[0].product_id;
    const part = (await rows(s, 'product')).find((p) => p.id !== whole).id;
    const inventoryVersion = await version(s);
    const results = await Promise.all([
      hold(s, whole, inventoryVersion),
      hold(s, part, inventoryVersion),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    expect([409, 412]).toContain(statuses[1]);
    const loser = results[0].status === 201 ? part : whole;
    const retry = await hold(s, loser, await version(s));
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('RESOURCE_UNAVAILABLE');
    const overlap = await withOwner((c) =>
      c.query(
        `select count(*)::int as count from plan_allocation a join plan_allocation b on a.resource_id=b.resource_id and a.id<b.id and a.state='ACTIVE' and b.state='ACTIVE' and daterange(a.start_date,a.end_date,'[)') && daterange(b.start_date,b.end_date,'[)') where a.property_id=$1`,
        [s.property.id],
      ),
    );
    expect(overlap.rows[0].count).toBe(0);
  },
);

test('location changes invalidate preview without inventory changes', async () => {
  const s = await setup();
  const created = await apiRequest(
    admin.context,
    'POST',
    `${base(s.property)}/locations`,
    { body: { code: 'AFTER', name: 'Added after preview' } },
  );
  expect(created.status).toBe(201);
  expect((await apply(s)).body.code).toBe('PREVIEW_STALE');
  expect(await rows(s, 'resource')).toEqual([]);
});
test('changed limits invalidate the preview even without an inventory version bump', async () => {
  const s = await setup();
  const profile = await withOwner(
    async (c) =>
      (
        await c.query(
          'select l.* from property_limits_profile l join property p on p.limits_profile_id=l.id where p.id=$1',
          [s.property.id],
        )
      ).rows[0],
  );
  await withOwner((c) =>
    c.query(
      'update property_limits_profile set max_setup_units_inline=max_setup_units_inline-1 where id=$1',
      [profile.id],
    ),
  );
  try {
    expect((await apply(s)).body.code).toBe('PREVIEW_STALE');
    expect(await rows(s, 'resource')).toEqual([]);
  } finally {
    await withOwner((c) =>
      c.query(
        'update property_limits_profile set max_setup_units_inline=$1 where id=$2',
        [profile.max_setup_units_inline, profile.id],
      ),
    );
  }
});
test('read-only actor cannot execute v2 plans', async () => {
  const s = await setup();
  const auditor = await loginAs('auditor-a');
  const result = await apiRequest(
    auditor.context,
    'POST',
    `${base(s.property)}/setup-draft/apply`,
    {
      body: { preview_version: s.preview.preview_version },
      headers: {
        'idempotency-key': key(),
        'if-match': `"${s.draft.draft_id}:${s.draft.revision}"`,
      },
    },
  );
  expect(result.status).toBe(403);
  expect(await rows(s, 'resource')).toEqual([]);
});
