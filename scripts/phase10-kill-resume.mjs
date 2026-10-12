import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { Client } from 'pg';
import {
  addMemberWithRole,
  createOrm,
  provisionTenant,
} from '../packages/backend/dist/index.js';

/**
 * P10-02 kill/resume evidence: runs a real worker process against a fresh
 * synthetic database, SIGKILLs it after every committed checkpoint, restarts
 * it, and proves the night audit resumes without a second charge (AT-F06).
 * Usage: node --env-file=.env scripts/phase10-kill-resume.mjs [--keep]
 */

const appUrl = process.env.DATABASE_URL;
if (!appUrl) throw new Error('DATABASE_URL required; run with --env-file=.env');
const evidenceDir = '.local/verification/P10-02';
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const killLogPath = `${evidenceDir}/kill-resume-${stamp}.log`;
const summaryPath = `${evidenceDir}/kill-resume-summary.json`;
const apiLogPath = `${evidenceDir}/kill-resume-api.log`;
const workerLogPath = `${evidenceDir}/kill-resume-worker.log`;
const killLog = openSync(killLogPath, 'a', 0o600);

function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(entry);
  appendFileSync(killLog, entry, { mode: 0o600 });
}

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const database = `hotel_test_${runId}_p10`;
const apiPort = process.env.API_PORT ?? '4100';
const workerPort = process.env.WORKER_PORT ?? '4101';
const apiBase = `http://127.0.0.1:${apiPort}`;

function runtimeUrl(base, db) {
  const url = new URL(base);
  url.pathname = `/${db}`;
  return url.toString();
}

async function withRoot(task) {
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.end();
  }
}

const ownerUrl = (() => {
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? appUrl);
  url.pathname = `/${database}`;
  return url.toString();
})();

async function withOwner(task) {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    return await task(client);
  } finally {
    await client.end();
  }
}

async function dbRows(sql, params = []) {
  return withOwner(async (client) => {
    const result = await client.query(sql, params);
    return result.rows;
  });
}

async function serviceReady(url, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 200 || response.status === 503) return true;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function portBusy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

function spawnLogged(command, args, env, logPath, marker) {
  appendFileSync(logPath, `\n--- ${marker} ${new Date().toISOString()} ---\n`, {
    mode: 0o600,
  });
  const out = openSync(logPath, 'a', 0o600);
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', out, out],
    detached: true,
  });
  closeSync(out);
  child.unref();
  return child;
}

function killProcess(child, signal = 'SIGKILL') {
  if (!child?.pid) return null;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      return false;
    }
  }
  return true;
}

let apiProcess = null;
let workerProcess = null;
let browserCleanup = null;
let exitCode = 0;
const summary = {
  database,
  evidence: { killLogPath, apiLogPath, workerLogPath },
  kills: [],
  checks: {},
};

try {
  if (await portBusy(`${apiBase}/api/v1/system/ready`))
    throw new Error(
      `An API already owns port ${apiPort}; stop dev/api before this evidence run`,
    );
  if (await portBusy(`http://127.0.0.1:${workerPort}/health`))
    throw new Error(
      `A worker already owns port ${workerPort}; stop dev/worker before this evidence run`,
    );

  log(`creating database ${database}`);
  await withRoot(async (client) => {
    await client.query(`create database "${database}"`);
  });
  log('migrating database');
  const migrateLog = openSync(apiLogPath, 'a', 0o600);
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
      env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl },
      stdio: ['ignore', migrateLog, migrateLog],
      timeout: 180000,
    },
  );
  closeSync(migrateLog);

  const identityUsers = JSON.parse(
    readFileSync('.local/identity-users.json', 'utf8'),
  );
  const identityUser = (username) => {
    const entry = identityUsers.users[username];
    if (!entry) throw new Error(`Missing synthetic identity ${username}`);
    return {
      identitySubject: entry.id,
      issuer: identityUsers.issuer,
      email: entry.email,
      displayName: null,
    };
  };
  const orm = await createOrm(runtimeUrl(appUrl, database));
  let tenantId;
  try {
    const tenant = await provisionTenant(orm, {
      name: 'P10 Kill Resume Tenant',
      slug: `p10-kill-${runId}`,
      owner: identityUser('owner-a'),
    });
    tenantId = tenant.tenantId;
    await addMemberWithRole(orm, {
      tenantId,
      user: identityUser('admin-a'),
      roleCode: 'TENANT_ADMIN',
    });
  } finally {
    await orm.close(true);
  }
  log(`provisioned tenant ${tenantId}`);

  const apiEnv = {
    API_DATABASE_URL: runtimeUrl(process.env.API_DATABASE_URL, database),
    WORKER_DATABASE_URL: runtimeUrl(process.env.WORKER_DATABASE_URL, database),
  };
  apiProcess = spawnLogged(
    process.execPath,
    ['--env-file=.env', 'apps/api/dist/main.js'],
    apiEnv,
    apiLogPath,
    `api start pid=%PID%`,
  );
  if (!(await serviceReady(`${apiBase}/api/v1/system/ready`)))
    throw new Error('API did not become ready');
  log(`api ready pid=${apiProcess.pid}`);

  process.env.IDENTITY_TEST_DB = database;
  process.env.HARNESS_SHARED_API = '0';
  const harness = await import('../tests/identity/support/harness.mjs');
  browserCleanup = harness.closeBrowser;
  const admin = await harness.loginFresh('admin-a');
  const api = (method, path, options = {}) =>
    harness.apiRequest(
      admin.context,
      method,
      `/tenants/${tenantId}${path}`,
      options,
    );
  log('admin-a authenticated');

  const propertyCreate = await api('POST', '/properties', {
    body: {
      code: `P10-KR-${runId}`,
      name: `P10 Kill Resume ${runId}`,
      timezone: 'Asia/Jakarta',
    },
  });
  if (propertyCreate.status !== 201)
    throw new Error(`property create ${propertyCreate.status}`);
  const propertyId = propertyCreate.body.property.id;
  const base = `/properties/${propertyId}`;
  const rooms = [];
  for (let index = 1; index <= 4; index += 1) {
    const resource = await api('POST', `${base}/resources`, {
      body: { code: `P10-KR-R${index}-${runId}`, type: 'ROOM', capacity: 2 },
    });
    if (resource.status !== 201)
      throw new Error(
        `resource ${index} ${resource.status} ${JSON.stringify(resource.body)}`,
      );
    rooms.push(resource.body.resource);
  }
  const product = await api('POST', `${base}/products`, {
    body: {
      code: `P10-KR-P-${runId}`,
      name: `P10 KR ${runId}`,
      kind: 'ROOM',
      occupancy_adults_max: 2,
    },
  });
  if (product.status !== 201)
    throw new Error(
      `product ${product.status} ${JSON.stringify(product.body)}`,
    );
  const productId = product.body.product.id;
  for (const room of rooms) {
    await api('POST', `${base}/products/${productId}/candidates`, {
      body: { resource_id: room.id },
    });
  }
  await api('PATCH', `${base}/products/${productId}`, {
    body: { version: product.body.product.version, status: 'ACTIVE' },
  });
  const plan = await api('POST', `${base}/rate-plans`, {
    body: {
      code: `P10-KR-RP-${runId}`,
      name: `P10 KR ${runId}`,
      product_id: productId,
      currency: 'IDR',
    },
  });
  if (plan.status !== 201)
    throw new Error(`rate plan ${plan.status} ${JSON.stringify(plan.body)}`);
  const planId = plan.body.rate_plan.id;
  await api('PATCH', `${base}/rate-plans/${planId}`, {
    body: { version: plan.body.rate_plan.version, status: 'ACTIVE' },
  });
  const addDays = (days) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const cells = [];
  for (let offset = 0; offset <= 10; offset += 1) {
    cells.push({
      rate_plan_id: planId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '275000', currency: 'IDR' },
    });
  }
  await api('POST', `${base}/rates/batch`, { body: { cells } });

  const day = await api('GET', `${base}/finance/business-day`);
  const openDay = day.body.date;

  async function createStay(index) {
    const draft = await api('POST', `${base}/reservations/drafts`, {
      body: {
        source: 'DIRECT',
        items: [
          {
            product_id: productId,
            period: { arrival: openDay, departure: addDays(2) },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
      },
    });
    if (draft.status !== 201)
      throw new Error(`draft ${draft.status} ${JSON.stringify(draft.body)}`);
    const reservationId = draft.body.reservation.id;
    const detail = await api('GET', `${base}/reservations/${reservationId}`);
    if (detail.status !== 200)
      throw new Error(`detail ${detail.status} ${JSON.stringify(detail.body)}`);
    const itemId = detail.body.items[0].id;
    const quote = await api('POST', `${base}/quotes`, {
      body: {
        product_id: productId,
        rate_plan_id: planId,
        period: { arrival: openDay, departure: addDays(2) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    });
    if (quote.status !== 201)
      throw new Error(`quote ${quote.status} ${JSON.stringify(quote.body)}`);
    const rates = await api(
      'GET',
      `${base}/rates?from=${addDays(0)}&to=${addDays(10)}`,
    );
    const confirmed = await api('POST', `${base}/reservations`, {
      body: {
        reservation_id: reservationId,
        inventory_version: rates.body.inventory_version,
        items: [{ item_id: itemId, price_snapshot_id: quote.body.quote.id }],
      },
    });
    if (confirmed.status !== 200)
      throw new Error(
        `confirm ${confirmed.status} ${JSON.stringify(confirmed.body)}`,
      );
    const confirmedDetail = await api(
      'GET',
      `${base}/reservations/${reservationId}`,
    );
    const confirmedItem = confirmedDetail.body.items.find(
      (entry) => entry.id === itemId,
    );
    const checkIn = await api(
      'POST',
      `${base}/reservations/${reservationId}/items/${itemId}/check-in`,
      {
        body: { version: confirmedItem.version, resource_id: rooms[index].id },
        headers: { 'idempotency-key': `p10-kr-ci-${runId}-${index}` },
      },
    );
    if (checkIn.status !== 200)
      throw new Error(
        `check-in ${checkIn.status} ${JSON.stringify(checkIn.body)}`,
      );
    const folio = await api('POST', `${base}/folios`, {
      body: {
        reservation_id: reservationId,
        kind: 'GUEST',
        payer_label: `KR Guest ${index}`,
        currency: 'IDR',
      },
      headers: { 'idempotency-key': `p10-kr-folio-${runId}-${index}` },
    });
    if (folio.status !== 200)
      throw new Error(`folio ${folio.status} ${JSON.stringify(folio.body)}`);
    return { reservationId, itemId, folioId: folio.body.folio.id };
  }

  const stays = [];
  for (let index = 0; index < 3; index += 1)
    stays.push(await createStay(index));
  log(`fixtures ready: 3 in-house stays with folios; business date ${openDay}`);

  const started = await api('POST', `${base}/night-audits/runs`, {
    body: { business_date: openDay },
    headers: { 'idempotency-key': `p10-kr-start-${runId}` },
  });
  if (started.status !== 202)
    throw new Error(
      `start run ${started.status} ${JSON.stringify(started.body)}`,
    );
  const runIdValue = started.body.run.id;
  log(`night audit run ${runIdValue} queued (PENDING)`);

  const workerEnv = {
    WORKER_DATABASE_URL: runtimeUrl(process.env.WORKER_DATABASE_URL, database),
    API_DATABASE_URL: runtimeUrl(process.env.API_DATABASE_URL, database),
    NIGHT_AUDIT_WORKER: 'on',
    NIGHT_AUDIT_POLL_MS: '250',
    NIGHT_AUDIT_LEASE_MS: '1500',
    NIGHT_AUDIT_STEP_DELAY_MS: '600',
    DISTRIBUTION_WORKER: 'off',
  };

  async function startWorker() {
    const child = spawnLogged(
      process.execPath,
      ['--env-file=.env', 'apps/worker/dist/main.js'],
      workerEnv,
      workerLogPath,
      `worker start`,
    );
    const ready = await serviceReady(
      `http://127.0.0.1:${workerPort}/health`,
      80,
    );
    log(`worker pid=${child.pid} ready=${ready}`);
    return child;
  }

  async function stopWorker(child) {
    if (!child) return;
    killProcess(child, 'SIGKILL');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  workerProcess = await startWorker();

  const expectedCharges = stays.length;
  let lastDone = 0;
  let killIndex = 0;
  let iterations = 0;
  let terminal = null;
  while (iterations < 120) {
    iterations += 1;
    const run = (
      await dbRows(
        `select "state", "current_step", "attempt", "steps_done", "steps_total"
           from "night_audit_run" where "id" = $1`,
        [runIdValue],
      )
    )[0];
    const steps = await dbRows(
      `select "step_key", "state" from "night_audit_step"
        where "run_id" = $1 order by "step_order"`,
      [runIdValue],
    );
    const doneSteps = steps.filter((step) => step.state === 'DONE');
    const charges = (
      await dbRows(
        `select count(*)::int as "count" from "folio_charge"
          where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'`,
        [propertyId],
      )
    )[0].count;

    if (
      doneSteps.length > lastDone &&
      !['SUCCEEDED', 'VALIDATION_FAILED', 'FAILED'].includes(run.state)
    ) {
      const runningStep =
        steps.find((step) => step.state === 'RUNNING')?.step_key ?? null;
      killIndex += 1;
      const killedPid = workerProcess?.pid ?? null;
      killProcess(workerProcess, 'SIGKILL');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        workerProcess.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const killRecord = {
        kill: killIndex,
        after_checkpoint: doneSteps[doneSteps.length - 1].step_key,
        done_steps: doneSteps.map((step) => step.step_key),
        running_step_at_kill: runningStep,
        run_state_at_kill: run.state,
        charges_at_kill: charges,
        pid: killedPid,
      };
      summary.kills.push(killRecord);
      log(`SIGKILL worker pid=${killedPid} ${JSON.stringify(killRecord)}`);
      workerProcess = await startWorker();
      const resumed = (
        await dbRows(
          `select "state", "current_step", "steps_done", "attempt"
             from "night_audit_run" where "id" = $1`,
          [runIdValue],
        )
      )[0];
      log(
        `resumed run state=${resumed.state} current_step=${resumed.current_step} steps_done=${resumed.steps_done} attempt=${resumed.attempt}`,
      );
      lastDone = doneSteps.length;
    }

    if (['SUCCEEDED', 'VALIDATION_FAILED', 'FAILED'].includes(run.state)) {
      terminal = run;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (!terminal || terminal.state !== 'SUCCEEDED')
    throw new Error(`run did not succeed: ${JSON.stringify(terminal)}`);
  log(`run SUCCEEDED after ${summary.kills.length} kill/resume cycles`);

  const chargesAfter = await dbRows(
    `select "source_ref", "net_amount"::text as "net_amount"
       from "folio_charge"
      where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'
      order by "source_ref"`,
    [propertyId],
  );
  const nightlyJournals = await dbRows(
    `select j."id", j."total_debit"::text as "total_debit", j."total_credit"::text as "total_credit",
            (select count(*)::int from "journal_line" l where l."journal_id" = j."id") as "lines"
       from "journal" j
      where j."property_id" = $1 and j."source_type" = 'CHARGE'
        and j."memo" like 'Night %'`,
    [propertyId],
  );
  const dayState = await dbRows(
    `select "business_date"::text as "business_date", "state" from "business_day"
      where "property_id" = $1 order by "business_date"`,
    [propertyId],
  );
  summary.checks = {
    expected_charges: expectedCharges,
    charges_after_resume: chargesAfter.length,
    charge_refs: chargesAfter.map((row) => row.source_ref),
    nightly_journals: nightlyJournals.length,
    journals_balanced: nightlyJournals.every(
      (row) => row.total_debit === row.total_credit,
    ),
    business_days: dayState,
  };
  log(`charges after resume: ${JSON.stringify(summary.checks)}`);
  if (chargesAfter.length !== expectedCharges)
    throw new Error(
      `expected ${expectedCharges} nightly charges, found ${chargesAfter.length}`,
    );
  if (nightlyJournals.length !== expectedCharges)
    throw new Error('nightly journal count mismatch');
  if (!nightlyJournals.every((row) => row.total_debit === row.total_credit))
    throw new Error('nightly journal is unbalanced');

  await stopWorker(workerProcess);
  workerProcess = null;
  workerProcess = await startWorker();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const chargesIdle = await dbRows(
    `select "id" from "folio_charge"
      where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'`,
    [propertyId],
  );
  const runIdle = (
    await dbRows(
      `select "state", "attempt" from "night_audit_run" where "id" = $1`,
      [runIdValue],
    )
  )[0];
  summary.checks.restart_after_completion = {
    charges: chargesIdle.length,
    run_state: runIdle.state,
    attempt: runIdle.attempt,
  };
  log(
    `restart after completion: ${JSON.stringify(summary.checks.restart_after_completion)}`,
  );
  if (chargesIdle.length !== expectedCharges)
    throw new Error('a restarted worker posted a second charge');

  const replay = await api('POST', `${base}/night-audits`, {
    body: { business_date: openDay },
    headers: { 'idempotency-key': `p10-kr-replay-${runId}` },
  });
  summary.checks.replay = {
    status: replay.status,
    replayed: replay.body.replayed,
  };
  log(`sync replay: ${JSON.stringify(summary.checks.replay)}`);
  if (replay.status !== 200 || replay.body.replayed !== true)
    throw new Error('completed run did not replay with the same result');
} catch (error) {
  exitCode = 1;
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  summary.status = exitCode === 0 ? 'PASS' : 'FAIL';
  summary.finished_at = new Date().toISOString();
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), { mode: 0o600 });
  if (workerProcess) killProcess(workerProcess, 'SIGKILL');
  if (apiProcess) {
    killProcess(apiProcess, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 800));
    killProcess(apiProcess, 'SIGKILL');
  }
  if (browserCleanup) await browserCleanup().catch(() => undefined);
  if (!process.argv.includes('--keep')) {
    await withRoot(async (client) => {
      await client.query(`drop database if exists "${database}" with (force)`);
    }).catch(() => undefined);
    rmSync(
      `packages/backend/src/persistence/migrations/.snapshot-${database}.json`,
      { force: true },
    );
  } else {
    log(`keeping database ${database}`);
  }
  closeSync(killLog);
}

process.exit(exitCode);
