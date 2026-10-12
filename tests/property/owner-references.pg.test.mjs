import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll } from '@jest/globals';
import { withOwner, withTestRole } from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
const tenantB = process.env.IDENTITY_TENANT_B;

let propertyA;
let propertyB;
let grantId;

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
  propertyA = randomUUID();
  propertyB = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'P4-A', 'P4 Property A', 'Asia/Jakarta'),
              ($3, $4, 'P4-B', 'P4 Property B', 'Asia/Jakarta')`,
      [propertyA, tenantA, propertyB, tenantB],
    );
  });
});

test('grant_property references a real property of the same tenant', async () => {
  await withTestRole(async (client) => {
    await begin(client, tenantA);
    const membership = await client.query(
      `select "id" from "membership" where "tenant_id" = $1 limit 1`,
      [tenantA],
    );
    const role = await client.query(
      `select "id" from "role" where "tenant_id" = $1 limit 1`,
      [tenantA],
    );
    const grant = await client.query(
      `insert into "role_grant"
         ("tenant_id", "membership_id", "role_id", "effect", "scope_type")
       values ($1, $2, $3, 'GRANT', 'PROPERTIES')
       returning "id"`,
      [tenantA, membership.rows[0].id, role.rows[0].id],
    );
    grantId = grant.rows[0].id;
    await client.query('commit');

    await begin(client, tenantA);
    const valid = await client.query(
      `insert into "grant_property" ("grant_id", "tenant_id", "property_ref")
       values ($1, $2, $3)`,
      [grantId, tenantA, propertyA],
    );
    expect(valid.rowCount).toBe(1);
    await client.query('rollback');

    await probeFail(
      client,
      tenantA,
      `insert into "grant_property" ("grant_id", "tenant_id", "property_ref")
       values ($1, $2, $3)`,
      [grantId, tenantA, randomUUID()],
      '23503',
    );
    await probeFail(
      client,
      tenantA,
      `insert into "grant_property" ("grant_id", "tenant_id", "property_ref")
       values ($1, $2, $3)`,
      [grantId, tenantA, propertyB],
      '23503',
    );
  });

  const validated = await withOwner(async (client) => {
    const result = await client.query(`
      select "convalidated" from "pg_constraint"
       where "conname" = 'grant_property_property_fk'
    `);
    return result.rows[0]?.convalidated;
  });
  expect(validated).toBe(true);
});

test('distribution connections reference a real property with legacy tolerance documented', async () => {
  await withTestRole(async (client) => {
    await begin(client, tenantA);
    const valid = await client.query(
      `insert into "distribution_connection"
         ("id", "tenant_id", "property_id", "provider_key", "environment",
          "channel_key", "external_property_id", "secret_ref")
       values ($1, $2, $3, 'simulator', 'simulator', 'tiket-com', $4, 'secret:synthetic')`,
      [randomUUID(), tenantA, propertyA, `P4-${randomUUID().slice(0, 8)}`],
    );
    expect(valid.rowCount).toBe(1);
    await client.query('rollback');

    await probeFail(
      client,
      tenantA,
      `insert into "distribution_connection"
         ("id", "tenant_id", "property_id", "provider_key", "environment",
          "channel_key", "external_property_id", "secret_ref")
       values ($1, $2, $3, 'simulator', 'simulator', 'tiket-com', $4, 'secret:synthetic')`,
      [randomUUID(), tenantA, randomUUID(), `P4-${randomUUID().slice(0, 8)}`],
      '23503',
    );
  });

  const constraint = await withOwner(async (client) => {
    const result = await client.query(`
      select "convalidated" from "pg_constraint"
       where "conname" = 'distribution_connection_property_fk'
    `);
    return result.rows[0]?.convalidated;
  });
  expect(constraint).toBe(false);
});
