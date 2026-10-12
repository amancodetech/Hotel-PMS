import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  acceptInvitation,
  addMemberWithRole,
  changeMembershipStatus,
  countActiveAdmins,
  createApprovalRequest,
  createOrm,
  decideApprovalRequest,
  findRoleByCode,
  grantActionKey,
  grantHashInput,
  grantRoleToMembership,
  insertGrant,
  insertMembership,
  insertRole,
  inviteMember,
  provisionTenant,
  readRoles,
  revokeRoleGrantById,
  runScopedTransaction,
  updateCustomRole,
  updateRole,
  upsertUserBySubject,
} from '../../packages/backend/dist/index.js';
import { apiDatabaseUrl, testOwnerUrl } from './support/harness.mjs';

let ownerOrm;
let apiOrm;
let apiOrmSecond;

const actor = (userId, mfa = true) => ({
  kind: 'USER',
  userId,
  sessionId: randomUUID(),
  displayName: 'remediation-test',
  mfa,
});

const user = (name) => ({
  identitySubject: randomUUID(),
  issuer: 'http://local.test/remediation',
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
      issuer: 'http://local.test/remediation',
      email,
      displayName: name,
    }),
  );
}

async function approveGrant(tenantId, requester, decider, role, payload = {}) {
  const effect = payload.effect ?? 'GRANT';
  const approval = await createApprovalRequest(apiOrm, {
    actor: requester,
    tenantId,
    permission: 'role.grant',
    actionKey: grantActionKey(effect, payload.scopeType ?? 'TENANT'),
    resourceType: 'role',
    resourceId: role.id,
    resourceVersion: role.version,
    hashInput: grantHashInput({
      membershipId: payload.membershipId ?? null,
      roleId: role.id,
      effect,
      scopeType: payload.scopeType ?? 'TENANT',
      propertyRefs: payload.propertyRefs ?? [],
      expiresAt: null,
      email: payload.email ?? null,
    }),
    reason: 'remediation approval',
    correlationId: null,
  });
  await decideApprovalRequest(apiOrm, {
    actor: decider,
    tenantId,
    approvalId: approval.id,
    permission: 'role.grant',
    decision: 'APPROVED',
    reason: null,
    correlationId: null,
  });
  return approval;
}

beforeAll(async () => {
  ownerOrm = await createOrm(testOwnerUrl, { pool: { min: 0, max: 4 } });
  apiOrm = await createOrm(apiDatabaseUrl(), { pool: { min: 0, max: 6 } });
  apiOrmSecond = await createOrm(apiDatabaseUrl(), {
    pool: { min: 0, max: 4 },
  });
});

afterAll(async () => {
  await apiOrmSecond?.close(true);
  await apiOrm?.close(true);
  await ownerOrm?.close(true);
});

test('G03-R1: invite-only authority cannot escalate through invitations', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Remediation R1',
    slug: randomSlug('r1'),
    owner: user('r1-owner'),
  });
  const recruiter = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r1-recruiter'),
    roleCode: 'MEMBER',
  });
  const recruiterRole = await makeRole(tenant.tenantId, 'RECRUITER', [
    'membership.invite',
  ]);
  await grantFixture(tenant.tenantId, recruiter.membershipId, recruiterRole.id);
  const ownerRole = await roleByCode(tenant.tenantId, 'TENANT_OWNER');

  await expect(
    inviteMember(apiOrm, {
      actor: actor(recruiter.userId, false),
      tenantId: tenant.tenantId,
      email: 'r1-escalation@local.test',
      roleId: ownerRole.id,
      scopeType: 'TENANT',
      scopeRefs: [],
      expiresInHours: 1,
      reason: null,
      approvalId: null,
      correlationId: null,
    }),
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

  const roleLess = await inviteMember(apiOrm, {
    actor: actor(recruiter.userId, false),
    tenantId: tenant.tenantId,
    email: 'r1-roleless@local.test',
    roleId: null,
    scopeType: 'TENANT',
    scopeRefs: [],
    expiresInHours: 1,
    reason: null,
    approvalId: null,
    correlationId: null,
  });
  expect(roleLess.invitation.role_id).toBeNull();
  expect(roleLess.token).toHaveLength(64);
});

test('G03-R1: role invitations enforce MFA, approval, delegation and re-validation', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Remediation R1b',
    slug: randomSlug('r1b'),
    owner: user('r1b-owner'),
  });
  const decider = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r1b-decider'),
    roleCode: 'TENANT_ADMIN',
  });
  const granter = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r1b-granter'),
    roleCode: 'MEMBER',
  });
  await makeUser('r1b-invitee', 'r1b-invitee@local.test');
  const invitee = await ownerOrm.em
    .fork()
    .transactional((em) =>
      em.execute(
        `select id from app_user where email = 'r1b-invitee@local.test'`,
      ),
    );
  const inviteeId = invitee[0].id;
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
  const granterGrant = await grantFixture(
    tenant.tenantId,
    granter.membershipId,
    granterRole.id,
  );
  let auditorRole = await roleByCode(tenant.tenantId, 'AUDITOR');
  const ownerRole = await roleByCode(tenant.tenantId, 'TENANT_OWNER');
  const invite = (approvalId, roleId = auditorRole.id, mfa = true) =>
    inviteMember(apiOrm, {
      actor: actor(granter.userId, mfa),
      tenantId: tenant.tenantId,
      email: 'r1b-invitee@local.test',
      roleId,
      scopeType: 'TENANT',
      scopeRefs: [],
      expiresInHours: 1,
      reason: null,
      approvalId,
      correlationId: null,
    });

  await expect(invite(null, auditorRole.id, false)).rejects.toMatchObject({
    code: 'MFA_REQUIRED',
  });
  await expect(invite(null)).rejects.toMatchObject({
    code: 'APPROVAL_REQUIRED',
  });

  const ownerApproval = await approveGrant(
    tenant.tenantId,
    actor(tenant.userId),
    actor(decider.userId),
    ownerRole,
    { email: 'r1b-invitee@local.test' },
  );
  await expect(invite(ownerApproval.id, ownerRole.id)).rejects.toMatchObject({
    code: 'PERMISSION_DENIED',
  });

  const suspendedApproval = await approveGrant(
    tenant.tenantId,
    actor(tenant.userId),
    actor(decider.userId),
    auditorRole,
    { email: 'r1b-invitee@local.test' },
  );
  const suspendedInvite = await invite(suspendedApproval.id);
  await changeMembershipStatus(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    membershipId: granter.membershipId,
    status: 'SUSPENDED',
    reason: 'remediation suspension',
    correlationId: null,
  });
  await expect(
    acceptInvitation(apiOrm, {
      actor: actor(inviteeId),
      token: suspendedInvite.token,
      correlationId: null,
    }),
  ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  await changeMembershipStatus(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    membershipId: granter.membershipId,
    status: 'ACTIVE',
    reason: 'remediation reactivation',
    correlationId: null,
  });

  const revokedApproval = await approveGrant(
    tenant.tenantId,
    actor(tenant.userId),
    actor(decider.userId),
    auditorRole,
    { email: 'r1b-invitee@local.test' },
  );
  const revokedInvite = await invite(revokedApproval.id);
  await revokeRoleGrantById(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    grantId: granterGrant.id,
    reason: 'remediation revocation',
    correlationId: null,
  });
  await expect(
    acceptInvitation(apiOrm, {
      actor: actor(inviteeId),
      token: revokedInvite.token,
      correlationId: null,
    }),
  ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  await grantFixture(tenant.tenantId, granter.membershipId, granterRole.id);

  const changedApproval = await approveGrant(
    tenant.tenantId,
    actor(tenant.userId),
    actor(decider.userId),
    auditorRole,
    { email: 'r1b-invitee@local.test' },
  );
  const changedInvite = await invite(changedApproval.id);
  await runScopedTransaction(ownerOrm, { tenantId: tenant.tenantId }, (em) =>
    updateRole(em, tenant.tenantId, auditorRole.id, { name: 'AUDITOR v2' }),
  );
  await expect(
    acceptInvitation(apiOrm, {
      actor: actor(inviteeId),
      token: changedInvite.token,
      correlationId: null,
    }),
  ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  auditorRole = await roleByCode(tenant.tenantId, 'AUDITOR');

  const denyApproval = await approveGrant(
    tenant.tenantId,
    actor(tenant.userId),
    actor(decider.userId),
    auditorRole,
    { email: 'r1b-invitee@local.test' },
  );
  const denyInvite = await invite(denyApproval.id);
  const denyRole = await makeRole(tenant.tenantId, 'DENY_APPROVER', [
    'approval.approve',
  ]);
  const denyGrant = await grantFixture(
    tenant.tenantId,
    decider.membershipId,
    denyRole.id,
    'DENY',
  );
  await expect(
    acceptInvitation(apiOrm, {
      actor: actor(inviteeId),
      token: denyInvite.token,
      correlationId: null,
    }),
  ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  await revokeRoleGrantById(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    grantId: denyGrant.id,
    reason: 'remove fixture denial',
    correlationId: null,
  });

  const happyApproval = await approveGrant(
    tenant.tenantId,
    actor(tenant.userId),
    actor(decider.userId),
    auditorRole,
    { email: 'r1b-invitee@local.test' },
  );
  const happy = await invite(happyApproval.id);
  const accepted = await acceptInvitation(apiOrm, {
    actor: actor(inviteeId),
    token: happy.token,
    correlationId: null,
  });
  expect(accepted.tenant_id).toBe(tenant.tenantId);
  const grants = await runScopedTransaction(
    ownerOrm,
    { tenantId: tenant.tenantId },
    (em) =>
      em.execute(
        `select count(*)::int as count from role_grant
          where membership_id = ? and role_id = ? and revoked_at is null`,
        [accepted.membership_id, auditorRole.id],
      ),
  );
  expect(grants[0].count).toBe(1);
});

test('G03-R3: last administrator protection is serialized per tenant', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Remediation R3',
    slug: randomSlug('r3'),
    owner: user('r3-owner'),
  });
  const admin = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r3-admin'),
    roleCode: 'TENANT_ADMIN',
  });
  const lock = new Client({ connectionString: testOwnerUrl });
  await lock.connect();
  try {
    await lock.query('begin');
    await lock.query(
      `select pg_advisory_xact_lock(hashtextextended('hotel:authz:' || $1, 0))`,
      [tenant.tenantId],
    );
    const suspend = (membershipId) =>
      changeMembershipStatus(apiOrm, {
        actor: actor(tenant.userId),
        tenantId: tenant.tenantId,
        membershipId,
        status: 'SUSPENDED',
        reason: 'concurrent remediation',
        correlationId: null,
      });
    const pending = Promise.allSettled([
      suspend(tenant.membershipId),
      suspend(admin.membershipId),
    ]);
    const deadline = Date.now() + 1200;
    let waiting = 0;
    while (Date.now() < deadline) {
      const result = await lock.query(
        `select count(*)::int as count from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'`,
      );
      waiting = result.rows[0].count;
      if (waiting >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await lock.query('commit');
    const results = await pending;
    expect(waiting).toBeGreaterThanOrEqual(1);
    expect(results.filter((entry) => entry.status === 'fulfilled').length).toBe(
      1,
    );
    const rejected = results.filter((entry) => entry.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(['LAST_ADMIN_PROTECTED', 'MEMBERSHIP_INACTIVE']).toContain(
      rejected[0].reason?.code,
    );
    const remaining = await runScopedTransaction(
      ownerOrm,
      { tenantId: tenant.tenantId },
      (em) => countActiveAdmins(em, tenant.tenantId),
    );
    expect(remaining).toBe(1);
  } finally {
    await lock.query('rollback').catch(() => undefined);
    await lock.end();
  }
});

test('G03-R3: revoking, retiring or DENY-ing the last admin capability is blocked', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Remediation R3b',
    slug: randomSlug('r3b'),
    owner: user('r3b-owner'),
  });
  const admin = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r3b-admin'),
    roleCode: 'MEMBER',
  });
  const customAdminRole = await makeRole(tenant.tenantId, 'CUSTOM_ADMIN', [
    'role.grant',
    'role.manage',
  ]);
  const customGrant = await grantFixture(
    tenant.tenantId,
    admin.membershipId,
    customAdminRole.id,
  );
  const ownerRole = await roleByCode(tenant.tenantId, 'TENANT_OWNER');
  const ownerGrant = await runScopedTransaction(
    ownerOrm,
    { tenantId: tenant.tenantId },
    (em) =>
      em.execute(
        `select id from role_grant where membership_id = ? and role_id = ?`,
        [tenant.membershipId, ownerRole.id],
      ),
  );
  await revokeRoleGrantById(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    grantId: ownerGrant[0].id,
    reason: 'isolate the custom administrator',
    correlationId: null,
  });
  await expect(
    revokeRoleGrantById(apiOrm, {
      actor: actor(admin.userId),
      tenantId: tenant.tenantId,
      grantId: customGrant.id,
      reason: 'attempt to remove the last admin',
      correlationId: null,
    }),
  ).rejects.toMatchObject({ code: 'LAST_ADMIN_PROTECTED' });
  await expect(
    updateCustomRole(apiOrm, {
      actor: actor(admin.userId),
      tenantId: tenant.tenantId,
      roleId: customAdminRole.id,
      permissionCodes: ['role.grant'],
      status: 'RETIRED',
      correlationId: null,
    }),
  ).rejects.toMatchObject({ code: 'LAST_ADMIN_PROTECTED' });
});

test('G03-R3: DENY grants are excluded from the eligible administrator count', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Remediation R3c',
    slug: randomSlug('r3c'),
    owner: user('r3c-owner'),
  });
  const adminA = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r3c-admin-a'),
    roleCode: 'TENANT_ADMIN',
  });
  const adminB = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r3c-admin-b'),
    roleCode: 'TENANT_ADMIN',
  });
  const denyRole = await makeRole(tenant.tenantId, 'DENY_GRANT', [
    'role.grant',
  ]);
  const denyApproval = await approveGrant(
    tenant.tenantId,
    actor(adminB.userId),
    actor(tenant.userId),
    denyRole,
    { effect: 'DENY', membershipId: adminB.membershipId },
  );
  const denyGrant = await grantRoleToMembership(apiOrm, {
    actor: actor(adminB.userId),
    tenantId: tenant.tenantId,
    membershipId: adminB.membershipId,
    roleId: denyRole.id,
    effect: 'DENY',
    scopeType: 'TENANT',
    propertyRefs: [],
    expiresAt: null,
    reason: 'deny role.grant for admin B',
    approvalId: denyApproval.id,
    correlationId: null,
  });
  const counted = await runScopedTransaction(
    ownerOrm,
    { tenantId: tenant.tenantId },
    (em) => countActiveAdmins(em, tenant.tenantId),
  );
  expect(counted).toBe(2);
  const ownerRole = await roleByCode(tenant.tenantId, 'TENANT_OWNER');
  const ownerGrant = await runScopedTransaction(
    ownerOrm,
    { tenantId: tenant.tenantId },
    (em) =>
      em.execute(
        'select id from role_grant where membership_id = ? and role_id = ?',
        [tenant.membershipId, ownerRole.id],
      ),
  );
  await revokeRoleGrantById(apiOrm, {
    actor: actor(adminA.userId),
    tenantId: tenant.tenantId,
    grantId: ownerGrant[0].id,
    reason: 'isolate the remaining eligible admin',
    correlationId: null,
  });
  await expect(
    changeMembershipStatus(apiOrm, {
      actor: actor(adminA.userId),
      tenantId: tenant.tenantId,
      membershipId: adminA.membershipId,
      status: 'SUSPENDED',
      reason: 'attempt to suspend the only eligible admin',
      correlationId: null,
    }),
  ).rejects.toMatchObject({ code: 'LAST_ADMIN_PROTECTED' });
  await revokeRoleGrantById(apiOrm, {
    actor: actor(adminA.userId),
    tenantId: tenant.tenantId,
    grantId: denyGrant.id,
    reason: 'restore admin B eligibility',
    correlationId: null,
  });
  const suspended = await changeMembershipStatus(apiOrm, {
    actor: actor(adminA.userId),
    tenantId: tenant.tenantId,
    membershipId: adminA.membershipId,
    status: 'SUSPENDED',
    reason: 'admin B is eligible again',
    correlationId: null,
  });
  expect(suspended.status).toBe('SUSPENDED');
});

test('G03-R4: approvals are single use, version bound and DENY aware', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Remediation R4',
    slug: randomSlug('r4'),
    owner: user('r4-owner'),
  });
  const decider = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r4-decider'),
    roleCode: 'TENANT_ADMIN',
  });
  const target = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r4-target'),
    roleCode: 'MEMBER',
  });
  const role = await makeRole(tenant.tenantId, 'R4_ROLE', ['audit.read']);
  const grantInput = (approvalId, roleId = role.id) => ({
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    membershipId: target.membershipId,
    roleId,
    effect: 'GRANT',
    scopeType: 'TENANT',
    propertyRefs: [],
    expiresAt: null,
    reason: 'remediation grant',
    approvalId,
    correlationId: null,
  });

  const approval = await approveGrant(
    tenant.tenantId,
    actor(tenant.userId),
    actor(decider.userId),
    role,
    { membershipId: target.membershipId },
  );
  const first = await grantRoleToMembership(apiOrm, grantInput(approval.id));
  await revokeRoleGrantById(apiOrm, {
    actor: actor(tenant.userId),
    tenantId: tenant.tenantId,
    grantId: first.id,
    reason: 'remediation revocation',
    correlationId: null,
  });
  await expect(
    grantRoleToMembership(apiOrm, grantInput(approval.id)),
  ).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_USED' });

  const versionRole = await makeRole(tenant.tenantId, 'R4_VERSION', [
    'audit.read',
  ]);
  const versionApproval = await approveGrant(
    tenant.tenantId,
    actor(tenant.userId),
    actor(decider.userId),
    versionRole,
    { membershipId: target.membershipId },
  );
  await runScopedTransaction(ownerOrm, { tenantId: tenant.tenantId }, (em) =>
    updateRole(em, tenant.tenantId, versionRole.id, { name: 'R4_VERSION v2' }),
  );
  await expect(
    grantRoleToMembership(
      apiOrm,
      grantInput(versionApproval.id, versionRole.id),
    ),
  ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });

  const denyRole = await makeRole(tenant.tenantId, 'R4_DENY', [
    'approval.approve',
  ]);
  const denyApproval = await approveGrant(
    tenant.tenantId,
    actor(tenant.userId),
    actor(decider.userId),
    role,
    { membershipId: target.membershipId },
  );
  await grantFixture(
    tenant.tenantId,
    decider.membershipId,
    denyRole.id,
    'DENY',
  );
  await expect(
    grantRoleToMembership(apiOrm, grantInput(denyApproval.id)),
  ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
});

test('G03-R4: concurrent approval use produces exactly one grant', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Remediation R4b',
    slug: randomSlug('r4b'),
    owner: user('r4b-owner'),
  });
  const decider = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r4b-decider'),
    roleCode: 'TENANT_ADMIN',
  });
  const target = await addMemberWithRole(ownerOrm, {
    tenantId: tenant.tenantId,
    user: user('r4b-target'),
    roleCode: 'MEMBER',
  });
  const role = await makeRole(tenant.tenantId, 'R4_CONCURRENT', ['audit.read']);
  const approval = await approveGrant(
    tenant.tenantId,
    actor(tenant.userId),
    actor(decider.userId),
    role,
    { membershipId: target.membershipId },
  );
  const call = (orm) =>
    grantRoleToMembership(orm, {
      actor: actor(tenant.userId),
      tenantId: tenant.tenantId,
      membershipId: target.membershipId,
      roleId: role.id,
      effect: 'GRANT',
      scopeType: 'TENANT',
      propertyRefs: [],
      expiresAt: null,
      reason: 'concurrent approval use',
      approvalId: approval.id,
      correlationId: null,
    });
  const results = await Promise.allSettled([call(apiOrm), call(apiOrmSecond)]);
  expect(results.filter((entry) => entry.status === 'fulfilled').length).toBe(
    1,
  );
  const grants = await runScopedTransaction(
    ownerOrm,
    { tenantId: tenant.tenantId },
    (em) =>
      em.execute(
        `select count(*)::int as count from role_grant
          where membership_id = ? and role_id = ? and revoked_at is null`,
        [target.membershipId, role.id],
      ),
  );
  expect(grants[0].count).toBe(1);
});

test('G03-R4: property-scoped authority is matched per property reference', async () => {
  const tenant = await provisionTenant(ownerOrm, {
    name: 'Remediation Scope',
    slug: randomSlug('scope'),
    owner: user('scope-owner'),
  });
  const viewer = await makeUser('scope-viewer', 'scope-viewer@local.test');
  const membership = await runScopedTransaction(
    ownerOrm,
    { tenantId: tenant.tenantId },
    (em) =>
      insertMembership(em, {
        tenantId: tenant.tenantId,
        userId: viewer.id,
        status: 'ACTIVE',
      }),
  );
  const role = await makeRole(tenant.tenantId, 'SCOPE_VIEWER', ['role.read']);
  const propertyOne = '77777777-7777-4777-8777-777777777777';
  const propertyTwo = '88888888-8888-4888-8888-888888888888';
  await runScopedTransaction(
    ownerOrm,
    { tenantId: tenant.tenantId },
    async (em) => {
      await em.execute(
        `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
         values (?, ?, 'SCOPE-P1', 'Scoped property one', 'Asia/Jakarta'),
                (?, ?, 'SCOPE-P2', 'Scoped property two', 'Asia/Makassar')
         on conflict do nothing`,
        [propertyOne, tenant.tenantId, propertyTwo, tenant.tenantId],
      );
      return insertGrant(em, {
        tenantId: tenant.tenantId,
        membershipId: membership.id,
        roleId: role.id,
        effect: 'GRANT',
        scopeType: 'PROPERTIES',
        propertyRefs: [propertyOne],
        grantedBy: null,
        reason: 'fixture',
      });
    },
  );
  const viewerActor = actor(viewer.id);
  const scoped = await readRoles(
    apiOrm,
    viewerActor,
    tenant.tenantId,
    propertyOne,
  );
  expect(scoped.length).toBeGreaterThan(0);
  await expect(
    readRoles(apiOrm, viewerActor, tenant.tenantId, null),
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  await expect(
    readRoles(apiOrm, viewerActor, tenant.tenantId, propertyTwo),
  ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});
