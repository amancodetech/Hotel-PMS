import { randomUUID } from 'node:crypto';
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
let product;
let connectionId;

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
        code: 'P4-API',
        name: 'Owner refs property',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  const createdProduct = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products`,
    { body: { code: 'P4-ROOM', name: 'P4 room', kind: 'ROOM' } },
  );
  expect(createdProduct.status).toBe(201);
  product = createdProduct.body.product;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('channel management needs MFA and read permission is separate', async () => {
  const denied = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections`,
    {
      body: {
        provider_key: 'channex',
        environment: 'simulator',
        channel_key: 'tiket-com',
        secret_ref: 'secret:channex-a',
      },
    },
  );
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe('MFA_REQUIRED');
  const memberRead = await apiRequest(
    member.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/connections`,
  );
  expect(memberRead.status).toBe(403);
  const auditorRead = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/connections`,
  );
  expect(auditorRead.status).toBe(200);
  expect(auditorRead.body.items).toEqual([]);
});

test('connections are created as drafts and never expose the secret reference', async () => {
  const raw = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections`,
    {
      body: {
        provider_key: 'channex',
        environment: 'simulator',
        channel_key: 'tiket-com',
        secret_ref: 'plain-secret-value',
      },
    },
  );
  expect(raw.status).toBe(400);
  expect(raw.body.code).toBe('INVALID_REQUEST');

  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections`,
    {
      body: {
        provider_key: 'channex',
        environment: 'simulator',
        channel_key: 'tiket-com',
        external_property_id: 'EXT-P4',
        secret_ref: 'secret:channex-a',
      },
    },
  );
  expect(created.status).toBe(201);
  expect(created.body.connection.status).toBe('DRAFT');
  expect(created.body.connection.secret_ref_set).toBe(true);
  expect(JSON.stringify(created.body)).not.toContain('secret:channex-a');
  connectionId = created.body.connection.id;

  const duplicate = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections`,
    {
      body: {
        provider_key: 'channex',
        environment: 'simulator',
        channel_key: 'tiket-com',
        external_property_id: 'EXT-P4',
        secret_ref: 'secret:channex-b',
      },
    },
  );
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe('CONFLICT');

  const list = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/connections`,
  );
  expect(list.status).toBe(200);
  expect(list.body.items).toHaveLength(1);
  expect(JSON.stringify(list.body)).not.toContain('secret:');
});

test('draft capabilities are readable and remain explicit about unknown status', async () => {
  const response = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/capabilities`,
  );
  expect(response.status).toBe(200);
  expect(response.body.items).toEqual([]);
});

test('mapping drafts accept product and rate references inside the property scope', async () => {
  const acceptedNull = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/mapping`,
    {
      body: {
        channel_key: 'tiket-com',
        external_room_ref: 'ROOM-1',
        external_rate_ref: 'RATE-1',
        occupancy: 2,
        internal_rate_ref: null,
      },
    },
  );
  expect(acceptedNull.status).toBe(200);
  expect(acceptedNull.body.mapping.internal_rate_ref).toBeNull();

  const foreign = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/mapping`,
    {
      body: {
        channel_key: 'tiket-com',
        external_room_ref: 'ROOM-1',
        external_rate_ref: 'RATE-1',
        occupancy: 2,
        internal_product_ref: randomUUID(),
      },
    },
  );
  expect(foreign.status).toBe(422);
  expect(foreign.body.code).toBe('CROSS_SCOPE_REFERENCE');

  const foreignRate = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/mapping`,
    {
      body: {
        channel_key: 'tiket-com',
        external_room_ref: 'ROOM-1',
        external_rate_ref: 'RATE-1',
        occupancy: 2,
        internal_product_ref: product.id,
        internal_rate_ref: randomUUID(),
      },
    },
  );
  expect(foreignRate.status).toBe(422);
  expect(foreignRate.body.code).toBe('CROSS_SCOPE_REFERENCE');

  const saved = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/mapping`,
    {
      body: {
        channel_key: 'tiket-com',
        external_room_ref: 'ROOM-1',
        external_rate_ref: 'RATE-1',
        occupancy: 2,
        internal_product_ref: product.id,
      },
    },
  );
  expect(saved.status).toBe(200);
  expect(saved.body.mapping.status).toBe('DRAFT');
  expect(saved.body.mapping.internal_rate_ref).toBeNull();
  expect(saved.body.mapping.internal_product_ref).toBe(product.id);

  const list = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/mappings`,
  );
  expect(list.status).toBe(200);
  expect(list.body.items).toHaveLength(2);
  const withProduct = list.body.items.find(
    (item) => item.internal_product_ref === product.id,
  );
  expect(withProduct.status).toBe('DRAFT');
  expect(withProduct.internal_rate_ref).toBeNull();
});

test('connection activation is not implemented before rate mapping exists', async () => {
  const activation = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/activate`,
    { body: { reason: 'not yet' } },
  );
  expect(activation.status).toBe(404);
  expect(activation.body.code).toBe('NOT_FOUND');
});

test('connection reads stay inside the property scope', async () => {
  const other = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'P4-API-2',
        name: 'Other property',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(other.status).toBe(201);
  const crossProperty = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${other.body.property.id}/connections/${connectionId}/mappings`,
  );
  expect(crossProperty.status).toBe(404);
  expect(crossProperty.body.code).toBe('NOT_FOUND');
});
