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

const day = (n) =>
  new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
test('PSR05-O05: nineteen exact rooms exceed inline budget and leave the draft uncompleted', async () => {
  const s = await setup(
    payload({
      unit_groups: [
        {
          group_ref: 'rooms',
          physical_template: 'ROOM',
          booking_mode: 'WHOLE_ONLY',
          selection_mode: 'EXACT',
          capacity: 2,
          pattern: '101-120',
          exclusions: ['113'],
        },
      ],
    }),
  );
  expect(s.preview.generated.total_units).toBe(19);
  expect(
    s.preview.blockers.some((b) => b.code === 'SETUP_BATCH_TASK_REQUIRED'),
  ).toBe(true);
  expect((await apply(s)).body.code).toBe('SETUP_BATCH_TASK_REQUIRED');
  expect(await rows(s, 'resource')).toEqual([]);
  expect(await rows(s, 'product')).toEqual([]);
  expect((await rows(s, 'property_setup_draft'))[0].completed).toBe(false);
});
const composed = () =>
  payload({
    unit_groups: [
      {
        ...payload().unit_groups[0],
        booking_mode: 'WHOLE_AND_PARTS',
        privacy_ack: true,
        effective_from: day(1),
        effective_to: day(20),
        parts: [
          { part_ref: 'a', code: 'A', display_label: 'A', capacity: 2 },
          { part_ref: 'b', code: 'B', display_label: 'B', capacity: 2 },
        ],
      },
    ],
  });
const priced = () =>
  payload({
    pricing: {
      postponed: false,
      plan_name: 'Review',
      sell_from: day(2),
      sell_to: day(4),
      base_price: '120000',
    },
  });
async function withoutPermission(permission, run) {
  const removed = await withOwner(
    async (c) =>
      (
        await c.query(
          'delete from role_permission where permission_code=$1 and role_id in (select id from role where tenant_id=$2) returning *',
          [permission, tenant],
        )
      ).rows,
  );
  expect(removed.length).toBeGreaterThan(0);
  try {
    await run();
  } finally {
    await withOwner(async (c) => {
      for (const r of removed)
        await c.query(
          'insert into role_permission(role_id,permission_code) values($1,$2) on conflict do nothing',
          [r.role_id, r.permission_code],
        );
    });
  }
}
test.each(['composition.manage', 'rate.manage'])(
  'missing %s rejects composed execution and replay',
  async (permission) => {
    const s = await setup(permission === 'rate.manage' ? priced() : composed());
    await withoutPermission(permission, async () => {
      expect((await apply(s)).status).toBe(403);
      expect(await rows(s, 'resource')).toEqual([]);
    });
    const k = key();
    expect((await apply(s, k)).status).toBe(200);
    const before = await rows(s, 'resource');
    await withoutPermission(permission, async () => {
      expect((await apply(s, k)).status).toBe(403);
      expect(await rows(s, 'resource')).toEqual(before);
    });
  },
);
test.each(['nightly_price', 'api_idempotency', 'audit_event'])(
  'late failure in %s rolls back all setup writes and retry works',
  async (table) => {
    const body = priced();
    body.locations = [
      {
        client_ref: 'zone',
        code: 'ZONE',
        name: 'Zone',
        kind: 'ZONE',
        display_order: 0,
      },
    ];
    body.unit_groups[0].location_ref = 'zone';
    const s = await setup(body);
    const k = key();
    const before = await withOwner(
      async (c) =>
        (
          await c.query(
            'select inventory_version,location_tree_revision from property where id=$1',
            [s.property.id],
          )
        ).rows[0],
    );
    await withOwner((c) =>
      c.query(
        `create function psr_review_fail() returns trigger language plpgsql as $$ begin if NEW.property_id='${s.property.id}'::uuid then raise exception 'synthetic late failure'; end if; return NEW; end $$; create trigger psr_review_fail before insert on "${table}" for each row execute function psr_review_fail()`,
      ),
    );
    try {
      expect((await apply(s, k)).status).toBeGreaterThanOrEqual(400);
      for (const t of [
        'location',
        'resource',
        'product',
        'rate_plan',
        'nightly_price',
      ])
        expect(await rows(s, t)).toEqual([]);
      expect((await rows(s, 'property_setup_draft'))[0].completed).toBe(false);
      const after = await withOwner(
        async (c) =>
          (
            await c.query(
              'select inventory_version,location_tree_revision from property where id=$1',
              [s.property.id],
            )
          ).rows[0],
      );
      expect(after).toEqual(before);
    } finally {
      await withOwner((c) =>
        c.query(
          `drop trigger psr_review_fail on "${table}"; drop function psr_review_fail()`,
        ),
      );
    }
    expect((await apply(s, k)).status).toBe(200);
  },
);
async function suiteFixture() {
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
        effective_from: day(1),
        effective_to: day(20),
      },
    ],
  });
  const d = await apiRequest(
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
  expect(d.status).toBe(200);
  s.draft = d.body.draft;
  const p = await apiRequest(
    admin.context,
    'POST',
    `${base(s.property)}/setup-draft/preview`,
  );
  expect(p.status).toBe(200);
  s.preview = p.body;
  return { s, ids, body };
}
test('block after connected-suite preview invalidates apply', async () => {
  const { s, ids } = await suiteFixture();
  const b = await apiRequest(
    admin.context,
    'POST',
    `${base(s.property)}/blocks`,
    {
      body: {
        resource_ids: [ids[0]],
        period: { arrival: day(3), departure: day(5) },
        reason: 'Synthetic review',
        mode: 'PLANNED',
      },
    },
  );
  expect(b.status).toBe(201);
  expect((await apply(s)).body.code).toBe('PREVIEW_STALE');
  expect(await rows(s, 'product')).toEqual([]);
  expect(await rows(s, 'resource')).toHaveLength(2);
});
test('foreign property resource rejected even for a tampered stored draft', async () => {
  const { s, body } = await suiteFixture();
  const other = await setup();
  expect((await apply(other)).status).toBe(200);
  body.unit_groups[0].connected_resource_ids[0] = (
    await rows(other, 'resource')
  )[0].id;
  // Bypass save intentionally: execution must resolve scope itself.
  await withOwner((c) =>
    c.query(
      'update property_setup_draft set input=$1::jsonb where property_id=$2',
      [JSON.stringify(body), s.property.id],
    ),
  );
  const p = await apiRequest(
    admin.context,
    'POST',
    `${base(s.property)}/setup-draft/preview`,
  );
  expect(p.status).toBe(422);
  expect(p.body.code).toBe('CROSS_SCOPE_REFERENCE');
  expect(await rows(s, 'product')).toEqual([]);
});

test('preview reports a pricing horizon that apply cannot accept', async () => {
  const body = priced();
  body.pricing.sell_to = day(2000);
  const s = await setup(body);
  expect(s.preview.blockers.some((b) => b.code === 'LIMIT_EXCEEDED')).toBe(
    true,
  );
  expect(
    s.preview.blockers.find((b) => b.field === 'pricing.sell_to')?.step,
  ).toBe('PRICING');
  expect(await rows(s, 'resource')).toEqual([]);
});
test('preview reports composition leaf limit before any write', async () => {
  const s = await setup(composed());
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
      'update property_limits_profile set max_leaves_per_product=1 where id=$1',
      [profile.id],
    ),
  );
  try {
    const p = await apiRequest(
      admin.context,
      'POST',
      `${base(s.property)}/setup-draft/preview`,
    );
    expect(p.status).toBe(200);
    expect(p.body.blockers.some((b) => b.code === 'LIMIT_EXCEEDED')).toBe(true);
    expect(await rows(s, 'resource')).toEqual([]);
  } finally {
    await withOwner((c) =>
      c.query(
        'update property_limits_profile set max_leaves_per_product=$1 where id=$2',
        [profile.max_leaves_per_product, profile.id],
      ),
    );
  }
});
test('preview detects depth33 over an existing depth32 location tree', async () => {
  const s = await setup();
  const body = payload();
  let parent = null,
    parentRef = null;
  await withOwner(async (c) => {
    for (let i = 0; i < 32; i++) {
      const id = key(),
        ref = `l${i}`;
      await c.query(
        "insert into location(id,tenant_id,property_id,code,name,parent_id,kind,display_order) values($1,$2,$3,$4,$4,$5,'ZONE',0)",
        [id, tenant, s.property.id, ref, parent],
      );
      body.locations.push({
        client_ref: ref,
        existing_location_id: id,
        parent_ref: parentRef,
        code: ref,
        name: ref,
        kind: 'ZONE',
        display_order: 0,
      });
      parent = id;
      parentRef = ref;
    }
  });
  body.locations.push({
    client_ref: 'deep',
    parent_ref: parentRef,
    code: 'DEEP',
    name: 'Deep',
    kind: 'ZONE',
    display_order: 0,
  });
  const d = await apiRequest(
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
  expect(d.status).toBe(200);
  const p = await apiRequest(
    admin.context,
    'POST',
    `${base(s.property)}/setup-draft/preview`,
  );
  expect(p.status).toBe(200);
  expect(p.body.blockers.some((b) => b.code === 'LIMIT_EXCEEDED')).toBe(true);
  expect(await rows(s, 'resource')).toEqual([]);
});
test('a whole stay crossing composition end is rejected', async () => {
  const s = await setup(composed());
  expect((await apply(s)).status).toBe(200);
  const product = (await rows(s, 'composition_version'))[0].product_id;
  const v = await apiRequest(
    admin.context,
    'GET',
    `${base(s.property)}/rates?from=${day(1)}&to=${day(2)}`,
  );
  expect(v.status).toBe(200);
  const h = await apiRequest(
    admin.context,
    'POST',
    `${base(s.property)}/holds`,
    {
      body: {
        items: [
          {
            product_id: product,
            quantity: 1,
            occupancy: { adults: 1, child_ages: [] },
            period: { arrival: day(20), departure: day(22) },
          },
        ],
        inventory_version: v.body.inventory_version,
        ttl_seconds: 300,
      },
      headers: { 'idempotency-key': key() },
    },
  );
  expect(h.status).toBe(409);
  expect(h.body.code).toBe('RESOURCE_UNAVAILABLE');
  expect(await rows(s, 'plan_allocation')).toEqual([]);
});

const batchStart = (s, k = key()) =>
  apiRequest(admin.context, 'POST', `${base(s.property)}/setup-batches`, {
    body: { mode: 'DRAFT', preview_version: s.preview.preview_version },
    headers: {
      'idempotency-key': k,
      'if-match': `"${s.draft.draft_id}:${s.draft.revision}"`,
    },
  });
const batchStep = (s, b, k = key()) =>
  apiRequest(
    admin.context,
    'POST',
    `${base(s.property)}/setup-batches/${b.id}/advance`,
    {
      body: { index: b.completed_batches, preview_version: b.preview_version },
      headers: { 'idempotency-key': k },
    },
  );
function nineteen() {
  return payload({
    unit_groups: [
      {
        group_ref: 'rooms',
        physical_template: 'ROOM',
        booking_mode: 'WHOLE_ONLY',
        selection_mode: 'EXACT',
        capacity: 2,
        pattern: '101-120',
        exclusions: ['113'],
      },
    ],
  });
}
test('PSR05 batches: nineteen rooms with location and prices survive response replay and complete once', async () => {
  const input = nineteen();
  input.locations = [
    {
      client_ref: 'floor',
      code: 'F1',
      name: 'First floor',
      kind: 'FLOOR',
      display_order: 1,
    },
  ];
  input.unit_groups[0].location_ref = 'floor';
  input.pricing = priced().pricing;
  const s = await setup(input);
  expect(s.preview.batch_plan.total_batches).toBeGreaterThan(1);
  const k = key(),
    started = await batchStart(s, k);
  expect(started.status).toBe(200);
  expect((await batchStart(s, k)).body.batch.id).toBe(started.body.batch.id);
  expect(await rows(s, 'resource')).toHaveLength(0);
  let b = started.body.batch;
  const stepKey = key(),
    first = await batchStep(s, b, stepKey);
  expect(first.status).toBe(200);
  expect(first.body.batch.completed).toBe(false);
  expect((await batchStep(s, b, stepKey)).body.batch).toEqual(first.body.batch);
  expect((await rows(s, 'property_setup_draft'))[0].completed).toBe(false);
  expect(
    (
      await apiRequest(
        admin.context,
        'PUT',
        `${base(s.property)}/setup-draft`,
        {
          body: input,
          headers: {
            'idempotency-key': key(),
            'if-match': `"${s.draft.draft_id}:${s.draft.revision}"`,
          },
        },
      )
    ).status,
  ).toBe(409);
  const reload = await apiRequest(
    admin.context,
    'GET',
    `${base(s.property)}/setup-batches`,
  );
  b = reload.body.batch;
  expect(b.completed_batches).toBe(1);
  while (!b.completed) {
    const next = await batchStep(s, b);
    expect(next.status).toBe(200);
    b = next.body.batch;
  }
  expect(b.created_units).toBe(19);
  expect(b.result.created_products).toBe(19);
  const resources = await rows(s, 'resource');
  expect(resources).toHaveLength(19);
  expect(resources.some((r) => r.code === '113')).toBe(false);
  expect(new Set(resources.map((r) => r.location_id)).size).toBe(1);
  expect(await rows(s, 'product')).toHaveLength(19);
  expect(await rows(s, 'rate_plan')).toHaveLength(19);
  expect(await rows(s, 'nightly_price')).toHaveLength(38);
  expect((await rows(s, 'property_setup_draft'))[0].completed).toBe(true);
});
test('PSR05 batch step rolls back on late failure and rejects stale/concurrent progress', async () => {
  const s = await setup(nineteen());
  const start = await batchStart(s);
  expect(start.status).toBe(200);
  const b = start.body.batch,
    k = key();
  await withOwner((c) =>
    c.query(
      `create function psr_batch_fail() returns trigger language plpgsql as $$ begin if NEW.property_id='${s.property.id}'::uuid then raise exception 'batch review failure'; end if; return NEW; end $$; create trigger psr_batch_fail before insert on product for each row execute function psr_batch_fail()`,
    ),
  );
  try {
    expect((await batchStep(s, b, k)).status).toBeGreaterThanOrEqual(400);
    expect(await rows(s, 'resource')).toHaveLength(0);
    expect((await rows(s, 'property_setup_batch'))[0].next_index).toBe(0);
  } finally {
    await withOwner((c) =>
      c.query(
        'drop trigger psr_batch_fail on product; drop function psr_batch_fail()',
      ),
    );
  }
  const results = await Promise.all([batchStep(s, b, k), batchStep(s, b)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
  expect(await rows(s, 'resource')).toHaveLength(10);
  const other = await setup();
  expect((await batchStep(other, b)).status).toBe(404);
  const reader = await loginAs('auditor-a');
  expect(
    (
      await apiRequest(
        reader.context,
        'POST',
        `${base(s.property)}/setup-batches/${b.id}/advance`,
        {
          body: { index: 1, preview_version: b.preview_version },
          headers: { 'idempotency-key': key() },
        },
      )
    ).status,
  ).toBe(403);
});
test('PSR05 batch start rejects stale preview and unsplittable product without changing limits', async () => {
  const s = await setup(nineteen());
  await apiRequest(admin.context, 'POST', `${base(s.property)}/resources`, {
    body: { code: 'OTHER', type: 'ROOM', capacity: 2 },
  });
  expect((await batchStart(s)).status).toBe(412);
  expect(await rows(s, 'property_setup_batch')).toHaveLength(0);
  const body = nineteen();
  body.unit_groups[0].selection_mode = 'CATEGORY';
  body.unit_groups[0].pattern = '101-140';
  const large = await setup(body);
  expect(large.preview.batch_plan).toBeNull();
  expect((await batchStart(large)).body.code).toBe('SETUP_BATCH_TASK_REQUIRED');
  expect(await rows(large, 'resource')).toHaveLength(0);
});
