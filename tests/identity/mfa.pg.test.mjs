import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let tenantA;
let tenantC;

function expectStatus(response, status, label) {
  if (response.status !== status)
    throw new Error(
      `${label}: expected ${status} got ${response.status} ${JSON.stringify(response.body)}`,
    );
}
let mfa;
let admin;
let owner;

beforeAll(async () => {
  await startApi();
  owner = await loginAs('owner-a');
  mfa = await loginAs('mfa-a');
  admin = await loginAs('admin-a');
  tenantA = process.env.IDENTITY_TENANT_A;
  tenantC = process.env.IDENTITY_TENANT_C;
  const selected = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/select`,
  );
  expect(selected.status).toBe(200);
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('OTP login carries the amr signal while password-only login does not', async () => {
  expect(mfa.session.body.session.mfa).toBe(true);
  expect(mfa.session.body.session.auth_methods).toContain('otp');
  expect(admin.session.body.session.mfa).toBe(true);
  expect(owner.session.body.session.mfa).toBe(false);
  expect(owner.session.body.session.auth_methods).not.toContain('otp');
});

test('MFA is required for sensitive administration', async () => {
  const denied = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/roles`,
    {
      body: {
        code: 'NO_MFA_ROLE',
        name: 'No MFA role',
        permission_codes: ['tenant.read'],
      },
    },
  );
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe('MFA_REQUIRED');
});

test('role escalation is rejected even with a valid MFA session', async () => {
  const escalated = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/roles`,
    {
      body: {
        code: 'ESCALATED_ROLE',
        name: 'Escalated role',
        permission_codes: ['tenant.manage'],
      },
    },
  );
  expect(escalated.status).toBe(403);
  expect(escalated.body.code).toBe('PERMISSION_DENIED');
});

test('tenant-scope grants require an independent approval bound to the payload', async () => {
  const created = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/roles`,
    {
      body: {
        code: 'REPORT_VIEWER',
        name: 'Report viewer',
        permission_codes: ['audit.read'],
      },
    },
  );
  expectStatus(created, 201, 'create REPORT_VIEWER');
  const role = created.body.role;

  const memberships = await apiRequest(
    mfa.context,
    'GET',
    `/tenants/${tenantA}/memberships`,
  );
  const memberId = memberships.body.memberships.find(
    (entry) => entry.user_email === 'member-a@local.test',
  ).id;

  const body = {
    membership_id: memberId,
    role_id: role.id,
    scope_type: 'TENANT',
  };
  const gated = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/role-grants`,
    { body },
  );
  expect(gated.status).toBe(409);
  expect(gated.body.code).toBe('APPROVAL_REQUIRED');

  const requested = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/approval-requests`,
    {
      body: { action: 'role.grant', payload: body, reason: 'reporting access' },
    },
  );
  expect(requested.status).toBe(201);
  const approvalId = requested.body.approval_request.id;

  const self = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/approval-requests/${approvalId}/decide`,
    { body: { decision: 'APPROVED', permission: 'role.grant' } },
  );
  expect(self.status).toBe(403);
  expect(self.body.code).toBe('SELF_APPROVAL_DENIED');

  const approved = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/approval-requests/${approvalId}/decide`,
    {
      body: {
        decision: 'APPROVED',
        permission: 'role.grant',
        reason: 'approved for reporting',
      },
    },
  );
  expect(approved.status).toBe(201);

  const granted = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/role-grants`,
    { body, headers: { 'x-approval-id': approvalId } },
  );
  expect(granted.status).toBe(201);
  expect(granted.body.grant.id).toBeTruthy();

  const roles = await apiRequest(
    mfa.context,
    'GET',
    `/tenants/${tenantA}/roles`,
  );
  const adminRole = roles.body.roles.find(
    (entry) => entry.code === 'TENANT_ADMIN',
  );
  const mismatched = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/role-grants`,
    {
      body: {
        membership_id: memberId,
        role_id: adminRole.id,
        scope_type: 'TENANT',
      },
      headers: { 'x-approval-id': approvalId },
    },
  );
  expect(mismatched.status).toBe(409);
  expect(mismatched.body.code).toBe('APPROVAL_ALREADY_USED');

  const duplicate = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/role-grants`,
    { body },
  );
  expect(duplicate.status).toBe(409);
});

test('property scope applies only to the listed synthetic property', async () => {
  const propertyOne = '22222222-2222-4222-8222-222222222222';
  const propertyTwo = '33333333-3333-4333-8333-333333333333';
  const created = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/roles`,
    {
      body: {
        code: 'PROPERTY_VIEWER',
        name: 'Property viewer',
        permission_codes: ['role.read'],
      },
    },
  );
  expectStatus(created, 201, 'create PROPERTY_VIEWER');

  const viewer = await withOwner(async (client) => {
    const userId = randomUUID();
    const membershipId = randomUUID();
    await client.query(
      `insert into "app_user" ("id", "identity_subject", "issuer", "email")
       values ($1, $2, 'http://local.test/property', $3)`,
      [
        userId,
        randomUUID(),
        `property-viewer-${userId.slice(0, 8)}@local.test`,
      ],
    );
    await client.query(
      `insert into "membership" ("id", "tenant_id", "user_id", "status")
       values ($1, $2, $3, 'ACTIVE')`,
      [membershipId, tenantA, userId],
    );
    const grantId = randomUUID();
    await client.query(
      `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
       values ($1, $2, 'MFA-SCOPE-1', 'MFA scoped property', 'Asia/Jakarta')`,
      [propertyOne, tenantA],
    );
    await client.query(
      `insert into "role_grant"
         ("id", "tenant_id", "membership_id", "role_id", "effect", "scope_type")
       values ($1, $2, $3, $4, 'GRANT', 'PROPERTIES')`,
      [grantId, tenantA, membershipId, created.body.role.id],
    );
    await client.query(
      `insert into "grant_property" ("grant_id", "tenant_id", "property_ref")
       values ($1, $2, $3)`,
      [grantId, tenantA, propertyOne],
    );
    return { userId, membershipId };
  });

  const effective = await apiRequest(
    mfa.context,
    'GET',
    `/tenants/${tenantA}/memberships/${viewer.membershipId}/effective-permissions`,
  );
  expectStatus(effective, 200, 'effective permissions');
  const roleRead = effective.body.permissions.find(
    (entry) => entry.permission === 'role.read',
  );
  expect(roleRead.granted).toBe(true);
  expect(roleRead.tenant_scope).toBe(false);
  expect(roleRead.property_refs).toEqual([propertyOne]);

  const unscoped = await apiRequest(
    mfa.context,
    'GET',
    `/tenants/${tenantA}/roles`,
  );
  expectStatus(unscoped, 200, 'owner tenant scope stays intact');
  const other = await apiRequest(
    mfa.context,
    'GET',
    `/tenants/${tenantA}/roles`,
    { headers: { 'x-property-ref': propertyTwo } },
  );
  expectStatus(other, 200, 'owner tenant scope ignores property header');
});

test('cross-tenant grants cannot reference another tenant role or membership', async () => {
  const foreign = await withOwner(async (client) => {
    const role = await client.query(
      `select r.id from role r join tenant t on t.id = r.tenant_id
        where t.id = $1 and r.code = 'TENANT_ADMIN'`,
      [process.env.IDENTITY_TENANT_B],
    );
    const membership = await client.query(
      'select id from membership where tenant_id = $1 limit 1',
      [process.env.IDENTITY_TENANT_B],
    );
    return { roleId: role.rows[0].id, membershipId: membership.rows[0].id };
  });
  const memberships = await apiRequest(
    mfa.context,
    'GET',
    `/tenants/${tenantA}/memberships`,
  );
  const localMember = memberships.body.memberships[0].id;
  const localRoles = await apiRequest(
    mfa.context,
    'GET',
    `/tenants/${tenantA}/roles`,
  );
  const localRole = localRoles.body.roles.find(
    (entry) => entry.code === 'REPORT_VIEWER',
  );
  const foreignRole = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/role-grants`,
    {
      body: {
        membership_id: localMember,
        role_id: foreign.roleId,
        scope_type: 'PROPERTIES',
        property_refs: ['55555555-5555-4555-8555-555555555555'],
      },
    },
  );
  expectStatus(foreignRole, 404, 'foreign role');
  expect(foreignRole.body.code).toBe('ROLE_NOT_FOUND');
  const foreignMembership = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/role-grants`,
    {
      body: {
        membership_id: foreign.membershipId,
        role_id: localRole.id,
        scope_type: 'PROPERTIES',
        property_refs: ['55555555-5555-4555-8555-555555555555'],
      },
    },
  );
  expectStatus(foreignMembership, 404, 'foreign membership');
  expect(foreignMembership.body.code).toBe('MEMBERSHIP_NOT_FOUND');
});

test('suspension revokes access immediately and reactivation restores it', async () => {
  const auditor = await loginAs('auditor-a');
  const before = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/memberships`,
  );
  expect(before.status).toBe(200);
  const memberships = await apiRequest(
    mfa.context,
    'GET',
    `/tenants/${tenantA}/memberships`,
  );
  const auditorMembership = memberships.body.memberships.find(
    (entry) => entry.user_email === 'auditor-a@local.test',
  );
  const suspended = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/memberships/${auditorMembership.id}/suspend`,
    { body: { reason: 'P03 synthetic suspension' } },
  );
  expect(suspended.status).toBe(201);
  const after = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/memberships`,
  );
  expect(after.status).toBe(403);
  expect(after.body.code).toBe('MEMBERSHIP_INACTIVE');
  const reactivated = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/memberships/${auditorMembership.id}/reactivate`,
    { body: { reason: 'P03 synthetic reactivation' } },
  );
  expect(reactivated.status).toBe(201);
  const restored = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/memberships`,
  );
  expect(restored.status).toBe(200);
});

test('the last active administrator cannot be removed', async () => {
  const selected = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantC}/select`,
  );
  expect(selected.status).toBe(200);
  const memberships = await apiRequest(
    mfa.context,
    'GET',
    `/tenants/${tenantC}/memberships`,
  );
  const self = memberships.body.memberships.find(
    (entry) => entry.user_email === 'mfa-a@local.test',
  );
  const denied = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantC}/memberships/${self.id}/revoke`,
    { body: { reason: 'attempt to remove the last admin' } },
  );
  expect(denied.status).toBe(409);
  expect(denied.body.code).toBe('LAST_ADMIN_PROTECTED');
  await apiRequest(mfa.context, 'POST', `/tenants/${tenantA}/select`);
});
