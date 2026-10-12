import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
  workerDatabaseUrl,
} from './support/harness.mjs';
import { createOrm } from '../../packages/backend/dist/persistence/orm.js';
import {
  dispatchDueEvents,
  ProviderRegistry,
  SimulatorAdapter,
  SimulatorEngine,
  simulatorTestProfile,
} from '../../packages/backend/dist/modules/distribution/index.js';
import { addBusinessDays, todayInTimeZone } from './support/business-dates.mjs';
let admin, tenant, orm;
const today = todayInTimeZone('Asia/Jakarta');
const day = (n) => addBusinessDays(today, n);
const key = () => randomUUID();
const base = (p) => `/tenants/${tenant}/properties/${p.id}`;
async function request(p, method, suffix, body, status = 200, headers = {}) {
  const r = await apiRequest(admin.context, method, `${base(p)}${suffix}`, {
    body,
    headers,
  });
  expect({
    status: r.status,
    ...(r.status !== status ? { body: r.body } : {}),
  }).toEqual({ status });
  return r.body;
}
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
async function fixture(group, locations = []) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P7-${key().slice(0, 12)}`,
        name: 'PSR07 synthetic',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  const p = created.body.property;
  if (group.booking_mode === 'CONNECTED_UNITS') {
    group = { ...group, connected_resource_ids: [] };
    for (const code of ['C1', 'C2']) {
      const r = await request(
        p,
        'POST',
        '/resources',
        { code, type: 'ROOM', capacity: 2, display_label: code },
        201,
      );
      group.connected_resource_ids.push(r.resource.id);
    }
  }
  const saved = await request(
    p,
    'PUT',
    '/setup-draft',
    {
      schema_version: 2,
      property: {
        name: 'PSR07 synthetic',
        timezone: 'Asia/Jakarta',
        base_currency: 'IDR',
        types: ['ROOM'],
      },
      locations,
      unit_groups: [group],
      operations: {
        check_in: '14:00',
        check_out: '12:00',
        explicit_states: true,
      },
      pricing: { postponed: true },
    },
    200,
    { 'idempotency-key': key() },
  );
  const preview = await request(p, 'POST', '/setup-draft/preview');
  expect(preview.blockers).toEqual([]);
  await request(
    p,
    'POST',
    '/setup-draft/apply',
    { preview_version: preview.preview_version },
    200,
    {
      'idempotency-key': key(),
      'if-match': `"${saved.draft.draft_id}:${saved.draft.revision}"`,
    },
  );
  return p;
}
const whole = (template) => ({
  group_ref: 'g',
  physical_template: template,
  booking_mode: 'WHOLE_ONLY',
  selection_mode: 'EXACT',
  capacity: 2,
  units: [{ unit_ref: 'u', code: 'U1', display_label: '101' }],
});
const parts = (template, mode) => ({
  ...whole(template),
  booking_mode: mode,
  privacy_ack: true,
  parts: [
    { part_ref: 'a', code: 'A', display_label: '101', capacity: 2 },
    { part_ref: 'b', code: 'B', display_label: '102', capacity: 2 },
  ],
  effective_from: today,
  effective_to: day(30),
});
const beds = (mode) => ({
  ...whole('DORM'),
  selection_mode: 'CATEGORY',
  booking_mode: mode,
  sharing_scope: 'MIXED',
  beds_per_unit: 2,
  effective_from: today,
  effective_to: day(30),
});
async function version(p) {
  return (await request(p, 'GET', `/rates?from=${today}&to=${day(10)}`))
    .inventory_version;
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
  orm = await createOrm(workerDatabaseUrl(), { pool: { min: 0, max: 3 } });
});
afterAll(async () => {
  await orm?.close(true);
  await stopApi();
  await closeBrowser();
});

// API connections use the existing CHANNEX/STAGING contract. Only this test
// registry binds that key to the in-process simulator; no HTTP adapter or live
// provider is used, and synthetic profiles never update persisted capabilities.
async function dispatch(
  failures = [],
  now = new Date().toISOString(),
  maxAttempts = 5,
) {
  const adapter = new SimulatorAdapter({
    engine: new SimulatorEngine({ seed: 'PSR-T23', start_time: now, failures }),
    allowedChannelKeys: ['TIKET_COM', 'BOOKING_COM'],
  });
  adapter.provider_key = 'CHANNEX';
  return dispatchDueEvents({
    orm,
    tenantId: tenant,
    registry: new ProviderRegistry([adapter]),
    profileFor: (context) =>
      simulatorTestProfile(context.channel_key, context.environment),
    owner: 'PSR07-local-simulator',
    limit: 100,
    maxAttempts,
    now: () => now,
  });
}
async function prepared(group) {
  const p = await fixture(group);
  const products = await rows(p, 'product');
  const versions = await rows(p, 'composition_version');
  const compositionLeaves = await rows(p, 'composition_leaf');
  const compositions = compositionLeaves.map((leaf) => ({
    ...leaf,
    product_id: versions.find((v) => v.id === leaf.version_id).product_id,
  }));
  const full = products.find((r) =>
    compositions.some((c) => c.product_id === r.id),
  );
  const part = products.find((r) => r.id !== full.id);
  const candidates = await rows(p, 'product_resource_candidate');
  const leaves = (product) =>
    compositions.some((c) => c.product_id === product.id)
      ? compositions
          .filter((c) => c.product_id === product.id)
          .map((c) => c.resource_id)
      : candidates
          .filter((c) => c.product_id === product.id)
          .map((c) => c.resource_id);
  const connections = [];
  for (const channel_key of ['TIKET_COM', 'BOOKING_COM']) {
    const connection = (
      await request(
        p,
        'POST',
        '/connections',
        {
          provider_key: 'CHANNEX',
          environment: 'STAGING',
          channel_key,
          external_property_id: `PSR-T23-${key()}`,
          secret_ref: 'local:hotel/psr07-quota',
        },
        201,
      )
    ).connection.id;
    connections.push(connection);
    for (const product of products) {
      // BED has one guest; map and price all products at their valid occupancy.
      const occupancy = product.kind === 'BED' ? 1 : 2;
      const plan = (
        await request(
          p,
          'POST',
          '/rate-plans',
          {
            code: `R-${key().slice(0, 8)}`,
            name: 'PSR-T23 synthetic',
            product_id: product.id,
            currency: 'IDR',
          },
          201,
        )
      ).rate_plan;
      await request(p, 'PATCH', `/rate-plans/${plan.id}`, {
        version: plan.version,
        status: 'ACTIVE',
      });
      await request(p, 'POST', '/rates/batch', {
        cells: [1, 2].map((n) => ({
          rate_plan_id: plan.id,
          date: day(n),
          occupancy,
          money: { amount: '100000', currency: 'IDR' },
        })),
      });
      await request(p, 'PUT', `/connections/${connection}/mapping`, {
        channel_key,
        external_room_ref: `ROOM-${product.id}`,
        external_rate_ref: `RATE-${plan.id}`,
        occupancy,
        internal_product_ref: product.id,
        internal_rate_ref: plan.id,
      });
    }
  }
  return { p, full, part, products, leaves, connections };
}
const period = () => ({ arrival: day(1), departure: day(3) });
async function preview(f, product, connection) {
  return request(f.p, 'POST', '/exposures/preview', {
    connection_id: connection,
    product_id: product.id,
    period: period(),
    resource_ids: f.leaves(product),
    inventory_version: await version(f.p),
  });
}
async function publish(f, q) {
  return request(
    f.p,
    'POST',
    '/exposures',
    {
      preview_id: q.preview_id,
      preview_version: q.preview_version,
    },
    202,
  );
}
async function reconcile(f) {
  return request(f.p, 'POST', `/connections/${f.connections[0]}/reconcile`, {
    reason: 'PSR-T23 synthetic local evidence',
  });
}
async function protectedQuota(f, product) {
  const q = await preview(f, product, f.connections[1]);
  expect(q.allowed).toBe(false);
  expect(q.reason_codes).toContain('EXPOSURE_PROTECTED');
  const rejected = await apiRequest(
    admin.context,
    'POST',
    `${base(f.p)}/exposures`,
    {
      body: { preview_id: q.preview_id, preview_version: q.preview_version },
    },
  );
  expect({
    status: rejected.status,
    ...(rejected.status !== 422 ? { body: rejected.body } : {}),
  }).toEqual({ status: 422 });
  expect(rejected.body.code).toBe('PREVIEW_NOT_ALLOWED');
  const occupancy = { adults: product.kind === 'BED' ? 1 : 2, child_ages: [] };
  const search = await request(f.p, 'POST', '/availability/search', {
    product_ids: [product.id],
    period: period(),
    occupancy,
    quantity: 1,
  });
  expect(search.offers[0].result).toBe('UNAVAILABLE');
  expect(search.offers[0].reason_codes).toContain('EXPOSURE_PROTECTED');
}

// Independent T23 assertions. Fixtures use API v2; SQL is read-only.
test.each([
  ['VILLA', parts('VILLA', 'WHOLE_AND_PARTS')],
  ['DORM', beds('BEDS_AND_PRIVATE')],
])(
  'independent T23 %s whole exposure publishes one sellable unit, not its leaf count',
  async (_name, group) => {
    const f = await prepared(group);
    expect(f.leaves(f.full)).toHaveLength(2);
    const published = await publish(
      f,
      await preview(f, f.full, f.connections[0]),
    );
    const events = await rows(f.p, 'distribution_outbox_event');
    const availability = events.find(
      (r) =>
        r.aggregate_id === published.operation_id &&
        r.event_type === 'AvailabilitySnapshot',
    );
    expect(
      availability.payload_safe.cells.map((c) => ({
        date: c.date,
        available: c.available,
      })),
    ).toEqual([
      { date: day(1), available: 1 },
      { date: day(2), available: 1 },
    ]);
  },
);

test('independent T23 exhausted UNKNOWN publication never activates or releases the whole allocation', async () => {
  const f = await prepared(parts('VILLA', 'WHOLE_AND_PARTS'));
  const pub = await publish(f, await preview(f, f.full, f.connections[0]));
  const initial = await rows(f.p, 'exposure_allocation');
  await dispatch(
    [{ operation: 'pushAvailability', kind: 'timeout_after_send', times: 100 }],
    new Date().toISOString(),
    1,
  );
  const events = (await rows(f.p, 'distribution_outbox_event')).filter(
    (r) => r.aggregate_id === pub.operation_id,
  );
  expect(
    events.find((r) => r.event_type === 'AvailabilitySnapshot'),
  ).toMatchObject({ status: 'DEAD_LETTER', certainty: 'UNKNOWN' });
  expect(await reconcile(f)).toMatchObject({ activated: 0, released: 0 });
  expect(
    (await rows(f.p, 'exposure')).find((r) => r.id === pub.operation_id).state,
  ).toBe('UNKNOWN');
  await protectedQuota(f, f.part);
  expect(await rows(f.p, 'exposure_allocation')).toEqual(initial);
  expect(await reconcile(f)).toMatchObject({ activated: 0, released: 0 });
});

test('independent T23 rejected and provider-accepted withdrawals both remain protected without cutoff proof', async () => {
  const f = await prepared(parts('VILLA', 'WHOLE_AND_PARTS'));
  const other = f.products.find(
    (r) => r.id !== f.full.id && r.id !== f.part.id,
  );
  const a = await publish(f, await preview(f, f.part, f.connections[0]));
  const b = await publish(f, await preview(f, other, f.connections[0]));
  await dispatch();
  expect((await reconcile(f)).activated).toBe(2);
  const initial = (await rows(f.p, 'exposure_allocation')).filter(
    (r) => r.exposure_id === a.operation_id,
  );
  await request(
    f.p,
    'POST',
    `/exposures/${a.operation_id}/withdraw`,
    { reason: 'Independent rejected stop' },
    202,
  );
  await dispatch([
    { operation: 'pushRestrictions', kind: 'validation_rejected', times: 100 },
  ]);
  expect(await reconcile(f)).toMatchObject({ released: 0, reconciling: 1 });
  await request(
    f.p,
    'POST',
    `/exposures/${b.operation_id}/withdraw`,
    { reason: 'Independent accepted stop' },
    202,
  );
  await dispatch();
  expect(await reconcile(f)).toMatchObject({ released: 0, reconciling: 2 });
  const allocations = await rows(f.p, 'exposure_allocation');
  expect(
    allocations.filter((r) => r.exposure_id === b.operation_id),
  ).toHaveLength(1);
  expect(allocations.filter((r) => r.exposure_id === a.operation_id)).toEqual(
    initial,
  );
  expect(
    allocations
      .filter((r) => r.exposure_id === b.operation_id)
      .every((r) => r.state === 'RESERVED'),
  ).toBe(true);
  await protectedQuota(f, f.full);
  await protectedQuota(f, other);
  expect(await reconcile(f)).toMatchObject({ released: 0, reconciling: 2 });
});
