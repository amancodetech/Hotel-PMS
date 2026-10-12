import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll } from '@jest/globals';
import {
  withOwner,
  withRuntimeRole,
  withTestRole,
} from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
const tenantB = process.env.IDENTITY_TENANT_B;

let propertyA;
let propertyB;
let roomA;
let bedA;
let roomB;
let productRoomA;
let poolRoomA;
let poolBedA;

async function probeFail(client, tenantId, sql, params, code) {
  await client.query('begin');
  try {
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    await expect(client.query(sql, params)).rejects.toMatchObject({ code });
  } finally {
    await client.query('rollback');
  }
}

beforeAll(async () => {
  propertyA = randomUUID();
  propertyB = randomUUID();
  roomA = randomUUID();
  bedA = randomUUID();
  roomB = randomUUID();
  productRoomA = randomUUID();
  poolRoomA = randomUUID();
  poolBedA = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'P2-A', 'P2 Property A', 'Asia/Jakarta'),
              ($3, $4, 'P2-B', 'P2 Property B', 'Asia/Jakarta')`,
      [propertyA, tenantA, propertyB, tenantB],
    );
    await client.query(
      `insert into "resource"
         ("id", "tenant_id", "property_id", "code", "resource_type", "capacity")
       values ($1, $2, $3, 'P2-ROOM-A', 'ROOM', 2),
              ($4, $2, $3, 'P2-BED-A', 'BED', 1),
              ($5, $6, $7, 'P2-ROOM-B', 'ROOM', 2)`,
      [roomA, tenantA, propertyA, bedA, roomB, tenantB, propertyB],
    );
    await client.query(
      `insert into "product"
         ("id", "tenant_id", "property_id", "code", "name", "kind")
       values ($1, $2, $3, 'P2-PROD-A', 'P2 Product A', 'ROOM')`,
      [productRoomA, tenantA, propertyA],
    );
    await client.query(
      `insert into "inventory_pool"
         ("id", "tenant_id", "property_id", "code", "name", "resource_type")
       values ($1, $2, $3, 'P2-POOL-A', 'P2 Pool A', 'ROOM'),
              ($4, $2, $3, 'P2-POOL-BED', 'P2 Pool BED', 'BED')`,
      [poolRoomA, tenantA, propertyA, poolBedA],
    );
  });
});

test('product and pool tables force RLS with runtime least privilege', async () => {
  const inventory = await withOwner(async (client) => {
    const tables = await client.query(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('product', 'inventory_pool', 'pool_member',
                           'product_resource_candidate')
    `);
    const privileges = await client.query(`
      select
        has_table_privilege('hotel_worker', 'product', 'select') as worker_select,
        has_table_privilege('hotel_worker', 'product', 'insert') as worker_insert,
        has_table_privilege('hotel_api', 'product', 'delete') as api_delete,
        has_table_privilege('hotel_api', 'pool_member', 'delete') as api_member_delete
    `);
    return { tables: tables.rows, privileges: privileges.rows[0] };
  });
  for (const row of inventory.tables) {
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  }
  expect(inventory.tables).toHaveLength(4);
  expect(inventory.privileges.worker_select).toBe(true);
  expect(inventory.privileges.worker_insert).toBe(false);
  expect(inventory.privileges.api_delete).toBe(false);
  expect(inventory.privileges.api_member_delete).toBe(false);
});

test('without tenant context product tables are invisible and reject writes', async () => {
  await withTestRole(async (client) => {
    for (const table of [
      'product',
      'inventory_pool',
      'pool_member',
      'product_resource_candidate',
    ]) {
      const count = await client.query(
        `select count(*)::int as count from "${table}"`,
      );
      expect(count.rows[0].count).toBe(0);
    }
    await expect(
      client.query(
        `insert into "product" ("tenant_id", "property_id", "code", "name", "kind")
         values ($1, $2, 'NOCTX-P', 'No context', 'ROOM')`,
        [tenantA, propertyA],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

test('candidate and member type mismatches are rejected by composite keys', async () => {
  await withTestRole(async (client) => {
    await probeFail(
      client,
      tenantA,
      `insert into "product_resource_candidate"
         ("product_id", "tenant_id", "property_id", "resource_type", "resource_id")
       values ($1, $2, $3, 'BED', $4)`,
      [productRoomA, tenantA, propertyA, bedA],
      '23503',
    );
    await probeFail(
      client,
      tenantA,
      `insert into "pool_member"
         ("pool_id", "tenant_id", "property_id", "resource_type", "resource_id")
       values ($1, $2, $3, 'ROOM', $4)`,
      [poolBedA, tenantA, propertyA, roomA],
      '23503',
    );
    await probeFail(
      client,
      tenantA,
      `insert into "product_resource_candidate"
         ("product_id", "tenant_id", "property_id", "resource_type", "resource_id")
       values ($1, $2, $3, 'ROOM', $4)`,
      [productRoomA, tenantA, propertyA, roomB],
      '23503',
    );
    await probeFail(
      client,
      tenantA,
      `update "product" set "pool_id" = $1 where "id" = $2`,
      [poolBedA, productRoomA],
      '23503',
    );
  });
});

test('duplicate candidates are rejected and valid matches are stored', async () => {
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await client.query(
      `insert into "product_resource_candidate"
         ("product_id", "tenant_id", "property_id", "resource_type", "resource_id")
       values ($1, $2, $3, 'ROOM', $4)`,
      [productRoomA, tenantA, propertyA, roomA],
    );
    await expect(
      client.query(
        `insert into "product_resource_candidate"
           ("product_id", "tenant_id", "property_id", "resource_type", "resource_id")
         values ($1, $2, $3, 'ROOM', $4)`,
        [productRoomA, tenantA, propertyA, roomA],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await client.query('rollback');
  });
});

test('product and pool rows are invisible across tenants and reject deletes from workers', async () => {
  await withRuntimeRole('worker', async (client) => {
    const count = await client.query(
      `select count(*)::int as count from "product"`,
    );
    expect(count.rows[0].count).toBe(0);
    await probeFail(
      client,
      tenantA,
      'delete from "product" where "id" = $1',
      [productRoomA],
      '42501',
    );
  });
});
