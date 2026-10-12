import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { Client } from 'pg';
import {
  addMemberWithRole,
  createOrm,
  provisionTenant,
} from '../packages/backend/dist/index.js';

const appUrl = process.env.DATABASE_URL;
if (!appUrl)
  throw new Error('DATABASE_URL required; run through pnpm test:identity');

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
const database = `hotel_test_${runId}_identity`;
const tenantSlugs = {
  a: `p03-a-${runId}`,
  b: `p03-b-${runId}`,
  c: `p03-c-${runId}`,
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

let exitCode;
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
      name: 'P03 Synthetic Tenant A',
      slug: tenantSlugs.a,
      owner: identityUser('owner-a'),
    });
    tenants.a = tenantA.tenantId;
    for (const [username, roleCode] of [
      ['admin-a', 'TENANT_ADMIN'],
      ['mfa-a', 'TENANT_ADMIN'],
      ['member-a', 'MEMBER'],
      ['auditor-a', 'AUDITOR'],
    ])
      await addMemberWithRole(orm, {
        tenantId: tenantA.tenantId,
        user: identityUser(username),
        roleCode,
      });
    const tenantB = await provisionTenant(orm, {
      name: 'P03 Synthetic Tenant B',
      slug: tenantSlugs.b,
      owner: identityUser('owner-b'),
    });
    tenants.b = tenantB.tenantId;
    const tenantC = await provisionTenant(orm, {
      name: 'P03 Synthetic Tenant C',
      slug: tenantSlugs.c,
      owner: identityUser('mfa-a'),
    });
    tenants.c = tenantC.tenantId;
  } finally {
    await orm.close(true);
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
      'jest.identity.config.mjs',
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
        IDENTITY_TENANT_C: tenants.c,
        IDENTITY_TENANT_A_SLUG: tenantSlugs.a,
        IDENTITY_TENANT_B_SLUG: tenantSlugs.b,
      },
      stdio: 'inherit',
      timeout: 600000,
    },
  );
  exitCode = jest.status ?? 1;
} finally {
  if (process.argv.includes('--keep'))
    console.log(`Keeping test database ${database} for inspection (--keep).`);
  else await dropDatabase();
}
process.exitCode = exitCode ?? 1;
