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

test('independent: changed next-step state rejects old preview, replay remains stable, and recovery completes once', async () => {
  const s = await setup(nineteen());
  const started = await batchStart(s);
  expect(started.status).toBe(200);
  const initial = started.body.batch;
  const k = key();
  const first = await batchStep(s, initial, k);
  expect(first.status).toBe(200);
  const stale = first.body.batch;
  const inserted = await apiRequest(
    admin.context,
    'POST',
    `${base(s.property)}/resources`,
    { body: { code: 'INDEPENDENT-EXTRA', type: 'ROOM', capacity: 2 } },
  );
  expect(inserted.status).toBe(201);
  expect((await batchStep(s, stale)).status).toBe(412);
  expect((await rows(s, 'property_setup_batch'))[0].next_index).toBe(1);
  expect((await batchStep(s, initial, k)).body.batch).toEqual(first.body.batch);
  const fresh = await apiRequest(
    admin.context,
    'GET',
    `${base(s.property)}/setup-batches`,
  );
  const final = await batchStep(s, fresh.body.batch);
  expect(final.status).toBe(200);
  expect(final.body.batch.completed).toBe(true);
  expect(await rows(s, 'resource')).toHaveLength(20);
  expect(await rows(s, 'product')).toHaveLength(19);
  expect((await rows(s, 'property_setup_draft'))[0].completed).toBe(true);
  expect((await batchStep(s, fresh.body.batch)).status).toBe(412);
});
test('independent: batch table forces tenant RLS and denies runtime deletion', async () => {
  const s = await setup(nineteen());
  const started = await batchStart(s);
  expect(started.status).toBe(200);
  const observed = await withOwner(async (c) => {
    await c.query('begin');
    try {
      await c.query('set local role hotel_api');
      await c.query("select set_config('app.tenant_id',$1,true)", [
        randomUUID(),
      ]);
      return (
        await c.query('select id from property_setup_batch where id=$1', [
          started.body.batch.id,
        ])
      ).rows;
    } finally {
      await c.query('rollback');
    }
  });
  expect(observed).toEqual([]);
  await withOwner(async (c) => {
    await c.query('begin');
    try {
      await c.query('set local role hotel_api');
      await c.query("select set_config('app.tenant_id',$1,true)", [tenant]);
      await expect(
        c.query('delete from property_setup_batch where id=$1', [
          started.body.batch.id,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('rollback');
    }
  });
  expect(await rows(s, 'property_setup_batch')).toHaveLength(1);
});
