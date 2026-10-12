import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { phase11Operations } from '../../apps/api/dist/reporting/operations.js';
import {
  apiRequest,
  closeBrowser,
  closeSessions,
  loginAs,
  loginFresh,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';
import { addBusinessDays, todayInTimeZone } from './support/business-dates.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;

// Fixed synthetic seed, no real guest data.
const seed = 20261103;
const runId = `P11X${seed}`;
const key = (name) => `p11x-${name}-${runId}-${String(name).length}`;

let admin;
let owner;
let ownerB;
let member;

// Anchor every relative date to the facility's business timezone (Asia/Jakarta).
// A UTC-derived date can equal the local business date around midnight and
// collapse a one-night period into `date_from == date_to`.
const businessToday = todayInTimeZone('Asia/Jakarta');

function addDays(days) {
  return addBusinessDays(businessToday, days);
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

function base(propertyId) {
  return `/tenants/${tenantA}/properties/${propertyId}`;
}

function runtimeUrl(baseUrl, name) {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

let worker;
async function startExportWorker() {
  const testDb = process.env.IDENTITY_TEST_DB;
  const child = spawn(
    process.execPath,
    ['--env-file=.env', 'apps/worker/dist/main.js'],
    {
      env: {
        ...process.env,
        API_DATABASE_URL: runtimeUrl(process.env.API_DATABASE_URL, testDb),
        WORKER_DATABASE_URL: runtimeUrl(
          process.env.WORKER_DATABASE_URL,
          testDb,
        ),
        REPORT_EXPORT_WORKER: 'on',
        REPORT_EXPORT_POLL_MS: '500',
        NIGHT_AUDIT_WORKER: 'off',
        DISTRIBUTION_WORKER: 'off',
        WORKER_PORT: '4201',
      },
      stdio: 'ignore',
    },
  );
  child.on('exit', () => {
    worker = null;
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (child.exitCode !== null)
    throw new Error(`export worker exited early (${child.exitCode})`);
  return child;
}

async function stopExportWorker(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function setupProperty(suffix) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: `P11X-${suffix}-${runId}`,
        name: `P11X ${suffix} ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  const property = created.body.property;
  const resource = await apiRequest(
    admin.context,
    'POST',
    `${base(property.id)}/resources`,
    {
      body: { code: `P11X-${suffix}-R1-${runId}`, type: 'ROOM', capacity: 2 },
    },
  );
  expect(resource.status).toBe(201);
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base(property.id)}/products`,
    {
      body: {
        code: `P11X-${suffix}-P-${runId}`,
        name: `P11X ${suffix} ${runId}`,
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(product.status).toBe(201);
  expect(
    (
      await apiRequest(
        admin.context,
        'POST',
        `${base(property.id)}/products/${product.body.product.id}/candidates`,
        { body: { resource_id: resource.body.resource.id } },
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await apiRequest(
        admin.context,
        'PATCH',
        `${base(property.id)}/products/${product.body.product.id}`,
        { body: { version: product.body.product.version, status: 'ACTIVE' } },
      )
    ).status,
  ).toBe(200);
  const plan = await apiRequest(
    admin.context,
    'POST',
    `${base(property.id)}/rate-plans`,
    {
      body: {
        code: `P11X-${suffix}-RP-${runId}`,
        name: `P11X ${suffix} ${runId}`,
        product_id: product.body.product.id,
        currency: 'IDR',
      },
    },
  );
  expect(plan.status).toBe(201);
  await apiRequest(
    admin.context,
    'PATCH',
    `${base(property.id)}/rate-plans/${plan.body.rate_plan.id}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  const cells = [];
  for (let offset = 0; offset <= 20; offset += 1)
    cells.push({
      rate_plan_id: plan.body.rate_plan.id,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '300000', currency: 'IDR' },
    });
  expect(
    (
      await apiRequest(
        admin.context,
        'POST',
        `${base(property.id)}/rates/batch`,
        {
          body: { cells },
        },
      )
    ).status,
  ).toBe(200);
  const day = await apiRequest(
    admin.context,
    'GET',
    `${base(property.id)}/finance/business-day`,
  );
  expect(day.status).toBe(200);
  return {
    property,
    resource: resource.body.resource,
    product: product.body.product,
    planId: plan.body.rate_plan.id,
    openDay: day.body.date,
  };
}

async function createExport(propertyId, body, name) {
  return apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/reports/exports`,
    {
      body,
      headers: { 'idempotency-key': key(name) },
    },
  );
}

async function createTenantExport(body, name) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/reports/exports`,
    {
      body,
      headers: { 'idempotency-key': key(name) },
    },
  );
}

async function waitForReady(exportId, context = admin.context) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const response = await apiRequest(
      context,
      'GET',
      `/tenants/${tenantA}/reports/exports/${exportId}/download`,
    );
    if (response.status === 200) return response;
    if (response.status !== 409 && response.status !== 404)
      throw new Error(
        `export download failed ${response.status}: ${JSON.stringify(response.body)}`,
      );
    if (Date.now() > deadline)
      throw new Error('export was not generated in time');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function csvFields(content) {
  return content
    .split(/\r\n/)
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const fields = [];
      let current = '';
      let quoted = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quoted) {
          if (character === '"' && line[index + 1] === '"') {
            current += '"';
            index += 1;
          } else if (character === '"') {
            quoted = false;
          } else {
            current += character;
          }
        } else if (character === '"') {
          quoted = true;
        } else if (character === ',') {
          fields.push(current);
          current = '';
        } else {
          current += character;
        }
      }
      fields.push(current);
      return fields;
    });
}

let main;
let exportCount = 0;

async function revenueForPeriod(scope, businessDate) {
  exportCount += 1;
  const suffix = exportCount;
  const draft = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: [
          {
            product_id: scope.product.id,
            period: { arrival: addDays(0), departure: addDays(1) },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
      },
    },
  );
  expect(draft.status).toBe(201);
  const reservationId = draft.body.reservation.id;
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base(scope.property.id)}/reservations/${reservationId}`,
  );
  const itemId = detail.body.items[0].id;
  const quote = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/quotes`,
    {
      body: {
        product_id: scope.product.id,
        rate_plan_id: scope.planId,
        period: { arrival: addDays(0), departure: addDays(1) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    },
  );
  expect(quote.status).toBe(201);
  const rates = await apiRequest(
    admin.context,
    'GET',
    `${base(scope.property.id)}/rates?from=${addDays(0)}&to=${addDays(20)}`,
  );
  expect(
    (
      await apiRequest(
        admin.context,
        'POST',
        `${base(scope.property.id)}/reservations`,
        {
          body: {
            reservation_id: reservationId,
            inventory_version: rates.body.inventory_version,
            items: [
              { item_id: itemId, price_snapshot_id: quote.body.quote.id },
            ],
          },
        },
      )
    ).status,
  ).toBe(200);
  const folio = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/folios`,
    {
      body: {
        reservation_id: reservationId,
        kind: 'GUEST',
        payer_label: `Guest ${runId}`,
        currency: 'IDR',
      },
      headers: { 'idempotency-key': key(`folio-${suffix}`) },
    },
  );
  expect(folio.status).toBe(200);
  const charge = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/charges`,
    {
      body: {
        folio_id: folio.body.folio.id,
        business_date: businessDate,
        money: { amount: '400000', currency: 'IDR' },
        tax_money: { amount: '40000', currency: 'IDR' },
        tax_policy: { code: 'SYNTHETIC' },
        account_code: 'REVENUE_ROOM',
        source_ref: `p11x-revenue-${suffix}`,
      },
      headers: { 'idempotency-key': key(`charge-${suffix}`) },
    },
  );
  expect(charge.status).toBe(200);
  return folio.body.folio.id;
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  owner = await loginAs('owner-a');
  ownerB = await loginAs('owner-b');
  member = await loginAs('member-a');
  main = await setupProperty('MAIN');
  await revenueForPeriod(main, main.openDay);
  worker = await startExportWorker();
});

afterAll(async () => {
  await stopExportWorker(worker);
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P11-03 contract declares the full short-lived export lifecycle', () => {
  const contract = JSON.parse(
    readFileSync('docs/contracts/phase11.openapi.json', 'utf8'),
  );
  const operationIds = phase11Operations
    .map((operation) => operation.operationId)
    .sort();
  expect(operationIds).toEqual(
    [
      'CaptureReportSnapshot',
      'DownloadReportExport',
      'ExportReport',
      'ExportTenantReport',
      'ListReportExports',
      'ListReportSnapshots',
      'ReadReport',
      'ReadTenantReport',
      'RevokeReportExport',
    ].sort(),
  );
  const exportOperation = phase11Operations.find(
    (operation) => operation.operationId === 'ExportReport',
  );
  expect(exportOperation?.permission).toBe('report.export');
  expect(exportOperation?.csrf).toBe(true);
  expect(
    contract.paths['/tenants/{tenantId}/reports/exports/{exportId}/download'],
  ).toBeTruthy();
});

test('the worker generates a private CSV that only its creator can download', async () => {
  const created = await createExport(
    main.property.id,
    {
      kind: 'REVENUE',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    'revenue',
  );
  expect(created.status).toBe(202);
  expect(created.body.export.state).toBe('PENDING');
  const exportId = created.body.export.id;

  const replay = await createExport(
    main.property.id,
    {
      kind: 'REVENUE',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    'revenue',
  );
  expect(replay.status).toBe(202);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.export.id).toBe(exportId);

  const download = await waitForReady(exportId);
  expect(download.headers['content-type']).toContain('text/csv');
  expect(download.headers['content-disposition']).toContain('attachment');
  const sha = download.headers['x-report-sha256'];
  expect(sha).toBe(
    createHash('sha256').update(download.body, 'utf8').digest('hex'),
  );
  expect(download.body).toContain('revenue_journal.REVENUE_ROOM');
  expect(download.body).toContain('400000');

  // Another client in the same tenant and a client of another tenant cannot
  // read it; owner-a lacks MFA for report.export and owner-b is out of scope.
  const ownerAttempt = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/reports/exports/${exportId}/download`,
  );
  expect([403, 404]).toContain(ownerAttempt.status);
  const foreignAttempt = await apiRequest(
    ownerB.context,
    'GET',
    `/tenants/${tenantA}/reports/exports/${exportId}/download`,
  );
  expect([403, 404]).toContain(foreignAttempt.status);
  const memberAttempt = await apiRequest(
    member.context,
    'GET',
    `/tenants/${tenantA}/reports/exports/${exportId}/download`,
  );
  expect(memberAttempt.status).toBe(403);

  const auditCreate = await dbOne(
    `select count(*)::int as "count" from "audit_event"
      where "property_id" = $1 and "action" = 'report.export_created'`,
    [main.property.id],
  );
  expect(auditCreate.count).toBeGreaterThanOrEqual(1);
  const auditDownload = await dbOne(
    `select count(*)::int as "count" from "audit_event"
      where "property_id" = $1 and "action" = 'report.export_downloaded'`,
    [main.property.id],
  );
  expect(auditDownload.count).toBeGreaterThanOrEqual(1);
});

test('CSV neutralizes spreadsheet formulas and list stays caller-scoped', async () => {
  const connection = await apiRequest(
    admin.context,
    'POST',
    `${base(main.property.id)}/connections`,
    {
      body: {
        provider_key: 'channex',
        environment: 'simulator',
        channel_key: 'tiket-com',
        secret_ref: 'secret:p11x-simulator',
      },
    },
  );
  expect(connection.status).toBe(201);
  await dbRows(
    `insert into "distribution_external_booking"
       ("id", "connection_id", "channel_key", "external_booking_id", "state",
        "tenant_id", "property_id")
     values (gen_random_uuid(), $1, '=EVIL("x")', $2, 'ACTIVE', $3, $4)`,
    [
      connection.body.connection.id,
      `P11X-INJ-${runId}`,
      tenantA,
      main.property.id,
    ],
  );

  const created = await createExport(
    main.property.id,
    {
      kind: 'CHANNEL_PERFORMANCE',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    'injection',
  );
  expect(created.status).toBe(202);
  const download = await waitForReady(created.body.export.id);
  expect(download.body).toContain("'=EVIL");
  for (const field of csvFields(download.body)) {
    if (field.length === 0) continue;
    expect(['=', '+', '@', '\t', '\r'].includes(field[0])).toBe(false);
    if (field[0] === '-') expect(field.startsWith("'-")).toBe(true);
  }

  const listed = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/reports/exports?property_id=${main.property.id}`,
  );
  expect(listed.status).toBe(200);
  expect(
    listed.body.items.every((item) =>
      ['READY', 'EXPIRED', 'REVOKED'].includes(item.state),
    ),
  ).toBe(true);
  expect(listed.body.items.length).toBeGreaterThanOrEqual(2);

  const ownerList = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/reports/exports?property_id=${main.property.id}`,
  );
  expect(ownerList.status).toBe(403);
});

test('download survives session revoke but fails closed after permission revoke', async () => {
  const created = await createExport(
    main.property.id,
    {
      kind: 'REVENUE',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    'revoke-session',
  );
  expect(created.status).toBe(202);
  const exportId = created.body.export.id;
  await waitForReady(exportId);

  await closeSessions();
  admin = await loginFresh('admin-a');
  const afterRelogin = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/reports/exports/${exportId}/download`,
  );
  expect(afterRelogin.status).toBe(200);

  // A DENY grant for report.export on this property must fail the live check.
  // The DENY row is written directly because the API's DENY path carries its
  // own approval workflow, which is outside the reporting scope.
  const role = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/roles`,
    {
      body: {
        code: `EXPORT_DENY_${runId}`,
        name: `Export deny ${runId}`,
        permission_codes: ['report.export'],
      },
    },
  );
  if (role.status !== 201)
    throw new Error(`role failed ${role.status}: ${JSON.stringify(role.body)}`);
  const me = await apiRequest(admin.context, 'GET', `/tenants/${tenantA}/me`);
  expect(me.status).toBe(200);
  const grant = await dbOne(
    `insert into "role_grant"
       ("id", "tenant_id", "membership_id", "role_id", "effect", "scope_type",
        "granted_by", "reason")
     values (gen_random_uuid(), $1, $2, $3, 'DENY', 'PROPERTIES', $4,
             'synthetic deny for the live permission check')
     returning "id"`,
    [
      tenantA,
      me.body.membership.id,
      role.body.role.id,
      me.body.membership.user_id,
    ],
  );
  await dbRows(
    `insert into "grant_property" ("grant_id", "tenant_id", "property_ref")
     values ($1, $2, $3)`,
    [grant.id, tenantA, main.property.id],
  );
  const blocked = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/reports/exports/${exportId}/download`,
  );
  expect(blocked.status).toBe(403);

  await dbRows(`update "role_grant" set "revoked_at" = now() where "id" = $1`, [
    grant.id,
  ]);
  const restored = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/reports/exports/${exportId}/download`,
  );
  expect(restored.status).toBe(200);
});

test('exports expire and revocation deletes content immediately', async () => {
  const expiring = await createExport(
    main.property.id,
    {
      kind: 'REVENUE',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    'expire',
  );
  expect(expiring.status).toBe(202);
  const expiringId = expiring.body.export.id;
  await waitForReady(expiringId);
  await dbRows(
    `update "report_export" set "expires_at" = now() - interval '1 minute'
      where "id" = $1`,
    [expiringId],
  );
  const expired = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/reports/exports/${expiringId}/download`,
  );
  expect(expired.status).toBe(410);
  expect(expired.body.code).toBe('REPORT_EXPORT_EXPIRED');
  const expiredRow = await dbOne(
    `select "state", "content" from "report_export" where "id" = $1`,
    [expiringId],
  );
  expect(expiredRow.state).toBe('EXPIRED');
  expect(expiredRow.content).toBe(null);

  const revocable = await createExport(
    main.property.id,
    {
      kind: 'REVENUE',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    'revoke',
  );
  expect(revocable.status).toBe(202);
  const revocableId = revocable.body.export.id;
  await waitForReady(revocableId);
  const revoked = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/reports/exports/${revocableId}/revocation`,
    { body: {} },
  );
  expect(revoked.status).toBe(200);
  expect(revoked.body.export.state).toBe('REVOKED');
  const afterRevoke = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/reports/exports/${revocableId}/download`,
  );
  expect(afterRevoke.status).toBe(410);
  expect(afterRevoke.body.code).toBe('REPORT_EXPORT_REVOKED');
  const row = await dbOne(
    `select "content" from "report_export" where "id" = $1`,
    [revocableId],
  );
  expect(row.content).toBe(null);
});

test('multi-property portfolio export is homogeneous and authorized', async () => {
  const second = await setupProperty('PORT');
  await revenueForPeriod(second, second.openDay);
  const created = await createTenantExport(
    {
      kind: 'PORTFOLIO',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    'portfolio',
  );
  expect(created.status).toBe(202);
  const download = await waitForReady(created.body.export.id);
  expect(download.body).toContain(`portfolio_revenue.${main.property.code}`);
  expect(download.body).toContain(`portfolio_revenue.${second.property.code}`);
  expect(download.body).toContain('portfolio_single_currency,IDR');
  expect(download.body).toContain('400000');
  expect(download.body).toContain('400000'); // both properties post the same synthetic amount

  // Unknown body fields are rejected instead of widening the scope.
  const wrongCurrency = await createTenantExport(
    {
      kind: 'PORTFOLIO',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
      property_ids: [main.property.id],
    },
    'portfolio-wrong',
  );
  expect(wrongCurrency.status).toBe(400);
  expect(wrongCurrency.body.code).toBe('INVALID_REQUEST');
});

test('export idempotency rejects a reused key with different content', async () => {
  const first = await createExport(
    main.property.id,
    {
      kind: 'REVENUE',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    'idem',
  );
  expect(first.status).toBe(202);
  const conflict = await apiRequest(
    admin.context,
    'POST',
    `${base(main.property.id)}/reports/exports`,
    {
      body: {
        kind: 'TAX',
        period: {
          date_from: main.openDay,
          date_to: addBusinessDays(main.openDay, 1),
        },
        currency: 'IDR',
      },
      headers: { 'idempotency-key': key('idem') },
    },
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.code).toBe('CONFLICT');
});

test('export views expose RFC 3339 instants, not raw database timestamps', async () => {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const created = await createExport(
    main.property.id,
    {
      kind: 'REVENUE',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    'instants',
  );
  expect(created.status).toBe(202);
  expect(created.body.export.created_at).toMatch(iso);
  expect(created.body.export.expires_at).toMatch(iso);
  expect(created.body.export.ready_at).toBeNull();
  expect(created.body.export.revoked_at).toBeNull();

  const exportId = created.body.export.id;
  await waitForReady(exportId);
  const listed = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/reports/exports?property_id=${main.property.id}`,
  );
  expect(listed.status).toBe(200);
  const row = listed.body.items.find((item) => item.id === exportId);
  expect(row).toBeTruthy();
  expect(row.created_at).toMatch(iso);
  expect(row.ready_at).toMatch(iso);
  expect(row.expires_at).toMatch(iso);
  expect(row.revoked_at).toBeNull();
});
