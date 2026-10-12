import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { Client } from 'pg';
import {
  addMemberWithRole,
  createOrm,
  provisionPlatformStaff,
  provisionTenant,
} from '../packages/backend/dist/index.js';

const appUrl = process.env.DATABASE_URL;
if (!appUrl)
  throw new Error('DATABASE_URL required; run through pnpm test:property');

if (!existsSync('.local/identity-users.json')) {
  console.log(
    'Provisioning local identity realm first (pnpm identity:local)...',
  );
  execFileSync(process.execPath, ['--env-file=.env', 'scripts/identity.mjs'], {
    stdio: 'inherit',
    timeout: 180000,
  });
}
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

const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const database = `hotel_test_${runId}_property`;
const tenantSlugs = {
  a: `p04-a-${runId}`,
  b: `p04-b-${runId}`,
};

function urlFor(base, name) {
  const url = new URL(base);
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

async function dropDatabase() {
  await admin(async (client) => {
    await client.query(`drop database if exists "${database}" with (force)`);
  });
  const snapshot = `packages/backend/src/persistence/migrations/.snapshot-${database}.json`;
  try {
    (await import('node:fs')).rmSync(snapshot, { force: true });
  } catch {
    /* nothing to remove */
  }
}

const apiBaseUrl = `http://127.0.0.1:${process.env.API_PORT ?? 4100}`;
const apiLogPath =
  process.env.HARNESS_API_LOG ?? '.local/verification/P04-01/property-api.log';
const sharedApiEnabled = process.env.PROPERTY_SHARED_API !== '0';

function runtimeUrl(base) {
  if (!base) throw new Error('API_DATABASE_URL/WORKER_DATABASE_URL required');
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function apiIsReady() {
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/system/ready`);
    return response.status === 200;
  } catch {
    return false;
  }
}

const sharedApiLockPath = '.local/harness-shared-api.lock';

function lockHolder() {
  try {
    return JSON.parse(readFileSync(sharedApiLockPath, 'utf8'));
  } catch {
    return null;
  }
}

function lockHolderAlive(holder) {
  if (!holder || !Number.isInteger(holder.pid)) return false;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireSharedApiLock() {
  const deadline = Date.now() + 30 * 60 * 1000;
  mkdirSync('.local', { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      writeFileSync(
        sharedApiLockPath,
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
        { flag: 'wx', mode: 0o600 },
      );
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = lockHolder();
      if (!lockHolderAlive(holder)) {
        try {
          unlinkSync(sharedApiLockPath);
        } catch {
          /* Another waiter removed it first. */
        }
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for ${sharedApiLockPath} held by pid ${holder.pid}`,
          { cause: error },
        );
      console.log(
        `Another test:property run holds the shared API (pid ${holder.pid}); waiting...`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

function releaseSharedApiLock() {
  const holder = lockHolder();
  if (holder?.pid !== process.pid) return;
  try {
    unlinkSync(sharedApiLockPath);
  } catch {
    /* Already gone. */
  }
}

async function stopSharedApi(child) {
  if (!child) return;
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      /* already gone */
    }
  };
  signal('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  signal('SIGKILL');
}

async function startSharedApi() {
  if (await apiIsReady())
    throw new Error(
      `An API is already bound to ${apiBaseUrl}; stop it before pnpm test:property`,
    );
  const logDirectory = apiLogPath.includes('/')
    ? apiLogPath.slice(0, apiLogPath.lastIndexOf('/'))
    : '.';
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  appendFileSync(
    apiLogPath,
    `\n--- shared api start ${new Date().toISOString()} ---\n`,
    { mode: 0o600 },
  );
  const log = openSync(apiLogPath, 'a', 0o600);
  const child = spawn(
    process.execPath,
    ['--env-file=.env', 'apps/api/dist/main.js'],
    {
      env: {
        ...process.env,
        API_DATABASE_URL: runtimeUrl(process.env.API_DATABASE_URL),
        WORKER_DATABASE_URL: runtimeUrl(process.env.WORKER_DATABASE_URL),
      },
      stdio: ['ignore', log, log],
      detached: true,
    },
  );
  closeSync(log);
  child.unref();
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(
        `Shared API exited before becoming ready (exit ${child.exitCode}); see ${apiLogPath}`,
      );
    if (await apiIsReady()) return child;
    if (Date.now() > deadline) {
      await stopSharedApi(child);
      throw new Error(
        `Shared API did not become ready within 60s; see ${apiLogPath}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

let exitCode;
let sharedApi = null;
try {
  await admin(async (client) => {
    await client.query(`create database "${database}"`);
  });
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
      env: { ...process.env, MIGRATION_DATABASE_URL: urlFor(appUrl, database) },
      stdio: 'inherit',
      timeout: 180000,
    },
  );

  const orm = await createOrm(urlFor(appUrl, database));
  const tenants = {};
  try {
    const tenantA = await provisionTenant(orm, {
      name: 'P04 Synthetic Tenant A',
      slug: tenantSlugs.a,
      owner: identityUser('owner-a'),
    });
    tenants.a = tenantA.tenantId;
    for (const [username, roleCode] of [
      ['admin-a', 'TENANT_ADMIN'],
      ['member-a', 'MEMBER'],
      ['auditor-a', 'AUDITOR'],
    ])
      await addMemberWithRole(orm, {
        tenantId: tenantA.tenantId,
        user: identityUser(username),
        roleCode,
      });
    const tenantB = await provisionTenant(orm, {
      name: 'P04 Synthetic Tenant B',
      slug: tenantSlugs.b,
      owner: identityUser('owner-b'),
    });
    tenants.b = tenantB.tenantId;
    for (const [username, roleCode] of [
      ['platform-a', 'PLATFORM_ADMIN'],
      ['platform-b', 'PLATFORM_ADMIN'],
      ['platform-s', 'PLATFORM_SUPPORT'],
    ])
      await provisionPlatformStaff(orm, {
        ...identityUser(username),
        roleCode,
      });
  } finally {
    await orm.close(true);
  }

  if (sharedApiEnabled) {
    await acquireSharedApiLock();
    sharedApi = await startSharedApi();
  }

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
      'jest.property.config.mjs',
      '--runInBand',
      ...(bail ? ['--bail=1'] : []),
      ...(filterArg ? [filterArg] : []),
    ],
    {
      env: {
        ...process.env,
        IDENTITY_TEST_DB: database,
        IDENTITY_TENANT_A: tenants.a,
        IDENTITY_TENANT_B: tenants.b,
        IDENTITY_TENANT_A_SLUG: tenantSlugs.a,
        IDENTITY_TENANT_B_SLUG: tenantSlugs.b,
        HARNESS_API_LOG: apiLogPath,
        HARNESS_SHARED_API: sharedApiEnabled ? '1' : '0',
      },
      stdio: 'inherit',
      timeout: 1800000,
    },
  );
  exitCode = jest.status ?? 1;
} finally {
  if (sharedApi) await stopSharedApi(sharedApi);
  releaseSharedApiLock();
  if (process.argv.includes('--keep'))
    console.log(`Keeping test database ${database} for inspection (--keep).`);
  else await dropDatabase();
}
process.exitCode = exitCode ?? 1;
