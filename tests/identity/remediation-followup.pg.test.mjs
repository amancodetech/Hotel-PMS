import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  acceptInvitation,
  addMemberWithRole,
  changeMembershipStatus,
  createApprovalRequest,
  createOrm,
  decideApprovalRequest,
  effectivePermissions,
  evaluatePolicy,
  findRoleByCode,
  grantActionKey,
  grantHashInput,
  grantRoleToMembership,
  insertGrant,
  insertRole,
  inviteMember,
  provisionTenant,
  runScopedTransaction,
  upsertUserBySubject,
} from '../../packages/backend/dist/index.js';
import { apiDatabaseUrl, testOwnerUrl } from './support/harness.mjs';

let ownerOrm;
let apiOrm;

const actor = (userId, mfa = true) => ({
  kind: 'USER',
  userId,
  sessionId: randomUUID(),
  displayName: 'followup-test',
  mfa,
});

const user = (name) => ({
  identitySubject: randomUUID(),
  issuer: 'http://local.test/followup',
  email: `${name}-${randomUUID().slice(0, 8)}@local.test`,
  displayName: name,
});

function randomSlug(prefix) {
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

async function makeRole(tenantId, code, permissions) {
  return runScopedTransaction(ownerOrm, { tenantId }, (em) =>
    insertRole(em, {
      tenantId,
      code,
      name: code,
      description: null,
      permissions,
    }),
  );
}

async function roleByCode(tenantId, code) {
  return runScopedTransaction(ownerOrm, { tenantId }, (em) =>
    findRoleByCode(em, tenantId, code),
  );
}

async function grantFixture(tenantId, membershipId, roleId, effect = 'GRANT') {
  return runScopedTransaction(ownerOrm, { tenantId }, (em) =>
    insertGrant(em, {
      tenantId,
      membershipId,
      roleId,
      effect,
      scopeType: 'TENANT',
      propertyRefs: [],
      grantedBy: null,
      reason: 'fixture',
    }),
  );
}

async function makeUser(name, email) {
  return ownerOrm.em.fork().transactional((em) =>
    upsertUserBySubject(em, {
      identitySubject: randomUUID(),
      issuer: 'http://local.test/followup',
      email,
      displayName: name,
    }),
  );
}

async function activeGrants(tenantId, membershipId, roleId = null) {
  const rows = await runScopedTransaction(ownerOrm, { tenantId }, (em) =>
    em.execute(
      `select count(*)::int as count from "role_grant"
          where "membership_id" = ? and "revoked_at" is null
            and (?::uuid is null or "role_id" = ?::uuid)`,
      [membershipId, roleId, roleId],
    ),
  );
  return rows[0].count;
}

async function withTenantLock(tenantId, action, mutate) {
  const lock = new Client({ connectionString: testOwnerUrl });
  await lock.connect();
  await lock.query('begin');
  await lock.query(
    `select pg_advisory_xact_lock(hashtextextended('hotel:authz:' || $1, 0))`,
    [tenantId],
  );
  const pending = action().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  let waiting = false;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const probe = await lock.query(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database()
          and usename = 'hotel_api' and wait_event = 'advisory'`,
    );
    if (probe.rows[0].n > 0) {
      waiting = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    await mutate(lock);
  } finally {
    await lock.query('commit');
    await lock.end();
  }
  const result = await pending;
  expect(waiting).toBe(true);
  if (result.error) throw result.error;
  return result.value;
}

beforeAll(async () => {
  ownerOrm = await createOrm(testOwnerUrl, { pool: { min: 0, max: 4 } });
  apiOrm = await createOrm(apiDatabaseUrl(), { pool: { min: 0, max: 4 } });
});

afterAll(async () => {
  await apiOrm?.close(true);
  await ownerOrm?.close(true);
});

test('F1: a no-role invitation never restores revoked grants', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Followup F1',
    slug: randomSlug('f1'),
    owner: user('f1-owner'),
  });
  const recruiter = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f1-recruiter'),
    roleCode: 'MEMBER',
  });
  const recruiterRole = await makeRole(tenant.tenantId, 'RECRUITER', [
    'membership.invite',
  ]);
  await grantFixture(tenant.tenantId, recruiter.membershipId, recruiterRole.id);
  const former = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f1-former'),
    roleCode: 'TENANT_OWNER',
  });
  await changeMembershipStatus(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    membershipId: former.membershipId,
    status: 'REVOKED',
    reason: 'followup revocation',
    correlationId: null,
  });
  const invitation = await inviteMember(apiOrm, {
    actor: actor(recruiter.userId, false),
    tenantId: tenant.tenantId,
    email: (
      await ownerOrm.em
        .fork()
        .execute('select email from app_user where id = ?', [former.userId])
    )[0].email,
    roleId: null,
    scopeType: 'TENANT',
    scopeRefs: [],
    expiresInHours: 1,
    reason: null,
    approvalId: null,
    correlationId: null,
  });
  await acceptInvitation(apiOrm, {
    actor: actor(former.userId, false),
    token: invitation.token,
    correlationId: null,
  });
  expect(await activeGrants(tenant.tenantId, former.membershipId)).toBe(0);
  const authority = await runScopedTransaction(
    apiOrm,
    { tenantId: tenant.tenantId },
    (em) =>
      evaluatePolicy(em, {
        actor: actor(former.userId),
        tenantId: tenant.tenantId,
        permission: 'tenant.manage',
      }),
  );
  expect(authority.allowed).toBe(false);

  const newUserEmail = `f1-new-${randomUUID().slice(0, 8)}@local.test`;
  const newUser = await makeUser('f1-new', newUserEmail);
  const newInvite = await inviteMember(apiOrm, {
    actor: actor(recruiter.userId, false),
    tenantId: tenant.tenantId,
    email: newUserEmail,
    roleId: null,
    scopeType: 'TENANT',
    scopeRefs: [],
    expiresInHours: 1,
    reason: null,
    approvalId: null,
    correlationId: null,
  });
  const accepted = await acceptInvitation(apiOrm, {
    actor: actor(newUser.id, false),
    token: newInvite.token,
    correlationId: null,
  });
  expect(accepted.tenant_id).toBe(tenant.tenantId);
  expect(await activeGrants(tenant.tenantId, accepted.membership_id)).toBe(0);

  const suspended = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f1-suspended'),
    roleCode: 'MEMBER',
  });
  await changeMembershipStatus(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    membershipId: suspended.membershipId,
    status: 'SUSPENDED',
    reason: 'followup suspension',
    correlationId: null,
  });
  const suspendedEmail = (
    await ownerOrm.em
      .fork()
      .execute('select email from app_user where id = ?', [suspended.userId])
  )[0].email;
  const suspendedInvite = await inviteMember(apiOrm, {
    actor: actor(recruiter.userId, false),
    tenantId: tenant.tenantId,
    email: suspendedEmail,
    roleId: null,
    scopeType: 'TENANT',
    scopeRefs: [],
    expiresInHours: 1,
    reason: null,
    approvalId: null,
    correlationId: null,
  });
  await expect(
    acceptInvitation(apiOrm, {
      actor: actor(suspended.userId, false),
      token: suspendedInvite.token,
      correlationId: null,
    }),
  ).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
});

test('F1: a role invitation for a revoked membership keeps only the invited role', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Followup F1b',
    slug: randomSlug('f1b'),
    owner: user('f1b-owner'),
  });
  const decider = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f1b-decider'),
    roleCode: 'TENANT_ADMIN',
  });
  const granter = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f1b-granter'),
    roleCode: 'MEMBER',
  });
  const granterRole = await makeRole(tenant.tenantId, 'GRANTER', [
    'membership.invite',
    'role.grant',
    'tenant.read',
    'membership.read',
    'role.read',
    'audit.read',
    'approval.read',
    'property.read',
    'channel.read',
    'reservation.read',
    'folio.read',
    // AUDITOR also carries the P11 read-only report permissions and the P12
    // tenant subscription read; the fixture granter must hold what it delegates
    // (no assertion is relaxed).
    'report.operational.view',
    'report.financial.view',
    'subscription.read',
  ]);
  await grantFixture(tenant.tenantId, granter.membershipId, granterRole.id);
  const former = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f1b-former'),
    roleCode: 'TENANT_OWNER',
  });
  await changeMembershipStatus(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    membershipId: former.membershipId,
    status: 'REVOKED',
    reason: 'followup revocation',
    correlationId: null,
  });
  const auditor = await roleByCode(tenant.tenantId, 'AUDITOR');
  const approval = await createApprovalRequest(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    permission: 'role.grant',
    actionKey: grantActionKey('GRANT', 'TENANT'),
    resourceType: 'role',
    resourceId: auditor.id,
    resourceVersion: auditor.version,
    hashInput: grantHashInput({
      membershipId: null,
      roleId: auditor.id,
      effect: 'GRANT',
      scopeType: 'TENANT',
      propertyRefs: [],
      expiresAt: null,
      email: (
        await ownerOrm.em
          .fork()
          .execute('select email from app_user where id = ?', [former.userId])
      )[0].email,
    }),
    reason: 'followup invitation approval',
    correlationId: null,
  });
  await decideApprovalRequest(apiOrm, {
    actor: actor(decider.userId),
    tenantId: tenant.tenantId,
    approvalId: approval.id,
    permission: 'role.grant',
    decision: 'APPROVED',
    reason: null,
    correlationId: null,
  });
  const email = (
    await ownerOrm.em
      .fork()
      .execute('select email from app_user where id = ?', [former.userId])
  )[0].email;
  const invitation = await inviteMember(apiOrm, {
    actor: actor(granter.userId),
    tenantId: tenant.tenantId,
    email,
    roleId: auditor.id,
    scopeType: 'TENANT',
    scopeRefs: [],
    expiresInHours: 1,
    reason: null,
    approvalId: approval.id,
    correlationId: null,
  });
  await acceptInvitation(apiOrm, {
    actor: actor(former.userId, false),
    token: invitation.token,
    correlationId: null,
  });
  expect(
    await activeGrants(tenant.tenantId, former.membershipId, auditor.id),
  ).toBe(1);
  expect(await activeGrants(tenant.tenantId, former.membershipId)).toBe(1);
  const permissions = await runScopedTransaction(
    apiOrm,
    { tenantId: tenant.tenantId },
    (em) => effectivePermissions(em, former.membershipId),
  );
  expect(
    permissions.some(
      (row) =>
        row.permission_code === 'tenant.manage' && row.effect === 'GRANT',
    ),
  ).toBe(false);
});

test('F2a: a queued membership change re-reads the actor authority after the lock', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Followup F2a',
    slug: randomSlug('f2a'),
    owner: user('f2a-owner'),
  });
  const admin = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f2a-admin'),
    roleCode: 'TENANT_ADMIN',
  });
  const target = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f2a-target'),
    roleCode: 'MEMBER',
  });
  await expect(
    withTenantLock(
      tenant.tenantId,
      () =>
        changeMembershipStatus(apiOrm, {
          actor: actor(admin.userId),
          tenantId: tenant.tenantId,
          membershipId: target.membershipId,
          status: 'SUSPENDED',
          reason: 'stale authority attempt',
          correlationId: null,
        }),
      (lock) =>
        lock.query(
          `update "membership" set "status" = 'SUSPENDED' where "id" = $1`,
          [admin.membershipId],
        ),
    ),
  ).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
  const targetRow = await ownerOrm.em
    .fork()
    .execute('select status from membership where id = ?', [
      target.membershipId,
    ]);
  expect(targetRow[0].status).toBe('ACTIVE');
});

test('F2b: a queued grant re-validates the approval against the locked role version', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Followup F2b',
    slug: randomSlug('f2b'),
    owner: user('f2b-owner'),
  });
  const decider = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f2b-decider'),
    roleCode: 'TENANT_ADMIN',
  });
  const target = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f2b-target'),
    roleCode: 'MEMBER',
  });
  const role = await makeRole(tenant.tenantId, 'VERSION_ROLE', ['tenant.read']);
  const input = {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    membershipId: target.membershipId,
    roleId: role.id,
    effect: 'GRANT',
    scopeType: 'TENANT',
    propertyRefs: [],
    expiresAt: null,
    reason: 'version race',
    approvalId: null,
    correlationId: null,
  };
  const approval = await createApprovalRequest(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    permission: 'role.grant',
    actionKey: grantActionKey('GRANT', 'TENANT'),
    resourceType: 'role',
    resourceId: role.id,
    resourceVersion: role.version,
    hashInput: grantHashInput(input),
    reason: 'version race approval',
    correlationId: null,
  });
  await decideApprovalRequest(apiOrm, {
    actor: actor(decider.userId),
    tenantId: tenant.tenantId,
    approvalId: approval.id,
    permission: 'role.grant',
    decision: 'APPROVED',
    reason: null,
    correlationId: null,
  });
  const withApproval = { ...input, approvalId: approval.id };
  await expect(
    withTenantLock(
      tenant.tenantId,
      () => grantRoleToMembership(apiOrm, withApproval),
      async (lock) => {
        await lock.query(
          'update "role" set "version" = "version" + 1 where "id" = $1',
          [role.id],
        );
        await lock.query(
          `insert into "role_permission" ("role_id", "permission_code")
           values ($1, 'tenant.manage') on conflict do nothing`,
          [role.id],
        );
      },
    ),
  ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
  expect(
    await activeGrants(tenant.tenantId, target.membershipId, role.id),
  ).toBe(0);
  const permissions = await runScopedTransaction(
    apiOrm,
    { tenantId: tenant.tenantId },
    (em) => effectivePermissions(em, target.membershipId),
  );
  expect(
    permissions.some(
      (row) =>
        row.permission_code === 'tenant.manage' && row.effect === 'GRANT',
    ),
  ).toBe(false);
});

test('F2c: a queued grant re-reads the actor role.grant authority after the lock', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Followup F2c',
    slug: randomSlug('f2c'),
    owner: user('f2c-owner'),
  });
  const decider = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f2c-decider'),
    roleCode: 'TENANT_ADMIN',
  });
  const target = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('f2c-target'),
    roleCode: 'MEMBER',
  });
  const role = await makeRole(tenant.tenantId, 'AUTHORITY_ROLE', [
    'tenant.read',
  ]);
  const input = {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    membershipId: target.membershipId,
    roleId: role.id,
    effect: 'GRANT',
    scopeType: 'TENANT',
    propertyRefs: [],
    expiresAt: null,
    reason: 'authority race',
    approvalId: null,
    correlationId: null,
  };
  const approval = await createApprovalRequest(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    permission: 'role.grant',
    actionKey: grantActionKey('GRANT', 'TENANT'),
    resourceType: 'role',
    resourceId: role.id,
    resourceVersion: role.version,
    hashInput: grantHashInput(input),
    reason: 'authority race approval',
    correlationId: null,
  });
  await decideApprovalRequest(apiOrm, {
    actor: actor(decider.userId),
    tenantId: tenant.tenantId,
    approvalId: approval.id,
    permission: 'role.grant',
    decision: 'APPROVED',
    reason: null,
    correlationId: null,
  });
  const withApproval = { ...input, approvalId: approval.id };
  const ownerRole = await roleByCode(tenant.tenantId, 'TENANT_OWNER');
  await expect(
    withTenantLock(
      tenant.tenantId,
      () => grantRoleToMembership(apiOrm, withApproval),
      (lock) =>
        lock.query(
          `update "role_grant" set "revoked_at" = now()
            where "membership_id" = $1 and "role_id" = $2 and "revoked_at" is null`,
          [tenant.membershipId, ownerRole.id],
        ),
    ),
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(
    await activeGrants(tenant.tenantId, target.membershipId, role.id),
  ).toBe(0);
});
