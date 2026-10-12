import { parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';
import {
  addMemberWithRole,
  createOrm,
  findTenantBySlug,
  provisionPlatformStaff,
  provisionTenant,
} from '../packages/backend/dist/index.js';

const env = {
  ...parseEnv(readFileSync('.env', 'utf8')),
  ...process.env,
};
if (!env.DATABASE_URL)
  throw new Error('DATABASE_URL required; run pnpm env:init');
let identityUsers;
try {
  identityUsers = JSON.parse(
    readFileSync('.local/identity-users.json', 'utf8'),
  );
} catch {
  throw new Error('Run pnpm identity:local before provisioning tenants');
}

const orm = await createOrm(env.DATABASE_URL);
const issuer = identityUsers.issuer;
const user = (username) => {
  const entry = identityUsers.users[username];
  if (!entry) throw new Error(`Missing synthetic identity ${username}`);
  return {
    identitySubject: entry.id,
    issuer,
    email: entry.email,
    displayName: null,
  };
};

const plans = [
  {
    name: 'Nusantara Beach Resort',
    slug: 'nusantara-a',
    owner: 'owner-a',
    members: [
      ['admin-a', 'TENANT_ADMIN'],
      ['mfa-a', 'TENANT_ADMIN'],
      ['member-a', 'MEMBER'],
      ['auditor-a', 'AUDITOR'],
      ['viewer-v', 'MEMBER'],
    ],
  },
  {
    name: 'Sunda Highlands Hotel',
    slug: 'sunda-b',
    owner: 'owner-b',
    members: [],
  },
];

const created = [];
try {
  for (const plan of plans) {
    const existing = await orm.em
      .fork()
      .transactional((em) => findTenantBySlug(em, plan.slug));
    const provisioned = existing
      ? { tenantId: existing.id }
      : await provisionTenant(orm, {
          name: plan.name,
          slug: plan.slug,
          owner: user(plan.owner),
        });
    for (const [username, roleCode] of plan.members)
      await addMemberWithRole(orm, {
        tenantId: provisioned.tenantId,
        user: user(username),
        roleCode,
      });
    created.push(plan.slug);
  }
  for (const [username, roleCode] of [
    ['platform-a', 'PLATFORM_ADMIN'],
    ['platform-b', 'PLATFORM_ADMIN'],
    ['platform-s', 'PLATFORM_SUPPORT'],
  ])
    await provisionPlatformStaff(orm, {
      ...user(username),
      roleCode,
    });
} finally {
  await orm.close(true);
}
console.log(
  created.length > 0
    ? `Provisioned synthetic tenants: ${created.join(', ')}. No credentials printed.`
    : 'Synthetic tenants already provisioned; nothing changed.',
);
