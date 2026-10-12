import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
} from './support/harness.mjs';

let tenantA;
let owner;
let admin;
let member;
let property;
let roomId;
let bedId;

async function createResource(code, type, capacity) {
  const response = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/resources`,
    { body: { code, type, capacity } },
  );
  expect(response.status).toBe(201);
  return response.body.resource.id;
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
        code: 'P2-API',
        name: 'Product API property',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  roomId = await createResource('P2-R1', 'ROOM', 2);
  bedId = await createResource('P2-B1', 'BED', 1);
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('product activation requires a compatible candidate', async () => {
  const created = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products`,
    {
      body: {
        code: 'ROOM-STD',
        name: 'Standard room',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(created.status).toBe(201);
  const product = created.body.product;
  expect(product.status).toBe('DRAFT');
  expect(product.meal_plan).toBe('NONE');

  const early = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.id}`,
    { body: { version: product.version, status: 'ACTIVE' } },
  );
  expect(early.status).toBe(422);
  expect(early.body.code).toBe('PRODUCT_INCOMPLETE');

  const mismatch = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.id}/candidates`,
    { body: { resource_id: bedId } },
  );
  expect(mismatch.status).toBe(422);
  expect(mismatch.body.code).toBe('TYPE_MISMATCH');

  const candidate = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.id}/candidates`,
    { body: { resource_id: roomId } },
  );
  expect(candidate.status).toBe(201);
  expect(candidate.body.candidate.resource_type).toBe('ROOM');

  const activated = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.id}`,
    { body: { version: product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  expect(activated.body.product.status).toBe('ACTIVE');

  const stale = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.id}`,
    { body: { version: product.version, name: 'Renamed' } },
  );
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');

  const candidates = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.id}/candidates`,
  );
  expect(candidates.status).toBe(200);
  expect(candidates.body.items).toHaveLength(1);
  expect(candidates.body.items[0].resource_id).toBe(roomId);
});

test('meal plans and extra products do not create inventory units', async () => {
  const before = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/resources`,
  );
  const created = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products`,
    {
      body: {
        code: 'ROOM-STD-BB',
        name: 'Standard room breakfast',
        kind: 'ROOM',
        meal_plan: 'BREAKFAST',
      },
    },
  );
  expect(created.status).toBe(201);
  const candidate = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products/${created.body.product.id}/candidates`,
    { body: { resource_id: roomId } },
  );
  expect(candidate.status).toBe(201);
  const after = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/resources`,
  );
  expect(after.body.items).toHaveLength(before.body.items.length);
});

test('pools hold candidate members without adding inventory', async () => {
  const created = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/pools`,
    { body: { code: 'ROOM-POOL', name: 'Room pool', resource_type: 'ROOM' } },
  );
  expect(created.status).toBe(201);
  const pool = created.body.pool;

  const mismatch = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/pools/${pool.id}/members`,
    { body: { resource_id: bedId } },
  );
  expect(mismatch.status).toBe(422);
  expect(mismatch.body.code).toBe('TYPE_MISMATCH');

  const member = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/pools/${pool.id}/members`,
    { body: { resource_id: roomId, effective_from: '2026-09-13' } },
  );
  expect(member.status).toBe(201);
  expect(member.body.member.effective_from).toBe('2026-09-13');

  const product = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products`,
    {
      body: {
        code: 'POOL-ROOM',
        name: 'Pool room',
        kind: 'ROOM',
      },
    },
  );
  expect(product.status).toBe(201);
  const bound = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.body.product.id}`,
    { body: { version: product.body.product.version, pool_id: pool.id } },
  );
  expect(bound.status).toBe(200);
  const activated = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.body.product.id}`,
    { body: { version: bound.body.product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  expect(activated.body.product.status).toBe('ACTIVE');

  const invalidEnd = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/pools/${pool.id}/members/${roomId}`,
    { body: { effective_to: '2026-09-12' } },
  );
  expect(invalidEnd.status).toBe(400);
  const ended = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/pools/${pool.id}/members/${roomId}`,
    { body: { effective_to: '2026-09-13' } },
  );
  expect(ended.status).toBe(200);
  expect(ended.body.member.effective_to).toBe('2026-09-13');

  const afterEnd = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products`,
    {
      body: { code: 'POOL-ROOM-2', name: 'Pool room 2', kind: 'ROOM' },
    },
  );
  const boundTwo = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${afterEnd.body.product.id}`,
    {
      body: {
        version: afterEnd.body.product.version,
        pool_id: pool.id,
        status: 'ACTIVE',
      },
    },
  );
  expect(boundTwo.status).toBe(422);
  expect(boundTwo.body.code).toBe('PRODUCT_INCOMPLETE');

  const resources = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/resources`,
  );
  expect(resources.body.items).toHaveLength(2);
});

test('member role cannot read or manage the product catalog', async () => {
  const read = await apiRequest(
    member.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/products`,
  );
  expect(read.status).toBe(403);
  const write = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/pools`,
    { body: { code: 'MEMBER-POOL', name: 'Nope', resource_type: 'ROOM' } },
  );
  expect(write.status).toBe(403);
  expect(write.body.code).toBe('PERMISSION_DENIED');
});
