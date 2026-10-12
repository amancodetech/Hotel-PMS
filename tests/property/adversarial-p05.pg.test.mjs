import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
  withRuntimeRole,
} from './support/harness.mjs';

const tenantB = process.env.IDENTITY_TENANT_B;
let tenantA;
let admin;
let owner;
let member;
let auditor;
let property;
let propertyB;
let roomOne;
let roomTwo;
let roomThree;
let productOne;
let ratePlanId;
let connectionId;

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function base() {
  return `/tenants/${tenantA}/properties/${property.id}`;
}

async function search(productIds, arrival, departure, quantity = 1) {
  return apiRequest(admin.context, 'POST', `${base()}/availability/search`, {
    body: {
      product_ids: productIds,
      period: { arrival, departure },
      occupancy: { adults: 2, child_ages: [] },
      quantity,
    },
  });
}

async function inventoryVersion() {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=${addDays(1)}&to=${addDays(2)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function setRates(cells) {
  return apiRequest(admin.context, 'POST', `${base()}/rates/batch`, {
    body: { cells },
  });
}

async function holdRequest(input) {
  return apiRequest(admin.context, 'POST', `${base()}/holds`, { body: input });
}

async function createHold(arrival, departure, quantity = 1, ttl = 300) {
  return holdRequest({
    items: [
      {
        product_id: productOne,
        period: { arrival, departure },
        occupancy: { adults: 2, child_ages: [] },
        quantity,
      },
    ],
    inventory_version: await inventoryVersion(),
    ttl_seconds: ttl,
  });
}

async function preview(input) {
  return apiRequest(admin.context, 'POST', `${base()}/exposures/preview`, {
    body: input,
  });
}

async function publish(previewId, previewVersion) {
  return apiRequest(admin.context, 'POST', `${base()}/exposures`, {
    body: { preview_id: previewId, preview_version: previewVersion },
  });
}

async function setExposureEvents(status) {
  await withOwner(async (client) => {
    await client.query(
      `update "distribution_outbox_event"
          set "status" = $1, "provider_request_id" = 'adv5-' || "id"::text,
              "certainty" = 'ACCEPTED', "updated_at" = now()
        where "connection_id" = $2 and "aggregate_type" = 'Exposure'`,
      [status, connectionId],
    );
  });
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  owner = await loginAs('owner-a');
  member = await loginAs('member-a');
  auditor = await loginAs('auditor-a');
  tenantA = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: { code: 'ADV5', name: 'Adversarial P05', timezone: 'Asia/Jakarta' },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  const resources = [];
  for (const code of ['ADV5-R1', 'ADV5-R2', 'ADV5-R3']) {
    const resource = await apiRequest(
      admin.context,
      'POST',
      `${base()}/resources`,
      { body: { code, type: 'ROOM', capacity: 2 } },
    );
    expect(resource.status).toBe(201);
    resources.push(resource.body.resource.id);
  }
  [roomOne, roomTwo, roomThree] = resources;
  let product = await apiRequest(admin.context, 'POST', `${base()}/products`, {
    body: {
      code: 'ADV5-P1',
      name: 'Adversarial product',
      kind: 'ROOM',
      occupancy_adults_max: 2,
    },
  });
  expect(product.status).toBe(201);
  for (const resource of resources) {
    const candidate = await apiRequest(
      admin.context,
      'POST',
      `${base()}/products/${product.body.product.id}/candidates`,
      { body: { resource_id: resource } },
    );
    expect(candidate.status).toBe(201);
  }
  product = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/products/${product.body.product.id}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(product.status).toBe(200);
  productOne = product.body.product.id;
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: {
      code: 'ADV5-RATE',
      name: 'Adversarial rate',
      product_id: productOne,
      currency: 'IDR',
    },
  });
  expect(plan.status).toBe(201);
  ratePlanId = plan.body.rate_plan.id;
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/rate-plans/${ratePlanId}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  const cells = [];
  for (let offset = 1; offset <= 175; offset += 1)
    cells.push({
      rate_plan_id: ratePlanId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '250000', currency: 'IDR' },
    });
  for (let index = 0; index < cells.length; index += 30) {
    const rates = await setRates(cells.slice(index, index + 30));
    expect(rates.status).toBe(200);
  }
  const connection = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections`,
    {
      body: {
        provider_key: 'CHANNEX',
        environment: 'STAGING',
        channel_key: 'BOOKING_COM',
        external_property_id: 'ext-adv5',
        secret_ref: 'local:hotel/adv5',
      },
    },
  );
  expect(connection.status).toBe(201);
  connectionId = connection.body.connection.id;
  const mapping = await apiRequest(
    admin.context,
    'PUT',
    `${base()}/connections/${connectionId}/mapping`,
    {
      body: {
        channel_key: 'BOOKING_COM',
        external_room_ref: 'ext-adv5-room',
        external_rate_ref: 'ext-adv5-rate',
        occupancy: 2,
        internal_product_ref: productOne,
        internal_rate_ref: ratePlanId,
      },
    },
  );
  expect(mapping.status).toBe(200);
  propertyB = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'ADV5-TB', 'Adversarial tenant B', 'Asia/Jakarta')
       on conflict do nothing`,
      [propertyB, tenantB],
    );
  });
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('ADV5-01 prices: zero policy, negative, currency and malformed amounts fail closed', async () => {
  const zero = await setRates([
    {
      rate_plan_id: ratePlanId,
      date: addDays(5),
      occupancy: 2,
      money: { amount: '0', currency: 'IDR' },
    },
  ]);
  expect(zero.status).toBe(422);
  expect(zero.body.code).toBe('ZERO_PRICE_POLICY');

  const negative = await setRates([
    {
      rate_plan_id: ratePlanId,
      date: addDays(5),
      occupancy: 2,
      money: { amount: '-1', currency: 'IDR' },
    },
  ]);
  expect([400, 422]).toContain(negative.status);

  const currency = await setRates([
    {
      rate_plan_id: ratePlanId,
      date: addDays(5),
      occupancy: 2,
      money: { amount: '100', currency: 'USD' },
    },
  ]);
  expect(currency.status).toBe(400);
  expect(currency.body.code).toBe('INVALID_REQUEST');

  for (const amount of ['NaN', 'Infinity', '1.1234567', '']) {
    const malformed = await setRates([
      {
        rate_plan_id: ratePlanId,
        date: addDays(5),
        occupancy: 2,
        money: { amount, currency: 'IDR' },
      },
    ]);
    expect([400, 422]).toContain(malformed.status);
  }

  const state = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=${addDays(5)}&to=${addDays(6)}`,
  );
  expect(state.body.prices?.[0]?.money?.amount ?? '250000').toBe('250000');
});

test('ADV5-02 date abuse: reversed and empty ranges fail without touching inventory', async () => {
  const before = await inventoryVersion();
  const reversedCalendar = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=${addDays(10)}&to=${addDays(9)}`,
  );
  expect(reversedCalendar.status).toBe(400);
  const emptyCalendar = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=${addDays(10)}&to=${addDays(10)}`,
  );
  expect(emptyCalendar.status).toBe(400);
  const reversedSearch = await search([productOne], addDays(10), addDays(9));
  expect([400, 422]).toContain(reversedSearch.status);
  const emptySearch = await search([productOne], addDays(10), addDays(10));
  expect([400, 422]).toContain(emptySearch.status);
  const badQuery = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=%27%20or%20%271%27%3D%271&to=${addDays(12)}`,
  );
  expect([400, 422]).toContain(badQuery.status);
  const after = await inventoryVersion();
  expect(after).toBe(before);
});

test('ADV5-03 quote snapshot is immutable when prices change later', async () => {
  const quote = await apiRequest(admin.context, 'POST', `${base()}/quotes`, {
    body: {
      product_id: productOne,
      period: { arrival: addDays(61), departure: addDays(63) },
      occupancy: { adults: 2, child_ages: [] },
      quantity: 1,
    },
  });
  expect(quote.status).toBe(201);
  expect(quote.body.quote.total_money.amount).toBe('500000');
  const changed = await setRates([
    {
      rate_plan_id: ratePlanId,
      date: addDays(61),
      occupancy: 2,
      money: { amount: '999999', currency: 'IDR' },
    },
    {
      rate_plan_id: ratePlanId,
      date: addDays(62),
      occupancy: 2,
      money: { amount: '999999', currency: 'IDR' },
    },
  ]);
  expect(changed.status).toBe(200);
  const stored = await withOwner(async (client) => {
    const result = await client.query(
      'select "total_amount" from "price_quote" where "id" = $1',
      [quote.body.quote.id],
    );
    return result.rows[0].total_amount;
  });
  expect(stored).toMatch(/^500000/);
  const fresh = await apiRequest(admin.context, 'POST', `${base()}/quotes`, {
    body: {
      product_id: productOne,
      period: { arrival: addDays(61), departure: addDays(63) },
      occupancy: { adults: 2, child_ages: [] },
      quantity: 1,
    },
  });
  expect(fresh.body.quote.total_money.amount).toBe('1999998');
});

test('ADV5-04 stale inventory version is rejected with 412 and no allocation', async () => {
  const stale = await inventoryVersion();
  const changed = await setRates([
    {
      rate_plan_id: ratePlanId,
      date: addDays(64),
      occupancy: 2,
      money: { amount: '260000', currency: 'IDR' },
    },
  ]);
  expect(changed.status).toBe(200);
  const response = await holdRequest({
    items: [
      {
        product_id: productOne,
        period: { arrival: addDays(64), departure: addDays(65) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    ],
    inventory_version: stale,
    ttl_seconds: 300,
  });
  expect(response.status).toBe(412);
  expect(response.body.code).toBe('STALE_VERSION');
  const allocations = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "plan_allocation"
        where "tenant_id" = $1 and "property_id" = $2
          and "start_date" = $3 and "state" = 'ACTIVE'`,
      [tenantA, property.id, addDays(64)],
    );
    return result.rows[0].count;
  });
  expect(allocations).toBe(0);
});

test('ADV5-05 hold validation: bad items, foreign product and duplicate lines rejected', async () => {
  const version = await inventoryVersion();
  const reversed = await holdRequest({
    items: [
      {
        product_id: productOne,
        period: { arrival: addDays(66), departure: addDays(65) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    ],
    inventory_version: version,
    ttl_seconds: 300,
  });
  expect([400, 422]).toContain(reversed.status);
  const duplicate = await holdRequest({
    items: [
      {
        product_id: productOne,
        period: { arrival: addDays(66), departure: addDays(67) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
      {
        product_id: productOne,
        period: { arrival: addDays(66), departure: addDays(67) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    ],
    inventory_version: version,
    ttl_seconds: 300,
  });
  expect([400, 409, 422]).toContain(duplicate.status);
  const unknownProduct = await holdRequest({
    items: [
      {
        product_id: randomUUID(),
        period: { arrival: addDays(66), departure: addDays(67) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    ],
    inventory_version: version,
    ttl_seconds: 300,
  });
  expect([404, 422]).toContain(unknownProduct.status);
  const badTtl = await holdRequest({
    items: [
      {
        product_id: productOne,
        period: { arrival: addDays(66), departure: addDays(67) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    ],
    inventory_version: version,
    ttl_seconds: 5,
  });
  expect([400, 422]).toContain(badTtl.status);
  const nothing = await search([productOne], addDays(66), addDays(67), 1);
  expect(nothing.body.offers[0].result).toBe('AVAILABLE');
});

test('ADV5-06 concurrent hold and block: exactly one wins, never both', async () => {
  const arrival = addDays(81);
  const departure = addDays(83);
  const version = await inventoryVersion();
  const [holdResult, blockResult] = await Promise.all([
    holdRequest({
      items: [
        {
          product_id: productOne,
          period: { arrival, departure },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 3,
        },
      ],
      inventory_version: version,
      ttl_seconds: 300,
    }),
    apiRequest(admin.context, 'POST', `${base()}/blocks`, {
      body: {
        resource_ids: [roomOne, roomTwo, roomThree],
        period: { arrival, departure },
        reason: 'ADV5 race block',
        mode: 'PLANNED',
      },
    }),
  ]);
  const succeeded = [holdResult, blockResult].filter(
    (response) => response.status < 300,
  );
  const failed = [holdResult, blockResult].filter(
    (response) => response.status >= 400,
  );
  expect(succeeded).toHaveLength(1);
  expect(failed).toHaveLength(1);
  expect([400, 409, 412]).toContain(failed[0].status);
  expect([
    'BLOCK_CONFLICT',
    'RESOURCE_UNAVAILABLE',
    'STALE_VERSION',
    'INVALID_REQUEST',
  ]).toContain(failed[0].body.code);
  const after = await search([productOne], arrival, departure, 1);
  expect(after.body.offers[0].result).toBe('UNAVAILABLE');
});

test('ADV5-07 expired hold cannot be released, releases the resource without a worker', async () => {
  const arrival = addDays(84);
  const departure = addDays(86);
  const created = await createHold(arrival, departure, 1, 300);
  expect(created.status).toBe(201);
  const holdId = created.body.hold.id;
  await withOwner(async (client) => {
    await client.query(
      `update "commitment" set "expires_at" = now() - interval '1 minute'
        where "id" = $1`,
      [holdId],
    );
  });
  const settle = await search([productOne], arrival, departure, 1);
  expect(settle.status).toBe(200);
  const release = await apiRequest(
    admin.context,
    'POST',
    `${base()}/holds/${holdId}/release`,
  );
  expect(release.status).toBe(409);
  expect(release.body.code).toBe('HOLD_EXPIRED');
  const again = await createHold(arrival, departure, 1, 300);
  expect(again.status).toBe(201);
  const state = await withOwner(async (client) => {
    const result = await client.query(
      `select "state" from "commitment" where "id" = $1`,
      [holdId],
    );
    return result.rows[0].state;
  });
  expect(state).toBe('EXPIRED');
});

test('ADV5-08 hold release is one-way once the hold is released', async () => {
  const arrival = addDays(87);
  const departure = addDays(89);
  const created = await createHold(arrival, departure, 1, 300);
  expect(created.status).toBe(201);
  const holdId = created.body.hold.id;
  const first = await apiRequest(
    admin.context,
    'POST',
    `${base()}/holds/${holdId}/release`,
  );
  expect(first.status).toBe(200);
  const second = await apiRequest(
    admin.context,
    'POST',
    `${base()}/holds/${holdId}/release`,
  );
  expect(second.status).toBe(409);
  expect(['INVALID_STATE_TRANSITION', 'HOLD_EXPIRED']).toContain(
    second.body.code,
  );
});

test('ADV5-09 two previews cannot both publish an overlapping exposure', async () => {
  const arrival = addDays(101);
  const departure = addDays(103);
  const version = await inventoryVersion();
  const first = await preview({
    connection_id: connectionId,
    product_id: productOne,
    period: { arrival, departure },
    resource_ids: [roomOne],
    inventory_version: version,
  });
  expect(first.status).toBe(200);
  expect(first.body.allowed).toBe(true);
  const second = await preview({
    connection_id: connectionId,
    product_id: productOne,
    period: { arrival, departure },
    resource_ids: [roomOne],
    inventory_version: version,
  });
  expect(second.body.allowed).toBe(true);
  const published = await publish(
    first.body.preview_id,
    first.body.preview_version,
  );
  expect(published.status).toBe(202);
  expect(published.body.state).toBe('PUBLISHING');
  const conflicting = await publish(
    second.body.preview_id,
    second.body.preview_version,
  );
  expect(conflicting.status).toBe(412);
  expect(conflicting.body.code).toBe('PREVIEW_STALE');
  const nowBlocked = await search([productOne], arrival, departure, 3);
  expect(nowBlocked.body.offers[0].result).toBe('UNAVAILABLE');
  expect(nowBlocked.body.offers[0].reason_codes.length).toBeGreaterThan(0);
});

test('ADV5-10 publish is one-way and an expired preview is refused', async () => {
  const arrival = addDays(107);
  const departure = addDays(109);
  const version = await inventoryVersion();
  const created = await preview({
    connection_id: connectionId,
    product_id: productOne,
    period: { arrival, departure },
    resource_ids: [roomTwo],
    inventory_version: version,
  });
  expect(created.body.allowed).toBe(true);
  const published = await publish(
    created.body.preview_id,
    created.body.preview_version,
  );
  expect(published.status).toBe(202);
  const twice = await publish(
    created.body.preview_id,
    created.body.preview_version,
  );
  expect([409, 412]).toContain(twice.status);
  expect(['EXPOSURE_STATE', 'PREVIEW_STALE']).toContain(twice.body.code);

  const later = await preview({
    connection_id: connectionId,
    product_id: productOne,
    period: { arrival: addDays(115), departure: addDays(117) },
    resource_ids: [roomTwo],
    inventory_version: await inventoryVersion(),
  });
  expect(later.body.allowed).toBe(true);
  await withOwner(async (client) => {
    await client.query(
      `update "exposure_preview" set "expires_at" = now() - interval '1 minute'
        where "id" = $1`,
      [later.body.preview_id],
    );
  });
  const expired = await publish(
    later.body.preview_id,
    later.body.preview_version,
  );
  expect(expired.status).toBe(412);
  expect(expired.body.code).toBe('PREVIEW_STALE');
});

test('ADV5-11 withdrawal never releases on transport ACK, and fake ACK is out of reach', async () => {
  const arrival = addDays(110);
  const departure = addDays(113);
  const version = await inventoryVersion();
  const created = await preview({
    connection_id: connectionId,
    product_id: productOne,
    period: { arrival, departure },
    resource_ids: [roomThree],
    inventory_version: version,
  });
  expect(created.body.allowed).toBe(true);
  const published = await publish(
    created.body.preview_id,
    created.body.preview_version,
  );
  expect(published.status).toBe(202);
  const withdraw = await apiRequest(
    admin.context,
    'POST',
    `${base()}/exposures/${published.body.operation_id}/withdraw`,
    { body: { reason: 'ADV5 withdraw probe' } },
  );
  expect([200, 202]).toContain(withdraw.status);
  const reconcileQueued = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections/${connectionId}/reconcile`,
    { body: { reason: 'ADV5 reconcile with queued events' } },
  );
  expect(reconcileQueued.status).toBe(200);
  expect(reconcileQueued.body.released).toBe(0);
  const stillBlocked = await search([productOne], arrival, departure, 3);
  expect(stillBlocked.body.offers[0].result).toBe('UNAVAILABLE');

  await withRuntimeRole('api', async (client) => {
    for (const sql of [
      `update "distribution_outbox_event" set "status" = 'ACKNOWLEDGED'
        where "connection_id" = $1`,
      `delete from "distribution_outbox_event" where "connection_id" = $1`,
    ]) {
      await client.query('begin');
      try {
        await client.query("select set_config('app.tenant_id', $1, true)", [
          tenantA,
        ]);
        await expect(client.query(sql, [connectionId])).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await client.query('rollback');
      }
    }
  });

  await setExposureEvents('ACKNOWLEDGED');
  const reconcile = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections/${connectionId}/reconcile`,
    { body: { reason: 'ADV5 reconcile with evidence' } },
  );
  expect(reconcile.status).toBe(200);
  expect(reconcile.body.released).toBe(0);
  expect(reconcile.body.reconciling).toBeGreaterThan(0);
  const freed = await search([productOne], arrival, departure, 3);
  expect(freed.body.offers[0].result).toBe('UNAVAILABLE');
});

test('ADV5-12 cross-scope references and foreign keys do not leak across properties', async () => {
  const mismatchedTenant = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantB}/properties/${property.id}/rate-plans`,
  );
  expect(mismatchedTenant.status).toBe(403);
  expect(mismatchedTenant.body.code).toBe('TENANT_CONTEXT_MISMATCH');
  const foreignProperty = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${randomUUID()}/rate-plans`,
  );
  expect([200, 404]).toContain(foreignProperty.status);
  expect(foreignProperty.body.rate_plans ?? []).toHaveLength(0);
  const crossPropertyRate = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rates/batch`,
    {
      body: {
        cells: [
          {
            rate_plan_id: ratePlanId,
            date: addDays(120),
            occupancy: 2,
            money: { amount: '1000', currency: 'IDR' },
          },
        ],
      },
    },
  );
  expect(crossPropertyRate.status).toBe(200);
  const otherPlanProperty = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${propertyB}/rate-plans`,
    {
      body: {
        code: 'ADV5-XSCOPE',
        name: 'Cross scope',
        product_id: productOne,
        currency: 'IDR',
      },
    },
  );
  expect([404, 422]).toContain(otherPlanProperty.status);
  const noPermission = await apiRequest(
    member.context,
    'GET',
    `${base()}/rate-plans`,
  );
  expect(noPermission.status).toBe(403);
  const auditorDenied = await apiRequest(
    auditor.context,
    'GET',
    `${base()}/rate-plans`,
  );
  expect(auditorDenied.status).toBe(403);
});

test('ADV5-13 MFA gates cannot be bypassed by headers, and members cannot sell or block', async () => {
  const ownerPlan = await apiRequest(
    owner.context,
    'POST',
    `${base()}/rate-plans`,
    {
      body: {
        code: 'ADV5-MFA',
        name: 'MFA probe',
        product_id: productOne,
        currency: 'IDR',
      },
    },
  );
  expect(ownerPlan.status).toBe(403);
  expect(ownerPlan.body.code).toBe('MFA_REQUIRED');
  const headerBypass = await apiRequest(
    owner.context,
    'POST',
    `${base()}/rate-plans`,
    {
      body: {
        code: 'ADV5-MFA-HDR',
        name: 'MFA header probe',
        product_id: productOne,
        currency: 'IDR',
      },
      headers: { 'x-approval-id': randomUUID() },
    },
  );
  expect(headerBypass.status).toBe(403);
  const ownerMaintenance = await apiRequest(
    owner.context,
    'POST',
    `${base()}/resources/${roomOne}/maintenance`,
    { body: { version: 1, state: 'OOO', reason: 'ADV5 probe' } },
  );
  expect([403, 412]).toContain(ownerMaintenance.status);
  expect(ownerMaintenance.body.code).toBe('MFA_REQUIRED');
  const memberHold = await apiRequest(
    member.context,
    'POST',
    `${base()}/holds`,
    {
      body: {
        items: [
          {
            product_id: productOne,
            period: { arrival: addDays(121), departure: addDays(122) },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
        inventory_version: await inventoryVersion(),
        ttl_seconds: 300,
      },
    },
  );
  expect(memberHold.status).toBe(403);
  const memberBlock = await apiRequest(
    member.context,
    'POST',
    `${base()}/blocks`,
    {
      body: {
        resource_ids: [roomOne],
        period: { arrival: addDays(121), departure: addDays(122) },
        reason: 'ADV5 member block',
        mode: 'PLANNED',
      },
    },
  );
  expect(memberBlock.status).toBe(403);
});

test('ADV5-14 injection payloads stay inert and strict DTOs reject extra fields', async () => {
  const payload = `ADV5 ' OR 1=1-- <img src=x onerror=alert(1)>`;
  const created = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rate-plans`,
    {
      body: {
        code: payload,
        name: payload,
        product_id: productOne,
        currency: 'IDR',
      },
    },
  );
  expect([201, 400, 422]).toContain(created.status);
  if (created.status === 201) {
    expect(created.body.rate_plan.code).toBe(payload);
    const list = await apiRequest(admin.context, 'GET', `${base()}/rate-plans`);
    const stored = list.body.rate_plans.find(
      (plan) => plan.id === created.body.rate_plan.id,
    );
    expect(stored.code).toBe(payload);
  }
  const extra = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rate-plans`,
    {
      body: {
        code: 'ADV5-EXTRA',
        name: 'Extra field probe',
        product_id: productOne,
        currency: 'IDR',
        role: 'TENANT_OWNER',
      },
    },
  );
  expect([400, 422]).toContain(extra.status);
  const oversized = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rate-plans`,
    {
      body: {
        code: 'ADV5-LONG',
        name: 'x'.repeat(4000),
        product_id: productOne,
        currency: 'IDR',
      },
    },
  );
  expect([400, 413, 422]).toContain(oversized.status);
  const count = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "rate_plan" where "property_id" = $1`,
      [property.id],
    );
    return result.rows[0].count;
  });
  expect(count).toBeLessThanOrEqual(3);
});

test('ADV5-15 emergency block preserves the existing commitment and records a disruption', async () => {
  const arrival = addDays(123);
  const departure = addDays(125);
  const created = await createHold(arrival, departure, 1, 300);
  expect(created.status).toBe(201);
  const holdId = created.body.hold.id;
  const emergency = await apiRequest(
    admin.context,
    'POST',
    `${base()}/blocks`,
    {
      body: {
        resource_ids: [roomOne, roomTwo, roomThree],
        period: { arrival, departure },
        reason: 'ADV5 emergency probe',
        mode: 'EMERGENCY',
      },
    },
  );
  expect(emergency.status).toBe(201);
  const state = await withOwner(async (client) => {
    const result = await client.query(
      `select "state" from "commitment" where "id" = $1`,
      [holdId],
    );
    return result.rows[0].state;
  });
  expect(state).toBe('ACTIVE');
  const disruptions = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "inventory_disruption"
        where "block_id" = $1`,
      [emergency.body.block.id],
    );
    return result.rows[0].count;
  });
  expect(disruptions).toBeGreaterThanOrEqual(1);
});

test('ADV5-16 fractional IDR is refused without silent rounding', async () => {
  const changed = await setRates([
    {
      rate_plan_id: ratePlanId,
      date: addDays(70),
      occupancy: 2,
      money: { amount: '250000.555', currency: 'IDR' },
    },
    {
      rate_plan_id: ratePlanId,
      date: addDays(71),
      occupancy: 2,
      money: { amount: '250000.555', currency: 'IDR' },
    },
  ]);
  expect(changed.status).toBe(200);
  const evaluated = await preview({
    connection_id: connectionId,
    product_id: productOne,
    period: { arrival: addDays(70), departure: addDays(72) },
    resource_ids: [roomOne],
    inventory_version: await inventoryVersion(),
  });
  expect(evaluated.status).toBe(200);
  expect(evaluated.body.allowed).toBe(false);
  expect(evaluated.body.reason_codes).toContain('FRACTION_NOT_SUPPORTED');
});

async function expireCommitment(commitmentId) {
  await withOwner(async (client) => {
    await client.query(
      `update "commitment" set "expires_at" = now() - interval '1 minute'
        where "id" = $1`,
      [commitmentId],
    );
  });
}

async function databaseInventoryVersion() {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "inventory_version" from "property" where "id" = $1`,
      [property.id],
    );
    return Number(result.rows[0].inventory_version);
  });
}

test('FIX-F1 lazy expiry is committed and stale errors report the disk version', async () => {
  const arrival = addDays(130);
  const departure = addDays(132);
  const versionBefore = await inventoryVersion();
  const expiring = await holdRequest({
    items: [
      {
        product_id: productOne,
        period: { arrival, departure },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    ],
    inventory_version: versionBefore,
    ttl_seconds: 30,
  });
  expect(expiring.status).toBe(201);
  await expireCommitment(expiring.body.hold.id);
  const freshVersion = await inventoryVersion();
  const afterExpiry = await holdRequest({
    items: [
      {
        product_id: productOne,
        period: { arrival: addDays(133), departure: addDays(135) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    ],
    inventory_version: freshVersion,
    ttl_seconds: 300,
  });
  expect(afterExpiry.status).toBe(201);
  const expiredState = await withOwner(async (client) => {
    const result = await client.query(
      `select "state" from "commitment" where "id" = $1`,
      [expiring.body.hold.id],
    );
    return result.rows[0].state;
  });
  expect(expiredState).toBe('EXPIRED');
  const activeAllocations = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "plan_allocation"
        where "commitment_id" = $1 and "state" = 'ACTIVE'`,
      [expiring.body.hold.id],
    );
    return result.rows[0].count;
  });
  expect(activeAllocations).toBe(0);

  const diskVersion = await databaseInventoryVersion();
  const stale = await holdRequest({
    items: [
      {
        product_id: productOne,
        period: { arrival: addDays(136), departure: addDays(138) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    ],
    inventory_version: freshVersion,
    ttl_seconds: 300,
  });
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');
  expect(stale.body.details.current).toBe(diskVersion);

  const previewExpiring = await holdRequest({
    items: [
      {
        product_id: productOne,
        period: { arrival: addDays(139), departure: addDays(141) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    ],
    inventory_version: await inventoryVersion(),
    ttl_seconds: 30,
  });
  expect(previewExpiring.status).toBe(201);
  await expireCommitment(previewExpiring.body.hold.id);
  const previewVersion = await inventoryVersion();
  const previewed = await preview({
    connection_id: connectionId,
    product_id: productOne,
    period: { arrival: addDays(139), departure: addDays(141) },
    resource_ids: [roomOne],
    inventory_version: previewVersion,
  });
  expect(previewed.status).toBe(200);
  expect(previewed.body.allowed).toBe(true);
});

test('G13-R03 keeps withdrawal RECONCILING while accepted publishing can recover from UNKNOWN', async () => {
  const arrival = addDays(143);
  const departure = addDays(145);
  const created = await preview({
    connection_id: connectionId,
    product_id: productOne,
    period: { arrival, departure },
    resource_ids: [roomTwo],
    inventory_version: await inventoryVersion(),
  });
  expect(created.body.allowed).toBe(true);
  const published = await publish(
    created.body.preview_id,
    created.body.preview_version,
  );
  expect(published.status).toBe(202);
  const exposureId = published.body.operation_id;
  const withdraw = await apiRequest(
    admin.context,
    'POST',
    `${base()}/exposures/${exposureId}/withdraw`,
    { body: { reason: 'FIX-R1 withdrawal' } },
  );
  expect(withdraw.status).toBe(202);
  await setExposureEvents('DEAD_LETTER');
  const failed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections/${connectionId}/reconcile`,
    { body: { reason: 'FIX-R1 failed evidence' } },
  );
  expect(failed.status).toBe(200);
  expect(failed.body.released).toBe(0);
  const stuck = await withOwner(async (client) => {
    const result = await client.query(
      `select "state" from "exposure" where "id" = $1`,
      [exposureId],
    );
    return result.rows[0].state;
  });
  expect(stuck).toBe('RECONCILING');
  await setExposureEvents('ACKNOWLEDGED');
  const released = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections/${connectionId}/reconcile`,
    { body: { reason: 'FIX-R1 accepted evidence' } },
  );
  expect(released.status).toBe(200);
  expect(released.body.released).toBe(0);
  expect(released.body.reconciling).toBeGreaterThan(0);
  const afterEvidence = await withOwner(async (client) => {
    const exposure = await client.query(
      `select "state" from "exposure" where "id" = $1`,
      [exposureId],
    );
    const allocation = await client.query(
      `select "state" from "exposure_allocation" where "exposure_id" = $1`,
      [exposureId],
    );
    return {
      exposure: exposure.rows[0].state,
      allocation: allocation.rows[0].state,
    };
  });
  expect(afterEvidence.exposure).toBe('RECONCILING');
  expect(afterEvidence.allocation).toBe('RESERVED');

  const unknownDates = { arrival: addDays(146), departure: addDays(148) };
  const unknownPreview = await preview({
    connection_id: connectionId,
    product_id: productOne,
    period: unknownDates,
    resource_ids: [roomThree],
    inventory_version: await inventoryVersion(),
  });
  expect(unknownPreview.body.allowed).toBe(true);
  const unknownPublished = await publish(
    unknownPreview.body.preview_id,
    unknownPreview.body.preview_version,
  );
  expect(unknownPublished.status).toBe(202);
  const unknownId = unknownPublished.body.operation_id;
  await setExposureEvents('UNKNOWN');
  const markedUnknown = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections/${connectionId}/reconcile`,
    { body: { reason: 'FIX-R1 unknown evidence' } },
  );
  expect(markedUnknown.status).toBe(200);
  const unknownState = await withOwner(async (client) => {
    const result = await client.query(
      `select "state" from "exposure" where "id" = $1`,
      [unknownId],
    );
    return result.rows[0].state;
  });
  expect(unknownState).toBe('UNKNOWN');
  await setExposureEvents('ACKNOWLEDGED');
  const activated = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections/${connectionId}/reconcile`,
    { body: { reason: 'FIX-R1 accepted evidence after unknown' } },
  );
  expect(activated.status).toBe(200);
  expect(activated.body.activated).toBe(1);
  const activeState = await withOwner(async (client) => {
    const result = await client.query(
      `select "state" from "exposure" where "id" = $1`,
      [unknownId],
    );
    return result.rows[0].state;
  });
  expect(activeState).toBe('ACTIVE');
});

test('FIX-R2 planned blocks require only inventory.block and emergency keeps its gate', async () => {
  const roleId = await withOwner(async (client) => {
    const result = await client.query(
      `select "id" from "role" where "tenant_id" = $1 and "code" = 'MEMBER'`,
      [tenantA],
    );
    return result.rows[0].id;
  });
  await withOwner(async (client) => {
    await client.query(
      `insert into "role_permission" ("role_id", "permission_code")
        values ($1, 'inventory.block') on conflict do nothing`,
      [roleId],
    );
  });
  try {
    const planned = await apiRequest(
      member.context,
      'POST',
      `${base()}/blocks`,
      {
        body: {
          resource_ids: [roomOne],
          period: { arrival: addDays(150), departure: addDays(152) },
          reason: 'FIX-R2 planned block',
          mode: 'PLANNED',
        },
      },
    );
    expect(planned.status).toBe(201);
    const emergency = await apiRequest(
      member.context,
      'POST',
      `${base()}/blocks`,
      {
        body: {
          resource_ids: [roomTwo],
          period: { arrival: addDays(150), departure: addDays(152) },
          reason: 'FIX-R2 emergency block',
          mode: 'EMERGENCY',
        },
      },
    );
    expect(emergency.status).toBe(403);
    expect(['PERMISSION_DENIED', 'MFA_REQUIRED']).toContain(
      emergency.body.code,
    );
  } finally {
    await withOwner(async (client) => {
      await client.query(
        `delete from "role_permission"
          where "role_id" = $1 and "permission_code" = 'inventory.block'`,
        [roleId],
      );
    });
  }
});

test('FIX-R3 lock timeouts map to a safe conflict response, never 500', async () => {
  const version = await inventoryVersion();
  let status;
  let body;
  await withOwner(async (client) => {
    await client.query('begin');
    try {
      await client.query(
        `select "id" from "property" where "id" = $1 for update`,
        [property.id],
      );
      const locked = await holdRequest({
        items: [
          {
            product_id: productOne,
            period: { arrival: addDays(155), departure: addDays(157) },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
        inventory_version: version,
        ttl_seconds: 300,
      });
      status = locked.status;
      body = locked.body;
    } finally {
      await client.query('rollback');
    }
  });
  expect(status).toBe(409);
  expect(body.code).toBe('CONFLICT');
  expect(body.details.reason).toBe('LOCK_TIMEOUT');
  expect(body.correlation_id).toBeTruthy();
});

test('FIX-R4 control characters are rejected as invalid requests', async () => {
  const nulName = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rate-plans`,
    {
      body: {
        code: 'FIX-R4-NUL',
        name: `nul${String.fromCharCode(0)}name`,
        product_id: productOne,
        currency: 'IDR',
      },
    },
  );
  expect(nulName.status).toBe(400);
  expect(nulName.body.code).toBe('INVALID_REQUEST');
  const nulReason = await apiRequest(
    admin.context,
    'POST',
    `${base()}/blocks`,
    {
      body: {
        resource_ids: [roomThree],
        period: { arrival: addDays(160), departure: addDays(162) },
        reason: `bad${String.fromCharCode(0)}reason`,
        mode: 'PLANNED',
      },
    },
  );
  expect(nulReason.status).toBe(400);
  expect(nulReason.body.code).toBe('INVALID_REQUEST');
  expect(nulReason.body.details.field).toBe('reason');
});

test('FIX-R8 hotel_api keeps only used table privileges', async () => {
  const grants = await withOwner(async (client) => {
    const result = await client.query(
      `select
         has_table_privilege('hotel_api', 'price_quote', 'UPDATE') as "quoteUpdate",
         has_table_privilege('hotel_api', 'inventory_block_resource', 'UPDATE') as "blockResourceUpdate",
         has_table_privilege('hotel_api', 'inventory_disruption', 'UPDATE') as "disruptionUpdate",
         has_table_privilege('hotel_api', 'price_quote', 'INSERT') as "quoteInsert",
         has_table_privilege('hotel_api', 'inventory_disruption', 'INSERT') as "disruptionInsert",
         has_table_privilege('hotel_api', 'price_quote', 'SELECT') as "quoteSelect"`,
    );
    return result.rows[0];
  });
  expect(grants.quoteUpdate).toBe(false);
  expect(grants.blockResourceUpdate).toBe(false);
  // P09-02 reintroduced UPDATE on inventory_disruption on purpose: work-order
  // closure now resolves its own block disruptions (docs/25/26 وP09-02). The
  // old FIX-R8 expectation is superseded by that documented consumer.
  expect(grants.disruptionUpdate).toBe(true);
  expect(grants.quoteInsert).toBe(true);
  expect(grants.disruptionInsert).toBe(true);
  expect(grants.quoteSelect).toBe(true);
});

test('FIX-R6 reason labels exist in every locale', () => {
  for (const locale of ['ar', 'id-ID', 'en-US']) {
    const dictionary = JSON.parse(
      readFileSync(
        new URL(
          `../../packages/i18n/src/locales/${locale}.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(dictionary.reason.WITHDRAWAL_PENDING).toBeTruthy();
    expect(dictionary.reason.RESOURCE_UNAVAILABLE).toBeTruthy();
  }
});
