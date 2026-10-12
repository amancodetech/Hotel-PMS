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

test('PSR-T02 exact acceptance size: nineteen CATEGORY rooms produce nineteen candidates and a hold consumes one', async () => {
  const s = await setup(
    payload({
      unit_groups: [
        {
          group_ref: 'rooms',
          physical_template: 'ROOM',
          booking_mode: 'WHOLE_ONLY',
          selection_mode: 'CATEGORY',
          pattern: '101-120',
          exclusions: ['113'],
          capacity: 2,
        },
      ],
    }),
  );
  expect(s.preview.blockers).toEqual([]);
  expect(await rows(s, 'resource')).toHaveLength(0);
  expect((await apply(s)).status).toBe(200);
  const resources = await rows(s, 'resource');
  expect(resources.map((r) => r.code).sort()).toEqual(
    Array.from({ length: 20 }, (_, i) => String(101 + i)).filter(
      (c) => c !== '113',
    ),
  );
  expect(await rows(s, 'product')).toHaveLength(1);
  expect(await rows(s, 'composition_version')).toHaveLength(0);
  expect(await rows(s, 'product_resource_candidate')).toHaveLength(19);
  const product = (await rows(s, 'product'))[0];
  expect((await hold(s, product.id, await version(s))).status).toBe(201);
  expect(
    (await rows(s, 'plan_allocation')).filter((r) => r.state === 'ACTIVE'),
  ).toHaveLength(1);
});

test.each(['BEDS_ONLY', 'BEDS_AND_PRIVATE'])(
  'PSR-T07 exact acceptance size: six beds in independent %s fixture',
  async (booking_mode) => {
    const s = await setup(
      payload({
        unit_groups: [
          {
            group_ref: 'dorm',
            physical_template: 'DORM',
            booking_mode,
            selection_mode: 'CATEGORY',
            units: [{ unit_ref: 'd1', code: 'D1', display_label: 'Dorm One' }],
            capacity: 6,
            beds_per_unit: 6,
            sharing_scope: 'MIXED',
            effective_from: day(0),
            effective_to: day(30),
          },
        ],
      }),
    );
    expect(s.preview.blockers).toEqual([]);
    expect((await apply(s)).status).toBe(200);
    const resources = await rows(s, 'resource');
    expect(resources.filter((r) => r.resource_type === 'BED')).toHaveLength(6);
    const versions = await rows(s, 'composition_version');
    expect(versions).toHaveLength(booking_mode === 'BEDS_ONLY' ? 0 : 1);
    expect(await rows(s, 'composition_leaf')).toHaveLength(
      booking_mode === 'BEDS_ONLY' ? 0 : 6,
    );
    if (booking_mode === 'BEDS_AND_PRIVATE') {
      const whole = versions[0].product_id;
      const part = (await rows(s, 'product')).find((p) => p.id !== whole).id;
      const v = await version(s);
      const results = await Promise.all([hold(s, whole, v), hold(s, part, v)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect([409, 412]).toContain(
        results.find((r) => r.status !== 201).status,
      );
      const loser = results[0].status === 201 ? part : whole;
      expect((await hold(s, loser, await version(s))).status).toBe(409);
    }
  },
);

test('PSR-T28 descriptive cot and shared pool do not create bed inventory or lock a sibling villa', async () => {
  const s = await setup(
    payload({
      unit_groups: [
        {
          group_ref: 'villas',
          physical_template: 'VILLA',
          booking_mode: 'WHOLE_ONLY',
          selection_mode: 'EXACT',
          capacity: 6,
          units: [
            { unit_ref: 'a', code: 'VA', display_label: 'Villa A' },
            { unit_ref: 'b', code: 'VB', display_label: 'Villa B' },
          ],
          details: {
            bedrooms_count: 4,
            notes:
              'Synthetic descriptive cot and shared pool; no separately sold facility.',
          },
        },
      ],
    }),
  );
  expect((await apply(s)).status).toBe(200);
  expect(await rows(s, 'resource')).toHaveLength(2);
  expect(
    (await rows(s, 'resource')).some((r) => r.resource_type === 'BED'),
  ).toBe(false);
  expect(await rows(s, 'composition_version')).toHaveLength(0);
  const products = await rows(s, 'product');
  expect(products).toHaveLength(2);
  expect((await hold(s, products[0].id, await version(s))).status).toBe(201);
  expect((await hold(s, products[1].id, await version(s))).status).toBe(201);
  expect(
    (await rows(s, 'plan_allocation')).filter((r) => r.state === 'ACTIVE'),
  ).toHaveLength(2);
});

test.each(['PARTS_ONLY', 'WHOLE_AND_PARTS'])(
  'PSR-T05/T06 three named parts %s keep parent unsold and independent siblings available',
  async (booking_mode) => {
    const s = await setup(
      payload({
        unit_groups: [
          {
            ...payload().unit_groups[0],
            booking_mode,
            privacy_ack: true,
            capacity: 6,
            parts: ['A', 'B', 'C'].map((code) => ({
              part_ref: code.toLowerCase(),
              code,
              display_label: code,
              capacity: 2,
            })),
            effective_from: day(0),
            effective_to: day(30),
          },
        ],
      }),
    );
    expect(s.preview.blockers).toEqual([]);
    expect((await apply(s)).status).toBe(200);
    const resources = await rows(s, 'resource');
    const parent = resources.find((r) => r.code === 'V1');
    const parts = resources.filter((r) => r.parent_resource_id === parent.id);
    expect(parts).toHaveLength(3);
    const products = await rows(s, 'product');
    const versions = await rows(s, 'composition_version');
    expect(versions).toHaveLength(booking_mode === 'PARTS_ONLY' ? 0 : 1);
    const candidates = await rows(s, 'product_resource_candidate');
    expect(candidates.some((c) => c.resource_id === parent.id)).toBe(false);
    expect(
      (await rows(s, 'composition_leaf')).some(
        (l) => l.resource_id === parent.id,
      ),
    ).toBe(false);
    expect(products).toHaveLength(booking_mode === 'PARTS_ONLY' ? 3 : 4);
    for (const part of parts) {
      const candidate = candidates.find((c) => c.resource_id === part.id);
      expect(candidate).toBeDefined();
      expect(
        (await hold(s, candidate.product_id, await version(s))).status,
      ).toBe(201);
    }
    expect(
      (await rows(s, 'plan_allocation')).filter((r) => r.state === 'ACTIVE'),
    ).toHaveLength(3);
    if (booking_mode === 'WHOLE_AND_PARTS')
      expect(
        (await hold(s, versions[0].product_id, await version(s))).status,
      ).toBe(409);
  },
);
