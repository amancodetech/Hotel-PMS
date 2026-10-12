import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { Client } from 'pg';
import {
  legacyAckFixture,
  legacyAckSeedStatements,
} from '../tests/distribution/integration/legacy-ack-fixtures.mjs';
import {
  legacyTenantFixture,
  legacyTenantSeedStatements,
} from '../tests/distribution/integration/legacy-tenant-fixtures.mjs';

const appUrl = process.env.DATABASE_URL;
if (!appUrl)
  throw new Error(
    'DATABASE_URL is required; run through pnpm test:distribution',
  );

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const databases = {
  new: `hotel_test_${runId}_new`,
  legacy: `hotel_test_${runId}_legacy`,
  legacyAck: `hotel_test_${runId}_legacy_ack`,
  legacyTenant: `hotel_test_${runId}_legacy_tenant`,
};
const coreMigration = 'Migration20260913120000_distribution_core';

function urlFor(name) {
  const url = new URL(appUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin(task) {
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.end();
  }
}

async function recreate() {
  await admin(async (client) => {
    for (const name of Object.values(databases)) {
      await client.query(`create database "${name}"`);
    }
  });
  const legacy = new Client({ connectionString: urlFor(databases.legacy) });
  await legacy.connect();
  try {
    await legacy.query(
      `create table "synthetic_legacy_marker" ("id" integer primary key, "note" text not null)`,
    );
    await legacy.query(
      `insert into "synthetic_legacy_marker" ("id", "note") values (1, 'pre-migration-synthetic')`,
    );
  } finally {
    await legacy.end();
  }
}

function migrate(name, { to } = {}) {
  const args = [
    'node_modules/@mikro-orm/cli/cli.js',
    'migration:up',
    '--config',
    'dist/persistence/mikro-orm.config.js',
  ];
  if (to) args.push(`--to=${to}`);
  execFileSync(process.execPath, args, {
    cwd: 'packages/backend',
    env: { ...process.env, MIGRATION_DATABASE_URL: urlFor(name) },
    stdio: 'inherit',
    timeout: 180000,
  });
}

async function seedLegacyAck(name) {
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    for (const statement of legacyAckSeedStatements())
      await client.query(statement);
  } finally {
    await client.end();
  }
}

async function seedLegacyAckTenant(name) {
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    await client.query(
      `insert into "tenant" ("id", "name", "slug")
       values ($1, 'Legacy ACK Tenant', 'legacy-ack-tenant')
       on conflict ("id") do nothing`,
      [legacyAckFixture.tenantId],
    );
  } finally {
    await client.end();
  }
}

async function seedLegacyTenant(name) {
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    for (const statement of legacyTenantSeedStatements())
      await client.query(statement);
  } finally {
    await client.end();
  }
}

async function verifyLegacyTenant(name) {
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    const conflicts = await client.query(
      `select "row_id", "details_safe" ->> 'reason' as reason
         from "distribution_consistency_conflict"
        where "row_id" = any($1::uuid[])
        order by "row_id"`,
      [
        [
          legacyTenantFixture.mixedOutbox,
          legacyTenantFixture.mixedInbox,
          legacyTenantFixture.orphanConnection,
        ],
      ],
    );
    if (conflicts.rowCount !== 3)
      throw new Error(
        `Expected 3 quarantine conflicts, found ${conflicts.rowCount}`,
      );
    const constraints = await client.query(
      `select "conname", "convalidated" from "pg_constraint"
        where "conname" in (
          'distribution_connection_tenant_fk',
          'distribution_outbox_connection_tenant_fk',
          'distribution_inbox_exception_tenant_fk'
        )`,
    );
    const validated = Object.fromEntries(
      constraints.rows.map((row) => [row.conname, row.convalidated]),
    );
    if (validated.distribution_connection_tenant_fk !== false)
      throw new Error('Orphan connection Tenant FK must stay NOT VALID');
    if (validated.distribution_outbox_connection_tenant_fk !== false)
      throw new Error('Mixed outbox Tenant FK must stay NOT VALID');
    if (validated.distribution_inbox_exception_tenant_fk !== false)
      throw new Error('Mixed inbox Tenant FK must stay NOT VALID');
    return conflicts.rowCount;
  } finally {
    await client.end();
  }
}

async function verify(
  name,
  { expectMarker = false, expectLegacyAck = false } = {},
) {
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    const tables = await client.query(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = new Set(tables.rows.map((row) => row.table_name));
    for (const required of [
      'distribution_connection',
      'distribution_inbox_revision',
      'distribution_outbox_event',
      'distribution_sync_attempt',
      'distribution_dedup_key',
      'distribution_sync_checkpoint',
      'distribution_exception_case',
      'distribution_dead_letter',
    ])
      if (!names.has(required))
        throw new Error(`Missing ${required} in ${name}`);
    if (expectMarker) {
      const marker = await client.query(
        `select note from "synthetic_legacy_marker" where id = 1`,
      );
      if (marker.rows[0]?.note !== 'pre-migration-synthetic')
        throw new Error('Legacy synthetic marker was lost');
    }
    if (expectLegacyAck) {
      const columns = await client.query(
        `select column_name from information_schema.columns
         where table_name = 'distribution_inbox_revision'
           and column_name in ('ack_lease_expires_at','ack_lease_token','ack_exception_id')`,
      );
      if (columns.rowCount !== 3)
        throw new Error(
          'Legacy ACK upgrade did not add lease/exception columns',
        );
      const revisions = await client.query(
        `select count(*)::int as count from "distribution_inbox_revision"`,
      );
      if (revisions.rows[0]?.count !== 7)
        throw new Error('Legacy ACK seed data was lost during upgrade');
    }
    return names.size;
  } finally {
    await client.end();
  }
}

async function dropDatabases() {
  await admin(async (client) => {
    for (const name of Object.values(databases))
      await client.query(`drop database if exists "${name}" with (force)`);
  });
  for (const name of Object.values(databases))
    rmSync(
      `packages/backend/src/persistence/migrations/.snapshot-${name}.json`,
      { force: true },
    );
}

let exitCode;
try {
  await recreate();
  migrate(databases.legacyAck, { to: coreMigration });
  await seedLegacyAck(databases.legacyAck);
  migrate(databases.legacyAck, {
    to: 'Migration20260913170000_identity_flow_state_columns',
  });
  await seedLegacyAckTenant(databases.legacyAck);
  migrate(databases.legacyTenant, {
    to: 'Migration20260913170000_identity_flow_state_columns',
  });
  await seedLegacyTenant(databases.legacyTenant);
  migrate(databases.new);
  migrate(databases.legacy);
  migrate(databases.legacyAck);
  migrate(databases.legacyTenant);
  const newTables = await verify(databases.new);
  await verify(databases.legacy, { expectMarker: true });
  await verify(databases.legacyAck, { expectLegacyAck: true });
  const quarantined = await verifyLegacyTenant(databases.legacyTenant);
  console.log(
    `PASS: migrations applied to a new database (${newTables} public tables), to a database with synthetic data, to a pre-migration ACK database upgraded from ${coreMigration}, and to a pre-consistency distribution database (${quarantined} quarantined references); seed data preserved.`,
  );
  const filterArg = process.argv
    .find((value) => value.startsWith('--filter='))
    ?.slice('--filter='.length);
  const bail = process.argv.includes('--bail');
  const jest = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      'node_modules/jest/bin/jest.js',
      '--config',
      'jest.distribution.config.mjs',
      '--runInBand',
      ...(bail ? ['--bail=1'] : []),
      ...(filterArg ? [filterArg] : []),
    ],
    {
      env: {
        ...process.env,
        TEST_DATABASE_URL: urlFor(databases.new),
        TEST_LEGACY_DATABASE_URL: urlFor(databases.legacy),
        TEST_LEGACY_ACK_DATABASE_URL: urlFor(databases.legacyAck),
        TEST_LEGACY_TENANT_DATABASE_URL: urlFor(databases.legacyTenant),
        TEST_ROLE_DATABASE_URL: process.env.TEST_DATABASE_URL,
      },
      stdio: 'inherit',
      timeout: 300000,
    },
  );
  exitCode = jest.status ?? 1;
} finally {
  if (process.argv.includes('--keep'))
    console.log('Keeping test databases for inspection (--keep).');
  else await dropDatabases();
}
process.exitCode = exitCode ?? 1;
