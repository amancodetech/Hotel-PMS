#!/usr/bin/env node
// Root-only existing API preparation/check. No service control, secret loading or provider HTTP.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  readlinkSync,
  mkdirSync,
  lstatSync,
  openSync,
  writeFileSync,
  closeSync,
  renameSync,
  fsyncSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Client } from 'pg';
const database = 'hotel_np_operational_trial_20261009';
const tenant = '4e4da283-994c-41af-93ce-54b7fa89814e';
const property = 'f5651217-3100-4da5-91ec-d3fe1775db7c';
const mode = process.argv[2];
assert.ok(['plan', 'prepare', 'check'].includes(mode));
const opts = {};
for (let i = 3; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i].startsWith('--') && process.argv[i + 1]);
  opts[process.argv[i].slice(2)] = process.argv[i + 1];
}
const env = (key) => {
  assert.ok(process.env[key], `${key} required`);
  return process.env[key];
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const equal = (a, b) =>
  assert.deepEqual(
    JSON.parse(JSON.stringify(a)),
    JSON.parse(JSON.stringify(b)),
  );
const out = resolve(opts.out);
assert.ok(out.startsWith(`${resolve('.local/verification')}/`));
mkdirSync(out, { recursive: true, mode: 0o700 });
assert.ok(
  lstatSync(out).isDirectory() &&
    !lstatSync(out).isSymbolicLink() &&
    !(lstatSync(out).mode & 0o077),
);
function atomic(name, value, exclusive = false) {
  const target = `${out}/${name}`,
    tmp = exclusive ? target : `${target}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, json(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!exclusive) renameSync(tmp, target);
  const dir = openSync(dirname(target), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
const lock = openSync(`${out}/run.lock`, 'wx', 0o600);
writeFileSync(lock, json({ pid: process.pid, mode }));
closeSync(lock);
// Persistent lock: root confirms this PID stopped before clearing between modes.
function target(value) {
  const url = new URL(value);
  assert.equal(url.pathname, `/${database}`);
  assert.equal(url.port, '55432');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  return `${url.hostname.replace('localhost', '127.0.0.1')}:${url.port || 5432}${url.pathname}`;
}
const dbTarget = target(env('TEST_DATABASE_URL'));
for (const key of ['DATABASE_URL', 'API_DATABASE_URL', 'WORKER_DATABASE_URL'])
  assert.equal(target(env(key)), dbTarget);
assert.equal(env('IDENTITY_TEST_DB'), database);
function processGuard(pidKey, service, dbKey, requestedPort, expectedWorker) {
  const pid = env(pidKey);
  assert.match(pid, /^\d+$/);
  assert.ok(
    readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(
      `apps/${service}/dist/main.js`,
    ),
  );
  const runtime = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  const value = (key) =>
    runtime.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1);
  assert.equal(target(value(dbKey)), dbTarget);
  assert.equal(value('API_HOST'), '127.0.0.1');
  assert.equal(
    value(service === 'api' ? 'API_PORT' : 'WORKER_PORT'),
    requestedPort,
  );
  if (service === 'api') assert.equal(value('WEB_PORT'), env('WEB_PORT'));
  else {
    assert.equal(value('CHANNEX_STAGING_WORKER') ?? 'off', expectedWorker);
    if (expectedWorker === 'off') {
      assert.equal(value('DISTRIBUTION_WORKER') ?? 'off', 'off');
      assert.equal(value('NIGHT_AUDIT_WORKER'), 'off');
      assert.equal(value('REPORT_EXPORT_WORKER'), 'off');
    } else {
      assert.equal(value('DISTRIBUTION_WORKER'), 'on');
      assert.equal(value('NIGHT_AUDIT_WORKER'), 'off');
      assert.equal(value('REPORT_EXPORT_WORKER'), 'off');
      const prepared = JSON.parse(readFileSync(`${out}/prepared.json`));
      for (const [key, expected] of Object.entries(prepared.worker_environment))
        assert.equal(value(key), String(expected));
    }
  }
  const inodes = new Set();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const match = readlinkSync(`/proc/${pid}/fd/${fd}`).match(
        /^socket:\[(\d+)\]$/,
      );
      if (match) inodes.add(match[1]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const address = `0100007F:${Number(requestedPort).toString(16).toUpperCase().padStart(4, '0')}`;
  assert.ok(
    readFileSync(`/proc/${pid}/net/tcp`, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .some((line) => {
        const fields = line.trim().split(/\s+/);
        return (
          fields[1] === address && fields[3] === '0A' && inodes.has(fields[9])
        );
      }),
  );
}
function runtimeGuard() {
  processGuard('NP_TRIAL_API_PID', 'api', 'API_DATABASE_URL', env('API_PORT'));
  processGuard(
    'NP_TRIAL_WORKER_PID',
    'worker',
    'WORKER_DATABASE_URL',
    env('NP_TRIAL_WORKER_PORT'),
    mode === 'check' ? 'on' : 'off',
  );
}
const sourceFiles = [
  'scripts/channex-staging-pms-trial.mjs',
  'apps/worker/src/main.ts',
  'apps/worker/dist/main.js',
  'packages/backend/src/config.ts',
  'packages/backend/dist/config.js',
  'apps/api/src/property/connection.controller.ts',
  'apps/api/dist/property/connection.controller.js',
  'apps/api/src/inventory/exposure.controller.ts',
  'apps/api/dist/inventory/exposure.controller.js',
];
for (const name of [
  'staging-worker',
  'runtime',
  'dispatcher',
  'ack-service',
  'inbox-store',
  'pull-service',
])
  for (const [root, ext] of [
    ['src', 'ts'],
    ['dist', 'js'],
  ])
    sourceFiles.push(
      `packages/backend/${root}/modules/distribution/application/${name}.${ext}`,
    );
for (const name of [
  'inbox-repository',
  'outbox-repository',
  'connection-repository',
  'mapping-repository',
])
  for (const [root, ext] of [
    ['src', 'ts'],
    ['dist', 'js'],
  ])
    sourceFiles.push(
      `packages/backend/${root}/modules/distribution/persistence/${name}.${ext}`,
    );
for (const name of ['channex-adapter', 'normalize', 'http-client'])
  for (const [root, ext] of [
    ['src', 'ts'],
    ['dist', 'js'],
  ])
    sourceFiles.push(
      `packages/backend/${root}/modules/distribution/adapters/channex/${name}.${ext}`,
    );
for (const [module, name] of [
  ['inventory', 'exposure-service'],
  ['property', 'connection-draft-service'],
])
  for (const [root, ext] of [
    ['src', 'ts'],
    ['dist', 'js'],
  ])
    sourceFiles.push(
      `packages/backend/${root}/modules/${module}/application/${name}.${ext}`,
    );
function sourceHashes() {
  return Object.fromEntries(
    sourceFiles.map((path) => [path, hash(readFileSync(path))]),
  );
}
const db = new Client({ connectionString: env('TEST_DATABASE_URL') });
let harness, account;
let journal;
try {
  await db.connect();
  await db.query('SET default_transaction_read_only=on');
  runtimeGuard();
  const ready = await fetch(
    `http://127.0.0.1:${env('API_PORT')}/api/v1/system/ready`,
    { signal: AbortSignal.timeout(5000), redirect: 'error' },
  );
  assert.equal(ready.status, 200);
  assert.equal(
    (await db.query('select current_database() name')).rows[0].name,
    database,
  );
  const tables = (
    await db.query(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    )
  ).rows.map((row) => row.tablename);
  const rows = async (name) => {
    assert.ok(tables.includes(name));
    return JSON.parse(
      JSON.stringify(
        (
          await db.query(
            name === 'sale_restriction'
              ? 'select s.*, start_date::text as start_date, end_date::text as end_date from sale_restriction s'
              : `select * from "${name.replaceAll('"', '""')}"`,
          )
        ).rows,
      ),
    ).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  };
  const snapshot = async () => {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => [table, await rows(table)]),
        ),
      );
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  };
  const initial = await snapshot();
  assert.equal(initial.property.length, 1);
  assert.equal(initial.property[0].id, property);
  assert.equal(initial.property[0].tenant_id, tenant);
  assert.equal(initial.property[0].status, 'ACTIVE');
  const expectedUserId = env('NP_TRIAL_ADMIN_USER_ID');
  assert.match(expectedUserId, /^[0-9a-f-]{36}$/i);
  const expectedUser = initial.app_user.find(
    (row) => row.id === expectedUserId,
  );
  assert.ok(
    expectedUser &&
      expectedUser.status === 'ACTIVE' &&
      expectedUser.issuer === env('KEYCLOAK_ISSUER'),
  );
  assert.ok(
    initial.membership.some(
      (row) =>
        row.user_id === expectedUserId &&
        row.tenant_id === tenant &&
        row.status === 'ACTIVE',
    ),
  );

  assert.equal(initial.property[0].name, 'new pratama');
  assert.equal(initial.property[0].timezone, 'Asia/Jakarta');
  assert.equal(initial.property[0].base_currency, 'IDR');
  assert.equal(initial.resource.length, 97);
  assert.equal(
    initial.resource.filter((row) => row.resource_type === 'ROOM').length,
    73,
  );
  assert.equal(
    initial.resource.filter((row) => row.resource_type === 'VILLA').length,
    24,
  );
  assert.equal(initial.location.length, 44);
  const baselineBytes = readFileSync(env('NP_TRIAL_BASELINE'));
  assert.equal(hash(baselineBytes), env('NP_TRIAL_BASELINE_SHA256'));
  const baseline = JSON.parse(baselineBytes);
  assert.equal(baseline.status, 'PASS_READ_ONLY_DB_INVARIANTS');
  const successfulBytes = readFileSync(env('NP_TRIAL_SUCCESS_JOURNAL'));
  const successful = JSON.parse(successfulBytes);
  assert.equal(successful.status, 'PASS_API_TRIAL');
  assert.equal(successful.run_id, 'source3');
  assert.equal(successful.database, database);
  assert.equal(successful.baseline_sha, hash(baselineBytes));
  const fields = [
    'id',
    'tenant_id',
    'property_id',
    'code',
    'resource_type',
    'capacity',
    'parent_resource_id',
    'location_id',
    'unit_details',
    'display_label',
  ];
  const project = (list) =>
    list
      .map((row) => Object.fromEntries(fields.map((key) => [key, row[key]])))
      .sort((a, b) => a.id.localeCompare(b.id));
  equal(project(initial.resource), project(baseline.rows.resource));
  for (const table of [
    'location',
    'product_resource_candidate',
    'composition_version',
    'composition_edge',
  ])
    equal(
      initial[table],
      [...baseline.rows[table]].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    );
  const planPath = `${out}/plan.json`;
  let plan;
  if (mode === 'plan') {
    assert.equal(initial.distribution_connection.length, 0);
    const transportBytes = readFileSync(opts['transport-plan']);
    assert.equal(hash(transportBytes), opts['transport-plan-sha256']);
    const transport = JSON.parse(transportBytes);
    assert.equal(transport.host, 'https://staging.channex.io/api/v1');
    assert.equal(transport.context.tenant_id, tenant);
    assert.equal(transport.context.property_id, property);
    assert.equal(transport.scope.date_from, '2026-10-15');
    assert.equal(transport.scope.date_to, '2026-10-15');
    assert.equal(transport.room_pms_refs.resource_code, 'V04-R01');
    const product = initial.product.find(
      (row) => row.id === transport.room_pms_refs.product_id,
    );
    const resource = initial.resource.find(
      (row) =>
        row.id === transport.room_pms_refs.resource_id &&
        row.code === 'V04-R01',
    );
    assert.ok(
      resource &&
        initial.product_resource_candidate.some(
          (row) =>
            row.product_id === product?.id && row.resource_id === resource.id,
        ),
    );
    assert.ok(product && product.status === 'ACTIVE');
    const rate = initial.rate_plan.find(
      (row) => row.product_id === product.id && row.code === 'NPTRIAL-ROOM',
    );
    assert.ok(rate && rate.status === 'ACTIVE' && rate.currency === 'IDR');
    const connection = {
      provider_key: 'channex',
      environment: 'staging',
      channel_key: 'staging-crs',
      external_property_id: transport.context.external_property_id,
      secret_ref: 'env:NP_CHANNEX_STAGING_KEY',
    };
    const mapping = {
      channel_key: 'staging-crs',
      external_room_ref: transport.scope.product_refs[0],
      external_rate_ref: transport.scope.rate_refs[0],
      occupancy: 2,
      meal_plan_ref: null,
      internal_product_ref: product.id,
      internal_rate_ref: rate.id,
    };
    const sale = {
      action: 'STOP_SELL',
      product_id: product.id,
      period: { arrival: '2026-10-15', departure: '2026-10-16' },
      reason: 'Synthetic NP scoped staging PMS STOP_SELL 20261011',
    };
    plan = {
      database,
      created_at: new Date().toISOString(),
      expected_user_id: expectedUserId,
      tenant,
      property,
      transport_plan_sha256: hash(transportBytes),
      successful_trial_sha256: hash(successfulBytes),
      baseline_sha256: hash(baselineBytes),
      bodies: { connection, mapping, sale },
      bodies_sha256: hash(json({ connection, mapping, sale })),
      source_hashes: sourceHashes(),
      protected_snapshot: Object.fromEntries(
        Object.entries(initial).map(([table, entries]) => [
          table,
          {
            sha256: hash(json(entries)),
            count: entries.length,
            rows: entries.map((row) => ({
              id: row.id,
              sha256: hash(json(row)),
            })),
          },
        ]),
      ),
      protected_users: initial.app_user.map(
        ({ updated_at: _updated_at, ...row }) => ({
          id: row.id,
          sha256: hash(json(row)),
          full_sha256: hash(
            json(initial.app_user.find((entry) => entry.id === row.id)),
          ),
        }),
      ),
      protected_property: initial.property.map(
        ({
          inventory_version: _inventory_version,
          updated_at: _updated_at,
          ...row
        }) => row,
      ),
      initial_inventory_version: initial.property[0].inventory_version,
    };
    atomic('plan.json', plan, true);
    console.log(
      json({
        status: 'READ_ONLY_PMS_PLAN_READY',
        plan_sha256: hash(json(plan)),
        bodies_sha256: plan.bodies_sha256,
      }),
    );
  } else {
    const planBytes = readFileSync(planPath);
    assert.equal(hash(planBytes), opts['approve-plan-sha256']);
    plan = JSON.parse(planBytes);
    equal(plan.source_hashes, sourceHashes());
    assert.equal(plan.successful_trial_sha256, hash(successfulBytes));
    assert.equal(plan.baseline_sha256, hash(baselineBytes));
    const permitted = new Set([
      'auth_session',
      'auth_flow',
      'app_user',
      'audit_event',
      'distribution_connection',
      'distribution_mapping_version',
      'distribution_outbox_event',
      'distribution_sync_attempt',
      'sale_restriction',
      'property',
    ]);
    const unchanged = async () => {
      const current = await snapshot();
      equal(Object.keys(current), Object.keys(plan.protected_snapshot));
      for (const table of tables)
        if (!permitted.has(table))
          assert.equal(
            hash(json(current[table])),
            plan.protected_snapshot[table].sha256,
          );
      for (const table of permitted) {
        if (
          [
            'auth_session',
            'auth_flow',
            'app_user',
            'audit_event',
            'property',
          ].includes(table)
        )
          continue;
        for (const previous of plan.protected_snapshot[table]?.rows ?? [])
          assert.equal(
            hash(json(current[table].find((row) => row.id === previous.id))),
            previous.sha256,
          );
      }
      for (const previous of plan.protected_snapshot.audit_event.rows)
        assert.equal(
          hash(json(current.audit_event.find((row) => row.id === previous.id))),
          previous.sha256,
        );
      assert.equal(plan.expected_user_id, expectedUserId);
      assert.equal(current.app_user.length, plan.protected_users.length);
      for (const before of plan.protected_users) {
        const currentUser = current.app_user.find(
          (row) => row.id === before.id,
        );
        assert.ok(currentUser);
        if (before.id === plan.expected_user_id) {
          const { updated_at: _updated_at, ...identity } = currentUser;
          assert.equal(hash(json(identity)), before.sha256);
        } else assert.equal(hash(json(currentUser)), before.full_sha256);
      }
      for (const table of ['auth_flow', 'auth_session']) {
        const baselineRows = plan.protected_snapshot[table].rows;
        for (const before of baselineRows)
          assert.equal(
            hash(json(current[table].find((row) => row.id === before.id))),
            before.sha256,
          );
        const ids = new Set(baselineRows.map((row) => row.id));
        const additions = current[table].filter((row) => !ids.has(row.id));
        assert.ok(
          additions.length <= 2,
          'At most one fresh login per prepare/check',
        );
        for (const row of additions) {
          assert.ok(Date.parse(row.created_at) >= Date.parse(plan.created_at));
          if (table === 'auth_flow') {
            assert.ok(
              row.used_at &&
                Date.parse(row.used_at) >= Date.parse(row.created_at),
            );
            assert.equal(row.redirect_after, null);
            assert.ok(
              Date.parse(row.expires_at) - Date.parse(row.created_at) <= 601000,
            );
          } else {
            assert.equal(row.user_id, plan.expected_user_id);
            assert.equal(row.active_tenant_id, tenant);
            assert.equal(row.revoked_at, null);
          }
        }
      }
      const connectionRows = current.distribution_connection;
      assert.ok(connectionRows.length <= 1);
      const selected = connectionRows[0]?.id;
      if (selected) {
        for (const key of [
          'distribution_mapping_version',
          'distribution_outbox_event',
          'sale_restriction',
        ]) {
          const oldIds = new Set(
            plan.protected_snapshot[key].rows.map((row) => row.id),
          );
          for (const row of current[key])
            if (!oldIds.has(row.id)) assert.equal(row.connection_id, selected);
        }
        const outboxIds = new Set(
          current.distribution_outbox_event
            .filter((row) => row.connection_id === selected)
            .map((row) => row.id),
        );
        const oldAttempts = new Set(
          plan.protected_snapshot.distribution_sync_attempt.rows.map(
            (row) => row.id,
          ),
        );
        for (const row of current.distribution_sync_attempt)
          if (!oldAttempts.has(row.id)) assert.ok(outboxIds.has(row.outbox_id));
      } else {
        for (const key of [
          'distribution_mapping_version',
          'distribution_outbox_event',
          'sale_restriction',
          'distribution_sync_attempt',
        ])
          assert.equal(
            hash(json(current[key])),
            plan.protected_snapshot[key].sha256,
          );
      }
      const scrub = (list) =>
        list.map(
          ({
            inventory_version: _inventory_version,
            updated_at: _updated_at,
            ...row
          }) => row,
        );
      equal(scrub(current.property), plan.protected_property);
      return current;
    };
    journal = (() => {
      try {
        return JSON.parse(readFileSync(`${out}/journal.json`));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return { plan_sha256: hash(planBytes), steps: {} };
      }
    })();
    assert.equal(journal.plan_sha256, hash(planBytes));
    let current = await unchanged();
    const base = `/tenants/${tenant}/properties/${property}`;
    const connectionMatches = () =>
      current.distribution_connection.filter(
        (row) =>
          row.tenant_id === tenant &&
          row.property_id === property &&
          row.status === 'DRAFT' &&
          Object.entries(plan.bodies.connection).every(
            ([key, value]) => row[key] === value,
          ),
      );
    let connectionId;
    async function mutate(name, method, path, body, status, reconcile) {
      const step = journal.steps[name];
      if (step) {
        assert.equal(step.request_sha256, hash(json({ method, path, body })));
        current = await unchanged();
        const result = reconcile();
        assert.ok(result, 'Uncertain INTENT: no mutation retry');
        journal.steps[name].reconciled_at = new Date().toISOString();
        journal.steps[name].persisted_id = result.id;
        atomic('journal.json', journal);
        return result;
      }
      runtimeGuard();
      current = await unchanged();
      journal.steps[name] = {
        state: 'INTENT',
        request_sha256: hash(json({ method, path, body })),
        request: { method, path, body },
        at: new Date().toISOString(),
      };
      atomic('journal.json', journal);
      const response = await harness.apiRequest(account.context, method, path, {
        body,
      });
      assert.equal(
        response.status,
        status,
        'API mutation unresolved; inspect persisted INTENT',
      );
      current = await unchanged();
      const persisted = reconcile();
      assert.ok(persisted, 'Committed API state did not match INTENT');
      journal.steps[name].state = 'DONE';
      journal.steps[name].persisted_id = persisted.id;
      atomic('journal.json', journal);
      return persisted;
    }
    if (mode === 'prepare') {
      if (!journal.steps.connection)
        assert.equal(current.distribution_connection.length, 0);
      harness = await import('../tests/property/support/harness.mjs');
      account = await harness.loginAs('admin-a');
      assert.equal(account.session.body.authenticated, true);
      assert.equal(account.session.body.user.id, plan.expected_user_id);
      assert.equal(account.session.body.session.active_tenant_id, tenant);
      const created = await mutate(
        'connection',
        'POST',
        `${base}/connections`,
        plan.bodies.connection,
        201,
        () => {
          const found = connectionMatches();
          assert.equal(current.distribution_connection.length, 1);
          assert.equal(found.length, 1);
          return found[0];
        },
      );
      connectionId = created.id;
      const mapped = await mutate(
        'mapping',
        'PUT',
        `${base}/connections/${connectionId}/mapping`,
        plan.bodies.mapping,
        200,
        () => {
          const found = current.distribution_mapping_version.filter(
            (row) =>
              row.connection_id === connectionId &&
              row.status === 'DRAFT' &&
              row.internal_product_ref ===
                plan.bodies.mapping.internal_product_ref &&
              row.internal_rate_ref === plan.bodies.mapping.internal_rate_ref &&
              row.external_room_ref === plan.bodies.mapping.external_room_ref &&
              row.external_rate_ref === plan.bodies.mapping.external_rate_ref &&
              row.channel_key === 'staging-crs' &&
              row.occupancy === 2 &&
              row.meal_plan_ref === null,
          );
          assert.equal(found.length, 1);
          return found[0];
        },
      );
      const restriction = await mutate(
        'sale',
        'POST',
        `${base}/connections/${connectionId}/sale-status`,
        plan.bodies.sale,
        200,
        () => {
          const found = current.sale_restriction.filter(
            (row) =>
              row.connection_id === connectionId &&
              row.product_id === plan.bodies.sale.product_id &&
              row.reason === plan.bodies.sale.reason &&
              row.state === 'ACTIVE' &&
              String(row.start_date).startsWith('2026-10-15') &&
              String(row.end_date).startsWith('2026-10-16'),
          );
          assert.equal(found.length, 1);
          return found[0];
        },
      );
      const events = current.distribution_outbox_event.filter(
        (row) =>
          row.connection_id === connectionId &&
          row.aggregate_id === restriction.id,
      );
      assert.equal(events.length, 1);
      const event = events[0];
      assert.equal(event.status, 'PENDING');
      assert.equal(event.event_type, 'RestrictionSnapshot');
      assert.equal(event.inventory_version, plan.initial_inventory_version + 1);
      assert.equal(
        current.property[0].inventory_version,
        event.inventory_version,
      );
      assert.equal(
        current.sale_restriction.length,
        plan.protected_snapshot.sale_restriction.count + 1,
      );
      assert.equal(
        current.distribution_mapping_version.length,
        plan.protected_snapshot.distribution_mapping_version.count + 1,
      );
      assert.equal(
        current.distribution_outbox_event.length,
        plan.protected_snapshot.distribution_outbox_event.count + 1,
      );
      assert.equal(
        current.distribution_inbox_revision.length,
        plan.protected_snapshot.distribution_inbox_revision.count,
      );
      equal(event.payload_safe.cells, [
        {
          rate_ref: plan.bodies.mapping.external_rate_ref,
          date: '2026-10-15',
          price: null,
          currency: null,
          min_stay: null,
          max_stay: null,
          stop_sell: true,
          closed_to_arrival: null,
          closed_to_departure: null,
          inventory_version: event.inventory_version,
        },
      ]);
      const worker_environment = {
        CHANNEX_STAGING_WORKER: 'on',
        DISTRIBUTION_WORKER: 'on',
        NIGHT_AUDIT_WORKER: 'off',
        REPORT_EXPORT_WORKER: 'off',
        CHANNEX_STAGING_TENANT_ID: tenant,
        CHANNEX_STAGING_PROPERTY_ID: property,
        CHANNEX_STAGING_CONNECTION_ID: connectionId,
        CHANNEX_STAGING_EXTERNAL_PROPERTY_ID:
          plan.bodies.connection.external_property_id,
        CHANNEX_STAGING_EXTERNAL_ROOM_ID: plan.bodies.mapping.external_room_ref,
        CHANNEX_STAGING_EXTERNAL_RATE_ID: plan.bodies.mapping.external_rate_ref,
        CHANNEX_STAGING_DATE: '2026-10-15',
        CHANNEX_STAGING_MAX_TICKS: 3,
      };
      atomic(
        'prepared.json',
        {
          status: 'PMS_CLOSED_OUTBOX_PREPARED_WORKER_NOT_STARTED',
          connection_id: connectionId,
          mapping_id: mapped.id,
          restriction_id: restriction.id,
          outbox_id: event.id,
          worker_environment,
        },
        true,
      );
      console.log(
        json({
          status: 'PMS_CLOSED_OUTBOX_PREPARED_WORKER_NOT_STARTED',
          connection_id: connectionId,
          outbox_id: event.id,
        }),
      );
    } else {
      const prepared = JSON.parse(readFileSync(`${out}/prepared.json`));
      connectionId = prepared.connection_id;
      harness = await import('../tests/property/support/harness.mjs');
      account = await harness.loginAs('admin-a');
      assert.equal(account.session.body.authenticated, true);
      assert.equal(account.session.body.user.id, plan.expected_user_id);
      assert.equal(account.session.body.session.active_tenant_id, tenant);
      const connectionsGet = await harness.apiRequest(
        account.context,
        'GET',
        `${base}/connections`,
      );
      assert.equal(connectionsGet.status, 200);
      assert.equal(connectionsGet.body.items.length, 1);
      assert.equal(connectionsGet.body.items[0].id, connectionId);
      const mappingsGet = await harness.apiRequest(
        account.context,
        'GET',
        `${base}/connections/${connectionId}/mappings`,
      );
      assert.equal(mappingsGet.status, 200);
      assert.equal(mappingsGet.body.items.length, 1);
      assert.equal(mappingsGet.body.items[0].id, prepared.mapping_id);
      current = await unchanged();

      const found = connectionMatches();
      assert.equal(found.length, 1);
      assert.equal(found[0].id, connectionId);
      assert.equal(current.distribution_connection.length, 1);
      const event = current.distribution_outbox_event.find(
        (row) => row.id === prepared.outbox_id,
      );
      assert.ok(
        event &&
          event.connection_id === connectionId &&
          event.status === 'ACKNOWLEDGED',
      );
      assert.equal(event.certainty, 'PROVIDER_ACCEPTED');
      const attempts = current.distribution_sync_attempt.filter(
        (row) => row.outbox_id === event.id,
      );
      assert.equal(attempts.length, 1);
      assert.equal(event.provider_task_id, attempts[0].provider_task_id);
      assert.equal(attempts[0].certainty, 'PROVIDER_ACCEPTED');
      assert.equal(attempts[0].status, 'SUCCEEDED');
      assert.equal(
        current.property[0].inventory_version,
        plan.initial_inventory_version + 1,
      );
      assert.equal(
        current.distribution_dead_letter.length,
        plan.protected_snapshot.distribution_dead_letter.count,
      );
      assert.equal(
        current.distribution_exception_case.length,
        plan.protected_snapshot.distribution_exception_case.count,
      );
      assert.ok(
        attempts[0].provider_task_id,
        'Actual adapter task evidence required',
      );
      assert.equal(
        current.distribution_inbox_revision.length,
        plan.protected_snapshot.distribution_inbox_revision.count,
        'This runner requires empty booking feed; lifecycle is a separate trial',
      );
      atomic(
        'check-receipt.json',
        {
          status: 'PMS_WORKER_CLOSED_RESTRICTION_PROVIDER_ACCEPTED_WITH_LIMITS',
          connection_id: connectionId,
          outbox_id: event.id,
          inventory_version: event.inventory_version,
          attempts,
          checked_at: new Date().toISOString(),
          source_hashes: plan.source_hashes,
          protected_tables_unchanged: true,
          booking_ack: 'NOT_TESTED_BOOKING_ACK',
          materialization: 'NOT_TESTED_THIS_TRIAL',
          zero_availability_price_pms_outbox: false,
          downstream_ota_proof: false,
          g13_accepted: false,
        },
        true,
      );
      console.log(
        json({
          status: 'PMS_WORKER_CLOSED_RESTRICTION_PROVIDER_ACCEPTED_WITH_LIMITS',
          booking_ack: 'NOT_TESTED_BOOKING_ACK',
        }),
      );
    }
  }
} catch {
  atomic(
    `failure-${mode}-${Date.now()}.json`,
    {
      status: 'STOPPED_NO_AUTOMATIC_RETRY',
      mode,
      journal_present: !!journal,
      at: new Date().toISOString(),
    },
    true,
  );
  console.error(
    'PMS_TRIAL_STOPPED: inspect private plan/journal and root evidence; no automatic mutation retry',
  );
  process.exitCode = 1;
} finally {
  if (harness) {
    await harness.closeSessions();
    await harness.closeBrowser();
  }
  await db.end();
}
