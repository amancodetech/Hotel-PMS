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
async function priced(p, product) {
  const plan = await request(
    p,
    'POST',
    '/rate-plans',
    {
      code: `R-${key().slice(0, 8)}`,
      name: 'PSR07 rate',
      product_id: product.id,
      currency: 'IDR',
    },
    201,
  );
  await request(p, 'PATCH', `/rate-plans/${plan.rate_plan.id}`, {
    version: plan.rate_plan.version,
    status: 'ACTIVE',
  });
  await request(p, 'POST', '/rates/batch', {
    cells: Array.from({ length: 10 }, (_, i) => ({
      rate_plan_id: plan.rate_plan.id,
      date: day(i),
      occupancy: 2,
      money: { amount: '100000', currency: 'IDR' },
    })),
  });
  return plan.rate_plan.id;
}
async function confirm(p, product, from = 0, to = 2) {
  const plan = await priced(p, product);
  const period = { arrival: day(from), departure: day(to) };
  const occupancy = { adults: 2, child_ages: [] };
  const draft = await request(
    p,
    'POST',
    '/reservations/drafts',
    {
      source: 'DIRECT',
      items: [{ product_id: product.id, period, occupancy, quantity: 1 }],
    },
    201,
  );
  const id = draft.reservation.id;
  const detail = await request(p, 'GET', `/reservations/${id}`);
  const quote = await request(
    p,
    'POST',
    '/quotes',
    {
      product_id: product.id,
      rate_plan_id: plan,
      period,
      occupancy,
      quantity: 1,
    },
    201,
  );
  await request(p, 'POST', '/reservations', {
    reservation_id: id,
    inventory_version: await version(p),
    items: [{ item_id: detail.items[0].id, price_snapshot_id: quote.quote.id }],
  });
  return { reservationId: id, itemId: detail.items[0].id };
}
async function itemVersion(p, item) {
  return (
    await request(p, 'GET', `/reservations/${item.reservationId}`)
  ).items.find((r) => r.id === item.itemId).version;
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
async function dispatch(failures = [], now = new Date().toISOString()) {
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
  const part = products.find((r) => r.id !== full?.id);
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

test.each([
  ['VILLA', parts('VILLA', 'WHOLE_AND_PARTS')],
  ['DORM', beds('BEDS_AND_PRIVATE')],
])(
  'PSR-T23 %s whole quota remains exclusive through queued, UNKNOWN and accepted withdrawal with actual local worker replay',
  async (_name, group) => {
    const f = await prepared(group);
    const q = await preview(f, f.full, f.connections[0]);
    expect(q.allowed).toBe(true);
    const published = await publish(f, q);
    const exposureId = published.operation_id;
    const availability = (await rows(f.p, 'distribution_outbox_event')).find(
      (r) =>
        r.aggregate_id === exposureId &&
        r.event_type === 'AvailabilitySnapshot',
    );
    expect(
      availability.payload_safe.cells.map((cell) => cell.available),
    ).toEqual([1, 1]);
    const initial = await rows(f.p, 'exposure_allocation');
    expect(initial.filter((r) => r.exposure_id === exposureId)).toHaveLength(
      f.leaves(f.full).length,
    );
    await protectedQuota(f, f.part);
    const sent = await dispatch();
    expect(sent.acknowledged).toBeGreaterThanOrEqual(2);
    expect((await reconcile(f)).activated).toBe(1);
    await protectedQuota(f, f.part);
    await request(
      f.p,
      'POST',
      `/exposures/${exposureId}/withdraw`,
      { reason: 'PSR-T23 local withdrawal' },
      202,
    );
    expect((await reconcile(f)).released).toBe(0);
    await protectedQuota(f, f.part);
    const unknown = await dispatch([
      { operation: 'pushRestrictions', kind: 'timeout_after_send', times: 100 },
    ]);
    expect(unknown.retried).toBeGreaterThan(0);
    const events = await rows(f.p, 'distribution_outbox_event');
    const stop = events.find(
      (r) =>
        r.aggregate_id === exposureId &&
        r.payload_safe.cells?.some((c) => c.stop_sell === true),
    );
    expect(stop.certainty).toBe('UNKNOWN');
    expect(stop.status).toBe('RETRY_SCHEDULED');
    expect((await reconcile(f)).released).toBe(0);
    expect(await rows(f.p, 'exposure_allocation')).toEqual(initial);
    await protectedQuota(f, f.part);
    const retryAt = new Date(
      Date.parse(stop.next_attempt_at) + 1000,
    ).toISOString();
    expect((await dispatch([], retryAt)).acknowledged).toBeGreaterThan(0);
    // G13-R03 supersedes ACK-only release and handover.
    expect((await reconcile(f)).released).toBe(0);
    const released = await rows(f.p, 'exposure_allocation');
    expect(released.every((r) => r.state === 'RESERVED')).toBe(true);
    expect((await dispatch([], retryAt)).leased).toBe(0);
    expect((await reconcile(f)).released).toBe(0);
    expect(await rows(f.p, 'exposure_allocation')).toEqual(released);
    const handed = await preview(f, f.part, f.connections[1]);
    expect(handed.allowed).toBe(false);
    expect(handed.reason_codes).toContain('EXPOSURE_PROTECTED');
    const competingWhole = await preview(f, f.full, f.connections[0]);
    expect(competingWhole.reason_codes).toContain('EXPOSURE_PROTECTED');
  },
);

test('PSR-T23 CATEGORY BED quota publishes two independent sellable units and preserves quantity-two availability', async () => {
  const f = await prepared(beds('BEDS_ONLY'));
  const product = f.products.find((r) => r.kind === 'BED');
  expect(f.leaves(product)).toHaveLength(2);
  const search = await request(f.p, 'POST', '/availability/search', {
    product_ids: [product.id],
    period: period(),
    occupancy: { adults: 1, child_ages: [] },
    quantity: 2,
  });
  expect(search.offers[0].result).toBe('AVAILABLE');
  const q = await preview(f, product, f.connections[0]);
  expect(q.allowed).toBe(true);
  const published = await publish(f, q);
  const exposure = (await rows(f.p, 'exposure')).find(
    (r) => r.id === published.operation_id,
  );
  expect(exposure.mode).toBe('PARTS');
  expect(
    (await rows(f.p, 'exposure_allocation')).map((r) => r.resource_id).sort(),
  ).toEqual(f.leaves(product).sort());
  const availability = (await rows(f.p, 'distribution_outbox_event')).find(
    (r) =>
      r.aggregate_id === published.operation_id &&
      r.event_type === 'AvailabilitySnapshot',
  );
  expect(availability.payload_safe.cells.map((cell) => cell.available)).toEqual(
    [2, 2],
  );
  await dispatch();
  expect((await reconcile(f)).activated).toBe(1);
  const protectedSearch = await request(f.p, 'POST', '/availability/search', {
    product_ids: [product.id],
    period: period(),
    occupancy: { adults: 1, child_ages: [] },
    quantity: 2,
  });
  expect(protectedSearch.offers[0].result).toBe('UNAVAILABLE');
  expect(protectedSearch.offers[0].reason_codes).toContain(
    'EXPOSURE_PROTECTED',
  );
});

test('PSR-T23 competing whole/part publish race commits one exclusive allocation set and its events atomically', async () => {
  const f = await prepared(parts('VILLA', 'WHOLE_AND_PARTS'));
  const a = await preview(f, f.full, f.connections[0]);
  const b = await preview(f, f.part, f.connections[1]);
  expect(a.allowed && b.allowed).toBe(true);
  const results = await Promise.all(
    [a, b].map((q) =>
      apiRequest(admin.context, 'POST', `${base(f.p)}/exposures`, {
        body: { preview_id: q.preview_id, preview_version: q.preview_version },
      }),
    ),
  );
  const statuses = results.map((r) => r.status).sort();
  expect({
    statuses,
    ...(JSON.stringify(statuses) !== '[202,412]' ? { responses: results } : {}),
  }).toEqual({ statuses: [202, 412] });
  const loser = results.find((r) => r.status === 412);
  expect(loser.body.code).toBe('PREVIEW_STALE');
  const winner = results.find((r) => r.status === 202).body.operation_id;
  const exposures = await rows(f.p, 'exposure');
  expect(exposures).toHaveLength(1);
  expect(exposures[0].id).toBe(winner);
  const allocations = await rows(f.p, 'exposure_allocation');
  expect(
    allocations.every(
      (r) => r.exposure_id === winner && r.state === 'RESERVED',
    ),
  ).toBe(true);
  const expectedProduct = f.products.find(
    (r) => r.id === exposures[0].product_id,
  );
  expect(allocations.map((r) => r.resource_id).sort()).toEqual(
    f.leaves(expectedProduct).sort(),
  );
  const events = (await rows(f.p, 'distribution_outbox_event')).filter(
    (r) => r.aggregate_type === 'Exposure',
  );
  expect(events).toHaveLength(2);
  expect(events.every((r) => r.aggregate_id === winner)).toBe(true);
  expect(events.map((r) => r.event_type).sort()).toEqual([
    'AvailabilitySnapshot',
    'RestrictionSnapshot',
  ]);
});

test('PSR-T23 block/release and direct cancellation on a separate part never release an external part quota', async () => {
  const f = await prepared(parts('VILLA', 'WHOLE_AND_PARTS'));
  const q = await preview(f, f.part, f.connections[0]);
  expect(q.allowed).toBe(true);
  await publish(f, q);
  await dispatch();
  expect((await reconcile(f)).activated).toBe(1);
  const initial = await rows(f.p, 'exposure_allocation');
  const other = f.products.find(
    (r) => r.id !== f.full.id && r.id !== f.part.id,
  );
  const block = await request(
    f.p,
    'POST',
    '/blocks',
    {
      resource_ids: f.leaves(other),
      period: period(),
      mode: 'PLANNED',
      reason: 'PSR-T23 synthetic block',
    },
    201,
  );
  expect((await preview(f, other, f.connections[1])).reason_codes).toContain(
    'BLOCKED',
  );
  await request(f.p, 'POST', `/blocks/${block.block.id}/release`, {
    reason: 'PSR-T23 synthetic release',
  });
  expect(await rows(f.p, 'exposure_allocation')).toEqual(initial);
  await protectedQuota(f, f.full);
  const item = await confirm(f.p, other, 1, 3);
  await request(
    f.p,
    'POST',
    `/reservation-items/${item.itemId}/cancel`,
    {
      version: await itemVersion(f.p, item),
      reason: 'PSR-T23 synthetic cancellation',
    },
    200,
    { 'idempotency-key': key() },
  );
  expect(
    (await rows(f.p, 'commitment')).every((r) => r.state === 'RELEASED'),
  ).toBe(true);
  expect(await rows(f.p, 'exposure_allocation')).toEqual(initial);
  await protectedQuota(f, f.full);
  expect(
    (await rows(f.p, 'reservation_item')).find((r) => r.id === item.itemId)
      .state,
  ).toBe('CANCELLED');
});
