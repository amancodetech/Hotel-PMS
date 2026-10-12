import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  apiRequest,
  closeBrowser,
  closeSessions,
  loginAs,
  startApi,
  stopApi,
  withOwner,
  withRuntimeRole,
} from './support/harness.mjs';

// Suite-owned synthetic tenants isolate subscription/grant fixtures from P12 SaaS.
// The runner destroys the temporary test database; no shared fixture is deleted.
const runId = `P12S${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const planCode = `P12SUPPLAN_${runId.toUpperCase()}`;
const tenantA = randomUUID();
const tenantB = randomUUID();
const tenantASlug = `p12-support-a-${runId.toLowerCase()}`;
const tenantBSlug = `p12-support-b-${runId.toLowerCase()}`;
// Export ownership checks still use the admin's actual identity tenant.
const adminTenantA = process.env.IDENTITY_TENANT_A;

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

let platform;
let platformNoMfa;
let platformSupport;
let admin;
let owner;

async function dbRows(sql, params = []) {
  return withOwner(async (client) => {
    const result = await client.query(sql, params);
    return result.rows;
  });
}

async function dbOne(sql, params = []) {
  const result = await dbRows(sql, params);
  return result[0];
}

function platformRequest(method, path, options = {}) {
  return apiRequest(platform.context, method, path, options);
}

async function ensurePlan() {
  const existing = await platformRequest('GET', '/platform/plans');
  expect(existing.status).toBe(200);
  if (existing.body.items.some((plan) => plan.code === planCode)) return;
  const created = await platformRequest('POST', '/platform/plans', {
    body: { code: planCode, name: 'P12 support plan' },
  });
  expect(created.status).toBe(201);
  const version = await platformRequest(
    'POST',
    `/platform/plans/${planCode}/policy-versions`,
    {
      body: {
        effective_from: today,
        limits: { PROPERTIES: 50, API_CALLS: 100 },
        entitlements: { REPORTING: true },
      },
    },
  );
  expect(version.status).toBe(201);
}

async function ensureSubscription(tenantId, slug) {
  await dbRows(
    `insert into "platform_subscription"
       ("tenant_id", "tenant_slug", "customer_label", "plan_id",
        "policy_version_id", "plan_code", "policy_version", "policy_snapshot",
        "state", "started_at")
     select $1, $2, $3, p."id", v."id", p."code", v."version",
            jsonb_build_object('limits', v."limits", 'entitlements', v."entitlements"),
            'ACTIVE', now()
       from "platform_plan" p
       join "platform_plan_policy_version" v on v."plan_id" = p."id"
      where p."code" = $4 and v."version" = 1
     on conflict ("tenant_id") do nothing`,
    [tenantId, slug, `P12 support ${slug}`, planCode],
  );
  await dbRows(
    `insert into "platform_usage_counter" ("tenant_id", "metric", "limit_value")
     values ($1, 'API_CALLS', 100)
     on conflict ("tenant_id", "metric", "period_key") do nothing`,
    [tenantId],
  );
}

beforeAll(async () => {
  if (
    !/^hotel_test_[a-z0-9]+_property$/.test(process.env.IDENTITY_TEST_DB ?? '')
  )
    throw new Error(
      'platform-support fixtures require the isolated property test runner',
    );
  await startApi();
  platform = await loginAs('platform-a');
  platformNoMfa = await loginAs('platform-b');
  platformSupport = await loginAs('platform-s');
  admin = await loginAs('admin-a');
  owner = await loginAs('owner-a');
  await dbRows(
    `insert into "tenant" ("id", "name", "slug", "status")
     values ($1, $2, $3, 'ACTIVE'), ($4, $5, $6, 'ACTIVE')`,
    [
      tenantA,
      'P12 support synthetic A',
      tenantASlug,
      tenantB,
      'P12 support synthetic B',
      tenantBSlug,
    ],
  );
  await ensurePlan();
  await ensureSubscription(tenantA, tenantASlug);
  await ensureSubscription(tenantB, tenantBSlug);
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P12-03 support access without a grant is rejected and platform reads stay minimal', async () => {
  const noGrant = await apiRequest(
    platformSupport.context,
    'POST',
    '/platform/support/tenant-profile',
    { body: { tenant_id: tenantA } },
  );
  expect(noGrant.status).toBe(403);
  expect(noGrant.body.code).toBe('SUPPORT_GRANT_REQUIRED');

  const noGrantAudit = await apiRequest(
    platformSupport.context,
    'POST',
    '/platform/support/tenant-audit',
    { body: { tenant_id: tenantA } },
  );
  expect(noGrantAudit.status).toBe(403);
  expect(noGrantAudit.body.code).toBe('SUPPORT_GRANT_REQUIRED');

  const directory = await platformRequest('GET', '/platform/tenants');
  expect(directory.status).toBe(200);
  const row = directory.body.items.find((item) => item.tenant_id === tenantA);
  expect(row.tenant_slug).toBe(tenantASlug);
  expect(row.plan_code).toBe(planCode);
  expect(row.state).toBe('ACTIVE');
  expect(
    row.usage.find((entry) => entry.metric === 'API_CALLS').limit_value,
  ).toBe(100);
  // Minimum data: no tenant name, no guest/reservation fields.
  expect(JSON.stringify(directory.body)).not.toContain(
    'P04 Synthetic Tenant A',
  );

  const audit = await platformRequest(
    'GET',
    `/platform/audit?tenant_id=${tenantA}`,
  );
  expect(audit.status).toBe(200);
  expect(Array.isArray(audit.body.items)).toBe(true);
});

test('P12-03 temporary support grant is scoped, expires and fails closed', async () => {
  const grantEmail = 'platform-s@local.test';
  const selfGrant = await platformRequest('POST', '/platform/support-grants', {
    body: {
      tenant_id: tenantA,
      platform_user_email: 'platform-a@local.test',
      scopes: ['tenant.read'],
      reason: 'self grant must be denied',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    headers: { 'idempotency-key': `p12-sup-${runId}-self` },
  });
  expect(selfGrant.status).toBe(403);
  expect(selfGrant.body.code).toBe('SUPPORT_SELF_GRANT_DENIED');

  const shortGrant = await platformRequest('POST', '/platform/support-grants', {
    body: {
      tenant_id: tenantA,
      platform_user_email: grantEmail,
      scopes: ['tenant.read'],
      reason: 'synthetic short support window',
      expires_at: new Date(Date.now() + 2500).toISOString(),
    },
    headers: { 'idempotency-key': `p12-sup-${runId}-short` },
  });
  expect(shortGrant.status).toBe(201);
  expect(shortGrant.body.scopes).toEqual(['tenant.read']);
  expect(shortGrant.body.status).toBe('ACTIVE');
  expect(shortGrant.body.replayed).toBe(false);

  const replay = await platformRequest('POST', '/platform/support-grants', {
    body: {
      tenant_id: tenantA,
      platform_user_email: grantEmail,
      scopes: ['tenant.read'],
      reason: 'synthetic short support window',
      expires_at: new Date(Date.now() + 2500).toISOString(),
    },
    headers: { 'idempotency-key': `p12-sup-${runId}-short` },
  });
  expect(replay.status).toBe(201);
  expect(replay.body.replayed).toBe(true);

  const profile = await apiRequest(
    platformSupport.context,
    'POST',
    '/platform/support/tenant-profile',
    { body: { tenant_id: tenantA } },
  );
  expect(profile.status).toBe(200);
  expect(profile.body.scope).toBe('tenant.read');
  expect(profile.body.tenant.slug).toBe(tenantASlug);
  expect(profile.body.grant_id).toBe(shortGrant.body.id);

  await new Promise((resolve) => setTimeout(resolve, 2700));
  const expired = await apiRequest(
    platformSupport.context,
    'POST',
    '/platform/support/tenant-profile',
    { body: { tenant_id: tenantA } },
  );
  expect(expired.status).toBe(403);
  expect(expired.body.code).toBe('SUPPORT_GRANT_EXPIRED');

  // A grant with only audit.read can read the audit trail but not the profile.
  const auditGrant = await platformRequest('POST', '/platform/support-grants', {
    body: {
      tenant_id: tenantA,
      platform_user_email: grantEmail,
      scopes: ['audit.read'],
      reason: 'synthetic audit support window',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    },
    headers: { 'idempotency-key': `p12-sup-${runId}-audit` },
  });
  expect(auditGrant.status).toBe(201);
  const scopeDenied = await apiRequest(
    platformSupport.context,
    'POST',
    '/platform/support/tenant-profile',
    { body: { tenant_id: tenantA } },
  );
  expect(scopeDenied.status).toBe(403);
  expect(scopeDenied.body.code).toBe('SUPPORT_GRANT_SCOPE_DENIED');
  const auditRead = await apiRequest(
    platformSupport.context,
    'POST',
    '/platform/support/tenant-audit',
    { body: { tenant_id: tenantA, limit: 10 } },
  );
  expect(auditRead.status).toBe(200);
  expect(auditRead.body.scope).toBe('audit.read');
  expect(Array.isArray(auditRead.body.events)).toBe(true);

  const supportRoleAttempt = await apiRequest(
    platformSupport.context,
    'POST',
    '/platform/support-grants',
    {
      body: {
        tenant_id: tenantA,
        platform_user_email: grantEmail,
        scopes: ['tenant.read'],
        reason: 'support role cannot manage grants',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      headers: { 'idempotency-key': `p12-sup-${runId}-role` },
    },
  );
  expect(supportRoleAttempt.status).toBe(403);
  expect(supportRoleAttempt.body.code).toBe('PERMISSION_DENIED');

  const listed = await platformRequest(
    'GET',
    `/platform/support-grants?tenant_id=${tenantA}`,
  );
  expect(listed.status).toBe(200);
  const statuses = listed.body.items.map((item) => item.status);
  expect(statuses).toContain('EXPIRED');
  expect(statuses).toContain('ACTIVE');

  const revoked = await platformRequest(
    'POST',
    `/platform/support-grants/${auditGrant.body.id}/revocation`,
    { body: { reason: 'synthetic support window closed' } },
  );
  expect(revoked.status).toBe(200);
  expect(revoked.body.grant.status).toBe('REVOKED');
  const afterRevoke = await apiRequest(
    platformSupport.context,
    'POST',
    '/platform/support/tenant-audit',
    { body: { tenant_id: tenantA } },
  );
  expect(afterRevoke.status).toBe(403);
  expect(afterRevoke.body.code).toBe('SUPPORT_GRANT_REQUIRED');
  expect(afterRevoke.body.details.reason).toBe('revoked');
});

test('P12-03 reads, jobs, files and exports never cross the platform/tenant boundary', async () => {
  const ownerToPlatform = await apiRequest(
    owner.context,
    'GET',
    '/platform/tenants',
  );
  expect(ownerToPlatform.status).toBe(403);

  const ownerSupport = await apiRequest(
    owner.context,
    'POST',
    '/platform/support/tenant-profile',
    { body: { tenant_id: tenantA } },
  );
  expect(ownerSupport.status).toBe(403);

  const ownerAudit = await apiRequest(owner.context, 'GET', '/platform/audit');
  expect(ownerAudit.status).toBe(403);

  // A platform employee without MFA cannot read tenant data through support.
  const noMfaSupport = await apiRequest(
    platformNoMfa.context,
    'POST',
    '/platform/support/tenant-profile',
    { body: { tenant_id: tenantA } },
  );
  expect(noMfaSupport.status).toBe(403);
  expect(noMfaSupport.body.code).toBe('MFA_REQUIRED');
  const noMfaGrant = await apiRequest(
    platformNoMfa.context,
    'POST',
    '/platform/support-grants',
    {
      body: {
        tenant_id: tenantA,
        platform_user_email: 'platform-s@local.test',
        scopes: ['tenant.read'],
        reason: 'sensitive grant without MFA',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      headers: { 'idempotency-key': `p12-sup-${runId}-nomfa` },
    },
  );
  expect(noMfaGrant.status).toBe(403);
  expect(noMfaGrant.body.code).toBe('MFA_REQUIRED');

  // The platform transaction can never read tenant business rows.
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.platform_user_id', $1, true)", [
      platform.session.body.user.id,
    ]);
    const guests = await client.query(
      `select count(*)::int as "count" from "guest"`,
    );
    const reservations = await client.query(
      `select count(*)::int as "count" from "reservation"`,
    );
    const tenantRow = await client.query(
      `select count(*)::int as "count" from "tenant" where "id" = $1`,
      [tenantA],
    );
    expect(guests.rows[0].count).toBe(0);
    expect(reservations.rows[0].count).toBe(0);
    expect(tenantRow.rows[0].count).toBe(0);
    await client.query('rollback');
  });

  // Raw SQL under the operating role fails closed without a live grant.
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.platform_user_id', $1, true)", [
      platformSupport.session.body.user.id,
    ]);
    await expect(
      client.query(
        `select * from public.platform_support_tenant_profile($1::uuid, $2::uuid)`,
        [tenantB, platformSupport.session.body.user.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });

  // P12-04: actor binding denies an active platform actor without session context.
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await expect(
      client.query(
        `select * from public.platform_support_tenant_profile($1::uuid, $2::uuid)`,
        [tenantA, platformSupport.session.body.user.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });

  // Worker jobs cannot read platform audit even with a platform context.
  await withRuntimeRole('worker', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.platform_user_id', $1, true)", [
      platform.session.body.user.id,
    ]);
    await expect(
      client.query(
        `select count(*)::int as "count" from "platform_audit_event"`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });

  // Report exports stay private to their creator membership.
  const exportRequest = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${adminTenantA}/reports/exports`,
    {
      body: {
        kind: 'PORTFOLIO',
        period: { date_from: yesterday, date_to: today },
        currency: 'IDR',
      },
      headers: { 'idempotency-key': `p12-sup-${runId}-export` },
    },
  );
  expect(exportRequest.status).toBe(202);
  const exportId = exportRequest.body.export.id;
  const platformDownload = await platformRequest(
    'GET',
    `/tenants/${adminTenantA}/reports/exports/${exportId}/download`,
  );
  expect([401, 403, 404]).toContain(platformDownload.status);
  const platformList = await platformRequest(
    'GET',
    `/tenants/${adminTenantA}/reports/exports`,
  );
  expect([401, 403, 404]).toContain(platformList.status);

  const grantAudit = await dbRows(
    `select distinct "action" from "platform_audit_event"
      where "tenant_id" = $1 and "action" like 'platform.support%'
      order by "action"`,
    [tenantA],
  );
  expect(grantAudit.map((row) => row.action)).toEqual(
    expect.arrayContaining([
      'platform.support_granted',
      'platform.support_access',
      'platform.support_revoked',
    ]),
  );
});

test('P12-03 platform tenant reads require the exact grant scope at the database layer', async () => {
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.platform_user_id', $1, true)", [
      platform.session.body.user.id,
    ]);
    // platform-a is not the grantee; own grants target platform-s.
    await expect(
      client.query(
        `select * from public.platform_support_tenant_profile($1::uuid, $2::uuid)`,
        [tenantA, platform.session.body.user.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });
  const auditBefore = await dbOne(
    `select count(*)::int as "count" from "platform_audit_event"
      where "action" = 'platform.support_access' and "tenant_id" = $1`,
    [tenantA],
  );
  const profileViaAdmin = await platformRequest(
    'POST',
    '/platform/support/tenant-profile',
    { body: { tenant_id: tenantA } },
  );
  expect(profileViaAdmin.status).toBe(403);
  expect(profileViaAdmin.body.code).toBe('SUPPORT_GRANT_REQUIRED');
  const auditAfter = await dbOne(
    `select count(*)::int as "count" from "platform_audit_event"
      where "action" = 'platform.support_access' and "tenant_id" = $1`,
    [tenantA],
  );
  expect(Number(auditAfter.count)).toBe(Number(auditBefore.count));
});
