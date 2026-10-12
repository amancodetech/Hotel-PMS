import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import {
  createOrm,
  distribution,
  runScopedTransaction,
} from '../../packages/backend/dist/index.js';
import {
  apiDatabaseUrl,
  testDatabaseUrl,
  withOwner,
  withRuntimeRole,
  withTestRole,
  workerDatabaseUrl,
} from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
const tenantB = process.env.IDENTITY_TENANT_B;
const propertyA = '66666666-6666-4666-8666-666666666666';

let workerOrm;

beforeAll(async () => {
  workerOrm = await createOrm(workerDatabaseUrl(), {
    pool: { min: 0, max: 2 },
  });
});

afterAll(async () => {
  await workerOrm?.close(true);
});

test('all tenant tables force RLS and runtime roles own nothing', async () => {
  const inventory = await withOwner(async (client) => {
    const tables = await client.query(`
      select c.relname,
             c.relrowsecurity,
             c.relforcerowsecurity,
             pg_get_userbyid(c.relowner) as owner
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
    `);
    const roles = await client.query(`
      select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
        from pg_roles
       where rolname in ('hotel_api', 'hotel_worker', 'hotel_test')
    `);
    return { tables: tables.rows, roles: roles.rows };
  });
  const byName = Object.fromEntries(
    inventory.tables.map((row) => [row.relname, row]),
  );
  const tenantTables = [
    'tenant',
    'membership',
    'role',
    'role_permission',
    'role_grant',
    'grant_property',
    'invitation',
    'approval_request',
    'audit_event',
    'distribution_connection',
    'distribution_channel_capability',
    'distribution_mapping_version',
    'distribution_external_booking',
    'distribution_exception_case',
    'distribution_inbox_revision',
    'distribution_dedup_key',
    'distribution_outbox_event',
    'distribution_sync_attempt',
    'distribution_sync_checkpoint',
    'distribution_dead_letter',
  ];
  for (const table of tenantTables) {
    expect(byName[table]).toBeTruthy();
    expect(byName[table].relrowsecurity).toBe(true);
    expect(byName[table].relforcerowsecurity).toBe(true);
  }
  for (const table of [
    'app_user',
    'auth_session',
    'auth_flow',
    'permission',
    'mikro_orm_migrations',
  ]) {
    expect(byName[table].relrowsecurity).toBe(false);
  }
  for (const role of inventory.roles) {
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
    expect(role.rolcreatedb).toBe(false);
    expect(role.rolcreaterole).toBe(false);
  }
  for (const row of inventory.tables)
    expect(['hotel_api', 'hotel_worker', 'hotel_test']).not.toContain(
      row.owner,
    );
});

test('without tenant context tenant tables are invisible and reject writes', async () => {
  await withTestRole(async (client) => {
    for (const table of [
      'tenant',
      'membership',
      'role',
      'role_grant',
      'invitation',
      'approval_request',
      'audit_event',
      'distribution_connection',
      'distribution_outbox_event',
    ]) {
      const result = await client.query(
        `select count(*)::int as count from "${table}"`,
      );
      expect(result.rows[0].count).toBe(0);
    }
    await expect(
      client.query(
        'insert into "role" ("id", "tenant_id", "code", "name") values ($1, $2, $3, $4)',
        [randomUUID(), tenantA, 'NO_CTX_ROLE', 'No context role'],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

test('cross-tenant read, update and delete are blocked and tenant_id is immutable', async () => {
  const tenantX = randomUUID();
  const userId = randomUUID();
  const roleId = randomUUID();
  const membershipId = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "tenant" ("id", "name", "slug") values ($1, 'RLS X', $2)`,
      [tenantX, `rls-x-${tenantX.slice(0, 8)}`],
    );
    await client.query(
      `insert into "app_user" ("id", "identity_subject", "issuer", "email")
       values ($1, $2, 'http://local.test/issuer', 'rls-x@local.test')`,
      [userId, `rls-x-${tenantX.slice(0, 8)}`],
    );
    await client.query(
      `insert into "role" ("id", "tenant_id", "code", "name")
       values ($1, $2, 'RLS_ROLE', 'RLS role')`,
      [roleId, tenantX],
    );
    await client.query(
      `insert into "membership" ("id", "tenant_id", "user_id", "status")
       values ($1, $2, $3, 'ACTIVE')`,
      [membershipId, tenantX, userId],
    );
  });

  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantB,
    ]);
    const read = await client.query(
      'select count(*)::int as count from "membership" where tenant_id = $1',
      [tenantX],
    );
    expect(read.rows[0].count).toBe(0);
    const updated = await client.query(
      `update "membership" set "status" = 'SUSPENDED' where id = $1`,
      [membershipId],
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await client.query(
      'delete from "membership" where id = $1',
      [membershipId],
    );
    expect(deleted.rowCount).toBe(0);
    await expect(
      client.query(
        'insert into "membership" ("id", "tenant_id", "user_id", "status") values ($1, $2, $3, $4)',
        [randomUUID(), tenantX, userId, 'ACTIVE'],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });

  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantX,
    ]);
    const own = await client.query(
      'select id from "membership" where id = $1',
      [membershipId],
    );
    expect(own.rowCount).toBe(1);
    await expect(
      client.query('update "membership" set tenant_id = $1 where id = $2', [
        tenantB,
        membershipId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });
});

test('transaction-local context does not leak through a pooled connection', async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  try {
    await pool.query('begin');
    await pool.query("select set_config('app.tenant_id', $1, true)", [tenantA]);
    const inside = await pool.query('select id from "tenant" limit 1');
    expect(inside.rows[0]?.id).toBe(tenantA);
    await pool.query('rollback');
    const afterRollback = await pool.query(
      'select count(*)::int as count from "tenant"',
    );
    expect(afterRollback.rows[0].count).toBe(0);

    await pool.query('begin');
    await pool.query("select set_config('app.tenant_id', $1, true)", [tenantB]);
    const tenantBRows = await pool.query('select id from "tenant" limit 5');
    expect(tenantBRows.rows.every((row) => row.id === tenantB)).toBe(true);
    await pool.query('commit');
    const afterCommit = await pool.query(
      'select count(*)::int as count from "tenant"',
    );
    expect(afterCommit.rows[0].count).toBe(0);
  } finally {
    await pool.end();
  }
});

test('two concurrent sessions never exchange tenant rows', async () => {
  const first = new Client({ connectionString: testDatabaseUrl });
  const second = new Client({ connectionString: testDatabaseUrl });
  await first.connect();
  await second.connect();
  try {
    await first.query('begin');
    await first.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await second.query('begin');
    await second.query("select set_config('app.tenant_id', $1, true)", [
      tenantB,
    ]);
    const firstName = await first.query('select name from "tenant" limit 1');
    const secondName = await second.query('select name from "tenant" limit 1');
    expect(firstName.rows[0].name).toContain('P03 Synthetic Tenant A');
    expect(secondName.rows[0].name).toContain('P03 Synthetic Tenant B');
    const cross = await first.query(
      'select count(*)::int as count from "tenant" where id = $1',
      [tenantB],
    );
    expect(cross.rows[0].count).toBe(0);
    await first.query('commit');
    await second.query('rollback');
  } finally {
    await first.end();
    await second.end();
  }
});

test('distribution tables inherit isolation from their connection parent', async () => {
  const connectionA = randomUUID();
  const inboxA = randomUUID();
  const outboxA = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'RLS-DIST-A', 'RLS distribution A', 'Asia/Jakarta')
       on conflict do nothing`,
      [propertyA, tenantA],
    );
  });
  await runScopedTransaction(workerOrm, { tenantId: tenantA }, async (em) => {
    await em.execute(
      `insert into "distribution_connection"
         ("id", "tenant_id", "property_id", "provider_key", "environment",
          "channel_key", "external_property_id", "secret_ref")
       values (?, ?, ?, 'simulator', 'simulator', 'tiket-com', ?, 'secret:synthetic')`,
      [connectionA, tenantA, propertyA, `RLS-EXT-${connectionA.slice(0, 8)}`],
    );
    await em.execute(
      `insert into "distribution_inbox_revision"
         ("id", "connection_id", "property_id", "channel_key", "provider_key",
          "environment", "provider_revision_id", "external_booking_id",
          "revision_type", "payload_hash", "payload_safe", "received_at")
       values (?, ?, ?, 'tiket-com', 'simulator', 'simulator', ?, 'RLS-BOOKING',
               'new', repeat('a', 64), '{}'::jsonb, now())`,
      [inboxA, connectionA, propertyA, `RLS-REV-${connectionA.slice(0, 8)}`],
    );
    await em.execute(
      `insert into "distribution_dedup_key"
         ("id", "scope", "dedup_key", "inbox_revision_id")
       values (?, 'rls', ?, ?)`,
      [randomUUID(), `RLS-DEDUP-${connectionA.slice(0, 8)}`, inboxA],
    );
    await em.execute(
      `insert into "distribution_outbox_event"
         ("id", "tenant_id", "property_id", "connection_id", "channel_key",
          "aggregate_type", "aggregate_id", "event_type", "event_version",
          "inventory_version", "payload_safe")
       values (?, ?, ?, ?, 'tiket-com', 'inventory', ?, 'AvailabilitySnapshot',
               1, 1, '{"cells":[]}'::jsonb)`,
      [outboxA, tenantA, propertyA, connectionA, randomUUID()],
    );
    await em.execute(
      `insert into "distribution_sync_attempt"
         ("id", "outbox_id", "attempt_no", "status", "started_at")
       values (?, ?, 1, 'STARTED', now())`,
      [randomUUID(), outboxA],
    );
    await em.execute(
      `insert into "distribution_sync_checkpoint"
         ("id", "connection_id", "stream")
       values (?, ?, 'revisions')`,
      [randomUUID(), connectionA],
    );
  });

  await runScopedTransaction(workerOrm, { tenantId: tenantA }, async (em) => {
    const connections = await em.execute(
      'select id from "distribution_connection"',
    );
    const inbox = await em.execute(
      'select id from "distribution_inbox_revision"',
    );
    const dedup = await em.execute('select id from "distribution_dedup_key"');
    const outbox = await em.execute(
      'select id from "distribution_outbox_event"',
    );
    expect(connections.length).toBeGreaterThan(0);
    expect(inbox.length).toBe(1);
    expect(dedup.length).toBe(1);
    expect(outbox.length).toBe(1);
  });

  await runScopedTransaction(workerOrm, { tenantId: tenantB }, async (em) => {
    const inbox = await em.execute(
      'select id from "distribution_inbox_revision" where id = ?',
      [inboxA],
    );
    const outbox = await em.execute(
      'select id from "distribution_outbox_event" where id = ?',
      [outboxA],
    );
    expect(inbox.length).toBe(0);
    expect(outbox.length).toBe(0);
  });

  await expect(
    runScopedTransaction(workerOrm, { tenantId: tenantB }, async (em) => {
      await em.execute(
        `insert into "distribution_inbox_revision"
           ("id", "connection_id", "channel_key", "provider_key", "environment",
            "provider_revision_id", "external_booking_id", "revision_type",
            "payload_hash", "payload_safe", "received_at")
         values (?, ?, 'tiket-com', 'simulator', 'simulator', ?, 'RLS-X', 'new',
                 repeat('b', 64), '{}'::jsonb, now())`,
        [randomUUID(), connectionA, `RLS-X-${connectionA.slice(0, 8)}`],
      );
    }),
  ).rejects.toMatchObject({ code: '42501' });

  const workTenants = await runScopedTransaction(workerOrm, {}, async (em) =>
    em.execute('select tenant_id from public.distribution_work_tenants()'),
  );
  expect(workTenants.map((row) => row.tenant_id)).toContain(tenantA);
});

test('distribution tenant references are enforced by composite foreign keys', async () => {
  const connectionB = randomUUID();
  const propertyB = randomUUID();
  const connectionA = randomUUID();
  const propertyA = randomUUID();
  const outboxA = randomUUID();
  const outboxB = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'R2-A', 'R2 property A', 'Asia/Jakarta'),
              ($3, $4, 'R2-B', 'R2 property B', 'Asia/Jakarta')
       on conflict do nothing`,
      [propertyA, tenantA, propertyB, tenantB],
    );
    await client.query(
      `insert into "distribution_connection"
         ("id", "tenant_id", "property_id", "provider_key", "environment",
          "channel_key", "external_property_id", "secret_ref")
       values ($1, $2, $3, 'simulator', 'simulator', 'tiket-com', $4, 'secret:synthetic'),
              ($5, $6, $7, 'simulator', 'simulator', 'tiket-com', $8, 'secret:synthetic')`,
      [
        connectionB,
        tenantB,
        propertyB,
        `R2-B-${connectionB.slice(0, 8)}`,
        connectionA,
        tenantA,
        propertyA,
        `R2-A-${connectionA.slice(0, 8)}`,
      ],
    );
    await client.query(
      `insert into "distribution_outbox_event"
         ("id", "tenant_id", "property_id", "connection_id", "channel_key",
          "aggregate_type", "aggregate_id", "event_type", "event_version",
          "inventory_version", "payload_safe")
       values ($1, $2, $3, $4, 'tiket-com', 'inventory', $5,
               'AvailabilitySnapshot', 1, 1, '{}'),
              ($6, $7, $8, $9, 'tiket-com', 'inventory', $10,
               'AvailabilitySnapshot', 1, 1, '{}')`,
      [
        outboxA,
        tenantA,
        propertyA,
        connectionA,
        randomUUID(),
        outboxB,
        tenantB,
        propertyB,
        connectionB,
        randomUUID(),
      ],
    );
  });

  await withRuntimeRole('worker', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    const rejected = async (sql, params, code) => {
      await client.query('savepoint r2_probe');
      await expect(client.query(sql, params)).rejects.toMatchObject({ code });
      await client.query('rollback to savepoint r2_probe');
    };
    await rejected(
      `insert into "distribution_outbox_event"
         ("id", "tenant_id", "property_id", "connection_id", "channel_key",
          "aggregate_type", "aggregate_id", "event_type", "event_version",
          "inventory_version", "payload_safe")
       values ($1, $2, $3, $4, 'tiket-com', 'inventory', $5,
               'AvailabilitySnapshot', 1, 1, '{}')`,
      [randomUUID(), tenantA, propertyA, connectionB, randomUUID()],
      '23503',
    );
    await rejected(
      `insert into "distribution_outbox_event"
         ("id", "property_id", "connection_id", "channel_key",
          "aggregate_type", "aggregate_id", "event_type", "event_version",
          "inventory_version", "payload_safe")
       values ($1, $2, $3, 'tiket-com', 'inventory', $4,
               'AvailabilitySnapshot', 1, 1, '{}')`,
      [randomUUID(), propertyA, connectionB, randomUUID()],
      '42501',
    );
    await rejected(
      `insert into "distribution_exception_case"
         ("id", "tenant_id", "property_id", "connection_id", "type")
       values ($1, $2, $3, $4, 'R2_MIXED')`,
      [randomUUID(), tenantA, propertyA, connectionB],
      '23503',
    );
    await rejected(
      `insert into "distribution_inbox_revision"
         ("id", "connection_id", "channel_key", "provider_key", "environment",
          "provider_revision_id", "external_booking_id", "revision_type",
          "payload_hash", "payload_safe", "received_at")
       values ($1, $2, 'tiket-com', 'simulator', 'simulator', $3, 'R2-BOOKING',
               'new', repeat('c', 64), '{}', now())`,
      [randomUUID(), connectionB, `R2-REV-${connectionB.slice(0, 8)}`],
      '42501',
    );
    await rejected(
      `insert into "distribution_dead_letter"
         ("id", "tenant_id", "property_id", "connection_id", "event_type",
          "payload_safe", "attempts", "reason")
       values ($1, $2, $3, $4, 'AvailabilitySnapshot', '{}', 1, 'R2')`,
      [randomUUID(), tenantA, propertyA, connectionB],
      '23503',
    );
    await client.query('rollback');
  });

  await withRuntimeRole('worker', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await client.query('savepoint r2_update');
    await expect(
      client.query(
        `update "distribution_outbox_event" set "connection_id" = $1 where "id" = $2`,
        [connectionB, outboxA],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await client.query('rollback to savepoint r2_update');
    await client.query('rollback');
  });

  await withRuntimeRole('worker', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantB,
    ]);
    const inbox = randomUUID();
    await client.query(
      `insert into "distribution_inbox_revision"
         ("id", "connection_id", "property_id", "channel_key", "provider_key",
          "environment", "provider_revision_id", "external_booking_id",
          "revision_type", "payload_hash", "payload_safe", "received_at")
       values ($1, $2, $3, 'tiket-com', 'simulator', 'simulator', $4, 'R2-FILL',
               'new', repeat('d', 64), '{}', now())`,
      [inbox, connectionB, propertyB, `R2-FILL-${connectionB.slice(0, 8)}`],
    );
    const filledInbox = await client.query(
      'select tenant_id from "distribution_inbox_revision" where id = $1',
      [inbox],
    );
    expect(filledInbox.rows[0].tenant_id).toBe(tenantB);
    const dedup = randomUUID();
    await client.query(
      `insert into "distribution_dedup_key"
         ("id", "scope", "dedup_key", "inbox_revision_id")
       values ($1, 'r2', $2, $3)`,
      [dedup, `R2-DEDUP-${dedup.slice(0, 8)}`, inbox],
    );
    const filledDedup = await client.query(
      'select tenant_id from "distribution_dedup_key" where id = $1',
      [dedup],
    );
    expect(filledDedup.rows[0].tenant_id).toBe(tenantB);
    await client.query(
      `insert into "distribution_sync_attempt"
         ("id", "outbox_id", "attempt_no", "status", "started_at")
       values ($1, $2, 1, 'STARTED', now())`,
      [randomUUID(), outboxB],
    );
    const filledAttempt = await client.query(
      'select tenant_id from "distribution_sync_attempt" where outbox_id = $1',
      [outboxB],
    );
    expect(filledAttempt.rows[0].tenant_id).toBe(tenantB);
    await client.query('commit');
  });

  await withRuntimeRole('worker', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await client.query('savepoint r2_attempt');
    await expect(
      client.query(
        `insert into "distribution_sync_attempt"
           ("id", "outbox_id", "attempt_no", "status", "started_at")
         values ($1, $2, 1, 'STARTED', now())`,
        [randomUUID(), outboxB],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback to savepoint r2_attempt');
    await client.query('rollback');
  });

  await withOwner(async (client) => {
    await client.query(
      'delete from "distribution_outbox_event" where "id" in ($1, $2)',
      [outboxA, outboxB],
    );
    await client.query(
      'delete from "distribution_connection" where "id" in ($1, $2)',
      [connectionA, connectionB],
    );
  });
});

test('worker runtime repository claims only the scoped tenant work', async () => {
  const claimed = await runScopedTransaction(
    workerOrm,
    { tenantId: tenantA },
    (em) =>
      distribution.leaseDueOutbox(em, {
        owner: 'rls-test-worker',
        limit: 10,
        now: new Date().toISOString(),
        leaseMs: 30_000,
      }),
  );
  expect(claimed.length).toBeGreaterThan(0);
  const wrongTenant = await runScopedTransaction(
    workerOrm,
    { tenantId: tenantB },
    (em) =>
      distribution.leaseDueOutbox(em, {
        owner: 'rls-test-worker-b',
        limit: 10,
        now: new Date().toISOString(),
        leaseMs: 30_000,
      }),
  );
  expect(wrongTenant.length).toBe(0);
});

test('least privilege: worker cannot read identity and API reads only the inbox needed by reprocess', async () => {
  await withRuntimeRole('worker', async (client) => {
    await expect(
      client.query('select count(*) from "membership"'),
    ).rejects.toMatchObject({ code: '42501' });
  });
  await withRuntimeRole('api', async (client) => {
    await expect(
      client.query('select count(*) from "distribution_inbox_revision"'),
    ).resolves.toBeDefined();
    for (const table of [
      'distribution_dead_letter',
      'distribution_consistency_conflict',
    ]) {
      await expect(
        client.query(`select count(*) from "${table}"`),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      client.query(`update "distribution_outbox_event" set "status" = 'SENT'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      client.query('delete from "distribution_outbox_event"'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      client.query('delete from "distribution_connection"'),
    ).rejects.toMatchObject({ code: '42501' });
  });
  await withRuntimeRole('api', async (client) => {
    await expect(
      client.query('update "audit_event" set outcome = \'FAILED\''),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      client.query('delete from "audit_event"'),
    ).rejects.toMatchObject({ code: '42501' });
  });
  await withRuntimeRole('worker', async (client) => {
    await expect(
      client.query(
        `insert into "audit_event"
           ("id", "tenant_id", "actor_type", "action", "resource_type", "outcome")
         values ($1, $2, 'SERVICE', 'worker.write', 'test', 'SUCCESS')`,
        [randomUUID(), tenantA],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

test('audit events are append-only and tenant isolated', async () => {
  const eventIds = await withOwner(async (client) => {
    const a = randomUUID();
    const b = randomUUID();
    await client.query(
      `insert into "audit_event"
         ("id", "tenant_id", "actor_type", "action", "resource_type", "outcome")
       values ($1, $2, 'SERVICE', 'rls.a', 'test', 'SUCCESS'),
              ($3, $4, 'SERVICE', 'rls.b', 'test', 'SUCCESS')`,
      [a, tenantA, b, tenantB],
    );
    return { a, b };
  });
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    const visible = await client.query(
      'select id from "audit_event" where id in ($1, $2)',
      [eventIds.a, eventIds.b],
    );
    expect(visible.rows.map((row) => row.id)).toEqual([eventIds.a]);
    await client.query('rollback');
  });
});

test('configured API and worker URLs actually use the limited roles', async () => {
  const apiClient = new Client({ connectionString: apiDatabaseUrl() });
  const workerClient = new Client({ connectionString: workerDatabaseUrl() });
  await apiClient.connect();
  await workerClient.connect();
  try {
    const apiRole = await apiClient.query('select current_user');
    const workerRole = await workerClient.query('select current_user');
    expect(apiRole.rows[0].current_user).toBe('hotel_api');
    expect(workerRole.rows[0].current_user).toBe('hotel_worker');
  } finally {
    await apiClient.end();
    await workerClient.end();
  }
});
