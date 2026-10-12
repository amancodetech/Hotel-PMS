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
const etag = (d) => `"${d.draft_id}:${d.revision}"`;
const v2 = () => ({
  schema_version: 2,
  property: { name: null, timezone: null },
  locations: [],
  unit_groups: [
    {
      group_ref: 'one',
      physical_template: 'ROOM',
      booking_mode: 'WHOLE_ONLY',
      selection_mode: 'EXACT',
      capacity: 2,
      units: [{ unit_ref: 'one', code: 'R1', display_label: '101' }],
    },
  ],
  operations: { check_in: null, explicit_states: false },
  pricing: null,
});
async function property() {
  const r = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `R08-${key().slice(0, 12)}`,
        name: 'Independent synthetic',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(r.status).toBe(201);
  return r.body.property;
}
async function snapshot(p) {
  return withOwner(async (c) => {
    const result = {};
    for (const table of [
      'property_setup_draft',
      'location',
      'resource',
      'product',
      'composition_version',
      'composition_leaf',
      'commitment',
      'plan_allocation',
    ]) {
      result[table] = (
        await c.query(
          `select * from "${table}" where tenant_id=$1 and property_id=$2 order by ${table === 'composition_leaf' ? 'version_id,resource_id' : 'id'}`,
          [tenant, p.id],
        )
      ).rows;
    }
    result.property = (
      await c.query('select * from property where tenant_id=$1 and id=$2', [
        tenant,
        p.id,
      ])
    ).rows;
    return result;
  });
}
async function setupAudits(p) {
  return withOwner(
    async (c) =>
      (
        await c.query(
          "select action,count(*)::int as count from audit_event where tenant_id=$1 and property_id=$2 and outcome='SUCCESS' and action like 'setup_draft.%' group by action order by action",
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

test.each([
  ['hourly', { booking_mode: 'HOURLY' }],
  [
    'unnumbered pooled campsite',
    { physical_template: 'SITE', pooled_capacity: 100 },
  ],
  [
    'category of composite villas',
    {
      physical_template: 'VILLA',
      booking_mode: 'WHOLE_AND_PARTS',
      selection_mode: 'CATEGORY',
      parts: [
        { part_ref: 'a', code: 'A', display_label: 'Part A', capacity: 2 },
        { part_ref: 'b', code: 'B', display_label: 'Part B', capacity: 2 },
      ],
      privacy_ack: true,
    },
  ],
])(
  'T25 independent HTTP rejects %s on save and addition without any inventory or draft mutation',
  async (_label, extra) => {
    const p = await property();
    const body = v2();
    const accepted = await apiRequest(
      admin.context,
      'PUT',
      `${base(p)}/setup-draft`,
      { body, headers: { 'idempotency-key': key() } },
    );
    expect(accepted.status).toBe(200);
    const before = await snapshot(p);
    const audits = await setupAudits(p);
    expect(audits).toContainEqual({ action: 'setup_draft.saved', count: 1 });
    Object.assign(body.unit_groups[0], extra);
    const save = await apiRequest(
      admin.context,
      'PUT',
      `${base(p)}/setup-draft`,
      {
        body,
        headers: {
          'idempotency-key': key(),
          'if-match': etag(accepted.body.draft),
        },
      },
    );
    expect([400, 422]).toContain(save.status);
    if (_label === 'category of composite villas') {
      expect(save.body.code).toBe('SETUP_DRAFT_INVALID');
      expect(save.body.details.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'selection_unsupported' }),
        ]),
      );
    }
    const preview = await apiRequest(
      admin.context,
      'POST',
      `${base(p)}/setup-unit-additions/preview`,
      {
        body: {
          schema_version: 2,
          locations: [],
          unit_groups: body.unit_groups,
        },
      },
    );
    if (preview.status === 200)
      expect(preview.body.blockers.length).toBeGreaterThan(0);
    else expect([400, 422]).toContain(preview.status);
    expect(await snapshot(p)).toEqual(before);
    expect(await setupAudits(p)).toEqual(audits);
  },
);

test('T14 independent incomplete v1 read/save stays exact and explicit v2 replacement preserves null/omitted/zero without inventory', async () => {
  const p = await property();
  const legacy = {
    property: { name: null, country: null },
    unit_groups: [
      {
        template_code: 'ROOM',
        rental_mode: 'EXCLUSIVE',
        pattern: '101-102',
        capacity: null,
      },
    ],
    operations: { check_in: null, explicit_states: false },
    pricing: null,
  };
  const initial = await apiRequest(
    admin.context,
    'PUT',
    `${base(p)}/setup-draft`,
    { body: legacy, headers: { 'idempotency-key': key() } },
  );
  expect(initial.status).toBe(200);
  // Existing v1 PUT normalizes omitted optional fields (SET-03). GET must
  // preserve that stored representation; v2 below preserves omissions exactly.
  expect(initial.body.draft.input).toMatchObject(legacy);
  expect(initial.body.draft.input).not.toHaveProperty('schema_version');
  const before = await snapshot(p);
  for (let i = 0; i < 2; i++) {
    const read = await apiRequest(
      admin.context,
      'GET',
      `${base(p)}/setup-draft`,
    );
    expect(read.status).toBe(200);
    expect(read.body.draft.input).toEqual(initial.body.draft.input);
  }
  expect(await snapshot(p)).toEqual(before);
  const modern = v2();
  modern.property = legacy.property;
  modern.unit_groups[0].capacity = null;
  modern.unit_groups[0].details = { bedrooms_count: 0 };
  const saved = await apiRequest(
    admin.context,
    'PUT',
    `${base(p)}/setup-draft`,
    {
      body: modern,
      headers: {
        'idempotency-key': key(),
        'if-match': etag(initial.body.draft),
      },
    },
  );
  expect(saved.status).toBe(200);
  expect(saved.body.draft.input).toEqual(modern);
  expect(saved.body.draft.draft_id).toBe(initial.body.draft.draft_id);
  expect(saved.body.draft.revision).toBe(initial.body.draft.revision + 1);
  const after = await snapshot(p);
  delete before.property_setup_draft;
  delete after.property_setup_draft;
  expect(after).toEqual(before);
});

test('P01 independent resource pagination preserves every row with submillisecond timestamp ties', async () => {
  const p = await property();
  // Fixed historical ordering is a pagination fixture, never a production write.
  // API reads still execute with the session role and scoped repository.
  const expected = await withOwner(async (c) => {
    await c.query(
      `insert into resource (id,tenant_id,property_id,code,resource_type,capacity,created_at)
      select gen_random_uuid(),$1,$2,'R08-'||n,'ROOM',2,'2026-01-01T00:00:00.123456Z'::timestamptz
      from generate_series(1,75) n`,
      [tenant, p.id],
    );
    return (
      await c.query(
        'select id from resource where tenant_id=$1 and property_id=$2 order by created_at,id',
        [tenant, p.id],
      )
    ).rows.map((r) => r.id);
  });
  let cursor;
  const seen = [];
  for (let page = 0; page < 5; page++) {
    const r = await apiRequest(
      admin.context,
      'GET',
      `${base(p)}/resources?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(25);
    seen.push(...r.body.items.map((row) => row.id));
    cursor = r.body.next_cursor;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(75);
});
