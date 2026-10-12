import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createOrm } from '../../../packages/backend/dist/persistence/orm.js';
import {
  DistributionRuntime,
  ProviderRegistry,
  SimulatorAdapter,
  SimulatorEngine,
  claimPendingAck,
  leaseDueOutbox,
  lifecycleSeeds,
  listDistributionWorkTenants,
  realChannelKeys,
  simulatorTestProfile,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import { runScopedTransaction } from '../../../packages/backend/dist/persistence/tenant-context.js';
import { legacyTenantFixture as fixture } from './legacy-tenant-fixtures.mjs';

const databaseUrl = process.env.TEST_LEGACY_TENANT_DATABASE_URL;
const registration = databaseUrl ? test : test.skip;

let ownerOrm;
let workerOrm;
let testOrm;

function workerDatabaseUrl() {
  const url = new URL(process.env.WORKER_DATABASE_URL);
  url.pathname = new URL(databaseUrl).pathname;
  return url.href;
}

function testRoleDatabaseUrl() {
  const url = new URL(process.env.TEST_ROLE_DATABASE_URL);
  url.pathname = new URL(databaseUrl).pathname;
  return url.href;
}

function countingAdapter() {
  const calls = [];
  const adapter = new SimulatorAdapter({
    engine: new SimulatorEngine({
      seed: 'quarantine-closure',
      start_time: '2026-09-13T00:00:00Z',
      revisions: lifecycleSeeds('tiket-com'),
    }),
    allowedChannelKeys: realChannelKeys(),
  });
  const proxied = new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string')
        return value;
      if (!property.match(/^(acknowledge|push|pull|read|inspect)/))
        return value.bind(target);
      return (...args) => {
        calls.push({ method: property, connectionId: args[0]?.connection_id });
        return value.apply(target, args);
      };
    },
  });
  return { adapter: proxied, calls };
}

async function visibleCount(orm, tenantId, table, id) {
  const rows = await runScopedTransaction(orm, { tenantId }, (em) =>
    em.execute(`select count(*)::int as count from "${table}" where "id" = ?`, [
      id,
    ]),
  );
  return rows[0].count;
}

beforeAll(async () => {
  if (!databaseUrl) return;
  ownerOrm = await createOrm(databaseUrl, { pool: { min: 0, max: 3 } });
  workerOrm = await createOrm(workerDatabaseUrl(), {
    pool: { min: 0, max: 3 },
  });
  testOrm = await createOrm(testRoleDatabaseUrl(), {
    pool: { min: 0, max: 3 },
  });
});

afterAll(async () => {
  await testOrm?.close(true);
  await workerOrm?.close(true);
  await ownerOrm?.close(true);
});

registration(
  'upgrade quarantines mixed records and keeps them out of worker claims',
  async () => {
    const conflicts = await ownerOrm.em.getConnection().execute(
      `select "row_id", "resolution", "details_safe" ->> 'reason' as reason
         from "distribution_consistency_conflict"
        where "row_id" in (?, ?, ?)`,
      [fixture.mixedOutbox, fixture.mixedInbox, fixture.orphanConnection],
    );
    expect(conflicts).toHaveLength(3);
    for (const row of conflicts)
      expect(row.resolution).toBe('QUARANTINED_NOT_VALID');

    const hiddenOutbox = await runScopedTransaction(
      workerOrm,
      { tenantId: fixture.tenantA },
      (em) =>
        em.execute(
          'select count(*)::int as count from "distribution_outbox_event" where "id" = ?',
          [fixture.mixedOutbox],
        ),
    );
    expect(hiddenOutbox[0].count).toBe(0);
    const hiddenInbox = await runScopedTransaction(
      workerOrm,
      { tenantId: fixture.tenantA },
      (em) =>
        em.execute(
          'select count(*)::int as count from "distribution_inbox_revision" where "id" = ?',
          [fixture.mixedInbox],
        ),
    );
    expect(hiddenInbox[0].count).toBe(0);
    const visibleToOwner = await ownerOrm.em.getConnection().execute(
      `select (select count(*)::int from "distribution_outbox_event" where "id" = ?) as outbox,
              (select count(*)::int from "distribution_inbox_revision" where "id" = ?) as inbox`,
      [fixture.mixedOutbox, fixture.mixedInbox],
    );
    expect(visibleToOwner[0]).toEqual({ outbox: 1, inbox: 1 });

    const claimedMixed = await runScopedTransaction(
      workerOrm,
      { tenantId: fixture.tenantA },
      (em) =>
        leaseDueOutbox(em, {
          owner: 'quarantine-test',
          limit: 10,
          now: new Date().toISOString(),
          leaseMs: 30_000,
        }),
    );
    expect(claimedMixed.some((row) => row.id === fixture.mixedOutbox)).toBe(
      false,
    );

    const discovered = await listDistributionWorkTenants(workerOrm, 4);
    expect(discovered).not.toContain(fixture.tenantA);
    expect(discovered).not.toContain(fixture.tenantB);
    expect(discovered).not.toContain(fixture.orphanTenant);

    const constraints = await ownerOrm.em.getConnection().execute(
      `select "conname", "convalidated" from "pg_constraint"
        where "conname" in (
          'distribution_connection_tenant_fk',
          'distribution_outbox_connection_tenant_fk',
          'distribution_inbox_exception_tenant_fk'
        )`,
    );
    const validated = Object.fromEntries(
      constraints.map((row) => [row.conname, row.convalidated]),
    );
    expect(validated.distribution_connection_tenant_fk).toBe(false);
    expect(validated.distribution_outbox_connection_tenant_fk).toBe(false);
    expect(validated.distribution_inbox_exception_tenant_fk).toBe(false);
  },
);

registration(
  'the root Tenant FK rejects connections for a nonexistent tenant and accepts healthy writes',
  async () => {
    await expect(
      runScopedTransaction(
        workerOrm,
        { tenantId: fixture.orphanTenant },
        (em) =>
          em.execute(
            `insert into "distribution_connection"
             ("id", "tenant_id", "property_id", "provider_key", "environment",
              "channel_key", "external_property_id", "secret_ref")
           values (?, ?, ?, 'simulator', 'simulator', 'tiket-com', ?, 'secret:synthetic')`,
            [
              randomUUID(),
              fixture.orphanTenant,
              fixture.propertyB,
              `ORPHAN-${randomUUID().slice(0, 8)}`,
            ],
          ),
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const healthyId = randomUUID();
    await runScopedTransaction(workerOrm, { tenantId: fixture.tenantA }, (em) =>
      em.execute(
        `insert into "distribution_outbox_event"
           ("id", "tenant_id", "property_id", "connection_id", "channel_key",
            "aggregate_type", "aggregate_id", "event_type", "event_version",
            "inventory_version", "payload_safe", "next_attempt_at")
         values (?, ?, ?, ?, 'tiket-com', 'inventory', ?, 'AvailabilitySnapshot',
                 1, 1, '{}'::jsonb, now())`,
        [
          healthyId,
          fixture.tenantA,
          fixture.propertyA,
          fixture.connectionA,
          randomUUID(),
        ],
      ),
    );
    const claimed = await runScopedTransaction(
      workerOrm,
      { tenantId: fixture.tenantA },
      (em) =>
        leaseDueOutbox(em, {
          owner: 'quarantine-test',
          limit: 10,
          now: new Date().toISOString(),
          leaseMs: 30_000,
        }),
    );
    expect(claimed.some((row) => row.id === healthyId)).toBe(true);
    expect(claimed.some((row) => row.id === fixture.mixedOutbox)).toBe(false);
  },
);

registration(
  'G03-F3-A: the conflict ledger is closed to runtime roles and the quarantine helper stays bounded',
  async () => {
    for (const orm of [workerOrm, testOrm]) {
      await expect(
        orm.em
          .fork()
          .execute(
            'select "row_id" from "distribution_consistency_conflict" limit 1',
          ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runScopedTransaction(orm, { tenantId: fixture.tenantA }, (em) =>
          em.execute(
            'select "row_id" from "distribution_consistency_conflict" limit 1',
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }

    const privileged = await ownerOrm.em.getConnection().execute(
      `select p."prosecdef",
              p."proconfig",
              has_function_privilege('public',
                'public.distribution_quarantined(text, uuid)',
                'execute') as public_execute,
              has_function_privilege('hotel_worker',
                'public.distribution_quarantined(text, uuid)',
                'execute') as worker_execute,
              has_function_privilege('hotel_test',
                'public.distribution_quarantined(text, uuid)',
                'execute') as test_execute,
              has_function_privilege('hotel_worker',
                'public.distribution_row_quarantined(text, uuid)',
                'execute') as row_worker_execute,
              has_table_privilege('hotel_worker',
                'public.distribution_consistency_conflict',
                'select') as worker_ledger_select,
              has_table_privilege('hotel_test',
                'public.distribution_consistency_conflict',
                'select') as test_ledger_select
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'distribution_quarantined'`,
    );
    expect(privileged).toHaveLength(1);
    expect(privileged[0].prosecdef).toBe(true);
    expect(privileged[0].proconfig).toContain('search_path=pg_catalog, public');
    expect(privileged[0].public_execute).toBe(false);
    expect(privileged[0].worker_execute).toBe(true);
    expect(privileged[0].test_execute).toBe(true);
    expect(privileged[0].row_worker_execute).toBe(false);
    expect(privileged[0].worker_ledger_select).toBe(false);
    expect(privileged[0].test_ledger_select).toBe(false);

    const internals = await ownerOrm.em.getConnection().execute(
      `select p."proname",
              has_function_privilege('public', p."oid", 'execute') as public_execute,
              has_function_privilege('hotel_worker', p."oid", 'execute') as worker_execute
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p."proname" in (
            'distribution_conflict_row_tenant',
            'distribution_conflict_release_guard',
            'distribution_conflict_delete_guard',
            'distribution_conflict_truncate_guard'
          )
        order by p."proname"`,
    );
    expect(internals).toEqual([
      {
        proname: 'distribution_conflict_delete_guard',
        public_execute: false,
        worker_execute: false,
      },
      {
        proname: 'distribution_conflict_release_guard',
        public_execute: false,
        worker_execute: false,
      },
      {
        proname: 'distribution_conflict_row_tenant',
        public_execute: false,
        worker_execute: false,
      },
      {
        proname: 'distribution_conflict_truncate_guard',
        public_execute: false,
        worker_execute: false,
      },
    ]);

    await expect(
      runScopedTransaction(workerOrm, { tenantId: fixture.tenantA }, (em) =>
        em.execute(
          `select public.distribution_conflict_row_tenant(
             'distribution_connection', ?)`,
          [fixture.orphanConnection],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      ownerOrm.em.getConnection().execute(
        `update "distribution_consistency_conflict"
            set "resolution" = 'DISMISSED'
          where "row_id" = ?`,
        [fixture.mixedOutbox],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const flagged = await runScopedTransaction(
      workerOrm,
      { tenantId: fixture.orphanTenant },
      (em) =>
        em.execute(
          `select public.distribution_quarantined(
             'distribution_connection', ?) as blocked`,
          [fixture.orphanConnection],
        ),
    );
    expect(flagged[0].blocked).toBe(true);

    await expect(
      runScopedTransaction(workerOrm, { tenantId: fixture.tenantA }, (em) =>
        em.execute(`select public.distribution_quarantined('pg_class', ?)`, [
          randomUUID(),
        ]),
      ),
    ).rejects.toMatchObject({ code: '22023' });
  },
);

registration(
  'G03-F3-B: the quarantined connection and every descendant are invisible, undiscoverable and unclaimable',
  async () => {
    const descendants = [
      ['distribution_connection', fixture.orphanConnection],
      ['distribution_outbox_event', fixture.orphanOutbox],
      ['distribution_inbox_revision', fixture.orphanInbox],
      ['distribution_exception_case', fixture.orphanException],
      ['distribution_dead_letter', fixture.orphanDeadLetter],
      ['distribution_dedup_key', fixture.orphanDedup],
      ['distribution_sync_attempt', fixture.orphanAttempt],
      ['distribution_sync_checkpoint', fixture.orphanCheckpoint],
      ['distribution_external_booking', fixture.orphanBooking],
      ['distribution_channel_capability', fixture.orphanCapability],
      ['distribution_mapping_version', fixture.orphanMapping],
    ];
    for (const [table, id] of descendants) {
      expect(
        await visibleCount(workerOrm, fixture.orphanTenant, table, id),
      ).toBe(0);
      expect(await visibleCount(workerOrm, fixture.tenantA, table, id)).toBe(0);
      expect(await visibleCount(testOrm, fixture.orphanTenant, table, id)).toBe(
        0,
      );
      expect(
        await visibleCount(ownerOrm, fixture.orphanTenant, table, id),
      ).toBe(1);
    }

    const discovered = await listDistributionWorkTenants(workerOrm, 4);
    expect(discovered).not.toContain(fixture.orphanTenant);

    const claimedAck = await runScopedTransaction(
      workerOrm,
      { tenantId: fixture.orphanTenant },
      (em) =>
        claimPendingAck(em, {
          owner: 'quarantine-test',
          limit: 10,
          maxAttempts: 4,
          now: new Date().toISOString(),
          leaseMs: 30_000,
        }),
    );
    expect(claimedAck).toHaveLength(0);

    const claimedOutbox = await runScopedTransaction(
      workerOrm,
      { tenantId: fixture.orphanTenant },
      (em) =>
        leaseDueOutbox(em, {
          owner: 'quarantine-test',
          limit: 10,
          now: new Date().toISOString(),
          leaseMs: 30_000,
        }),
    );
    expect(claimedOutbox).toHaveLength(0);

    const attempts = await ownerOrm.em.getConnection().execute(
      `select "ack_attempt_count", "ack_lease_owner"
         from "distribution_inbox_revision" where "id" = ?`,
      [fixture.orphanInbox],
    );
    expect(attempts[0].ack_attempt_count).toBe(0);
    expect(attempts[0].ack_lease_owner).toBeNull();

    const { adapter, calls } = countingAdapter();
    const runtime = new DistributionRuntime({
      orm: workerOrm,
      registry: new ProviderRegistry([adapter]),
      profileFor: (context) => simulatorTestProfile(context.channel_key),
      owner: 'quarantine-test',
      maxAttempts: 4,
    });
    const summary = await runtime.tick();
    expect(summary.dispatch.leased).toBe(0);
    expect(summary.ack.processed).toBe(0);
    expect(
      calls.every((call) => call.connectionId !== fixture.orphanConnection),
    ).toBe(true);
  },
);

registration(
  'G03-F3 closure: RELEASED requires consistency, keeps history and never re-attributes data',
  async () => {
    const release = (table, rowId) =>
      ownerOrm.em.getConnection().execute(
        `update "distribution_consistency_conflict"
            set "resolution" = 'RELEASED'
          where "table_name" = ? and "row_id" = ?
            and "resolution" = 'QUARANTINED_NOT_VALID'`,
        [table, rowId],
      );

    await expect(
      ownerOrm.em.getConnection().execute(
        `delete from "distribution_consistency_conflict"
          where "table_name" = 'distribution_outbox_event'
            and "row_id" = ?`,
        [fixture.mixedOutbox],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      ownerOrm.em.getConnection().execute(
        `delete from "distribution_consistency_conflict"
          where "table_name" = 'distribution_connection'
            and "row_id" = ?`,
        [fixture.orphanConnection],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      ownerOrm.em
        .getConnection()
        .execute(`truncate table "distribution_consistency_conflict"`),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      release('distribution_connection', fixture.orphanConnection),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      release('distribution_outbox_event', fixture.mixedOutbox),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      release('distribution_inbox_revision', fixture.mixedInbox),
    ).rejects.toMatchObject({ code: '23514' });

    await ownerOrm.em.getConnection().execute(
      `insert into "tenant" ("id", "name", "slug")
       values (?, 'Legacy Orphan Tenant', 'legacy-orphan-tenant')`,
      [fixture.orphanTenant],
    );

    await release('distribution_connection', fixture.orphanConnection);

    const released = await ownerOrm.em.getConnection().execute(
      `select "resolution", "resolved_at", "resolved_by"
         from "distribution_consistency_conflict"
        where "table_name" = 'distribution_connection' and "row_id" = ?`,
      [fixture.orphanConnection],
    );
    expect(released[0].resolution).toBe('RELEASED');
    expect(released[0].resolved_at).not.toBeNull();
    expect(released[0].resolved_by).not.toBeNull();

    const connection = await ownerOrm.em
      .getConnection()
      .execute(
        `select "tenant_id" from "distribution_connection" where "id" = ?`,
        [fixture.orphanConnection],
      );
    expect(connection[0].tenant_id).toBe(fixture.orphanTenant);

    const stillQuarantined = await ownerOrm.em.getConnection().execute(
      `select "resolution" from "distribution_consistency_conflict"
        where "table_name" = 'distribution_outbox_event' and "row_id" = ?`,
      [fixture.orphanOutbox],
    );
    expect(stillQuarantined[0].resolution).toBe('QUARANTINED_NOT_VALID');

    const constraints = await ownerOrm.em.getConnection().execute(
      `select "convalidated" from "pg_constraint"
        where "conname" = 'distribution_connection_tenant_fk'`,
    );
    expect(constraints[0].convalidated).toBe(false);

    const unknownTenant = randomUUID();
    await expect(
      runScopedTransaction(workerOrm, { tenantId: unknownTenant }, (em) =>
        em.execute(
          `insert into "distribution_connection"
             ("id", "tenant_id", "property_id", "provider_key", "environment",
              "channel_key", "external_property_id", "secret_ref")
           values (?, ?, ?, 'simulator', 'simulator', 'tiket-com', ?, 'secret:synthetic')`,
          [
            randomUUID(),
            unknownTenant,
            fixture.propertyB,
            `UNKNOWN-${randomUUID().slice(0, 8)}`,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });

    expect(
      await visibleCount(
        workerOrm,
        fixture.orphanTenant,
        'distribution_connection',
        fixture.orphanConnection,
      ),
    ).toBe(1);
    expect(
      await visibleCount(
        workerOrm,
        fixture.orphanTenant,
        'distribution_inbox_revision',
        fixture.orphanInbox,
      ),
    ).toBe(1);

    const claimedAck = await runScopedTransaction(
      workerOrm,
      { tenantId: fixture.orphanTenant },
      (em) =>
        claimPendingAck(em, {
          owner: 'quarantine-test',
          limit: 10,
          maxAttempts: 4,
          now: new Date().toISOString(),
          leaseMs: 30_000,
        }),
    );
    expect(claimedAck.some((row) => row.id === fixture.orphanInbox)).toBe(true);

    const claimedOutbox = await runScopedTransaction(
      workerOrm,
      { tenantId: fixture.orphanTenant },
      (em) =>
        leaseDueOutbox(em, {
          owner: 'quarantine-test',
          limit: 10,
          now: new Date().toISOString(),
          leaseMs: 30_000,
        }),
    );
    expect(claimedOutbox.some((row) => row.id === fixture.orphanOutbox)).toBe(
      false,
    );

    await ownerOrm.em.getConnection().execute(
      `delete from "distribution_consistency_conflict"
        where "table_name" = 'distribution_connection' and "row_id" = ?`,
      [fixture.orphanConnection],
    );
    const remaining = await ownerOrm.em.getConnection().execute(
      `select count(*)::int as count from "distribution_consistency_conflict"
        where "table_name" = 'distribution_connection' and "row_id" = ?`,
      [fixture.orphanConnection],
    );
    expect(remaining[0].count).toBe(0);
  },
);
