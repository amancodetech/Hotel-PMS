import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';
import { addBusinessDays, todayInTimeZone } from './support/business-dates.mjs';
let admin, tenant, membershipId;
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
async function command(p, item, suffix, extra = {}) {
  return request(
    p,
    'POST',
    `/reservations/${item.reservationId}/items/${item.itemId}/${suffix}`,
    { version: await itemVersion(p, item), ...extra },
    200,
    { 'idempotency-key': key() },
  );
}
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
  membershipId = await withOwner(
    async (c) =>
      (
        await c.query(
          'select id from membership where tenant_id=$1 and user_id=$2',
          [tenant, admin.session.body.user.id],
        )
      ).rows[0]?.id,
  );
});
afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

const matrix = [
  ...[
    'ROOM',
    'VILLA',
    'APARTMENT',
    'HOUSE',
    'CABIN',
    'TENT',
    'SITE',
    'SUITE_STANDALONE',
  ].map((t) => [`${t}/WHOLE_ONLY`, whole(t)]),
  ['VILLA/PARTS_ONLY', parts('VILLA', 'PARTS_ONLY')],
  ['VILLA/WHOLE_AND_PARTS', parts('VILLA', 'WHOLE_AND_PARTS')],
  ['APARTMENT/WHOLE_AND_PARTS', parts('APARTMENT', 'WHOLE_AND_PARTS')],
  ['HOUSE/WHOLE_AND_PARTS', parts('HOUSE', 'WHOLE_AND_PARTS')],
  ['DORM/BEDS_ONLY', beds('BEDS_ONLY')],
  ['DORM/BEDS_AND_PRIVATE', beds('BEDS_AND_PRIVATE')],
  [
    'SUITE_CONNECTED/CONNECTED_UNITS',
    {
      group_ref: 'g',
      physical_template: 'SUITE_CONNECTED',
      booking_mode: 'CONNECTED_UNITS',
      selection_mode: 'EXACT',
      connection_ack: true,
      capacity: 4,
      effective_from: today,
      effective_to: day(30),
    },
  ],
];
test.each(matrix)(
  'PSR07.1 %s: generated inventory through booking, allocation, entry, report, checkout and housekeeping',
  async (name, group) => {
    let p = await fixture(group);
    const products = await rows(p, 'product');
    // Each generated sale product is exercised in its own isolated property.
    for (let index = 0; index < products.length; index += 1) {
      if (index > 0) p = await fixture(group);
      const product = (await rows(p, 'product')).sort((a, b) =>
        a.code.localeCompare(b.code),
      )[index];
      const resources = await rows(p, 'resource');
      const bedSale = product.kind === 'BED';
      const adults = bedSale ? 1 : 2;
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
        cells: [0, 1].map((n) => ({
          rate_plan_id: plan.rate_plan.id,
          date: day(n),
          occupancy: adults,
          money: { amount: '100000', currency: 'IDR' },
        })),
      });
      const period = { arrival: today, departure: day(2) },
        occupancy = { adults, child_ages: [] };
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
      const reservationId = draft.reservation.id;
      const detail = await request(p, 'GET', `/reservations/${reservationId}`);
      const item = { reservationId, itemId: detail.items[0].id };
      const quote = await request(
        p,
        'POST',
        '/quotes',
        {
          product_id: product.id,
          rate_plan_id: plan.rate_plan.id,
          period,
          occupancy,
          quantity: 1,
        },
        201,
      );
      await request(p, 'POST', '/reservations', {
        reservation_id: reservationId,
        inventory_version: await version(p),
        items: [{ item_id: item.itemId, price_snapshot_id: quote.quote.id }],
      });
      const arrival = (
        await request(p, 'GET', `/front-desk/board?date=${today}`)
      ).arrivals.find((r) => r.item_id === item.itemId);
      expect(arrival.product_kind).toBe(product.kind);
      expect(arrival.allocated_rooms.length).toBeGreaterThan(0);
      expect(arrival.group_assignment).toBe(arrival.allocated_rooms.length > 1);
      for (const leaf of arrival.allocated_rooms)
        expect(
          resources.some((r) => r.parent_resource_id === leaf.resource_id),
        ).toBe(false);
      if (!arrival.group_assignment)
        await command(p, item, 'assignments', {
          resource_id: arrival.allocated_rooms[0].resource_id,
        });
      const ci = await command(p, item, 'check-in');
      expect(ci.assignments).toHaveLength(arrival.allocated_rooms.length);
      const rack = await request(p, 'GET', `/front-desk/board?date=${today}`);
      expect(
        rack.inHouse.find((r) => r.item_id === item.itemId).rooms,
      ).toHaveLength(arrival.allocated_rooms.length);
      const report = await request(p, 'POST', '/reports/query', {
        kind: 'OCCUPANCY',
        period: { date_from: today, date_to: day(2) },
      });
      const display = report.metrics.find(
        (r) => r.key === `display_nights.${product.kind}`,
      );
      expect(display.value).toBe('2');
      const expectedByType = new Map();
      for (const leaf of arrival.allocated_rooms)
        expectedByType.set(
          leaf.resource_type,
          (expectedByType.get(leaf.resource_type) ?? 0) + 2,
        );
      for (const [type, count] of expectedByType)
        expect(
          report.metrics.find(
            (r) => r.key === `resource_nights_reserved.${type}`,
          ).value,
        ).toBe(String(count));
      await command(p, item, 'check-out');
      const tasks = (await request(p, 'GET', '/operations/board')).tasks.filter(
        (t) => t.item_id === item.itemId,
      );
      expect(tasks).toHaveLength(arrival.allocated_rooms.length);
      for (const task of tasks) {
        expect(task.source_event_type).toBe('STAY_CHECKED_OUT');
        const current = (await rows(p, 'resource')).find(
          (r) => r.id === task.resource_id,
        );
        expect(current.housekeeping_state).toBe('DIRTY');
        // Restore readiness via the established task API, so subsequent whole/part
        // products exercise the same leaves without owner changes or data deletion.
        let state = await request(
          p,
          'POST',
          `/tasks/${task.id}/assign`,
          { membership_id: membershipId, version: task.version },
          200,
          { 'idempotency-key': key() },
        );
        state = await request(
          p,
          'POST',
          `/tasks/${task.id}/start`,
          { version: state.task.version },
          200,
          { 'idempotency-key': key() },
        );
        state = await request(
          p,
          'POST',
          `/tasks/${task.id}/complete`,
          { version: state.task.version },
          200,
          { 'idempotency-key': key() },
        );
        expect(state.task.status).toBe('CLEAN');
      }
    }
  },
);

test('PSR-T24 repeated 101 labels retain scoped location paths and exact assignment identity', async () => {
  const p = await fixture(
    {
      ...whole('ROOM'),
      selection_mode: 'CATEGORY',
      units: [
        { unit_ref: 'a', code: 'A101', display_label: '101' },
        { unit_ref: 'b', code: 'B101', display_label: '101' },
      ],
    },
    [
      {
        client_ref: 'a',
        code: 'A',
        name: 'Building A',
        kind: 'BUILDING',
        display_order: 0,
      },
      {
        client_ref: 'b',
        code: 'B',
        name: 'Building B',
        kind: 'BUILDING',
        display_order: 1,
      },
    ],
  );
  const locations = await rows(p, 'location'),
    resources = await rows(p, 'resource');
  for (const [code, loc] of [
    ['A101', 'A'],
    ['B101', 'B'],
  ]) {
    const r = resources.find((r) => r.code === code);
    await request(p, 'PATCH', `/resources/${r.id}`, {
      version: r.version,
      location_id: locations.find((l) => l.code === loc).id,
    });
  }
  const duplicate = await apiRequest(
    admin.context,
    'POST',
    `${base(p)}/resources`,
    { body: { code: 'A101', display_label: '101', type: 'ROOM', capacity: 2 } },
  );
  expect(duplicate.status).toBe(409);
  const product = (await rows(p, 'product'))[0],
    item = await confirm(p, product);
  const rack = await request(p, 'GET', `/front-desk/board?date=${today}`);
  const arrival = rack.arrivals.find((r) => r.item_id === item.itemId);
  expect(arrival.candidates).toHaveLength(2);
  for (const candidate of arrival.candidates) {
    expect(candidate.display_label).toBe('101');
    expect(candidate.location_path).toEqual([
      candidate.code === 'A101' ? 'Building A' : 'Building B',
    ]);
  }
  const selected = resources.find((r) => r.code === 'B101');
  await command(p, item, 'assignments', { resource_id: selected.id });
  await command(p, item, 'check-in');
  expect(
    (await request(p, 'GET', `/front-desk/board?date=${today}`)).inHouse.find(
      (r) => r.item_id === item.itemId,
    ).room.location_path,
  ).toEqual(['Building B']);
  await command(p, item, 'check-out');
  const task = (await request(p, 'GET', '/operations/board')).tasks.find(
    (t) => t.item_id === item.itemId,
  );
  expect(task.resource_id).toBe(selected.id);
  expect(task.resource_display_label).toBe('101');
  expect(task.resource_location_path).toEqual(['Building B']);
  const listed = (await request(p, 'GET', '/tasks')).tasks.find(
    (t) => t.id === task.id,
  );
  expect(listed.resource_location_path).toEqual(['Building B']);
});

test('PSR-T24 bed location is inherited through its container without inventing another resource', async () => {
  const p = await fixture({ ...beds('BEDS_ONLY'), location_ref: 'f' }, [
    {
      client_ref: 'b',
      code: 'B',
      name: 'Building',
      kind: 'BUILDING',
      display_order: 0,
    },
    {
      client_ref: 'f',
      parent_ref: 'b',
      code: 'F',
      name: 'Floor 1',
      kind: 'FLOOR',
      display_order: 0,
    },
  ]);
  const before = await rows(p, 'resource');
  const rack = await request(p, 'GET', `/front-desk/board?date=${today}`);
  expect(rack.rooms).toHaveLength(2);
  for (const bed of rack.rooms) {
    expect(bed.location_path).toEqual(['Building', 'Floor 1']);
    expect(bed.parent_display_label).toBe('101');
  }
  expect(await rows(p, 'resource')).toHaveLength(before.length);
});

test('PSR-T22 category nights cannot silently split across two different rooms', async () => {
  const p = await fixture({
    ...whole('ROOM'),
    selection_mode: 'CATEGORY',
    units: [
      { unit_ref: 'a', code: 'R1', display_label: '101' },
      { unit_ref: 'b', code: 'R2', display_label: '102' },
    ],
  });
  const resources = await rows(p, 'resource'),
    product = (await rows(p, 'product'))[0];
  const plan = await priced(p, product);
  const period = { arrival: today, departure: day(2) },
    occupancy = { adults: 2, child_ages: [] };
  // Quote while a continuous room exists; confirmation must revalidate after blocks.
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
  for (const [r, from, to] of [
    [resources[0], 1, 2],
    [resources[1], 0, 1],
  ])
    await request(
      p,
      'POST',
      '/blocks',
      {
        resource_ids: [r.id],
        period: { arrival: day(from), departure: day(to) },
        mode: 'PLANNED',
        reason: 'PSR-T22 synthetic alternate night',
      },
      201,
    );
  const search = async (from, to) =>
    request(p, 'POST', '/availability/search', {
      product_ids: [product.id],
      period: { arrival: day(from), departure: day(to) },
      occupancy: { adults: 2, child_ages: [] },
      quantity: 1,
    });
  expect((await search(0, 1)).offers[0].result).toBe('AVAILABLE');
  expect((await search(1, 2)).offers[0].result).toBe('AVAILABLE');
  expect((await search(0, 2)).offers[0].result).toBe('UNAVAILABLE');
  const hold = await apiRequest(admin.context, 'POST', `${base(p)}/holds`, {
    body: {
      items: [
        {
          product_id: product.id,
          period: { arrival: today, departure: day(2) },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        },
      ],
      ttl_seconds: 300,
      inventory_version: await version(p),
    },
  });
  expect(hold.status).toBe(409);
  expect(hold.body.code).toBe('RESOURCE_UNAVAILABLE');
  expect(await rows(p, 'commitment')).toHaveLength(0);
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
  const detail = await request(
    p,
    'GET',
    `/reservations/${draft.reservation.id}`,
  );
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base(p)}/reservations`,
    {
      body: {
        reservation_id: draft.reservation.id,
        inventory_version: await version(p),
        items: [
          { item_id: detail.items[0].id, price_snapshot_id: quote.quote.id },
        ],
      },
    },
  );
  expect(confirmed.status).toBe(409);
  expect(confirmed.body.code).toBe('RESOURCE_UNAVAILABLE');
  expect(await rows(p, 'commitment')).toHaveLength(0);
  expect(await rows(p, 'room_assignment')).toHaveLength(0);
  expect(await rows(p, 'stay_segment')).toHaveLength(1);
});
test('PSR-T08 PSRv2 restricted bed rejects direct and local OTA reservation input without declared guests and writes no commitments', async () => {
  const p = await fixture(beds('BEDS_ONLY'));
  const product = (await rows(p, 'product'))[0];
  // PSRv2 creates MIXED only. Exercise an existing restricted policy explicitly,
  // using the same synthetic legacy fixture technique as set07-sharing.
  await withOwner((c) =>
    c.query('update product set sharing_scope=$2 where id=$1', [
      product.id,
      'FEMALE',
    ]),
  );
  const connection = await request(
    p,
    'POST',
    '/connections',
    {
      provider_key: 'CHANNEX',
      environment: 'STAGING',
      channel_key: 'BOOKING_COM',
      external_property_id: `psr07-${key()}`,
      secret_ref: 'local:hotel/psr07',
    },
    201,
  );
  for (const source of ['DIRECT', 'OTA']) {
    const rejected = await apiRequest(
      admin.context,
      'POST',
      `${base(p)}/reservations/drafts`,
      {
        body: {
          source,
          ...(source === 'OTA'
            ? {
                channel_connection_id: connection.connection.id,
                external_booking_key: key(),
              }
            : {}),
          items: [
            {
              product_id: product.id,
              period: { arrival: today, departure: day(2) },
              occupancy: { adults: 1, child_ages: [] },
              quantity: 1,
            },
          ],
        },
      },
    );
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('GUEST_GENDER_REQUIRED');
    expect(await rows(p, 'reservation')).toHaveLength(0);
    expect(await rows(p, 'reservation_item')).toHaveLength(0);
    expect(await rows(p, 'commitment')).toHaveLength(0);
    expect(await rows(p, 'plan_allocation')).toHaveLength(0);
  }
});
test('PSR-T08 actual local channel revision consumer rejects restricted-policy replanning and preserves the original commitment', async () => {
  const p = await fixture(whole('ROOM'));
  const product = (await rows(p, 'product'))[0];
  const item = await confirm(p, product);
  const connection = await request(
    p,
    'POST',
    '/connections',
    {
      provider_key: 'CHANNEX',
      environment: 'STAGING',
      channel_key: 'BOOKING_COM',
      external_property_id: `psr07-channel-${key()}`,
      secret_ref: 'local:hotel/psr07',
    },
    201,
  );
  const external = key(),
    revision = key();
  await withOwner(async (c) => {
    // Represent a previously accepted channel promise before a restricted sharing
    // policy is enabled. The current PSRv2 editor creates MIXED policy only.
    await c.query('update product set sharing_scope=$2 where id=$1', [
      product.id,
      'FEMALE',
    ]);
    await c.query(
      "update reservation set source='OTA',channel_connection_id=$2,external_booking_key=$3 where id=$1",
      [item.reservationId, connection.connection.id, external],
    );
    await c.query(
      `insert into distribution_inbox_revision(id,tenant_id,property_id,connection_id,channel_key,provider_key,environment,provider_revision_id,external_booking_id,revision_type,payload_hash,payload_safe,source_sequence,received_at)
      values($1,$2,$3,$4,'BOOKING_COM','CHANNEX','STAGING',$5,$6,'modified',$7,$8::jsonb,'1',now())`,
      [
        revision,
        tenant,
        p.id,
        connection.connection.id,
        `R-${revision}`,
        external,
        'a'.repeat(64),
        JSON.stringify({
          items: [{ arrival: today, departure: day(3), occupancy: 2 }],
        }),
      ],
    );
  });
  const protectedTables = [
    'reservation',
    'reservation_item',
    'stay_segment',
    'commitment',
    'plan_allocation',
    'room_assignment',
  ];
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        protectedTables.map(async (t) => [
          t,
          (await rows(p, t)).sort((a, b) => a.id.localeCompare(b.id)),
        ]),
      ),
    );
  const before = await snapshot();
  const result = await request(p, 'POST', `/inbox/${revision}/reprocess`);
  expect(result.outcome).toBe('EXCEPTION');
  expect(result.error_code).toBe('EXTERNAL_CONFLICT');
  expect(await snapshot()).toEqual(before);
  const stored = (await rows(p, 'distribution_inbox_revision')).find(
    (r) => r.id === revision,
  );
  expect(stored.processing_state).toBe('EXCEPTION');
  expect(stored.applied_at).toBeNull();
  // A durable exception is permitted; no external event is silently dropped.
  const exceptions = await rows(p, 'distribution_exception_case');
  expect(
    exceptions.some(
      (r) => r.inbox_revision_id === revision && r.state === 'OPEN',
    ),
  ).toBe(true);
});
