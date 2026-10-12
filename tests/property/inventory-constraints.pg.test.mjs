import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  startApi,
  stopApi,
  withOwner,
  withRuntimeRole,
} from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
const tenantB = process.env.IDENTITY_TENANT_B;

let propertyA;
let propertyB;
let resourceA;
let resourceB;
let commitmentA;
let connectionA;
let productA;

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function shift(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

beforeAll(async () => {
  await startApi();
  propertyA = randomUUID();
  propertyB = randomUUID();
  resourceA = randomUUID();
  resourceB = randomUUID();
  commitmentA = randomUUID();
  connectionA = randomUUID();
  productA = randomUUID();
  await withOwner(async (client) => {
    for (const [propertyId, tenantId, code] of [
      [propertyA, tenantA, 'CON-A'],
      [propertyB, tenantB, 'CON-B'],
    ]) {
      await client.query(
        `insert into "property"
           ("id", "tenant_id", "code", "name", "timezone", "base_currency", "limits_profile_id")
         values ($1, $2, $3, $3, 'Asia/Jakarta', 'IDR',
                 (select "id" from "property_limits_profile" where "code" = 'PERF-01'))`,
        [propertyId, tenantId, code],
      );
    }
    await client.query(
      `insert into "resource"
         ("id", "tenant_id", "property_id", "code", "resource_type", "capacity")
       values ($1, $2, $3, 'CON-R1', 'ROOM', 2),
              ($4, $2, $3, 'CON-R2', 'ROOM', 2),
              ($5, $6, $7, 'CON-R3', 'ROOM', 2)`,
      [
        resourceA,
        tenantA,
        propertyA,
        randomUUID(),
        resourceB,
        tenantB,
        propertyB,
      ],
    );
    await client.query(
      `insert into "commitment"
         ("id", "tenant_id", "property_id", "source_kind", "source_id", "expires_at", "inventory_version")
       values ($1, $2, $3, 'HOLD', $1, now() + interval '1 hour', 1)`,
      [commitmentA, tenantA, propertyA],
    );
    await client.query(
      `insert into "product"
         ("id", "tenant_id", "property_id", "code", "name", "kind")
       values ($1, $2, $3, 'CON-P1', 'Constraints product', 'ROOM')`,
      [productA, tenantA, propertyA],
    );
    await client.query(
      `insert into "distribution_connection"
         ("id", "tenant_id", "property_id", "provider_key", "environment",
          "channel_key", "external_property_id", "secret_ref")
       values ($1, $2, $3, 'CHANNEX', 'STAGING', 'BOOKING_COM', 'con-ext', 'local:con')`,
      [connectionA, tenantA, propertyA],
    );
  });
});

test('active allocations cannot overlap for the same resource', async () => {
  await withOwner(async (client) => {
    await client.query(
      `insert into "plan_allocation"
         ("id", "commitment_id", "tenant_id", "property_id", "resource_id", "start_date", "end_date")
       values ($1, $2, $3, $4, $5, $6::date, $7::date)`,
      [
        randomUUID(),
        commitmentA,
        tenantA,
        propertyA,
        resourceA,
        shift(1),
        shift(3),
      ],
    );
    await expect(
      client.query(
        `insert into "plan_allocation"
           ("id", "commitment_id", "tenant_id", "property_id", "resource_id", "start_date", "end_date")
         values ($1, $2, $3, $4, $5, $6::date, $7::date)`,
        [
          randomUUID(),
          commitmentA,
          tenantA,
          propertyA,
          resourceA,
          shift(2),
          shift(4),
        ],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
    await client.query(
      `insert into "plan_allocation"
         ("id", "commitment_id", "tenant_id", "property_id", "resource_id", "start_date", "end_date")
       values ($1, $2, $3, $4, $5, $6::date, $7::date)`,
      [
        randomUUID(),
        commitmentA,
        tenantA,
        propertyA,
        resourceA,
        shift(3),
        shift(5),
      ],
    );
    await client.query(
      `update "plan_allocation" set "state" = 'RELEASED'
        where "commitment_id" = $1`,
      [commitmentA],
    );
    await client.query(
      `insert into "plan_allocation"
         ("id", "commitment_id", "tenant_id", "property_id", "resource_id", "start_date", "end_date")
       values ($1, $2, $3, $4, $5, $6::date, $7::date)`,
      [
        randomUUID(),
        commitmentA,
        tenantA,
        propertyA,
        resourceA,
        shift(2),
        shift(4),
      ],
    );
  });
});

test('reserved exposure allocations cannot overlap on the same resource', async () => {
  await withOwner(async (client) => {
    const exposureOne = randomUUID();
    const exposureTwo = randomUUID();
    for (const exposureId of [exposureOne, exposureTwo]) {
      await client.query(
        `insert into "exposure"
           ("id", "tenant_id", "property_id", "connection_id", "product_id",
            "start_date", "end_date", "mode", "state", "inventory_version")
         values ($1, $2, $3, $4, $5, $6::date, $7::date, 'PARTS', 'PUBLISHING', 1)`,
        [
          exposureId,
          tenantA,
          propertyA,
          connectionA,
          productA,
          shift(10),
          shift(14),
        ],
      );
    }
    await client.query(
      `insert into "exposure_allocation"
         ("id", "exposure_id", "tenant_id", "property_id", "resource_id", "start_date", "end_date")
       values ($1, $2, $3, $4, $5, $6::date, $7::date)`,
      [
        randomUUID(),
        exposureOne,
        tenantA,
        propertyA,
        resourceA,
        shift(10),
        shift(12),
      ],
    );
    await expect(
      client.query(
        `insert into "exposure_allocation"
           ("id", "exposure_id", "tenant_id", "property_id", "resource_id", "start_date", "end_date")
         values ($1, $2, $3, $4, $5, $6::date, $7::date)`,
        [
          randomUUID(),
          exposureTwo,
          tenantA,
          propertyA,
          resourceA,
          shift(11),
          shift(13),
        ],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });
});

test('independent properties do not share a lock row', async () => {
  const first = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  const second = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await first.connect();
  await second.connect();
  try {
    await first.query(`set lock_timeout = '500ms'`);
    await second.query(`set lock_timeout = '500ms'`);
    await first.query('begin');
    await second.query('begin');
    await Promise.all([
      first.query('select "id" from "property" where "id" = $1 for update', [
        propertyA,
      ]),
      second.query('select "id" from "property" where "id" = $1 for update', [
        propertyB,
      ]),
    ]);
    await first.query('commit');
    await second.query('commit');
  } finally {
    await first.end();
    await second.end();
  }
});

test('runtime roles stay least privileged on guarantee tables', async () => {
  await withRuntimeRole('worker', async (client) => {
    await expect(
      client.query(
        `insert into "plan_allocation"
           ("id", "commitment_id", "tenant_id", "property_id", "resource_id", "start_date", "end_date")
         values (gen_random_uuid(), $1, $2, $3, $4, $5::date, $6::date)`,
        [commitmentA, tenantA, propertyA, resourceB, shift(20), shift(21)],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  await withRuntimeRole('api', async (client) => {
    await expect(
      client.query('delete from "plan_allocation" where "tenant_id" = $1', [
        tenantA,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      client.query(`delete from "exposure_allocation" where "tenant_id" = $1`, [
        tenantA,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

afterAll(async () => {
  await stopApi();
});
