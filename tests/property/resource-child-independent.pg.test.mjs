import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
} from './support/harness.mjs';
let admin, auditor, tenant;
const key = () => randomUUID();
const prefix = (p) => `/tenants/${tenant}/properties/${p.id}`;
const request = (p, method, suffix, body, k = key()) =>
  apiRequest(admin.context, method, prefix(p) + suffix, {
    body,
    headers: { 'idempotency-key': k },
  });
async function fixture(parts = true) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `CH-${key().slice(0, 12)}`,
        name: 'Synthetic child addition',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  const p = created.body.property;
  const input = {
    schema_version: 2,
    property: {
      name: 'Synthetic child addition',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['VILLA'],
    },
    locations: [],
    unit_groups: [
      {
        group_ref: 'v',
        physical_template: 'VILLA',
        booking_mode: parts ? 'WHOLE_AND_PARTS' : 'WHOLE_ONLY',
        selection_mode: 'EXACT',
        capacity: 6,
        privacy_ack: true,
        units: [{ unit_ref: 'v', code: 'V', display_label: 'Villa' }],
        ...(parts
          ? {
              parts: [
                {
                  part_ref: 'a',
                  code: 'R1',
                  display_label: 'Room 1',
                  capacity: 3,
                },
                {
                  part_ref: 'b',
                  code: 'R2',
                  display_label: 'Room 2',
                  capacity: 3,
                },
              ],
            }
          : {}),
        effective_from: '2026-10-01',
        effective_to: '2031-10-08',
      },
    ],
    operations: {
      check_in: '14:00',
      check_out: '12:00',
      explicit_states: true,
    },
    pricing: { postponed: true },
  };
  const draft = await request(p, 'PUT', '/setup-draft', input);
  expect(draft.status).toBe(200);
  const preview = await request(p, 'POST', '/setup-draft/preview');
  expect(preview.status).toBe(200);
  const applied = await apiRequest(
    admin.context,
    'POST',
    prefix(p) + '/setup-draft/apply',
    {
      body: { preview_version: preview.body.preview_version },
      headers: {
        'idempotency-key': key(),
        'if-match': `"${draft.body.draft.draft_id}:${draft.body.draft.revision}"`,
      },
    },
  );
  expect(applied.status).toBe(200);
  const rows = (await request(p, 'GET', '/resources?limit=100')).body.items;
  return { p, rows, parent: rows.find((r) => r.code === 'V') };
}
const child = (parent) => ({
  code: 'R3',
  type: 'ROOM',
  capacity: 3,
  parent_resource_id: parent.id,
  display_label: 'Room 3',
});
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  auditor = await loginAs('auditor-a');
  tenant = admin.session.body.session.active_tenant_id;
});
afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('independent: durable replay still checks actor permission and property scope', async () => {
  const a = await fixture(),
    b = await fixture();
  const k = key(),
    body = child(a.parent);
  const created = await request(a.p, 'POST', '/resources', body, k);
  expect(created.status).toBe(201);
  const denied = await apiRequest(
    auditor.context,
    'POST',
    prefix(a.p) + '/resources',
    { body, headers: { 'idempotency-key': k } },
  );
  expect(denied.status).toBe(403);
  const changedParent = await request(
    a.p,
    'POST',
    '/resources',
    { ...body, parent_resource_id: b.parent.id },
    k,
  );
  expect(changedParent.status).toBe(409);
  const crossProperty = await request(b.p, 'POST', '/resources', body, k);
  expect(crossProperty.status).toBe(404);
  expect(crossProperty.body.resource).toBeUndefined();
  expect(
    (await request(b.p, 'GET', '/resources?limit=100')).body.items,
  ).toHaveLength(3);
  const replay = await request(a.p, 'POST', '/resources', body, k);
  expect(replay.status).toBe(201);
  expect(replay.body).toEqual(created.body);
});

test('independent: foreign location fails atomically and failed intent does not consume the key', async () => {
  const a = await fixture(),
    b = await fixture();
  const location = await request(b.p, 'POST', '/locations', {
    code: 'FOREIGN',
    name: 'Other property',
    kind: 'FLOOR',
  });
  expect(location.status).toBe(201);
  const k = key(),
    body = { ...child(a.parent), location_id: location.body.location.id };
  const before = (await request(a.p, 'GET', '')).body.property
    .inventory_version;
  const rejected = await request(a.p, 'POST', '/resources', body, k);
  expect(rejected.status).toBe(422);
  expect(
    (await request(a.p, 'GET', '/resources?limit=100')).body.items,
  ).toHaveLength(3);
  expect((await request(a.p, 'GET', '')).body.property.inventory_version).toBe(
    before,
  );
  const valid = await request(a.p, 'POST', '/resources', child(a.parent), k);
  expect(valid.status).toBe(201);
  expect(valid.body.resource.parent_resource_id).toBe(a.parent.id);
  const replay = await request(a.p, 'POST', '/resources', child(a.parent), k);
  expect(replay.status).toBe(201);
  expect(replay.body).toEqual(valid.body);
});
