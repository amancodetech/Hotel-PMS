import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let tenantA;
let tenantB;
let owner;
let member;

beforeAll(async () => {
  await startApi();
  owner = await loginAs('owner-a');
  member = await loginAs('member-a');
  tenantA = owner.session.body.session.active_tenant_id;
  tenantB = process.env.IDENTITY_TENANT_B;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('unauthenticated requests are rejected before any tenant decision', async () => {
  const browser = await (await import('./support/harness.mjs')).getBrowser();
  const context = await browser.newContext();
  const response = await apiRequest(
    context,
    'GET',
    `/tenants/${tenantA}/memberships`,
  );
  expect(response.status).toBe(401);
  expect(response.body.code).toBe('AUTH_REQUIRED');
  await context.close();
});

test('deny by default: a member cannot administrate', async () => {
  const invite = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/invitations`,
    { body: { email: 'someone@local.test', scope_type: 'TENANT' } },
  );
  expect(invite.status).toBe(403);
  expect(invite.body.code).toBe('PERMISSION_DENIED');
  const createRole = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/roles`,
    {
      body: {
        code: 'MEMBER_ESCALATION',
        name: 'Member escalation',
        permission_codes: ['tenant.read'],
      },
    },
  );
  expect(createRole.status).toBe(403);
  expect(createRole.body.code).toBe('PERMISSION_DENIED');
  const grantRole = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/role-grants`,
    {
      body: {
        membership_id: '11111111-1111-4111-8111-111111111111',
        role_id: '22222222-2222-4222-8222-222222222222',
        scope_type: 'TENANT',
      },
    },
  );
  expect(grantRole.status).toBe(403);
  const memberships = await apiRequest(
    member.context,
    'GET',
    `/tenants/${tenantA}/memberships`,
  );
  expect(memberships.status).toBe(200);
  expect(memberships.body.memberships.length).toBeGreaterThanOrEqual(5);
});

test('tenant ids from the URL cannot reach another tenant', async () => {
  const cross = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantB}/memberships`,
  );
  expect(cross.status).toBe(403);
  expect(cross.body.code).toBe('TENANT_CONTEXT_MISMATCH');
  const unknown = await apiRequest(
    owner.context,
    'POST',
    '/tenants/11111111-1111-4111-8111-111111111111/select',
  );
  expect(unknown.status).toBe(404);
  expect(unknown.body.code).toBe('MEMBERSHIP_NOT_FOUND');
});

test('invitations expire, bind to the invited email and cannot be reused', async () => {
  const created = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/invitations`,
    {
      body: {
        email: 'other@local.test',
        role_id: null,
        scope_type: 'TENANT',
        expires_in_hours: 1,
      },
    },
  );
  expect(created.status).toBe(201);
  const token = created.body.invitation.token;
  expect(typeof token).toBe('string');
  const mismatch = await apiRequest(
    member.context,
    'POST',
    '/invitations/accept',
    { body: { token } },
  );
  expect(mismatch.status).toBe(403);
  expect(mismatch.body.code).toBe('INVITATION_EMAIL_MISMATCH');

  const other = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/invitations`,
    {
      body: {
        email: 'member-a@local.test',
        scope_type: 'TENANT',
        expires_in_hours: 1,
      },
    },
  );
  const otherToken = other.body.invitation.token;
  const accepted = await apiRequest(
    member.context,
    'POST',
    '/invitations/accept',
    {
      body: { token: otherToken },
    },
  );
  expect(accepted.status).toBe(201);
  expect(accepted.body.accepted).toBe(true);
  const reused = await apiRequest(
    member.context,
    'POST',
    '/invitations/accept',
    {
      body: { token: otherToken },
    },
  );
  expect(reused.status).toBe(409);
  expect(reused.body.code).toBe('INVITATION_USED');

  const expiring = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/invitations`,
    {
      body: {
        email: 'member-a@local.test',
        scope_type: 'TENANT',
        expires_in_hours: 1,
      },
    },
  );
  await withOwner(async (client) =>
    client.query(
      "update invitation set expires_at = now() - interval '1 minute' where id = $1",
      [expiring.body.invitation.id],
    ),
  );
  const expired = await apiRequest(
    member.context,
    'POST',
    '/invitations/accept',
    {
      body: { token: expiring.body.invitation.token },
    },
  );
  expect(expired.status).toBe(410);
  expect(expired.body.code).toBe('INVITATION_EXPIRED');
});

test('role invitations require the same gates as direct role grants', async () => {
  const roles = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/roles`,
  );
  const auditor = roles.body.roles.find((role) => role.code === 'AUDITOR');

  const withoutMfa = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/invitations`,
    {
      body: {
        email: 'member-a@local.test',
        role_id: auditor.id,
        scope_type: 'TENANT',
        expires_in_hours: 1,
      },
    },
  );
  expect(withoutMfa.status).toBe(403);
  expect(withoutMfa.body.code).toBe('MFA_REQUIRED');

  const admin = await loginAs('admin-a');
  const withoutApproval = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/invitations`,
    {
      body: {
        email: 'member-a@local.test',
        role_id: auditor.id,
        scope_type: 'TENANT',
        expires_in_hours: 1,
      },
    },
  );
  expect(withoutApproval.status).toBe(409);
  expect(withoutApproval.body.code).toBe('APPROVAL_REQUIRED');

  const requested = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/approval-requests`,
    {
      body: {
        action: 'role.grant',
        payload: {
          email: 'member-a@local.test',
          role_id: auditor.id,
          scope_type: 'TENANT',
        },
        reason: 'invite synthetic auditor',
      },
    },
  );
  expect(requested.status).toBe(201);
  const approvalId = requested.body.approval_request.id;

  const mfa = await loginAs('mfa-a');
  await apiRequest(mfa.context, 'POST', `/tenants/${tenantA}/select`);
  const decided = await apiRequest(
    mfa.context,
    'POST',
    `/tenants/${tenantA}/approval-requests/${approvalId}/decide`,
    {
      body: {
        decision: 'APPROVED',
        permission: 'role.grant',
        reason: 'independent approval',
      },
    },
  );
  expect(decided.status).toBe(201);

  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/invitations`,
    {
      body: {
        email: 'member-a@local.test',
        role_id: auditor.id,
        scope_type: 'TENANT',
        expires_in_hours: 1,
      },
      headers: { 'x-approval-id': approvalId },
    },
  );
  expect(created.status).toBe(201);
  const accepted = await apiRequest(
    member.context,
    'POST',
    '/invitations/accept',
    {
      body: { token: created.body.invitation.token },
    },
  );
  expect(accepted.status).toBe(201);
  const grants = await withOwner(async (client) =>
    client.query(
      `select count(*)::int as count from role_grant g
        join role r on r.id = g.role_id
       where g.membership_id = $1 and r.code = 'AUDITOR' and g.revoked_at is null`,
      [accepted.body.membership_id],
    ),
  );
  expect(grants.rows[0].count).toBe(1);
});

test('self effective permissions reflect scoped grants and never bypass the server', async () => {
  const me = await apiRequest(member.context, 'GET', `/tenants/${tenantA}/me`);
  expect(me.status).toBe(200);
  expect(me.body.role_codes).toContain('AUDITOR');
  const audit = me.body.permissions.find(
    (entry) => entry.permission === 'audit.read',
  );
  expect(audit.granted).toBe(true);
});
