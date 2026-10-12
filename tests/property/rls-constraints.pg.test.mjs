import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll } from '@jest/globals';
import {
  withOwner,
  withRuntimeRole,
  withTestRole,
} from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
const tenantB = process.env.IDENTITY_TENANT_B;

let propertyA1;
let propertyA2;
let propertyB1;
let locationA1;
let locationB1;
let groupB1;

async function begin(client, tenantId) {
  await client.query('begin');
  await client.query("select set_config('app.tenant_id', $1, true)", [
    tenantId,
  ]);
}

async function probeFail(client, tenantId, sql, params, code) {
  await begin(client, tenantId);
  try {
    await expect(client.query(sql, params)).rejects.toMatchObject({ code });
  } finally {
    await client.query('rollback');
  }
}

beforeAll(async () => {
  propertyA1 = randomUUID();
  propertyA2 = randomUUID();
  propertyB1 = randomUUID();
  locationA1 = randomUUID();
  locationB1 = randomUUID();
  groupB1 = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "property_group" ("id", "tenant_id", "code", "name")
       values ($1, $2, 'GRP-B', 'Group B')`,
      [groupB1, tenantB],
    );
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'PA1', 'Property A1', 'Asia/Jakarta'),
              ($3, $2, 'PA2', 'Property A2', 'Asia/Makassar')`,
      [propertyA1, tenantA, propertyA2],
    );
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'PB1', 'Property B1', 'Asia/Jayapura')`,
      [propertyB1, tenantB],
    );
    await client.query(
      `insert into "location" ("id", "tenant_id", "property_id", "code", "name")
       values ($1, $2, $3, 'BLK-A', 'Block A')`,
      [locationA1, tenantA, propertyA1],
    );
    await client.query(
      `insert into "location" ("id", "tenant_id", "property_id", "code", "name")
       values ($1, $2, $3, 'BLK-B', 'Block B')`,
      [locationB1, tenantB, propertyB1],
    );
    await client.query(
      `insert into "resource"
         ("id", "tenant_id", "property_id", "code", "resource_type", "capacity", "location_id")
       values ($1, $2, $3, 'R-001', 'ROOM', 2, $4)`,
      [randomUUID(), tenantA, propertyA1, locationA1],
    );
  });
});

test('phase 4 tenant tables force RLS and stay outside runtime role ownership', async () => {
  const inventory = await withOwner(async (client) => {
    const tables = await client.query(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
             pg_get_userbyid(c.relowner) as owner
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('property_group', 'property', 'location', 'resource',
                           'resource_type', 'property_limits_profile')
    `);
    const privileges = await client.query(`
      select
        has_table_privilege('hotel_api', 'resource', 'delete') as api_delete,
        has_table_privilege('hotel_api', 'resource', 'update') as api_update,
        has_table_privilege('hotel_worker', 'resource', 'select') as worker_select,
        has_table_privilege('hotel_worker', 'resource', 'insert') as worker_insert
    `);
    return { tables: tables.rows, privileges: privileges.rows[0] };
  });
  const byName = Object.fromEntries(
    inventory.tables.map((row) => [row.relname, row]),
  );
  for (const table of ['property_group', 'property', 'location', 'resource']) {
    expect(byName[table].relrowsecurity).toBe(true);
    expect(byName[table].relforcerowsecurity).toBe(true);
    expect(['hotel_api', 'hotel_worker', 'hotel_test']).not.toContain(
      byName[table].owner,
    );
  }
  expect(byName['resource_type'].relrowsecurity).toBe(false);
  expect(byName['property_limits_profile'].relrowsecurity).toBe(false);
  expect(inventory.privileges.api_delete).toBe(false);
  expect(inventory.privileges.api_update).toBe(true);
  expect(inventory.privileges.worker_select).toBe(true);
  expect(inventory.privileges.worker_insert).toBe(false);
});

test('without tenant context phase 4 tables are invisible and reject writes', async () => {
  await withTestRole(async (client) => {
    for (const table of [
      'property_group',
      'property',
      'location',
      'resource',
    ]) {
      const result = await client.query(
        `select count(*)::int as count from "${table}"`,
      );
      expect(result.rows[0].count).toBe(0);
    }
    await expect(
      client.query(
        `insert into "property" ("tenant_id", "code", "name", "timezone")
         values ($1, 'NO-CTX', 'No context', 'Asia/Jakarta')`,
        [tenantA],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

test('cross-tenant reads and writes are blocked and tenant_id is immutable', async () => {
  await withTestRole(async (client) => {
    await begin(client, tenantA);
    const read = await client.query(
      'select count(*)::int as count from "property" where "tenant_id" = $1',
      [tenantB],
    );
    expect(read.rows[0].count).toBe(0);
    const update = await client.query(
      `update "property" set "name" = 'Hijack'
        where "id" = $1 and "tenant_id" = $2`,
      [propertyB1, tenantB],
    );
    expect(update.rowCount).toBe(0);
    const remove = await client.query(
      'delete from "property" where "tenant_id" = $1',
      [tenantB],
    );
    expect(remove.rowCount).toBe(0);
    await client.query('rollback');

    await probeFail(
      client,
      tenantA,
      `insert into "property" ("tenant_id", "code", "name", "timezone")
       values ($1, 'CROSS', 'Cross tenant', 'Asia/Jakarta')`,
      [tenantB],
      '42501',
    );
    await probeFail(
      client,
      tenantA,
      `update "property" set "tenant_id" = $1 where "id" = $2`,
      [tenantB, propertyA1],
      '42501',
    );
  });
});

test('composite foreign keys reject cross-property and cross-tenant references', async () => {
  await withOwner(async (client) => {
    await expect(
      client.query(
        `insert into "resource"
           ("tenant_id", "property_id", "code", "resource_type", "capacity")
         values ($1, $2, 'X-001', 'ROOM', 2)`,
        [tenantB, propertyA1],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      client.query(
        `insert into "resource"
           ("tenant_id", "property_id", "code", "resource_type", "capacity", "location_id")
         values ($1, $2, 'X-002', 'ROOM', 2, $3)`,
        [tenantA, propertyA1, locationB1],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      client.query(
        `insert into "property" ("tenant_id", "group_id", "code", "name", "timezone")
         values ($1, $2, 'CROSS-GRP', 'Cross group', 'Asia/Jakarta')`,
        [tenantA, groupB1],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

test('local codes stay unique per property and checks reject invalid values', async () => {
  await withTestRole(async (client) => {
    await probeFail(
      client,
      tenantA,
      `insert into "resource"
         ("tenant_id", "property_id", "code", "resource_type", "capacity")
       values ($1, $2, 'R-001', 'BED', 1)`,
      [tenantA, propertyA1],
      '23505',
    );
    await begin(client, tenantA);
    const sameCodeOtherProperty = await client.query(
      `insert into "resource"
         ("tenant_id", "property_id", "code", "resource_type", "capacity")
       values ($1, $2, 'R-001', 'BED', 1)
       returning "id"`,
      [tenantA, propertyA2],
    );
    expect(sameCodeOtherProperty.rowCount).toBe(1);
    await client.query('rollback');

    await probeFail(
      client,
      tenantA,
      `insert into "resource"
         ("tenant_id", "property_id", "code", "resource_type", "capacity")
       values ($1, $2, 'R-BAD', 'ROOM', 0)`,
      [tenantA, propertyA1],
      '23514',
    );
    await probeFail(
      client,
      tenantA,
      `insert into "property" ("tenant_id", "code", "name", "timezone")
       values ($1, 'TZ-BAD', 'Bad timezone', 'Asia/Tokyo')`,
      [tenantA],
      '23514',
    );
    await probeFail(
      client,
      tenantA,
      `insert into "property" ("tenant_id", "code", "name", "timezone", "base_currency")
       values ($1, 'CCY-BAD', 'Bad currency', 'Asia/Jakarta', 'EUR')`,
      [tenantA],
      '23514',
    );
  });
});

test('runtime roles cannot delete property data', async () => {
  await withRuntimeRole('api', async (client) => {
    await probeFail(
      client,
      tenantA,
      'delete from "resource" where "property_id" = $1',
      [propertyA1],
      '42501',
    );
  });
  await withRuntimeRole('worker', async (client) => {
    await begin(client, tenantA);
    const read = await client.query(
      `select count(*)::int as count from "resource" where "property_id" = $1`,
      [propertyA1],
    );
    expect(read.rows[0].count).toBeGreaterThan(0);
    await client.query('rollback');
    await probeFail(
      client,
      tenantA,
      `insert into "resource"
         ("tenant_id", "property_id", "code", "resource_type", "capacity")
       values ($1, $2, 'W-001', 'ROOM', 1)`,
      [tenantA, propertyA1],
      '42501',
    );
  });
});
