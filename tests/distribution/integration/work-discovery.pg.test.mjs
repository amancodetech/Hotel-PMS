import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { Client } from 'pg';
import { createOrm } from '../../../packages/backend/dist/persistence/orm.js';
import {
  DistributionRuntime,
  ProviderRegistry,
  SimulatorAdapter,
  SimulatorEngine,
  lifecycleSeeds,
  listDistributionWorkTenants,
  realChannelKeys,
  simulatorTestProfile,
  storeChannelRevision,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import {
  CONNECTION_ID,
  PROPERTY_ID,
  TENANT_ID,
  forkTx,
  initOrm,
  pullRevisions,
  resetAll,
  seedConnection,
  seedMapping,
  storeOptions,
} from './helpers.mjs';

let ownerOrm;
let workerOrm;

function workerDatabaseUrl() {
  const url = new URL(process.env.WORKER_DATABASE_URL);
  url.pathname = new URL(process.env.TEST_DATABASE_URL).pathname;
  return url.href;
}

function runtimeFor(orm) {
  const adapter = new SimulatorAdapter({
    engine: new SimulatorEngine({
      seed: 'R6',
      start_time: '2026-09-13T00:00:00Z',
      revisions: lifecycleSeeds('tiket-com'),
    }),
    allowedChannelKeys: realChannelKeys(),
  });
  return new DistributionRuntime({
    orm,
    registry: new ProviderRegistry([adapter]),
    profileFor: (context) => simulatorTestProfile(context.channel_key),
    owner: 'r6-worker',
    maxAttempts: 4,
  });
}

async function seedOneRevision() {
  await forkTx(ownerOrm, (em) => seedMapping(em));
  const { revisions } = await pullRevisions({});
  await forkTx(ownerOrm, (em) =>
    storeChannelRevision(em, revisions[0], storeOptions),
  );
  return revisions[0];
}

async function markExhaustedLegacy() {
  await ownerOrm.em.getConnection().execute(
    `update "distribution_inbox_revision"
        set "ack_state" = 'PENDING',
            "ack_attempt_count" = 4,
            "ack_next_attempt_at" = null,
            "ack_lease_expires_at" = null
      where "connection_id" = ?`,
    [CONNECTION_ID],
  );
}

beforeAll(async () => {
  ownerOrm = await initOrm();
  workerOrm = await createOrm(workerDatabaseUrl(), {
    pool: { min: 0, max: 3 },
  });
});

afterAll(async () => {
  await workerOrm?.close(true);
  await ownerOrm?.close(true);
});

beforeEach(async () => {
  await resetAll(ownerOrm);
  await forkTx(ownerOrm, (em) => seedConnection(em));
});

test('G03-R6: work discovery includes an exhausted legacy ACK with no other work', async () => {
  await seedOneRevision();
  await markExhaustedLegacy();
  const discovered = await listDistributionWorkTenants(workerOrm, 4);
  expect(discovered).toContain(TENANT_ID);

  const runtime = runtimeFor(workerOrm);
  const first = await runtime.tick();
  expect(first.ack.recovered).toBe(1);
  const exceptionCount = await ownerOrm.em.getConnection().execute(
    `select count(*)::int as count from "distribution_exception_case"
      where "inbox_revision_id" is not null and "type" = 'ACK_EXHAUSTED'`,
  );
  expect(exceptionCount[0].count).toBe(1);

  const second = await runtime.tick();
  expect(second.ack.recovered).toBe(0);
  const again = await ownerOrm.em.getConnection().execute(
    `select count(*)::int as count from "distribution_exception_case"
      where "type" = 'ACK_EXHAUSTED'`,
  );
  expect(again[0].count).toBe(1);
  const stillDiscovered = await listDistributionWorkTenants(workerOrm, 4);
  expect(stillDiscovered).not.toContain(TENANT_ID);
});

test('G03-R6: an expired ACK lease is discovered and processed by the runtime', async () => {
  await seedOneRevision();
  await ownerOrm.em.getConnection().execute(
    `update "distribution_inbox_revision"
        set "ack_state" = 'PENDING',
            "ack_attempt_count" = 1,
            "ack_next_attempt_at" = null,
            "ack_lease_owner" = 'dead-worker',
            "ack_lease_token" = gen_random_uuid(),
            "ack_lease_expires_at" = now() - interval '1 minute'
      where "connection_id" = ?`,
    [CONNECTION_ID],
  );
  const discovered = await listDistributionWorkTenants(workerOrm, 4);
  expect(discovered).toContain(TENANT_ID);
  const runtime = runtimeFor(workerOrm);
  const summary = await runtime.tick();
  expect(summary.ack.sent).toBe(1);
  const rows = await ownerOrm.em.getConnection().execute(
    `select "ack_state" from "distribution_inbox_revision"
      where "connection_id" = ?`,
    [CONNECTION_ID],
  );
  expect(rows[0].ack_state).toBe('SENT');
});

test('G03-R6: an existing MAPPING_MISSING exception neither blocks nor duplicates recovery', async () => {
  await seedOneRevision();
  await markExhaustedLegacy();
  const inboxRows = await ownerOrm.em
    .getConnection()
    .execute(
      `select "id" from "distribution_inbox_revision" where "connection_id" = ?`,
      [CONNECTION_ID],
    );
  await ownerOrm.em.getConnection().execute(
    `insert into "distribution_exception_case"
       ("id", "tenant_id", "property_id", "connection_id", "inbox_revision_id",
        "type", "state", "details_safe")
     values (gen_random_uuid(), ?, ?, ?, ?, 'MAPPING_MISSING', 'OPEN', '{}')`,
    [TENANT_ID, PROPERTY_ID, CONNECTION_ID, inboxRows[0].id],
  );
  const runtime = runtimeFor(workerOrm);
  const first = await runtime.tick();
  expect(first.ack.recovered).toBe(1);
  const second = await runtime.tick();
  expect(second.ack.recovered).toBe(0);
  const types = await ownerOrm.em.getConnection().execute(
    `select "type", count(*)::int as count
       from "distribution_exception_case"
      where "inbox_revision_id" = ?
      group by "type" order by "type"`,
    [inboxRows[0].id],
  );
  expect(types).toEqual([
    { type: 'ACK_EXHAUSTED', count: 1 },
    { type: 'MAPPING_MISSING', count: 1 },
  ]);
});

test('G03-R6: discovery helper is a locked-down security definer', async () => {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await client.connect();
  try {
    const fn = await client.query(
      `select p.prosecdef,
              p.proconfig,
              has_function_privilege('public',
                'public.distribution_work_tenants(integer)', 'execute') as public_execute,
              has_function_privilege('hotel_worker',
                'public.distribution_work_tenants(integer)', 'execute') as worker_execute
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'distribution_work_tenants'`,
    );
    expect(fn.rows).toHaveLength(1);
    expect(fn.rows[0].prosecdef).toBe(true);
    expect(fn.rows[0].proconfig).toContain('search_path=public');
    expect(fn.rows[0].public_execute).toBe(false);
    expect(fn.rows[0].worker_execute).toBe(true);
  } finally {
    await client.end();
  }
});
