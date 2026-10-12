import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let tenantA;
let admin;
let owner;
let member;
let property;
let roomId;
let productId;
let standardPlanId;

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

async function createRatePlan(body) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans`,
    { body },
  );
  return response;
}

beforeAll(async () => {
  await startApi();
  owner = await loginAs('owner-a');
  admin = await loginAs('admin-a');
  member = await loginAs('member-a');
  tenantA = owner.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'P5-RATE',
        name: 'Rates property',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  const resource = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/resources`,
    { body: { code: 'P5-R1', type: 'ROOM', capacity: 2 } },
  );
  expect(resource.status).toBe(201);
  roomId = resource.body.resource.id;
  const product = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products`,
    {
      body: {
        code: 'P5-ROOM',
        name: 'Room product',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(product.status).toBe(201);
  productId = product.body.product.id;
  const candidate = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products/${productId}/candidates`,
    { body: { resource_id: roomId } },
  );
  expect(candidate.status).toBe(201);
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${productId}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('rate plan requires rate.manage and MFA, and policy versions are immutable', async () => {
  const denied = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans`,
    {
      body: {
        code: 'P5-STD',
        name: 'Standard',
        product_id: productId,
        currency: 'IDR',
      },
    },
  );
  expect(denied.status).toBe(403);

  const mfaDenied = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans`,
    {
      body: {
        code: 'P5-STD',
        name: 'Standard',
        product_id: productId,
        currency: 'IDR',
      },
    },
  );
  expect(mfaDenied.status).toBe(403);
  expect(mfaDenied.body.code).toBe('MFA_REQUIRED');

  const created = await createRatePlan({
    code: 'P5-STD',
    name: 'Standard',
    product_id: productId,
    currency: 'IDR',
    occupancy_basis: 2,
  });
  expect(created.status).toBe(201);
  let plan = created.body.rate_plan;
  expect(plan.status).toBe('DRAFT');
  expect(plan.policy_version).toBe(1);
  standardPlanId = plan.id;

  const renamed = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans/${plan.id}`,
    { body: { version: plan.version, name: 'Standard flexible' } },
  );
  expect(renamed.status).toBe(200);
  plan = renamed.body.rate_plan;
  expect(plan.name).toBe('Standard flexible');
  expect(plan.policy_version).toBe(1);

  const policy = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans/${plan.id}`,
    {
      body: {
        version: plan.version,
        occupancy_basis: 3,
        cancellation_policy: { free_until_days: 2 },
      },
    },
  );
  expect(policy.status).toBe(200);
  plan = policy.body.rate_plan;
  expect(plan.policy_version).toBe(2);
  expect(plan.occupancy_basis).toBe(3);

  const snapshots = await withOwner(async (client) => {
    const result = await client.query(
      `select "version_number", "occupancy_basis", "cancellation_policy"
         from "rate_policy_version"
        where "rate_plan_id" = $1 order by "version_number"`,
      [plan.id],
    );
    return result.rows;
  });
  expect(snapshots).toHaveLength(2);
  expect(snapshots[0].occupancy_basis).toBe(2);
  expect(snapshots[1].occupancy_basis).toBe(3);
  expect(snapshots[1].cancellation_policy.free_until_days).toBe(2);

  const stale = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans/${plan.id}`,
    { body: { version: 1, name: 'Stale' } },
  );
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');
});

test('SetRates is atomic and enforces zero-price policy and horizon', async () => {
  const created = await createRatePlan({
    code: 'P5-FLEX',
    name: 'Flexible',
    product_id: productId,
    currency: 'IDR',
  });
  expect(created.status).toBe(201);
  const plan = created.body.rate_plan;

  const zero = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rates/batch`,
    {
      body: {
        cells: [
          {
            rate_plan_id: plan.id,
            date: addDays(1),
            occupancy: 2,
            money: { amount: '0', currency: 'IDR' },
          },
        ],
      },
    },
  );
  expect(zero.status).toBe(422);
  expect(zero.body.code).toBe('ZERO_PRICE_POLICY');

  const free = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans/${plan.id}`,
    { body: { version: plan.version, free_policy: true } },
  );
  expect(free.status).toBe(200);
  const freePlan = free.body.rate_plan;
  expect(freePlan.policy_version).toBe(2);

  const invalidBatch = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rates/batch`,
    {
      body: {
        cells: [
          {
            rate_plan_id: freePlan.id,
            date: addDays(2),
            occupancy: 2,
            money: { amount: '100000', currency: 'IDR' },
          },
          {
            rate_plan_id: freePlan.id,
            date: addDays(3),
            occupancy: 2,
            money: { amount: '-5', currency: 'IDR' },
          },
        ],
      },
    },
  );
  expect(invalidBatch.status).toBe(400);
  expect(invalidBatch.body.code).toBe('INVALID_REQUEST');

  const rowCount = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "nightly_price" where "rate_plan_id" = $1`,
      [freePlan.id],
    );
    return result.rows[0].count;
  });
  expect(rowCount).toBe(0);

  const currencyMismatch = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rates/batch`,
    {
      body: {
        cells: [
          {
            rate_plan_id: freePlan.id,
            date: addDays(2),
            occupancy: 2,
            money: { amount: '10.50', currency: 'USD' },
          },
        ],
      },
    },
  );
  expect(currencyMismatch.status).toBe(400);
  expect(currencyMismatch.body.code).toBe('INVALID_REQUEST');
  expect(currencyMismatch.body.details.field).toBe('currency');

  const beyondHorizon = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rates/batch`,
    {
      body: {
        cells: [
          {
            rate_plan_id: freePlan.id,
            date: addDays(400),
            occupancy: 2,
            money: { amount: '100000', currency: 'IDR' },
          },
        ],
      },
    },
  );
  expect(beyondHorizon.status).toBe(422);
  expect(beyondHorizon.body.code).toBe('LIMIT_EXCEEDED');

  const accepted = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rates/batch`,
    {
      body: {
        cells: [
          {
            rate_plan_id: freePlan.id,
            date: addDays(2),
            occupancy: 2,
            money: { amount: '100000', currency: 'IDR' },
          },
          {
            rate_plan_id: freePlan.id,
            date: addDays(3),
            occupancy: 2,
            money: { amount: '0', currency: 'IDR' },
          },
        ],
      },
    },
  );
  expect(accepted.status).toBe(200);
  expect(accepted.body.updated).toBe(2);
  expect(accepted.body.inventory_version).toBeGreaterThan(1);

  const calendar = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/rates?from=${addDays(1)}&to=${addDays(5)}`,
  );
  expect(calendar.status).toBe(200);
  expect(calendar.body.inventory_version).toBe(accepted.body.inventory_version);
  const prices = calendar.body.prices;
  expect(prices).toHaveLength(2);
  expect(prices[0].money.amount).toBe('100000');
  expect(prices[1].money.amount).toBe('0');
});

test('rate plans stay inside the property and member has no access', async () => {
  const second = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'P5-OTHER',
        name: 'Other property',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(second.status).toBe(201);
  const otherProperty = second.body.property;
  const otherResource = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${otherProperty.id}/resources`,
    { body: { code: 'P5-R2', type: 'ROOM', capacity: 2 } },
  );
  expect(otherResource.status).toBe(201);
  const otherProduct = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${otherProperty.id}/products`,
    {
      body: {
        code: 'P5-ROOM2',
        name: 'Other product',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(otherProduct.status).toBe(201);
  await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${otherProperty.id}/products/${otherProduct.body.product.id}/candidates`,
    { body: { resource_id: otherResource.body.resource.id } },
  );

  const foreignPlan = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${otherProperty.id}/rate-plans`,
    {
      body: {
        code: 'P5-FOREIGN',
        name: 'Foreign plan',
        product_id: otherProduct.body.product.id,
        currency: 'IDR',
      },
    },
  );
  expect(foreignPlan.status).toBe(201);

  const crossScope = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans/${foreignPlan.body.rate_plan.id}`,
    { body: { version: 1, name: 'Cross' } },
  );
  expect(crossScope.status).toBe(404);
  expect(crossScope.body.code).toBe('NOT_FOUND');

  const forbidden = await apiRequest(
    member.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans`,
  );
  expect(forbidden.status).toBe(403);

  const connection = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections`,
    {
      body: {
        provider_key: 'CHANNEX',
        environment: 'STAGING',
        channel_key: 'BOOKING_COM',
        external_property_id: 'ext-p5',
        secret_ref: 'local:hotel/p5',
      },
    },
  );
  expect(connection.status).toBe(201);

  const mapping = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connection.body.connection.id}/mapping`,
    {
      body: {
        channel_key: 'BOOKING_COM',
        external_room_ref: 'ext-room-1',
        external_rate_ref: 'ext-rate-1',
        occupancy: 2,
        internal_product_ref: productId,
        internal_rate_ref: foreignPlan.body.rate_plan.id,
      },
    },
  );
  expect(mapping.status).toBe(422);
  expect(mapping.body.code).toBe('CROSS_SCOPE_REFERENCE');

  const validMapping = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connection.body.connection.id}/mapping`,
    {
      body: {
        channel_key: 'BOOKING_COM',
        external_room_ref: 'ext-room-2',
        external_rate_ref: 'ext-rate-2',
        occupancy: 2,
        internal_product_ref: productId,
        internal_rate_ref: standardPlanId,
      },
    },
  );
  expect(validMapping.status).toBe(200);
  expect(validMapping.body.mapping.internal_rate_ref).toBe(standardPlanId);
});
