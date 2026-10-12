import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { Client } from 'pg';
import {
  createOrm,
  provisionPlatformStaff,
  provisionTenant,
  runPlatformTransaction,
} from '../packages/backend/dist/index.js';

const appUrl = process.env.DATABASE_URL;
if (!appUrl) throw new Error('DATABASE_URL required');
const container = process.env.P13_PG_CONTAINER ?? 'hotel-phase1-postgres-1';
const rpoTargetMinutes = Number(process.env.RESTORE_RPO_TARGET_MINUTES ?? 15);
const rtoTargetMinutes = Number(process.env.RESTORE_RTO_TARGET_MINUTES ?? 60);
const evidenceDir =
  process.env.P13_EVIDENCE_DIR ?? '.local/verification/P13-02';
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const logPath = `${evidenceDir}/restore-rehearsal.log`;
rmSync(logPath, { force: true });
const jsonPath = `${evidenceDir}/restore-rehearsal.json`;
const dumpPath = `${evidenceDir}/restore-rehearsal.dump`;

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(logPath, `${stamped}\n`, { mode: 0o600 });
}

const runId = randomBytes(4).toString('hex');
const dbA = `hotel_p13_restore_${runId}_a`;
const dbB = `hotel_p13_restore_${runId}_b`;
const appBase = new URL(appUrl);
const admin = new Client({ connectionString: appUrl });

function urlFor(name) {
  const url = new URL(appUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDatabases() {
  for (const name of [dbA, dbB]) {
    await admin.query(`drop database if exists "${name}" with (force)`);
    const snapshot = `packages/backend/src/persistence/migrations/.snapshot-${name}.json`;
    try {
      rmSync(snapshot, { force: true });
    } catch {
      /* snapshot is optional */
    }
  }
}

function migrate(name) {
  log(`migrating ${name} (fresh copy)`);
  execFileSync(
    process.execPath,
    [
      'node_modules/@mikro-orm/cli/cli.js',
      'migration:up',
      '--config',
      'dist/persistence/mikro-orm.config.js',
    ],
    {
      cwd: 'packages/backend',
      env: { ...process.env, MIGRATION_DATABASE_URL: urlFor(name) },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000,
    },
  );
}

function dockerPg(args) {
  return execFileSync(
    'docker',
    ['exec', '-e', 'PGPASSWORD', container, ...args],
    {
      env: { ...process.env, PGPASSWORD: appBase.password },
      maxBuffer: 1024 * 1024 * 1024,
    },
  );
}

function dump(name, path) {
  log(`pg_dump ${name} (custom format, via ${container})`);
  const started = Date.now();
  const output = dockerPg([
    'pg_dump',
    '-h',
    '127.0.0.1',
    '-p',
    '5432',
    '-U',
    appBase.username,
    '-Fc',
    '-d',
    name,
  ]);
  writeFileSync(path, output, { mode: 0o600 });
  return Date.now() - started;
}

function restore(name, path) {
  log(`pg_restore into ${name}`);
  const started = Date.now();
  const payload = readFileSync(path);
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      container,
      'pg_restore',
      '-h',
      '127.0.0.1',
      '-p',
      '5432',
      '-U',
      appBase.username,
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '-d',
      name,
    ],
    {
      env: { ...process.env, PGPASSWORD: appBase.password },
      input: payload,
      maxBuffer: 1024 * 1024 * 1024,
    },
  );
  return Date.now() - started;
}

async function counts(name) {
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    const result = await client.query(`
      select
        (select count(*) from "property")::int as properties,
        (select count(*) from "product")::int as products,
        (select count(*) from "distribution_connection")::int as connections,
        (select count(*) from "exposure")::int as exposures,
        (select count(*) from "sale_restriction" where "platform_stop" and "state" = 'ACTIVE')::int as platform_stops,
        (select count(*) from "distribution_outbox_event" where "event_type" = 'AvailabilitySnapshot' and "status" = 'PENDING')::int as pending_increases,
        (select count(*) from "sale_restriction" where "state" = 'OPENED')::int as opened_restrictions
    `);
    return result.rows[0];
  } finally {
    await client.end();
  }
}

let exitCode = 0;
try {
  await admin.connect();
  await dropDatabases();
  await admin.query(`create database "${dbA}"`);
  migrate(dbA);

  log(`provisioning synthetic tenant in ${dbA}`);
  const orm = await createOrm(urlFor(dbA));
  const tenant = await provisionTenant(orm, {
    name: 'P13 Restore Rehearsal Tenant',
    slug: `p13-restore-${runId}`,
    owner: {
      identitySubject: `p13-restore-owner-${runId}`,
      issuer: 'https://local.test/realms/p13',
      email: `owner-${runId}@p13.test`,
      displayName: 'P13 Restore Owner',
    },
  });
  const staff = await provisionPlatformStaff(orm, {
    identitySubject: `p13-restore-platform-${runId}`,
    issuer: 'https://local.test/realms/p13',
    email: `platform-${runId}@p13.test`,
    displayName: 'P13 Restore Platform',
    roleCode: 'PLATFORM_ADMIN',
  });

  const propertyId = randomBytes(16).toString('hex');
  const connectionId = randomBytes(16).toString('hex');
  const productId = randomBytes(16).toString('hex');
  const exposureId = randomBytes(16).toString('hex');
  const uuid = (hex) =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const propertyUuid = uuid(propertyId);
  const connectionUuid = uuid(connectionId);
  const productUuid = uuid(productId);
  const exposureUuid = uuid(exposureId);

  await orm.em.fork().transactional(async (em) => {
    await em.execute(`select set_config('app.tenant_id', ?, true)`, [
      tenant.tenantId,
    ]);
    await em.execute(`select set_config('app.user_id', ?, true)`, [
      tenant.userId,
    ]);
    await em.execute(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone", "status")
       values (?, ?, ?, 'P13 Rehearsal Villa', 'Asia/Jakarta', 'ACTIVE')`,
      [propertyUuid, tenant.tenantId, `P13-${runId}`],
    );
    await em.execute(
      `insert into "product" ("id", "tenant_id", "property_id", "code", "name", "kind", "status")
       values (?, ?, ?, 'P13-VILLA', 'P13 Villa Whole', 'ROOM', 'ACTIVE')`,
      [productUuid, tenant.tenantId, propertyUuid],
    );
    await em.execute(
      `insert into "distribution_connection" (
         "id", "tenant_id", "property_id", "provider_key", "environment",
         "channel_key", "external_property_id", "secret_ref", "status"
       ) values (?, ?, ?, 'simulator', 'test', 'tiket-com', ?, 'secret:synthetic', 'ACTIVE')`,
      [connectionUuid, tenant.tenantId, propertyUuid, `EXT-P13-${runId}`],
    );
    await em.execute(
      `insert into "exposure" (
         "id", "tenant_id", "property_id", "connection_id", "product_id",
         "start_date", "end_date", "mode", "state", "inventory_version"
       ) values (?, ?, ?, ?, ?, current_date + 1, current_date + 11, 'WHOLE', 'ACTIVE', 1)`,
      [
        exposureUuid,
        tenant.tenantId,
        propertyUuid,
        connectionUuid,
        productUuid,
      ],
    );
  });

  const freeze = await runPlatformTransaction(
    orm,
    { platformUserId: staff.userId },
    async (em) => {
      const result = await em.execute(
        `select public.platform_stop_tenant_sales(?, ?, ?) as "inserted"`,
        [tenant.tenantId, staff.userId, 'P13-02 restore rehearsal freeze'],
      );
      return result[0].inserted;
    },
  );
  log(
    `sales freeze applied before backup: platform_stop_tenant_sales inserted=${freeze}`,
  );
  await orm.close(true);

  const before = await counts(dbA);
  log(`pre-backup counts ${JSON.stringify(before)}`);

  const dumpStartedAt = Date.now();
  const dumpMillis = dump(dbA, dumpPath);
  const dumpStartedIso = new Date(dumpStartedAt).toISOString();

  const postDumpClient = new Client({ connectionString: urlFor(dbA) });
  await postDumpClient.connect();
  const postDumpMarker = `P13-POST-DUMP-${runId}`;
  await postDumpClient.query(
    `insert into "property" ("tenant_id", "code", "name", "timezone", "status")
     values ($1, $2, 'P13 Post Dump Marker', 'Asia/Jakarta', 'ACTIVE')`,
    [tenant.tenantId, postDumpMarker],
  );
  const markerCommittedAt = await postDumpClient.query('select now() as at');
  await postDumpClient.end();

  await admin.query(`create database "${dbB}"`);
  const restoreStartedAt = Date.now();
  const restoreMillis = restore(dbB, dumpPath);

  const after = await counts(dbB);
  log(`post-restore counts ${JSON.stringify(after)}`);
  const marker = await new Client({ connectionString: urlFor(dbB) })
    .connect()
    .then(async (client) => {
      const rows = await client.query(
        `select count(*)::int as present from "property" where "code" = $1`,
        [postDumpMarker],
      );
      await client.end();
      return rows.rows[0].present;
    });

  const rpoProvenSeconds =
    (new Date(markerCommittedAt.rows[0].at).getTime() - dumpStartedAt) / 1000;
  const rtoMeasuredSeconds = (Date.now() - restoreStartedAt) / 1000;

  const record = {
    run_id: runId,
    database_source: dbA,
    database_restored: dbB,
    dump_started_at: dumpStartedIso,
    freeze_before_backup: freeze,
    counts_before: before,
    counts_after: after,
    post_dump_marker_present_after_restore: marker,
    dump_millis: dumpMillis,
    restore_millis: restoreMillis,
    rpo_proven_seconds: Number(rpoProvenSeconds.toFixed(3)),
    rpo_target_minutes: rpoTargetMinutes,
    rto_measured_seconds: Number(rtoMeasuredSeconds.toFixed(3)),
    rto_target_minutes: rtoTargetMinutes,
    limits_declared: {
      local_only: true,
      not_staging_measurement: true,
      not_production_authorization: true,
    },
  };
  writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });

  const countsEqual = [
    'properties',
    'products',
    'connections',
    'exposures',
  ].every((key) => before[key] === after[key]);
  const freezePreserved = freeze === 1 && after.platform_stops === 1;
  const noIncreaseReleased =
    after.pending_increases === 0 && after.opened_restrictions === 0;
  const markerAbsent = marker === 0;
  const rtoWithinTarget = rtoMeasuredSeconds <= rtoTargetMinutes * 60;
  const rpoWithinTarget = rpoProvenSeconds <= rpoTargetMinutes * 60;

  log(
    `checks: counts_equal=${countsEqual} freeze_preserved=${freezePreserved} ` +
      `no_increase_released=${noIncreaseReleased} marker_absent=${markerAbsent} ` +
      `rto_within_target=${rtoWithinTarget} rpo_within_target=${rpoWithinTarget}`,
  );
  log(
    `measured: rpo_proven_seconds=${record.rpo_proven_seconds} ` +
      `(target ${rpoTargetMinutes}m), rto_measured_seconds=${record.rto_measured_seconds} ` +
      `(target ${rtoTargetMinutes}m)`,
  );
  if (
    !countsEqual ||
    !freezePreserved ||
    !noIncreaseReleased ||
    !markerAbsent ||
    !rtoWithinTarget ||
    !rpoWithinTarget
  ) {
    log('REHEARSAL FAILED');
    exitCode = 1;
  } else {
    log(
      'REHEARSAL PASSED (local DB-level restore with freeze preserved and explicit resume still required)',
    );
  }
} catch (error) {
  log(`REHEARSAL ERROR: ${error?.stack ?? error?.message ?? error}`);
  exitCode = 1;
} finally {
  try {
    await dropDatabases();
  } catch (error) {
    log(`cleanup warning: ${error?.message ?? error}`);
  }
  await admin.end().catch(() => {});
  if (!process.argv.includes('--keep-dump')) rmSync(dumpPath, { force: true });
}
process.exit(exitCode);
