import { readFileSync } from 'node:fs';
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

const tenantA = process.env.IDENTITY_TENANT_A;

// Fixed synthetic seed, no real customer or guest data.
const seed = 20260917;
const runId = `P12A${seed}`;
const planCode = `P12PLAN_${seed}`;

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const periodStart = `${today.slice(0, 7)}-01`;
const periodEnd =
  today > periodStart
    ? today
    : new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

let platform;
let platformNoMfa;
let platformSupport;
let admin;
let owner;
let ownerB;

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

function platformRequest(context, method, path, options = {}) {
  return apiRequest(context, method, path, options);
}

async function ensureSubscription() {
  await dbRows(
    `insert into "platform_subscription"
       ("tenant_id", "tenant_slug", "customer_label", "plan_id",
        "policy_version_id", "plan_code", "policy_version", "policy_snapshot",
        "state", "started_at")
     select $1, $3, 'P12 Synthetic Tenant A', p."id", v."id", p."code", v."version",
            jsonb_build_object('limits', v."limits", 'entitlements', v."entitlements"),
            'ACTIVE', now()
       from "platform_plan" p
       join "platform_plan_policy_version" v on v."plan_id" = p."id"
      where p."code" = $2 and v."version" = 1
     on conflict ("tenant_id") do nothing`,
    [tenantA, planCode, process.env.IDENTITY_TENANT_A_SLUG],
  );
}

async function seedCounter(metric, limitValue) {
  await dbRows(
    `insert into "platform_usage_counter" ("tenant_id", "metric", "limit_value")
     values ($1, $2, $3)
     on conflict ("tenant_id", "metric", "period_key") do update
       set "limit_value" = excluded."limit_value", "used" = 0,
           "updated_at" = now()`,
    [tenantA, metric, limitValue],
  );
}

async function deleteCounter(metric) {
  await dbRows(
    `delete from "platform_usage_counter"
      where "tenant_id" = $1 and "metric" = $2`,
    [tenantA, metric],
  );
}

beforeAll(async () => {
  await startApi();
  platform = await loginAs('platform-a');
  platformNoMfa = await loginAs('platform-b');
  platformSupport = await loginAs('platform-s');
  admin = await loginAs('admin-a');
  owner = await loginAs('owner-a');
  ownerB = await loginAs('owner-b');
});

afterAll(async () => {
  // Remove declared limits so the shared test database keeps behaving for the
  // suites that run after this file.
  await deleteCounter('PROPERTIES');
  await deleteCounter('API_CALLS');
  await deleteCounter('PB_STEPS');
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P12-01 contract manifest matches the implemented platform operations', async () => {
  const document = JSON.parse(
    readFileSync('docs/contracts/phase12.openapi.json', 'utf8'),
  );
  const contractOperations = Object.entries(document.paths).flatMap(
    ([path, item]) =>
      Object.entries(item)
        .filter(([method]) =>
          ['get', 'post', 'put', 'patch', 'delete'].includes(method),
        )
        .map(([method, operation]) => ({
          operationId: operation.operationId,
          method: method.toUpperCase(),
          path: `/api/v1${path}`,
        })),
  );
  expect(new Set(contractOperations.map((op) => op.operationId)).size).toBe(
    contractOperations.length,
  );
  expect(contractOperations.length).toBe(phase12Operations.length);
  const byId = new Map(contractOperations.map((op) => [op.operationId, op]));
  for (const operation of phase12Operations) {
    const contract = byId.get(operation.operationId);
    expect(contract).toBeDefined();
    expect(contract.method).toBe(operation.method);
    expect(contract.path).toBe(operation.path);
  }
});

test('P12-01 platform plans and dated policy versions are append-only', async () => {
  const created = await platformRequest(
    platform.context,
    'POST',
    '/platform/plans',
    {
      body: { code: planCode, name: 'P12 Synthetic Plan' },
    },
  );
  expect(created.status).toBe(201);
  expect(created.body.code).toBe(planCode);

  const duplicate = await platformRequest(
    platform.context,
    'POST',
    '/platform/plans',
    { body: { code: planCode, name: 'P12 Synthetic Plan' } },
  );
  expect(duplicate.status).toBe(409);

  const version = await platformRequest(
    platform.context,
    'POST',
    `/platform/plans/${planCode}/policy-versions`,
    {
      body: {
        effective_from: today,
        limits: { PROPERTIES: 200, API_CALLS: 1000 },
        entitlements: { REPORTING: true, CHANNEL_MANAGER: true },
        notes: 'initial synthetic policy',
      },
    },
  );
  expect(version.status).toBe(201);
  expect(version.body.version).toBe(1);
  expect(version.body.effective_from).toBe(today);

  const backdated = await platformRequest(
    platform.context,
    'POST',
    `/platform/plans/${planCode}/policy-versions`,
    {
      body: {
        effective_from: yesterday,
        limits: { PROPERTIES: 1 },
      },
    },
  );
  expect(backdated.status).toBe(422);
  expect(backdated.body.code).toBe('POLICY_BACKDATED');

  const sameDay = await platformRequest(
    platform.context,
    'POST',
    `/platform/plans/${planCode}/policy-versions`,
    {
      body: {
        effective_from: today,
        limits: { PROPERTIES: 1 },
      },
    },
  );
  expect(sameDay.status).toBe(422);
  expect(sameDay.body.code).toBe('POLICY_BACKDATED');

  const listed = await platformRequest(
    platform.context,
    'GET',
    `/platform/plans/${planCode}/policy-versions`,
  );
  expect(listed.status).toBe(200);
  expect(listed.body.items).toHaveLength(1);
  expect(listed.body.items[0].limits.PROPERTIES).toBe(200);

  // The dated policy version is immutable even for the operating role.
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.platform_user_id', $1, true)", [
      platform.session.body.user.id,
    ]);
    await expect(
      client.query(
        `update "platform_plan_policy_version" set "limits" = '{}'::jsonb
          where "plan_id" = (select "id" from "platform_plan" where "code" = $1)`,
        [planCode],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });

  // A tenant permission never manages plans and a support role is read-only.
  const ownerAttempt = await platformRequest(
    owner.context,
    'POST',
    '/platform/plans',
    { body: { code: `P12DENIED_${seed}`, name: 'Denied plan' } },
  );
  expect(ownerAttempt.status).toBe(403);
  expect(ownerAttempt.body.code).toBe('PERMISSION_DENIED');

  const supportAttempt = await platformRequest(
    platformSupport.context,
    'POST',
    '/platform/plans',
    { body: { code: `P12SUP_${seed}`, name: 'Support plan' } },
  );
  expect(supportAttempt.status).toBe(403);
  expect(supportAttempt.body.code).toBe('PERMISSION_DENIED');

  // Sensitive platform actions require MFA (SEC-007).
  const noMfaAttempt = await platformRequest(
    platformNoMfa.context,
    'POST',
    '/platform/plans',
    { body: { code: `P12MFA_${seed}`, name: 'MFA plan' } },
  );
  expect(noMfaAttempt.status).toBe(403);
  expect(noMfaAttempt.body.code).toBe('MFA_REQUIRED');
  const readOnlyOk = await platformRequest(
    platformNoMfa.context,
    'GET',
    '/platform/plans',
  );
  expect(readOnlyOk.status).toBe(200);
});

test('P12-01 entitlements are dated, audited and never erase history', async () => {
  await ensureSubscription();
  const applied = await platformRequest(
    platform.context,
    'POST',
    `/platform/tenants/${tenantA}/entitlements`,
    {
      body: {
        capability_code: 'REPORTING',
        state: 'ENABLED',
        limits: { REPORT_EXPORTS: 5 },
        reason: 'synthetic contract rollout',
      },
    },
  );
  expect(applied.status).toBe(200);
  expect(applied.body.entitlement.state).toBe('ENABLED');
  expect(applied.body.entitlement.active).toBe(true);
  expect(applied.body.entitlement.limits.REPORT_EXPORTS).toBe(5);

  const disabled = await platformRequest(
    platform.context,
    'POST',
    `/platform/tenants/${tenantA}/entitlements`,
    {
      body: {
        capability_code: 'REPORTING',
        state: 'DISABLED',
        reason: 'synthetic rollback probe',
      },
    },
  );
  expect(disabled.status).toBe(200);
  expect(disabled.body.entitlement.state).toBe('DISABLED');
  expect(disabled.body.entitlement.active).toBe(false);

  // History stays: two append-only events plus the tenant-visible audit rows.
  const events = await dbRows(
    `select "state", "effective_from" from "platform_entitlement_event"
      where "tenant_id" = $1 and "capability_code" = 'REPORTING'
      order by "created_at", "id"`,
    [tenantA],
  );
  expect(events).toHaveLength(2);
  expect(events[0].state).toBe('ENABLED');
  expect(events[1].state).toBe('DISABLED');
  const tenantAudit = await dbRows(
    `select count(*)::int as "count" from "audit_event"
      where "tenant_id" = $1 and "action" = 'platform.entitlement_set'`,
    [tenantA],
  );
  expect(tenantAudit[0].count).toBe(2);

  const backdated = await platformRequest(
    platform.context,
    'POST',
    `/platform/tenants/${tenantA}/entitlements`,
    {
      body: {
        capability_code: 'REPORTING',
        state: 'ENABLED',
        effective_from: yesterday,
        reason: 'backdated probe',
      },
    },
  );
  expect(backdated.status).toBe(422);
  expect(backdated.body.code).toBe('POLICY_BACKDATED');

  // The tenant sees its own entitlements but can never manage them.
  const tenantView = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/subscription`,
  );
  expect(tenantView.status).toBe(200);
  expect(tenantView.body.state).toBe('ACTIVE');
  expect(
    tenantView.body.entitlements.find(
      (entry) => entry.capability_code === 'REPORTING',
    ).state,
  ).toBe('DISABLED');
  const tenantManage = await apiRequest(
    admin.context,
    'POST',
    `/platform/tenants/${tenantA}/entitlements`,
    {
      body: {
        capability_code: 'REPORTING',
        state: 'ENABLED',
        reason: 'tenant must not manage subscriptions',
      },
    },
  );
  expect(tenantManage.status).toBe(403);
  expect(tenantManage.body.code).toBe('PERMISSION_DENIED');
});

test('P12-01 usage metering is idempotent and rejects the concurrent loser', async () => {
  await ensureSubscription();
  await seedCounter('API_CALLS', 1);
  const keyOne = `p12-race-${runId}-a-1`;
  const keyTwo = `p12-race-${runId}-b-1`;

  const [first, second] = await Promise.all([
    platformRequest(
      platform.context,
      'POST',
      `/platform/tenants/${tenantA}/usage`,
      {
        body: { metric: 'API_CALLS', quantity: 1 },
        headers: { 'idempotency-key': keyOne },
      },
    ),
    platformRequest(
      platform.context,
      'POST',
      `/platform/tenants/${tenantA}/usage`,
      {
        body: { metric: 'API_CALLS', quantity: 1 },
        headers: { 'idempotency-key': keyTwo },
      },
    ),
  ]);
  const statuses = [first.status, second.status].sort((a, b) => a - b);
  expect(statuses).toEqual([200, 422]);
  const rejected = first.status === 422 ? first : second;
  expect(rejected.body.code).toBe('LIMIT_EXCEEDED');
  expect(rejected.body.details.kind).toBe('EXCEEDED');

  const afterRace = await dbOne(
    `select "used", "limit_value" from "platform_usage_counter"
      where "tenant_id" = $1 and "metric" = 'API_CALLS'`,
    [tenantA],
  );
  expect(Number(afterRace.used)).toBe(1);
  expect(Number(afterRace.limit_value)).toBe(1);

  const third = await platformRequest(
    platform.context,
    'POST',
    `/platform/tenants/${tenantA}/usage`,
    {
      body: { metric: 'API_CALLS', quantity: 1 },
      headers: { 'idempotency-key': `p12-race-${runId}-c-1` },
    },
  );
  expect(third.status).toBe(422);
  const stillOne = await dbOne(
    `select "used" from "platform_usage_counter"
      where "tenant_id" = $1 and "metric" = 'API_CALLS'`,
    [tenantA],
  );
  expect(Number(stillOne.used)).toBe(1);

  const winningKey = first.status === 200 ? keyOne : keyTwo;
  const replayed = await platformRequest(
    platform.context,
    'POST',
    `/platform/tenants/${tenantA}/usage`,
    {
      body: { metric: 'API_CALLS', quantity: 1 },
      headers: { 'idempotency-key': winningKey },
    },
  );
  expect(replayed.status).toBe(200);
  expect(replayed.body.replayed).toBe(true);
  const afterReplay = await dbOne(
    `select "used" from "platform_usage_counter"
      where "tenant_id" = $1 and "metric" = 'API_CALLS'`,
    [tenantA],
  );
  expect(Number(afterReplay.used)).toBe(1);
  const eventCount = await dbOne(
    `select count(*)::int as "count" from "platform_usage_event"
      where "tenant_id" = $1 and "metric" = 'API_CALLS'`,
    [tenantA],
  );
  expect(eventCount.count).toBe(1);

  // A tenant transaction can consume its own metered limit but cannot rewrite
  // the counter row directly.
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    const updated = await client.query(
      `update "platform_usage_counter" set "used" = 0
        where "tenant_id" = $1 and "metric" = 'API_CALLS'`,
      [tenantA],
    );
    expect(updated.rowCount).toBe(0);
    await client.query('rollback');
  });
  const unchanged = await dbOne(
    `select "used" from "platform_usage_counter"
      where "tenant_id" = $1 and "metric" = 'API_CALLS'`,
    [tenantA],
  );
  expect(Number(unchanged.used)).toBe(1);
});

test('P12-01 declared property limits are enforced atomically on a real write', async () => {
  const before = await dbOne(
    `select count(*)::int as "count" from "property" where "tenant_id" = $1`,
    [tenantA],
  );
  // The counter is a fresh metered allowance: existing rows are not
  // retroactively metered, so the race runs against an explicit limit of one.
  await seedCounter('PROPERTIES', 1);
  const beforeCounter = await dbOne(
    `select "used" from "platform_usage_counter"
      where "tenant_id" = $1 and "metric" = 'PROPERTIES'`,
    [tenantA],
  );
  expect(Number(beforeCounter.used)).toBe(0);

  const makeBody = (suffix) => ({
    code: `P12LP${suffix}${seed}`.slice(0, 40),
    name: `P12 limit property ${suffix}`,
    timezone: 'Asia/Jakarta',
    base_currency: 'IDR',
  });
  const [first, second] = await Promise.all([
    apiRequest(admin.context, 'POST', `/tenants/${tenantA}/properties`, {
      body: makeBody('A'),
    }),
    apiRequest(admin.context, 'POST', `/tenants/${tenantA}/properties`, {
      body: makeBody('B'),
    }),
  ]);
  const statuses = [first.status, second.status].sort((a, b) => a - b);
  expect(statuses).toEqual([201, 422]);
  const rejected = first.status === 422 ? first : second;
  expect(rejected.body.code).toBe('LIMIT_EXCEEDED');
  expect(rejected.body.details.metric).toBe('PROPERTIES');

  const after = await dbOne(
    `select count(*)::int as "count" from "property" where "tenant_id" = $1`,
    [tenantA],
  );
  expect(after.count).toBe(before.count + 1);
  const afterCounter = await dbOne(
    `select "used", "limit_value" from "platform_usage_counter"
      where "tenant_id" = $1 and "metric" = 'PROPERTIES'`,
    [tenantA],
  );
  expect(Number(afterCounter.used)).toBe(1);
  expect(Number(afterCounter.used)).toBeLessThanOrEqual(
    Number(afterCounter.limit_value),
  );

  await deleteCounter('PROPERTIES');
  const unlimited = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    { body: makeBody('C') },
  );
  expect(unlimited.status).toBe(201);
});

test('P12-01 property-based: metered limits match an independent reference', async () => {
  function mulberry32(value) {
    let state = value >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const random = mulberry32(20260917);
  const limit = 3 + Math.floor(random() * 4); // 3..6, independent of the DB
  await ensureSubscription();
  await seedCounter('PB_STEPS', limit);
  // Reference model: accept exactly while the running sum stays within limit.
  let referenceUsed = 0;
  const accepted = [];
  let replays = 0;
  for (let step = 0; step < 40; step += 1) {
    const quantity = 1 + Math.floor(random() * 3);
    const shouldAccept = referenceUsed + quantity <= limit;
    const usageKey = `p12-pb-${runId}-${step}-${quantity}`;
    const response = await platformRequest(
      platform.context,
      'POST',
      `/platform/tenants/${tenantA}/usage`,
      {
        body: { metric: 'PB_STEPS', quantity },
        headers: { 'idempotency-key': usageKey },
      },
    );
    if (shouldAccept) {
      expect(response.status).toBe(200);
      referenceUsed += quantity;
      accepted.push({ key: usageKey, quantity });
    } else {
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('LIMIT_EXCEEDED');
    }
    if (step % 9 === 4 && accepted.length > 0) {
      const previous = accepted[Math.floor(random() * accepted.length)];
      const replay = await platformRequest(
        platform.context,
        'POST',
        `/platform/tenants/${tenantA}/usage`,
        {
          body: { metric: 'PB_STEPS', quantity: previous.quantity },
          headers: { 'idempotency-key': previous.key },
        },
      );
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      replays += 1;
    }
  }
  expect(replays).toBeGreaterThan(0);
  const counter = await dbOne(
    `select "used", "limit_value" from "platform_usage_counter"
      where "tenant_id" = $1 and "metric" = 'PB_STEPS'`,
    [tenantA],
  );
  expect(Number(counter.used)).toBe(referenceUsed);
  expect(Number(counter.limit_value)).toBe(limit);
  expect(referenceUsed).toBeLessThanOrEqual(limit);
  await deleteCounter('PB_STEPS');
});

test('P12-01 administrative billing is documented, idempotent and manual', async () => {
  await ensureSubscription();
  const ledgerBefore = await dbOne(
    `select
       (select count(*)::int from "journal") as journals,
       (select count(*)::int from "journal_line") as lines,
       (select count(*)::int from "business_day") as days,
       (select count(*)::int from "folio_charge") as charges`,
  );

  const invoiceKey = `p12-invoice-${runId}-1`;
  const issued = await platformRequest(
    platform.context,
    'POST',
    `/platform/tenants/${tenantA}/invoices`,
    {
      body: {
        period_start: periodStart,
        period_end: periodEnd,
        currency: 'IDR',
        lines: [
          {
            description: 'Platform subscription',
            quantity: '1',
            unit_amount: '250000',
          },
          {
            description: 'Extra properties',
            quantity: '2',
            unit_amount: '12500.50',
          },
        ],
        notes: 'administrative record only',
      },
      headers: { 'idempotency-key': invoiceKey },
    },
  );
  expect(issued.status).toBe(201);
  expect(issued.body.currency).toBe('IDR');
  expect(issued.body.total_amount).toBe('275001');
  expect(issued.body.lines).toHaveLength(2);
  expect(issued.body.replayed).toBe(false);

  const replay = await platformRequest(
    platform.context,
    'POST',
    `/platform/tenants/${tenantA}/invoices`,
    {
      body: {
        period_start: periodStart,
        period_end: periodEnd,
        currency: 'IDR',
        lines: [
          {
            description: 'Platform subscription',
            quantity: '1',
            unit_amount: '250000',
          },
        ],
      },
      headers: { 'idempotency-key': invoiceKey },
    },
  );
  expect(replay.status).toBe(201);
  expect(replay.body.replayed).toBe(true);
  const invoiceRows = await dbOne(
    `select count(*)::int as "count" from "platform_invoice"
      where "tenant_id" = $1 and "idempotency_key" = $2`,
    [tenantA, invoiceKey],
  );
  expect(invoiceRows.count).toBe(1);

  const invalidCurrency = await platformRequest(
    platform.context,
    'POST',
    `/platform/tenants/${tenantA}/invoices`,
    {
      body: {
        period_start: periodStart,
        period_end: periodEnd,
        currency: 'EUR',
        lines: [
          { description: 'Bad currency', quantity: '1', unit_amount: '10' },
        ],
      },
      headers: { 'idempotency-key': `p12-invoice-${runId}-2` },
    },
  );
  expect(invalidCurrency.status).toBe(400);
  expect(invalidCurrency.body.code).toBe('INVALID_REQUEST');

  const listed = await platformRequest(
    platform.context,
    'GET',
    `/platform/tenants/${tenantA}/invoices`,
  );
  expect(listed.status).toBe(200);
  expect(listed.body.items.length).toBeGreaterThanOrEqual(1);

  // The tenant reads its own administrative invoices.
  const tenantList = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/subscription`,
  );
  expect(tenantList.status).toBe(200);

  const voided = await platformRequest(
    platform.context,
    'POST',
    `/platform/invoices/${issued.body.id}/revocation`,
    { body: { reason: 'synthetic void probe' } },
  );
  expect(voided.status).toBe(200);
  expect(voided.body.state).toBe('VOID');
  const voidAgain = await platformRequest(
    platform.context,
    'POST',
    `/platform/invoices/${issued.body.id}/revocation`,
    { body: { reason: 'synthetic void probe again' } },
  );
  expect(voidAgain.status).toBe(409);
  expect(voidAgain.body.code).toBe('PLATFORM_INVOICE_STATE');

  const settleKey = `p12-invoice-${runId}-3`;
  const second = await platformRequest(
    platform.context,
    'POST',
    `/platform/tenants/${tenantA}/invoices`,
    {
      body: {
        period_start: periodStart,
        period_end: periodEnd,
        currency: 'USD',
        lines: [
          {
            description: 'USD administrative line',
            quantity: '1',
            unit_amount: '99',
          },
        ],
      },
      headers: { 'idempotency-key': settleKey },
    },
  );
  expect(second.status).toBe(201);
  const settled = await platformRequest(
    platform.context,
    'POST',
    `/platform/invoices/${second.body.id}/settlement`,
    { body: { reference: 'MANUAL-TRANSFER-0001' } },
  );
  expect(settled.status).toBe(200);
  expect(settled.body.state).toBe('SETTLED');
  expect(settled.body.settlement_reference).toBe('MANUAL-TRANSFER-0001');
  const settledRow = await dbOne(
    `select "settlement_reference", "settled_at" from "platform_invoice"
      where "id" = $1`,
    [second.body.id],
  );
  expect(settledRow.settlement_reference).toBe('MANUAL-TRANSFER-0001');
  expect(settledRow.settled_at).not.toBeNull();

  // The hotel ledger is untouched by subscription, entitlement, usage or
  // administrative billing activity.
  const ledgerAfter = await dbOne(
    `select
       (select count(*)::int from "journal") as journals,
       (select count(*)::int from "journal_line") as lines,
       (select count(*)::int from "business_day") as days,
       (select count(*)::int from "folio_charge") as charges`,
  );
  expect(ledgerAfter).toEqual(ledgerBefore);
  const platformLedger = await dbOne(
    `select count(*)::int as "count" from "journal"
      where "tenant_id" = $1 and "source_type" like 'PLATFORM%'`,
    [tenantA],
  );
  expect(platformLedger.count).toBe(0);
});

test('P12-01 adversarial: platform rows stay invisible without a platform actor', async () => {
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query(`select set_config('app.platform_user_id', '', true)`);
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    const plans = await client.query(
      `select count(*)::int as "count" from "platform_plan"`,
    );
    const audit = await client.query(
      `select count(*)::int as "count" from "platform_audit_event"`,
    );
    const subscriptions = await client.query(
      `select count(*)::int as "count" from "platform_subscription"`,
    );
    expect(plans.rows[0].count).toBe(0);
    expect(audit.rows[0].count).toBe(0);
    expect(subscriptions.rows[0].count).toBe(1);
    await client.query('rollback');
  });
  await withRuntimeRole('worker', async (client) => {
    await client.query('begin');
    await expect(
      client.query(`select count(*)::int as "count" from "platform_plan"`),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.platform_user_id', $1, true)", [
      platform.session.body.user.id,
    ]);
    const guests = await client.query(
      `select count(*)::int as "count" from "guest"`,
    );
    expect(guests.rows[0].count).toBe(0);
    await client.query('rollback');
  });
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.platform_user_id', $1, true)", [
      platform.session.body.user.id,
    ]);
    await expect(
      client.query(`delete from "platform_invoice" where "tenant_id" = $1`, [
        tenantA,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });
  // Another tenant never sees this tenant's subscription through the platform
  // tables, and the tenant route fails closed across tenants.
  const crossTenant = await apiRequest(
    ownerB.context,
    'GET',
    `/tenants/${tenantA}/subscription`,
  );
  expect([403, 404]).toContain(crossTenant.status);
});

test('P12-01 platform actions are audited with correlation and actor role', async () => {
  const actions = await dbRows(
    `select distinct "action" from "platform_audit_event"
      where "actor_user_id" = $1 order by "action"`,
    [platform.session.body.user.id],
  );
  const names = actions.map((row) => row.action);
  expect(names).toEqual(
    expect.arrayContaining([
      'platform.plan_created',
      'platform.plan_policy_version_created',
      'platform.entitlement_set',
      'platform.usage_recorded',
      'platform.invoice_issued',
      'platform.invoice_voided',
      'platform.invoice_settled',
    ]),
  );
  const auditRow = await dbOne(
    `select "actor_role", "correlation_id" from "platform_audit_event"
      where "action" = 'platform.invoice_issued'
      order by "created_at" desc limit 1`,
  );
  expect(auditRow.actor_role).toBe('PLATFORM_ADMIN');
  expect(auditRow.correlation_id).toBeTruthy();
});
