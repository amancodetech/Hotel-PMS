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
let roomB;
let roomX;
let productA;
let compositionDraft;
let compositionActive;

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

async function insertVersion(client, tenantId, propertyId, productId, number) {
  const row = await client.query(
    `insert into "composition_version"
       ("tenant_id", "property_id", "product_id", "version_number",
        "effective_from", "effective_to")
     values ($1, $2, $3, $4, '2026-10-01', '2026-12-31')
     returning "id"`,
    [tenantId, propertyId, productId, number],
  );
  return row.rows[0].id;
}

beforeAll(async () => {
  propertyA = randomUUID();
  propertyB = randomUUID();
  roomA = randomUUID();
  roomB = randomUUID();
  roomX = randomUUID();
  productA = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'P3-A', 'P3 Property A', 'Asia/Jakarta'),
              ($3, $4, 'P3-B', 'P3 Property B', 'Asia/Jakarta')`,
      [propertyA, tenantA, propertyB, tenantB],
    );
    await client.query(
      `insert into "resource"
         ("id", "tenant_id", "property_id", "code", "resource_type", "capacity")
       values ($1, $2, $3, 'P3-RA', 'ROOM', 2),
              ($4, $2, $3, 'P3-RB', 'ROOM', 2),
              ($5, $6, $7, 'P3-RX', 'ROOM', 2)`,
      [roomA, tenantA, propertyA, roomB, roomX, tenantB, propertyB],
    );
    await client.query(
      `insert into "product" ("id", "tenant_id", "property_id", "code", "name", "kind")
       values ($1, $2, $3, 'P3-VILLA', 'P3 Villa', 'VILLA')`,
      [productA, tenantA, propertyA],
    );
    compositionDraft = await insertVersion(
      client,
      tenantA,
      propertyA,
      productA,
      1,
    );
    await client.query(
      `insert into "composition_edge"
         ("version_id", "tenant_id", "property_id", "position", "child_kind", "resource_id")
       values ($1, $2, $3, 0, 'RESOURCE', $4)`,
      [compositionDraft, tenantA, propertyA, roomA],
    );
    compositionActive = await insertVersion(
      client,
      tenantA,
      propertyA,
      productA,
      2,
    );
    await client.query(
      `insert into "composition_edge"
         ("version_id", "tenant_id", "property_id", "position", "child_kind", "resource_id")
       values ($1, $2, $3, 0, 'RESOURCE', $4)`,
      [compositionActive, tenantA, propertyA, roomB],
    );
    await client.query(
      `update "composition_version" set "status" = 'ACTIVE' where "id" = $1`,
      [compositionActive],
    );
  });
});

test('composition tables force RLS with runtime least privilege', async () => {
  const inventory = await withOwner(async (client) => {
    const tables = await client.query(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('composition_version', 'composition_edge', 'composition_leaf')
    `);
    const privileges = await client.query(`
      select
        has_table_privilege('hotel_worker', 'composition_version', 'select') as worker_select,
        has_table_privilege('hotel_worker', 'composition_edge', 'insert') as worker_insert,
        has_table_privilege('hotel_api', 'composition_leaf', 'delete') as api_delete,
        has_table_privilege('hotel_test', 'composition_version', 'update') as test_update
    `);
    return { tables: tables.rows, privileges: privileges.rows[0] };
  });
  expect(inventory.tables).toHaveLength(3);
  for (const row of inventory.tables) {
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  }
  expect(inventory.privileges.worker_select).toBe(true);
  expect(inventory.privileges.worker_insert).toBe(false);
  expect(inventory.privileges.api_delete).toBe(false);
  expect(inventory.privileges.test_update).toBe(true);
});

test('without tenant context composition tables stay invisible and reject writes', async () => {
  await withTestRole(async (client) => {
    for (const table of [
      'composition_version',
      'composition_edge',
      'composition_leaf',
    ]) {
      const count = await client.query(
        `select count(*)::int as count from "${table}"`,
      );
      expect(count.rows[0].count).toBe(0);
    }
    await expect(
      client.query(
        `insert into "composition_version"
           ("tenant_id", "property_id", "product_id", "version_number",
            "effective_from", "effective_to")
         values ($1, $2, $3, 9, '2026-10-01', '2026-12-31')`,
        [tenantA, propertyA, productA],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

test('edge targets reject self references, cross-property resources and bad shapes', async () => {
  await withTestRole(async (client) => {
    await probeFail(
      client,
      tenantA,
      `insert into "composition_edge"
         ("version_id", "tenant_id", "property_id", "position", "child_kind", "child_version_id")
       values ($1, $2, $3, 5, 'COMPOSITION', $1)`,
      [compositionDraft, tenantA, propertyA],
      '23514',
    );
    await probeFail(
      client,
      tenantA,
      `insert into "composition_edge"
         ("version_id", "tenant_id", "property_id", "position", "child_kind", "resource_id", "child_version_id")
       values ($1, $2, $3, 6, 'RESOURCE', $4, $5)`,
      [compositionDraft, tenantA, propertyA, roomA, compositionActive],
      '23514',
    );
    await probeFail(
      client,
      tenantA,
      `insert into "composition_edge"
         ("version_id", "tenant_id", "property_id", "position", "child_kind", "resource_id")
       values ($1, $2, $3, 7, 'RESOURCE', $4)`,
      [compositionDraft, tenantA, propertyA, roomX],
      '23503',
    );
  });
});

test('activated composition versions are immutable at the database level', async () => {
  await withTestRole(async (client) => {
    await probeFail(
      client,
      tenantA,
      `insert into "composition_edge"
         ("version_id", "tenant_id", "property_id", "position", "child_kind", "resource_id")
       values ($1, $2, $3, 9, 'RESOURCE', $4)`,
      [compositionActive, tenantA, propertyA, roomA],
      '23514',
    );
    await probeFail(
      client,
      tenantA,
      `delete from "composition_edge" where "version_id" = $1`,
      [compositionActive],
      '23514',
    );
    await probeFail(
      client,
      tenantA,
      `insert into "composition_leaf"
         ("version_id", "tenant_id", "property_id", "resource_id", "depth")
       values ($1, $2, $3, $4, 1)`,
      [compositionActive, tenantA, propertyA, roomA],
      '23514',
    );
  });
});

test('duplicate flattened leaves are rejected per version', async () => {
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await client.query(
      `insert into "composition_leaf"
         ("version_id", "tenant_id", "property_id", "resource_id", "depth")
       values ($1, $2, $3, $4, 1)`,
      [compositionDraft, tenantA, propertyA, roomA],
    );
    await expect(
      client.query(
        `insert into "composition_leaf"
           ("version_id", "tenant_id", "property_id", "resource_id", "depth")
         values ($1, $2, $3, $4, 2)`,
        [compositionDraft, tenantA, propertyA, roomA],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await client.query('rollback');
  });
});

test('worker role cannot write compositions or view other tenants', async () => {
  await withRuntimeRole('worker', async (client) => {
    const count = await client.query(
      `select count(*)::int as count from "composition_version"`,
    );
    expect(count.rows[0].count).toBe(0);
    await probeFail(
      client,
      tenantA,
      `update "composition_version" set "status" = 'RETIRED' where "id" = $1`,
      [compositionDraft],
      '42501',
    );
  });
});
