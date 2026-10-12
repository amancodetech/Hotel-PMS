import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  createOrm,
  setClockForTests,
  previewCompositionChange,
  applyCompositionChange,
  previewSetupMigration,
  applySetupMigration,
} from '../../packages/backend/dist/index.js';
import {
  apiDatabaseUrl,
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let admin, reader, tenant, orm;
const key = () => randomUUID();
const scope = (session = admin) => ({
  tenantId: tenant,
  correlationId: key(),
  actor: {
    kind: 'USER',
    userId: session.session.body.user.id,
    sessionId: session.session.body.session.id,
    displayName: 'Independent synthetic reviewer',
    mfa: session.session.body.session.mfa,
  },
});
const base = (p) => `/tenants/${tenant}/properties/${p.id}`;
const call = (p, method, path, body, headers = {}) =>
  apiRequest(admin.context, method, `${base(p)}${path}`, { body, headers });
const clock = (instant) => setClockForTests(() => new Date(instant));
const tables = [
  'resource',
  'product',
  'composition_version',
  'composition_edge',
  'composition_leaf',
  'commitment',
  'plan_allocation',
  'exposure',
  'exposure_allocation',
  'audit_event',
  'api_idempotency',
];
async function snapshot(p) {
  return withOwner(async (client) => {
    const values = {};
    for (const table of tables)
      values[table] = (
        await client.query(
          `select * from "${table}" t where tenant_id=$1 and property_id=$2 order by to_jsonb(t)::text`,
          [tenant, p.id],
        )
      ).rows;
    values.property = (
      await client.query(
        'select * from property where tenant_id=$1 and id=$2',
        [tenant, p.id],
      )
    ).rows;
    return values;
  });
}
async function fixture(timezone = 'Asia/Makassar') {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `PSR062-${key().slice(0, 8)}`,
        name: 'Independent temporal fixture',
        timezone,
      },
    },
  );
  expect(created.status).toBe(201);
  const p = created.body.property;
  const input = {
    schema_version: 2,
    locations: [],
    unit_groups: [
      {
        group_ref: 'g',
        physical_template: 'HOUSE',
        booking_mode: 'WHOLE_AND_PARTS',
        selection_mode: 'EXACT',
        capacity: 4,
        units: [
          { unit_ref: 'u', code: 'HOUSE', display_label: 'Synthetic house' },
        ],
        parts: [
          { part_ref: 'a', code: 'A', display_label: 'A', capacity: 2 },
          { part_ref: 'b', code: 'B', display_label: 'B', capacity: 2 },
        ],
        privacy_ack: true,
        effective_from: '2032-01-01',
        effective_to: '2032-12-31',
      },
    ],
  };
  const preview = await call(p, 'POST', '/setup-unit-additions/preview', input);
  expect(preview.status).toBe(200);
  expect(preview.body.blockers).toEqual([]);
  const applied = await call(
    p,
    'POST',
    '/setup-unit-additions',
    { input, preview_version: preview.body.preview_version },
    { 'idempotency-key': key(), 'if-match': preview.body.property_etag },
  );
  expect(applied.status).toBe(200);
  const rows = await snapshot(p);
  const composition = rows.composition_version[0];
  expect(composition.status).toBe('ACTIVE');
  return {
    p,
    composition,
    leaves: rows.composition_leaf.map((leaf) => leaf.resource_id),
  };
}
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  reader = await loginAs('auditor-a');
  tenant = admin.session.body.session.active_tenant_id;
  orm = await createOrm(apiDatabaseUrl());
});
afterAll(async () => {
  setClockForTests(null);
  if (orm) await orm.close(true);
  await stopApi();
  await closeBrowser();
});

test.each([
  ['Asia/Jakarta', '2032-02-28T16:59:59Z', '2032-02-28T17:00:00Z'],
  ['Asia/Makassar', '2032-02-28T15:59:59Z', '2032-02-28T16:00:00Z'],
  ['Asia/Jayapura', '2032-02-28T14:59:59Z', '2032-02-28T15:00:00Z'],
])(
  'independent T27: %s service rechecks its local day at apply and preserves leap-day history/replay',
  async (zone, beforeMidnight, afterMidnight) => {
    const { p, composition, leaves } = await fixture(zone);
    const original = await snapshot(p);
    const input = {
      effectiveFrom: '2032-02-28',
      effectiveTo: '2032-12-31',
      resourceIds: leaves,
    };
    try {
      clock(beforeMidnight);
      const preview = await previewCompositionChange(
        orm,
        scope(),
        p.id,
        composition.id,
        input,
      );
      expect(preview.verdict).toBe('SAFE');
      expect(await snapshot(p)).toEqual(original);
      clock(afterMidnight);
      await expect(
        applyCompositionChange(orm, scope(), p.id, composition.id, {
          ...input,
          previewFingerprint: preview.fingerprint,
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        details: { field: 'effective_from' },
      });
      expect(await snapshot(p)).toEqual(original);
      const leap = { ...input, effectiveFrom: '2032-02-29' };
      const fresh = await previewCompositionChange(
        orm,
        scope(),
        p.id,
        composition.id,
        leap,
      );
      expect(fresh.verdict).toBe('SAFE');
      const write = {
        ...leap,
        previewFingerprint: fresh.fingerprint,
        idempotencyKey: key(),
      };
      const result = await applyCompositionChange(
        orm,
        scope(),
        p.id,
        composition.id,
        write,
      );
      expect(result.superseded.effective_to).toBe('2032-02-28');
      expect(result.composition.effective_from).toBe('2032-02-29');
      const stored = await snapshot(p);
      expect(stored.resource).toEqual(original.resource);
      expect(
        stored.composition_leaf.filter(
          (leaf) => leaf.version_id === composition.id,
        ),
      ).toEqual(original.composition_leaf);
      // The old request is now backdated, but an authorized identical replay must
      // still return its stored result without generating another version/audit.
      clock('2032-03-01T12:00:00Z');
      expect(
        await applyCompositionChange(orm, scope(), p.id, composition.id, write),
      ).toEqual({ ...result, replayed: true });
      expect(await snapshot(p)).toEqual(stored);
      await expect(
        applyCompositionChange(orm, scope(reader), p.id, composition.id, write),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(await snapshot(p)).toEqual(stored);
    } finally {
      setClockForTests(null);
    }
  },
);

test('independent T27: migration preview and direct apply reject non-leap centuries and impossible dates without writes', async () => {
  const { p, leaves } = await fixture();
  const product = await call(p, 'POST', '/products', {
    code: 'MIGRATION-TARGET',
    name: 'Independent migration target',
    kind: 'HOUSE',
    occupancy_adults_max: 4,
  });
  expect(product.status).toBe(201);
  const original = await snapshot(p);
  try {
    clock('2032-02-28T16:00:00Z');
    for (const invalid of [
      '2100-02-29',
      '2032-04-31',
      '2032-02-30',
      '0000-01-01',
    ]) {
      const input = {
        productId: product.body.product.id,
        resourceIds: leaves,
        effectiveFrom: invalid,
        effectiveTo: null,
      };
      await expect(
        previewSetupMigration(orm, scope(), p.id, input),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        details: { field: 'effective_from' },
      });
      await expect(
        applySetupMigration(orm, scope(), p.id, {
          ...input,
          previewFingerprint: 'a'.repeat(64),
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        details: { field: 'effective_from' },
      });
    }
    const input = {
      productId: product.body.product.id,
      resourceIds: leaves,
      effectiveFrom: '2032-02-29',
      effectiveTo: '2100-02-29',
    };
    await expect(
      previewSetupMigration(orm, scope(), p.id, input),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      details: { field: 'effective_to' },
    });
    expect(await snapshot(p)).toEqual(original);
  } finally {
    setClockForTests(null);
  }
});

test('independent T16: used HOUSE leaves cannot be collapsed by direct requests and scoped previews stay isolated', async () => {
  const { p } = await fixture();
  const original = await snapshot(p);
  const input = {
    schema_version: 2,
    locations: [],
    unit_groups: [
      {
        group_ref: 'g',
        physical_template: 'HOUSE',
        booking_mode: 'WHOLE_ONLY',
        selection_mode: 'EXACT',
        capacity: 4,
        units: [
          { unit_ref: 'u', code: 'HOUSE', display_label: 'Synthetic house' },
        ],
      },
    ],
  };
  const rejected = await call(
    p,
    'POST',
    '/setup-unit-additions/preview',
    input,
  );
  expect(rejected.status).toBe(422);
  expect(rejected.body.code).toBe('INVENTORY_TRANSFORMATION_REQUIRED');
  const forged = await call(
    p,
    'POST',
    '/setup-unit-additions',
    { input, preview_version: 'a'.repeat(64) },
    {
      'idempotency-key': key(),
      'if-match': `"property:${p.id}:${original.property[0].version}:${original.property[0].inventory_version}"`,
    },
  );
  expect(forged.status).toBe(412);
  expect(forged.body.code).toBe('PREVIEW_STALE');
  expect(await snapshot(p)).toEqual(original);
  const second = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `PSR062-${key().slice(0, 8)}`,
        name: 'Independent empty property',
        timezone: 'Asia/Makassar',
      },
    },
  );
  expect(second.status).toBe(201);
  expect(
    (
      await call(
        second.body.property,
        'POST',
        '/setup-unit-additions/preview',
        input,
      )
    ).status,
  ).toBe(200);
  expect(await snapshot(p)).toEqual(original);
});
