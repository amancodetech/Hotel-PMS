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
let auditor;
let property;
let villaProduct;
let roomA;
let roomB;
let roomC;
let childComposition;

async function createRoom(code) {
  const response = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/resources`,
    { body: { code, type: 'ROOM', capacity: 2 } },
  );
  expect(response.status).toBe(201);
  return response.body.resource;
}

async function createComposition(body) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/compositions`,
    { body },
  );
}

async function activate(compositionId, includeReason = true) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/compositions/${compositionId}/activate`,
    { body: includeReason ? { reason: 'compose test activation' } : {} },
  );
}

beforeAll(async () => {
  await startApi();
  owner = await loginAs('owner-a');
  admin = await loginAs('admin-a');
  member = await loginAs('member-a');
  auditor = await loginAs('auditor-a');
  tenantA = owner.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'P3-API',
        name: 'Composition API property',
        timezone: 'Asia/Makassar',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  roomA = (await createRoom('P3-RA-API')).id;
  roomB = (await createRoom('P3-RB-API')).id;
  roomC = (await createRoom('P3-RC-API')).id;
  const product = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products`,
    { body: { code: 'P3-VILLA-API', name: 'Villa', kind: 'VILLA' } },
  );
  expect(product.status).toBe(201);
  villaProduct = product.body.product;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('composition.manage requires MFA and a complete edge set', async () => {
  const denied = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/compositions`,
    {
      body: {
        product_id: villaProduct.id,
        effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
        resource_ids: [roomA],
        nested_version_ids: [],
      },
    },
  );
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe('MFA_REQUIRED');

  const empty = await createComposition({
    product_id: villaProduct.id,
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: [],
    nested_version_ids: [],
  });
  expect(empty.status).toBe(400);
  expect(empty.body.code).toBe('INVALID_REQUEST');

  const created = await createComposition({
    product_id: villaProduct.id,
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: [roomA, roomB],
    nested_version_ids: [],
  });
  expect(created.status).toBe(201);
  childComposition = created.body.composition;
  expect(childComposition.status).toBe('DRAFT');
  expect(childComposition.version_number).toBe(1);

  const detail = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/compositions/${childComposition.id}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body.edges).toHaveLength(2);
  expect(detail.body.leaves).toHaveLength(0);

  const noReason = await activate(childComposition.id, false);
  expect(noReason.status).toBe(400);
  const activated = await activate(childComposition.id);
  expect(activated.status).toBe(200);
  expect(activated.body.composition.status).toBe('ACTIVE');
  expect(activated.body.leaves).toHaveLength(2);
  expect(activated.body.leaves.every((leaf) => leaf.depth === 1)).toBe(true);

  const again = await activate(childComposition.id);
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
});

test('nested active versions flatten with bounded depth and containment', async () => {
  const nested = await createComposition({
    product_id: villaProduct.id,
    effective_period: { arrival: '2026-09-15', departure: '2026-12-31' },
    resource_ids: [],
    nested_version_ids: [childComposition.id],
  });
  expect(nested.status).toBe(201);
  const activated = await activate(nested.body.composition.id);
  expect(activated.status).toBe(200);
  expect(activated.body.leaves).toHaveLength(2);
  expect(activated.body.leaves.every((leaf) => leaf.depth === 2)).toBe(true);

  const leaves = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/compositions/${nested.body.composition.id}/leaves`,
  );
  expect(leaves.status).toBe(200);
  expect(leaves.body.items.map((item) => item.resource_id).sort()).toEqual(
    [roomA, roomB].sort(),
  );

  const content = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/compositions/${nested.body.composition.id}`,
  );
  expect(content.status).toBe(200);
  expect(content.body.edges[0].child_kind).toBe('COMPOSITION');
  expect(content.body.edges[0].version_id).toBe(childComposition.id);

  const product = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${villaProduct.id}`,
    { body: { version: villaProduct.version, status: 'ACTIVE' } },
  );
  expect(product.status).toBe(200);
  expect(product.body.product.status).toBe('ACTIVE');
});

test('activation rejects periods outside the nested version and draft children', async () => {
  const outside = await createComposition({
    product_id: villaProduct.id,
    effective_period: { arrival: '2026-10-15', departure: '2026-11-30' },
    resource_ids: [],
    nested_version_ids: [childComposition.id],
  });
  expect(outside.status).toBe(201);
  const rejected = await activate(outside.body.composition.id);
  expect(rejected.status).toBe(400);
  expect(rejected.body.code).toBe('INVALID_REQUEST');

  const draftChild = await createComposition({
    product_id: villaProduct.id,
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: [roomC],
    nested_version_ids: [],
  });
  expect(draftChild.status).toBe(201);
  const parent = await createComposition({
    product_id: villaProduct.id,
    effective_period: { arrival: '2026-10-05', departure: '2026-11-30' },
    resource_ids: [],
    nested_version_ids: [draftChild.body.composition.id],
  });
  expect(parent.status).toBe(201);
  const parentActivation = await activate(parent.body.composition.id);
  expect(parentActivation.status).toBe(409);
  expect(parentActivation.body.code).toBe('INVALID_STATE_TRANSITION');
});

test('duplicate flattened leaves and retired resources are rejected', async () => {
  const duplicate = await createComposition({
    product_id: villaProduct.id,
    effective_period: { arrival: '2026-09-15', departure: '2026-12-31' },
    resource_ids: [roomA],
    nested_version_ids: [childComposition.id],
  });
  expect(duplicate.status).toBe(201);
  const rejected = await activate(duplicate.body.composition.id);
  expect(rejected.status).toBe(422);
  expect(rejected.body.code).toBe('DUPLICATE_LEAF');

  const draftChild = await createComposition({
    product_id: villaProduct.id,
    effective_period: { arrival: '2026-10-01', departure: '2026-12-31' },
    resource_ids: [roomC],
    nested_version_ids: [],
  });
  const retired = await apiRequest(
    owner.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/resources/${roomC}`,
    { body: { version: 1, state: 'RETIRED' } },
  );
  expect(retired.status).toBe(200);
  const activation = await activate(draftChild.body.composition.id);
  expect(activation.status).toBe(409);
  expect(activation.body.code).toBe('RESOURCE_RETIRED');
});

test('composition reads respect the read permission split', async () => {
  const denied = await apiRequest(
    member.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/compositions`,
  );
  expect(denied.status).toBe(403);
  const allowed = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/compositions`,
  );
  expect(allowed.status).toBe(200);
  expect(allowed.body.items.length).toBeGreaterThan(0);
});
