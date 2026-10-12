import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { phase12Operations } from '../../apps/api/dist/platform/operations.js';
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

// Fixed synthetic seed, no real customer or guest data.
const seed = 20260918;
const runId = `P12L${seed}`;
const planCode = `P12LIFEPLAN_${seed}`;
const slug = `p12-life-${seed}`;
const tenantA = process.env.IDENTITY_TENANT_A;

const today = new Date().toISOString().slice(0, 10);

let platform;
let platformNoMfa;
let admin;
let ownerB;
let newTenant;
let property;
let connectionId;
let productId;
let planId;

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

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

function base(propertyId = property) {
  return `/tenants/${newTenant}/properties/${propertyId}`;
}

async function insertRevision({ type, key, items, sequence }) {
  const id = randomUUID();
  await dbRows(
    `insert into "distribution_inbox_revision"
       ("id", "tenant_id", "property_id", "connection_id", "channel_key",
        "provider_key", "environment", "provider_revision_id",
        "external_booking_id", "revision_type", "payload_hash",
        "payload_safe", "source_sequence", "received_at")
     values ($1, $2, $3, $4, 'BOOKING_COM', 'CHANNEX', 'STAGING', $5, $6,
             $7, $8, $9::jsonb, $10, now())`,
    [
      id,
      newTenant,
      property,
      connectionId,
      `REV-${id.slice(0, 8)}`,
      key,
      type,
      'a'.repeat(64),
      JSON.stringify({
        items: items.map((item) => ({ occupancy: 2, ...item })),
      }),
      sequence,
    ],
  );
  return id;
}

function lifecycleRequest(method, path, options = {}) {
  return apiRequest(platform.context, method, path, options);
}

beforeAll(async () => {
  await startApi();
  platform = await loginAs('platform-a');
  platformNoMfa = await loginAs('platform-b');
  admin = await loginAs('admin-a');
  ownerB = await loginAs('owner-b');

  const plan = await apiRequest(platform.context, 'POST', '/platform/plans', {
    body: { code: planCode, name: 'P12 lifecycle plan' },
  });
  expect(plan.status).toBe(201);
  // Policy version 1 is a dated fixture (yesterday) so a newer effective
  // version can be appended legitimately today.
  await dbRows(
    `insert into "platform_plan_policy_version"
       ("plan_id", "version", "effective_from", "limits", "entitlements",
        "created_at")
     select p."id", 1, (now() at time zone 'utc')::date - 1,
            '{"PROPERTIES": 5}'::jsonb, '{"REPORTING": true}'::jsonb,
            now() - interval '1 day'
       from "platform_plan" p where p."code" = $1`,
    [planCode],
  );
});

afterAll(async () => {
  // The shared test database keeps this suite's tenant closed; switch the
  // shared admin session back to the base tenant so later suites that reuse
  // the cached session keep working against tenant A.
  if (newTenant)
    await apiRequest(admin.context, 'POST', `/tenants/${tenantA}/select`).catch(
      () => undefined,
    );
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P12-02 onboarding creates tenant, plan pin, entitlements and usage atomically', async () => {
  const key = `p12-onboard-${runId}-1`;
  const onboard = await lifecycleRequest('POST', '/platform/tenants', {
    body: {
      name: 'P12 Lifecycle Tenant',
      slug,
      customer_label: 'P12 Lifecycle Customer',
      plan_code: planCode,
      owner_email: admin.session.body.user.email,
      reason: 'synthetic onboarding',
    },
    headers: { 'idempotency-key': key },
  });
  expect(onboard.status).toBe(201);
  newTenant = onboard.body.tenant_id;
  expect(onboard.body.state).toBe('ACTIVE');
  expect(onboard.body.policy_version).toBe(1);
  expect(
    onboard.body.entitlements.find(
      (entry) => entry.capability_code === 'REPORTING',
    ).active,
  ).toBe(true);
  expect(
    onboard.body.usage.find((entry) => entry.metric === 'PROPERTIES')
      .limit_value,
  ).toBe(5);
  expect(onboard.body.owner_user_id).toBe(admin.session.body.user.id);
  expect(onboard.body.replayed).toBe(false);

  const replay = await lifecycleRequest('POST', '/platform/tenants', {
    body: {
      name: 'P12 Lifecycle Tenant',
      slug,
      customer_label: 'P12 Lifecycle Customer',
      plan_code: planCode,
      owner_email: admin.session.body.user.email,
      reason: 'synthetic onboarding',
    },
    headers: { 'idempotency-key': key },
  });
  expect(replay.status).toBe(201);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.tenant_id).toBe(newTenant);

  const reusedWithDifferentContent = await lifecycleRequest(
    'POST',
    '/platform/tenants',
    {
      body: {
        name: 'P12 Lifecycle Tenant Alt',
        slug: `${slug}-alt`,
        customer_label: 'P12 Lifecycle Customer Alt',
        plan_code: planCode,
        owner_email: admin.session.body.user.email,
        reason: 'synthetic onboarding',
      },
      headers: { 'idempotency-key': key },
    },
  );
  expect(reusedWithDifferentContent.status).toBe(409);
  expect(reusedWithDifferentContent.body.code).toBe('IDEMPOTENCY_CONFLICT');

  const conflict = await lifecycleRequest('POST', '/platform/tenants', {
    body: {
      name: 'P12 Lifecycle Tenant',
      slug,
      customer_label: 'P12 Lifecycle Customer',
      plan_code: planCode,
    },
    headers: { 'idempotency-key': `p12-onboard-${runId}-2` },
  });
  expect(conflict.status).toBe(409);
  const rows = await dbOne(
    `select count(*)::int as "count" from "platform_subscription"
      where "tenant_slug" = $1`,
    [slug],
  );
  expect(rows.count).toBe(1);
  const altRows = await dbOne(
    `select count(*)::int as "count" from "platform_subscription"
      where "tenant_slug" = $1`,
    [`${slug}-alt`],
  );
  expect(altRows.count).toBe(0);
  const requestRows = await dbOne(
    `select count(*)::int as "count" from "platform_onboarding_request"
      where "idempotency_key" = $1`,
    [key],
  );
  expect(requestRows.count).toBe(1);

  const selected = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${newTenant}/select`,
  );
  expect(selected.status).toBe(200);
});

test('P12-04 onboarding idempotency is platform-wide, race safe and fail-closed', async () => {
  const raceSlug = `${slug}-race`;
  const raceKey = `p12-onboard-${runId}-race`;
  const raceRequest = () =>
    lifecycleRequest('POST', '/platform/tenants', {
      body: {
        name: 'P12 Lifecycle Race Tenant',
        slug: raceSlug,
        customer_label: 'P12 Lifecycle Race Customer',
        plan_code: planCode,
        reason: 'synthetic race onboarding',
      },
      headers: { 'idempotency-key': raceKey },
    });
  const [first, second] = await Promise.all([raceRequest(), raceRequest()]);
  expect([first.status, second.status].sort()).toEqual([201, 201]);
  const bodies = [first.body, second.body];
  expect(bodies.filter((body) => body.replayed === true)).toHaveLength(1);
  expect(new Set(bodies.map((body) => body.tenant_id)).size).toBe(1);

  const raceTenants = await dbOne(
    `select count(*)::int as "count" from "platform_subscription"
      where "tenant_slug" = $1`,
    [raceSlug],
  );
  expect(raceTenants.count).toBe(1);
  const raceRequests = await dbOne(
    `select count(*)::int as "count" from "platform_onboarding_request"
      where "idempotency_key" = $1`,
    [raceKey],
  );
  expect(raceRequests.count).toBe(1);

  const altKey = `p12-onboard-${runId}-race-alt`;
  const altRequest = (altSlug) =>
    lifecycleRequest('POST', '/platform/tenants', {
      body: {
        name: 'P12 Lifecycle Race Alternate',
        slug: altSlug,
        customer_label: 'P12 Lifecycle Race Alternate',
        plan_code: planCode,
        reason: 'synthetic race onboarding',
      },
      headers: { 'idempotency-key': altKey },
    });
  const [left, right] = await Promise.all([
    altRequest(`${raceSlug}-a`),
    altRequest(`${raceSlug}-b`),
  ]);
  expect([left.status, right.status].sort()).toEqual([201, 409]);
  const rejected = left.status === 409 ? left : right;
  expect(rejected.body.code).toBe('IDEMPOTENCY_CONFLICT');
  const altRequests = await dbOne(
    `select count(*)::int as "count" from "platform_onboarding_request"
      where "idempotency_key" = $1`,
    [altKey],
  );
  expect(altRequests.count).toBe(1);
  const altSubscriptions = await dbOne(
    `select count(*)::int as "count" from "platform_subscription"
      where "tenant_slug" in ($1, $2)`,
    [`${raceSlug}-a`, `${raceSlug}-b`],
  );
  expect(altSubscriptions.count).toBe(1);
});

test('P12-02 suspend keeps commitments and channel intake while stopping sales increases', async () => {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${newTenant}/properties`,
    {
      body: {
        code: `P12L-PROP-${seed}`,
        name: 'P12 lifecycle property',
        timezone: 'Asia/Jakarta',
        base_currency: 'IDR',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property.id;

  const connection = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections`,
    {
      body: {
        provider_key: 'CHANNEX',
        environment: 'STAGING',
        channel_key: 'BOOKING_COM',
        external_property_id: `p12-life-${seed}`,
        secret_ref: 'local:hotel/p12-life',
      },
    },
  );
  expect(connection.status).toBe(201);
  connectionId = connection.body.connection.id;

  const resource = await apiRequest(
    admin.context,
    'POST',
    `${base()}/resources`,
    {
      body: { code: `P12L-R-${seed}`, type: 'ROOM', capacity: 2 },
    },
  );
  expect(resource.status).toBe(201);
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code: `P12L-P-${seed}`,
        name: 'P12 lifecycle room',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(product.status).toBe(201);
  productId = product.body.product.id;
  await apiRequest(
    admin.context,
    'POST',
    `${base()}/products/${productId}/candidates`,
    { body: { resource_id: resource.body.resource.id } },
  );
  await apiRequest(admin.context, 'PATCH', `${base()}/products/${productId}`, {
    body: { version: product.body.product.version, status: 'ACTIVE' },
  });
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: {
      code: `P12L-RATE-${seed}`,
      name: 'P12 lifecycle rate',
      product_id: productId,
      currency: 'IDR',
    },
  });
  expect(plan.status).toBe(201);
  planId = plan.body.rate_plan.id;
  await apiRequest(admin.context, 'PATCH', `${base()}/rate-plans/${planId}`, {
    body: { version: plan.body.rate_plan.version, status: 'ACTIVE' },
  });
  const cells = [];
  for (let offset = 80; offset <= 95; offset += 1)
    cells.push({
      rate_plan_id: planId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '325000', currency: 'IDR' },
    });
  await apiRequest(admin.context, 'POST', `${base()}/rates/batch`, {
    body: { cells },
  });

  // Synthetic active external exposure that the suspension must stop selling.
  await dbRows(
    `insert into "exposure"
       ("tenant_id", "property_id", "connection_id", "product_id",
        "start_date", "end_date", "mode", "state", "inventory_version")
     values ($1, $2, $3, $4, (now() at time zone 'utc')::date + 30,
             (now() at time zone 'utc')::date + 33, 'PARTS', 'ACTIVE', 1)`,
    [newTenant, property, connectionId, productId],
  );

  const subscriptionBefore = await lifecycleRequest(
    'GET',
    `/platform/tenants/${newTenant}/subscription`,
  );
  const version = subscriptionBefore.body.version;
  expect(subscriptionBefore.body.state).toBe('ACTIVE');

  const wrongVersion = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/suspension`,
    {
      body: { reason: 'stale version probe' },
      headers: {
        'idempotency-key': `p12-suspend-${runId}-stale`,
        'if-match': String(version + 10),
      },
    },
  );
  expect(wrongVersion.status).toBe(412);
  expect(wrongVersion.body.code).toBe('STALE_VERSION');

  const suspendKey = `p12-suspend-${runId}-1`;
  const suspended = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/suspension`,
    {
      body: { reason: 'synthetic safety suspension' },
      headers: { 'idempotency-key': suspendKey, 'if-match': String(version) },
    },
  );
  expect(suspended.status).toBe(200);
  expect(suspended.body.state).toBe('SUSPENDED');
  expect(suspended.body.safety.writer).toBe('PMS');
  expect(suspended.body.safety.sales_stops_applied).toBeGreaterThanOrEqual(1);
  expect(suspended.body.safety.snapshot.connections_total).toBe(1);
  expect(suspended.body.safety.snapshot.connections_active).toBe(0);
  expect(suspended.body.safety.snapshot.exposures_active).toBe(1);
  expect(suspended.body.event.event_type).toBe('SUSPENDED');

  const tenantRow = await dbOne(
    `select "status" from "tenant" where "id" = $1`,
    [newTenant],
  );
  expect(tenantRow.status).toBe('SUSPENDED');
  const restriction = await dbOne(
    `select "state", "platform_stop" from "sale_restriction"
      where "tenant_id" = $1 and "product_id" = $2`,
    [newTenant, productId],
  );
  expect(restriction.state).toBe('ACTIVE');
  expect(restriction.platform_stop).toBe(true);

  const replay = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/suspension`,
    {
      body: { reason: 'synthetic safety suspension' },
      headers: { 'idempotency-key': suspendKey, 'if-match': String(version) },
    },
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);

  // Channel intake continues while suspended: a new revision still creates its
  // reservation, and the connection service identity was never touched.
  const connectionRow = await dbOne(
    `select "status" from "distribution_connection" where "id" = $1`,
    [connectionId],
  );
  expect(connectionRow.status).toBe('DRAFT');
  const revisionId = await insertRevision({
    type: 'new',
    key: `P12L-NEW-${runId}`,
    items: [{ arrival: addDays(80), departure: addDays(82) }],
    sequence: '1',
  });
  const intake = await apiRequest(
    admin.context,
    'POST',
    `${base()}/inbox/${revisionId}/reprocess`,
  );
  expect(intake.status).toBe(200);
  expect(intake.body.outcome).toBe('CREATED');
  const reservations = await dbOne(
    `select count(*)::int as "count" from "reservation"
      where "tenant_id" = $1 and "channel_connection_id" = $2`,
    [newTenant, connectionId],
  );
  expect(reservations.count).toBe(1);
  const lifecycle = await lifecycleRequest(
    'GET',
    `/platform/tenants/${newTenant}/lifecycle`,
  );
  expect(lifecycle.status).toBe(200);
  expect(lifecycle.body.items.map((item) => item.event_type)).toEqual([
    'SUSPENDED',
    'ONBOARDED',
  ]);
});

test('P12-02 reactivation verifies the policy version and never revives expired entitlements', async () => {
  const before = await lifecycleRequest(
    'GET',
    `/platform/tenants/${newTenant}/subscription`,
  );
  const suspendedVersion = before.body.version;

  // Override with a short-lived entitlement, then let it expire.
  const overrideKey = `p12-entitle-${runId}-1`;
  const override = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/entitlements`,
    {
      body: {
        capability_code: 'CHANNEL_MANAGER',
        state: 'ENABLED',
        expires_at: new Date(Date.now() + 2000).toISOString(),
        reason: 'synthetic time-boxed override',
      },
      headers: { 'idempotency-key': overrideKey },
    },
  );
  expect(override.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 2600));

  // A newer effective policy version appears while the tenant is suspended.
  const v2 = await lifecycleRequest(
    'POST',
    `/platform/plans/${planCode}/policy-versions`,
    {
      body: {
        effective_from: today,
        limits: { PROPERTIES: 8 },
        entitlements: { REPORTING: true },
        notes: 'synthetic successor policy',
      },
    },
  );
  expect(v2.status).toBe(201);
  expect(v2.body.version).toBe(2);

  const stale = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/reactivation`,
    {
      body: { reason: 'synthetic reactivation' },
      headers: {
        'idempotency-key': `p12-reactivate-${runId}-stale`,
        'if-match': String(suspendedVersion),
      },
    },
  );
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe('POLICY_VERSION_STALE');
  expect(stale.body.details.pinned).toBe(1);
  expect(stale.body.details.current).toBe(2);

  const reactivateKey = `p12-reactivate-${runId}-1`;
  const reactivated = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/reactivation`,
    {
      body: {
        reason: 'synthetic reactivation',
        acknowledge_policy_version: true,
        resume_sales: true,
      },
      headers: {
        'idempotency-key': reactivateKey,
        'if-match': String(suspendedVersion),
      },
    },
  );
  expect(reactivated.status).toBe(200);
  expect(reactivated.body.state).toBe('ACTIVE');
  expect(reactivated.body.policy_version).toBe(2);
  expect(reactivated.body.repinned_policy_version).toBe(2);
  expect(reactivated.body.expired_entitlements).toContain('CHANNEL_MANAGER');
  const expired = reactivated.body.entitlements.find(
    (entry) => entry.capability_code === 'CHANNEL_MANAGER',
  );
  expect(expired.active).toBe(false);
  expect(expired.state).toBe('ENABLED');
  const restriction = await dbOne(
    `select "state" from "sale_restriction"
      where "tenant_id" = $1 and "product_id" = $2`,
    [newTenant, productId],
  );
  expect(restriction.state).toBe('OPENED');

  // A tenant user may no longer select a suspended tenant.
  const suspendedTenant = newTenant;
  const noMfaSuspend = await lifecycleRequest(
    'POST',
    `/platform/tenants/${suspendedTenant}/suspension`,
    {
      body: { reason: 'no mfa probe' },
      headers: {
        'idempotency-key': `p12-nomfa-${runId}-1`,
        'if-match': String(reactivated.body.version),
      },
    },
  );
  expect(noMfaSuspend.status).toBe(200);
  const selectClosed = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${newTenant}/select`,
  );
  expect(selectClosed.status).toBe(409);
  expect(selectClosed.body.code).toBe('TENANT_STATE_CONFLICT');
  const cleanupSuspend = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/reactivation`,
    {
      body: {
        reason: 'resume after select probe',
        acknowledge_policy_version: true,
      },
      headers: {
        'idempotency-key': `p12-cleanup-${runId}-1`,
        'if-match': String(noMfaSuspend.body.version),
      },
    },
  );
  expect(cleanupSuspend.status).toBe(200);
});

test('P12-02 closure keeps every financial and audit row', async () => {
  const before = await dbOne(
    `select
       (select count(*)::int from "journal" where "tenant_id" = $1) as journals,
       (select count(*)::int from "folio" where "tenant_id" = $1) as folios,
       (select count(*)::int from "reservation" where "tenant_id" = $1) as reservations,
       (select count(*)::int from "commitment" where "tenant_id" = $1) as commitments,
       (select count(*)::int from "audit_event" where "tenant_id" = $1) as audits`,
    [newTenant],
  );
  const current = await lifecycleRequest(
    'GET',
    `/platform/tenants/${newTenant}/subscription`,
  );
  const closeKey = `p12-close-${runId}-1`;
  const closed = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/closure`,
    {
      body: { reason: 'synthetic end of subscription' },
      headers: {
        'idempotency-key': closeKey,
        'if-match': String(current.body.version),
      },
    },
  );
  expect(closed.status).toBe(200);
  expect(closed.body.state).toBe('CLOSED');
  expect(closed.body.safety.deletions).toBe(0);
  const after = await dbOne(
    `select
       (select count(*)::int from "journal" where "tenant_id" = $1) as journals,
       (select count(*)::int from "folio" where "tenant_id" = $1) as folios,
       (select count(*)::int from "reservation" where "tenant_id" = $1) as reservations,
       (select count(*)::int from "commitment" where "tenant_id" = $1) as commitments,
       (select count(*)::int from "audit_event" where "tenant_id" = $1) as audits`,
    [newTenant],
  );
  expect(after.journals).toBe(before.journals);
  expect(after.folios).toBe(before.folios);
  expect(after.reservations).toBe(before.reservations);
  expect(after.commitments).toBe(before.commitments);
  expect(after.audits).toBe(before.audits + 1);

  const tenantRow = await dbOne(
    `select "status" from "tenant" where "id" = $1`,
    [newTenant],
  );
  expect(tenantRow.status).toBe('CLOSED');

  const replay = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/closure`,
    {
      body: { reason: 'synthetic end of subscription' },
      headers: {
        'idempotency-key': closeKey,
        'if-match': String(current.body.version),
      },
    },
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);

  const suspendClosed = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/suspension`,
    {
      body: { reason: 'closed must fail closed' },
      headers: {
        'idempotency-key': `p12-close-${runId}-2`,
        'if-match': String(closed.body.version),
      },
    },
  );
  expect(suspendClosed.status).toBe(409);
  expect(suspendClosed.body.code).toBe('TENANT_STATE_CONFLICT');

  const reactivateClosed = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/reactivation`,
    {
      body: {
        reason: 'closed must fail closed',
        acknowledge_policy_version: true,
      },
      headers: {
        'idempotency-key': `p12-close-${runId}-3`,
        'if-match': String(closed.body.version),
      },
    },
  );
  expect(reactivateClosed.status).toBe(409);
  expect(reactivateClosed.body.code).toBe('TENANT_STATE_CONFLICT');

  const lifecycle = await lifecycleRequest(
    'GET',
    `/platform/tenants/${newTenant}/lifecycle`,
  );
  expect(lifecycle.body.items.map((item) => item.event_type)).toEqual([
    'CLOSED',
    'REACTIVATED',
    'SUSPENDED',
    'REACTIVATED',
    'SUSPENDED',
    'ONBOARDED',
  ]);

  const auditActions = await dbRows(
    `select distinct "action" from "platform_audit_event"
      where "tenant_id" = $1 order by "action"`,
    [newTenant],
  );
  expect(auditActions.map((row) => row.action)).toEqual(
    expect.arrayContaining([
      'platform.tenant_onboarded',
      'platform.tenant_suspended',
      'platform.tenant_reactivated',
      'platform.tenant_closed',
    ]),
  );
});

test('P12-02 adversarial: lifecycle transitions are fail-closed and tenant-scoped', async () => {
  const ownerAttempt = await apiRequest(
    admin.context,
    'POST',
    `/platform/tenants/${newTenant}/suspension`,
    {
      body: { reason: 'tenant must not manage subscriptions' },
      headers: {
        'idempotency-key': `p12-adv-${runId}-1`,
        'if-match': '1',
      },
    },
  );
  expect(ownerAttempt.status).toBe(403);
  expect(ownerAttempt.body.code).toBe('PERMISSION_DENIED');

  const noMfaAttempt = await apiRequest(
    platformNoMfa.context,
    'POST',
    `/platform/tenants/${newTenant}/suspension`,
    {
      body: { reason: 'sensitive action without MFA' },
      headers: {
        'idempotency-key': `p12-adv-${runId}-nomfa`,
        'if-match': '1',
      },
    },
  );
  expect(noMfaAttempt.status).toBe(403);
  expect(noMfaAttempt.body.code).toBe('MFA_REQUIRED');

  const missingTenant = await apiRequest(
    platform.context,
    'GET',
    `/platform/tenants/${randomUUID()}/lifecycle`,
  );
  expect(missingTenant.status).toBe(404);

  const missingIfMatch = await lifecycleRequest(
    'POST',
    `/platform/tenants/${newTenant}/suspension`,
    {
      body: { reason: 'missing if-match probe' },
      headers: { 'idempotency-key': `p12-adv-${runId}-2` },
    },
  );
  expect(missingIfMatch.status).toBe(400);

  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.platform_user_id', $1, true)", [
      platform.session.body.user.id,
    ]);
    await expect(
      client.query(
        `select public.platform_set_tenant_status($1::uuid, 'ACTIVE', $2::uuid)`,
        [newTenant, platform.session.body.user.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await expect(
      client.query(
        `select public.platform_set_tenant_status($1::uuid, 'SUSPENDED', $2::uuid)`,
        [newTenant, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });
  // P12-04: an active platform actor without the session context is denied.
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await expect(
      client.query(
        `select public.platform_lifecycle_snapshot($1::uuid, $2::uuid)`,
        [newTenant, platform.session.body.user.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });

  const crossTenantRead = await apiRequest(
    ownerB.context,
    'GET',
    `/tenants/${newTenant}/subscription`,
  );
  expect([403, 404]).toContain(crossTenantRead.status);

  const audit = await dbOne(
    `select count(*)::int as "count" from "platform_lifecycle_event"
      where "tenant_id" = $1`,
    [newTenant],
  );
  expect(audit.count).toBe(6);
  expect(
    phase12Operations.some((op) => op.operationId === 'ClosePlatformTenant'),
  ).toBe(true);
});
