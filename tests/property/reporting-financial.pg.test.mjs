import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { phase11Operations } from '../../apps/api/dist/reporting/operations.js';
import {
  apiRequest,
  closeBrowser,
  closeSessions,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';
import { addBusinessDays, todayInTimeZone } from './support/business-dates.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;

// Fixed synthetic seed, no real guest data.
const seed = 20261102;
const runId = `P11F${seed}`;
const key = (name) => `p11f-${name}-${runId}-${String(name).length}`;

let admin;
let owner;
let ownerB;
let member;
let auditor;

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

async function setupProperty(suffix) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: `P11F-${suffix}-${runId}`,
        name: `P11F ${suffix} ${runId}`,
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
      body: { code: `P11F-${suffix}-R1-${runId}`, type: 'ROOM', capacity: 2 },
    },
  );
  expect(resource.status).toBe(201);
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base(property.id)}/products`,
    {
      body: {
        code: `P11F-${suffix}-P-${runId}`,
        name: `P11F ${suffix} ${runId}`,
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(product.status).toBe(201);
  const candidate = await apiRequest(
    admin.context,
    'POST',
    `${base(property.id)}/products/${product.body.product.id}/candidates`,
    { body: { resource_id: resource.body.resource.id } },
  );
  expect(candidate.status).toBe(201);
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base(property.id)}/products/${product.body.product.id}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  const plan = await apiRequest(
    admin.context,
    'POST',
    `${base(property.id)}/rate-plans`,
    {
      body: {
        code: `P11F-${suffix}-RP-${runId}`,
        name: `P11F ${suffix} ${runId}`,
        product_id: product.body.product.id,
        currency: 'IDR',
      },
    },
  );
  expect(plan.status).toBe(201);
  const planId = plan.body.rate_plan.id;
  const planActive = await apiRequest(
    admin.context,
    'PATCH',
    `${base(property.id)}/rate-plans/${planId}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  expect(planActive.status).toBe(200);
  const cells = [];
  for (let offset = 0; offset <= 20; offset += 1) {
    cells.push({
      rate_plan_id: planId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '300000', currency: 'IDR' },
    });
  }
  const rates = await apiRequest(
    admin.context,
    'POST',
    `${base(property.id)}/rates/batch`,
    {
      body: { cells },
    },
  );
  expect(rates.status).toBe(200);
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
    planId,
    openDay: day.body.date,
  };
}

async function openFolio(propertyId, reservationId) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/folios`,
    {
      body: {
        reservation_id: reservationId,
        kind: 'GUEST',
        payer_label: `Guest ${runId}`,
        currency: 'IDR',
      },
      headers: { 'idempotency-key': key(`folio-${reservationId}`) },
    },
  );
  expect(response.status).toBe(200);
  return response.body.folio;
}

async function postCharge(
  propertyId,
  folioId,
  businessDate,
  amount,
  tax,
  name,
) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/charges`,
    {
      body: {
        folio_id: folioId,
        business_date: businessDate,
        money: { amount, currency: 'IDR' },
        tax_money: { amount: tax, currency: 'IDR' },
        tax_policy: { code: 'SYNTHETIC', rate: '0.1' },
        account_code: name === 'room' ? 'REVENUE_ROOM' : 'REVENUE_OTHER',
        source_ref: `p11f-${name}-${runId}`,
      },
      headers: { 'idempotency-key': key(`charge-${name}`) },
    },
  );
  expect(response.status).toBe(200);
  return response.body.charge;
}

async function recordPayment(propertyId, body, name) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/payments`,
    {
      body,
      headers: { 'idempotency-key': key(`payment-${name}`) },
    },
  );
  return response;
}

async function confirmedStay(scope) {
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
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/reservations`,
    {
      body: {
        reservation_id: reservationId,
        inventory_version: rates.body.inventory_version,
        items: [{ item_id: itemId, price_snapshot_id: quote.body.quote.id }],
      },
    },
  );
  expect(confirmed.status).toBe(200);
  const refreshed = await apiRequest(
    admin.context,
    'GET',
    `${base(scope.property.id)}/reservations/${reservationId}`,
  );
  const itemVersion = refreshed.body.items.find(
    (entry) => entry.id === itemId,
  ).version;
  const checkedIn = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/reservations/${reservationId}/items/${itemId}/check-in`,
    {
      body: {
        version: itemVersion,
        resource_id: scope.resource.id,
      },
      headers: { 'idempotency-key': key(`ci-${itemId}`) },
    },
  );
  if (checkedIn.status !== 200)
    throw new Error(
      `check-in failed ${checkedIn.status}: ${JSON.stringify(checkedIn.body)}`,
    );
  return { reservationId, itemId };
}

async function readReport(propertyId, body, context = admin.context) {
  return apiRequest(context, 'POST', `${base(propertyId)}/reports/query`, {
    body,
  });
}

async function readTenantReport(body, context = admin.context) {
  return apiRequest(context, 'POST', `/tenants/${tenantA}/reports/query`, {
    body,
  });
}

function metricOf(report, metricKey) {
  return (report.metrics ?? []).find((entry) => entry.key === metricKey);
}

let main;
let portfolioB;
let stay;
let folio;
let connectionId;

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  owner = await loginAs('owner-a');
  ownerB = await loginAs('owner-b');
  member = await loginAs('member-a');
  auditor = await loginAs('auditor-a');

  main = await setupProperty('MAIN');
  stay = await confirmedStay(main);
  folio = await openFolio(main.property.id, stay.reservationId);
  await postCharge(
    main.property.id,
    folio.id,
    main.openDay,
    '300000',
    '30000',
    'room',
  );
  await recordPayment(
    main.property.id,
    {
      folio_id: folio.id,
      method: 'CASH',
      money: { amount: '100000', currency: 'IDR' },
      business_date: main.openDay,
      external_reference: `cash-${runId}`,
      source_ref: `p11f-cash-${runId}`,
    },
    'cash',
  );

  // Channel performance fixture: draft connection + external booking + OTA
  // settlement with gross/commission/net kept separate.
  const connection = await apiRequest(
    admin.context,
    'POST',
    `${base(main.property.id)}/connections`,
    {
      body: {
        provider_key: 'channex',
        environment: 'simulator',
        channel_key: 'tiket-com',
        secret_ref: 'secret:p11f-simulator',
      },
    },
  );
  expect(connection.status).toBe(201);
  connectionId = connection.body.connection.id;
  const externalId = `P11F-EXT-${runId}`;
  await dbRows(
    `insert into "distribution_external_booking"
       ("id", "connection_id", "channel_key", "external_booking_id", "state",
        "reservation_ref", "tenant_id", "property_id")
     values (gen_random_uuid(), $1, 'tiket-com', $2, 'ACTIVE', $3, $4, $5)`,
    [connectionId, externalId, stay.reservationId, tenantA, main.property.id],
  );
  const ota = await recordPayment(
    main.property.id,
    {
      folio_id: folio.id,
      method: 'OTA_SETTLEMENT',
      money: { amount: '225000', currency: 'IDR' },
      gross_money: { amount: '250000', currency: 'IDR' },
      commission_money: { amount: '25000', currency: 'IDR' },
      business_date: main.openDay,
      external_reference: externalId,
      evidence_ref: randomUUID(),
      source_ref: `p11f-ota-${runId}`,
    },
    'ota',
  );
  if (ota.status !== 200)
    throw new Error(`ota failed ${ota.status}: ${JSON.stringify(ota.body)}`);
  expect(ota.status).toBe(200);

  // Second property for the multi-property portfolio.
  portfolioB = await setupProperty('PORT');
  const bStay = await confirmedStay(portfolioB);
  const bFolio = await openFolio(portfolioB.property.id, bStay.reservationId);
  await postCharge(
    portfolioB.property.id,
    bFolio.id,
    portfolioB.openDay,
    '50000',
    '5000',
    'roomsmall',
  );
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P11-02 contract adds ReadTenantReport without breaking v1 consumers', () => {
  const contract = JSON.parse(
    readFileSync('docs/contracts/phase11.openapi.json', 'utf8'),
  );
  const operationIds = phase11Operations.map(
    (operation) => operation.operationId,
  );
  expect(operationIds).toContain('ReadReport');
  expect(operationIds).toContain('ReadTenantReport');
  const portfolio = contract.paths['/tenants/{tenantId}/reports/query'].post;
  expect(portfolio.operationId).toBe('ReadTenantReport');
  expect(portfolio['x-permission']).toBe('report.operational.view');
  expect(
    portfolio.responses['200'].content['application/json'].schema.$ref,
  ).toContain('ReportResult');
  expect(
    contract.components.schemas.ReportResult.properties.reconciliation,
  ).toBeTruthy();
});

test('revenue totals match the posted journal in the same snapshot', async () => {
  const response = await readReport(main.property.id, {
    kind: 'REVENUE',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
  });
  expect(response.status).toBe(200);
  const report = response.body;

  const journal = await dbOne(
    `select coalesce(sum(l."credit" - l."debit"), 0)::text as "total"
       from "journal_line" l join "journal" j on j."id" = l."journal_id"
      where j."property_id" = $1 and j."state" = 'POSTED' and j."currency" = 'IDR'
        and j."business_date" >= $2::date and j."business_date" < $3::date
        and l."account_code" = 'REVENUE_ROOM'`,
    [main.property.id, main.openDay, addBusinessDays(main.openDay, 1)],
  );
  const charges = await dbOne(
    `select coalesce(sum("net_amount"), 0)::text as "total" from "folio_charge"
      where "property_id" = $1 and "currency" = 'IDR'
        and "business_date" >= $2::date and "business_date" < $3::date
        and "account_code" = 'REVENUE_ROOM'`,
    [main.property.id, main.openDay, addBusinessDays(main.openDay, 1)],
  );
  expect(metricOf(report, 'revenue_journal.REVENUE_ROOM')?.value).toBe(
    '300000',
  );
  expect(metricOf(report, 'revenue_charges.REVENUE_ROOM')?.value).toBe(
    '300000',
  );
  expect(metricOf(report, 'revenue_journal.REVENUE_ROOM')?.value).toBe(
    String(Number(journal.total)),
  );
  expect(metricOf(report, 'revenue_charges.REVENUE_ROOM')?.value).toBe(
    String(Number(charges.total)),
  );
  expect(metricOf(report, 'revenue_journal_reconciled')?.value).toBe('true');
  expect(report.reconciliation.reconciled).toBe(true);
  expect(report.reconciliation.journal_source).toBe('POSTED');
  expect(report.cutoff.business_date).toBe(main.openDay);

  // Payments are not revenue: the cash and OTA collections never enter the
  // posted revenue accounts.
  expect(metricOf(report, 'revenue_total')?.value).toBe('300000');

  const outside = await readReport(main.property.id, {
    kind: 'REVENUE',
    period: { date_from: addDays(1), date_to: addDays(2) },
    currency: 'IDR',
  });
  expect(metricOf(outside.body, 'revenue_total')?.value).toBe('0');
});

test('SET-07.5: ADR/RevPAR attribute posted stay revenue per resource type', async () => {
  const response = await readReport(main.property.id, {
    kind: 'ADR_REVPAR',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
  });
  expect(response.status).toBe(200);
  const report = response.body;

  // The room charge reconciles with the posted REVENUE_ROOM journal.
  expect(metricOf(report, 'stay_revenue_journal')?.value).toBe('300000');
  expect(metricOf(report, 'stay_revenue_charges')?.value).toBe('300000');
  expect(metricOf(report, 'stay_revenue_unattributed')?.value).toBe('0');
  expect(metricOf(report, 'stay_revenue_delta')?.value).toBe('0');
  expect(metricOf(report, 'stay_revenue_reconciled')?.value).toBe('true');

  // Separate denominators per resource type: the stay is one ROOM night, and
  // no BED metric is manufactured for a property without bed stays.
  expect(metricOf(report, 'stay_revenue_type.ROOM')?.value).toBe('300000');
  expect(metricOf(report, 'resource_nights_paid.ROOM')?.value).toBe('1');
  const adr = metricOf(report, 'adr.ROOM');
  expect(adr?.value).toBe('300000');
  expect(adr?.numerator).toBe('300000');
  expect(adr?.denominator).toBe('1');
  expect(adr?.basis).toBe('POSTED_CHARGES');
  const revpar = metricOf(report, 'revpar_physical.ROOM');
  expect(revpar?.value).toBe('300000');
  expect(revpar?.denominator).toBe('1');
  expect(metricOf(report, 'revpar_operational.ROOM')?.value).toBe('300000');
  expect(metricOf(report, 'adr.BED')).toBeUndefined();
  expect(metricOf(report, 'revpar_physical.BED')).toBeUndefined();
  expect(report.rows.map((row) => row.label)).toEqual(['ROOM']);

  // A period with no eligible paid nights declares a null ADR instead of a
  // misleading zero, while the physical RevPAR keeps its own denominator.
  const empty = await readReport(main.property.id, {
    kind: 'ADR_REVPAR',
    period: { date_from: addDays(10), date_to: addDays(11) },
    currency: 'IDR',
  });
  expect(empty.status).toBe(200);
  expect(metricOf(empty.body, 'stay_revenue_charges')?.value).toBe('0');
  const emptyAdr = metricOf(empty.body, 'adr.ROOM');
  expect(emptyAdr?.value).toBe(null);
  expect(emptyAdr?.zero_denominator).toBe(true);
  expect(emptyAdr?.null_reason).toBe('DENOMINATOR_ZERO');
  const emptyRevpar = metricOf(empty.body, 'revpar_physical.ROOM');
  expect(emptyRevpar?.value).toBe('0');
  expect(emptyRevpar?.denominator).toBe('1');

  // This kind is financial: the operational-only member stays forbidden.
  const forbidden = await readReport(
    main.property.id,
    {
      kind: 'ADR_REVPAR',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    member.context,
  );
  expect(forbidden.status).toBe(403);
});

test('tax totals reconcile between journal and charges', async () => {
  const response = await readReport(main.property.id, {
    kind: 'TAX',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
  });
  expect(response.status).toBe(200);
  expect(metricOf(response.body, 'tax_journal')?.value).toBe('30000');
  expect(metricOf(response.body, 'tax_from_charges')?.value).toBe('30000');
  expect(metricOf(response.body, 'tax_delta')?.value).toBe('0');
  expect(metricOf(response.body, 'tax_journal_reconciled')?.value).toBe('true');
  const journalTax = await dbOne(
    `select coalesce(sum(l."credit" - l."debit"), 0)::text as "total"
       from "journal_line" l join "journal" j on j."id" = l."journal_id"
      where j."property_id" = $1 and j."state" = 'POSTED'
        and l."account_code" = 'TAX_PAYABLE'`,
    [main.property.id],
  );
  expect(metricOf(response.body, 'tax_journal')?.value).toBe(
    String(Number(journalTax.total)),
  );
});

test('IDR and USD never mix and there is no implicit conversion', async () => {
  const usd = await readReport(main.property.id, {
    kind: 'REVENUE',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'USD',
  });
  expect(usd.status).toBe(200);
  expect(metricOf(usd.body, 'revenue_total')?.value).toBe('0');
  expect(usd.body.currency).toBe('USD');

  const missing = await readReport(main.property.id, {
    kind: 'REVENUE',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
  });
  expect(missing.status).toBe(400);
  expect(missing.body.code).toBe('INVALID_REQUEST');
  expect(missing.body.details.reason).toBe('currency_required');
});

test('settlements report collections and cashier variance separately from revenue', async () => {
  const response = await readReport(main.property.id, {
    kind: 'SETTLEMENTS',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
  });
  expect(response.status).toBe(200);
  expect(metricOf(response.body, 'payments_cash_succeeded')?.value).toBe(
    '100000',
  );
  expect(metricOf(response.body, 'payments_succeeded_total')?.value).toBe(
    '325000',
  );
  expect(metricOf(response.body, 'net_collected')?.value).toBe('325000');
  expect(metricOf(response.body, 'payments_are_not_revenue')?.value).toBe(
    'true',
  );

  const revenue = await readReport(main.property.id, {
    kind: 'REVENUE',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
  });
  expect(metricOf(revenue.body, 'revenue_total')?.value).toBe('300000');
});

test('channel performance keeps gross, commission and net apart', async () => {
  const response = await readReport(main.property.id, {
    kind: 'CHANNEL_PERFORMANCE',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
  });
  expect(response.status).toBe(200);
  expect(metricOf(response.body, 'channel_gross.tiket-com')?.value).toBe(
    '250000',
  );
  expect(metricOf(response.body, 'channel_commission.tiket-com')?.value).toBe(
    '25000',
  );
  expect(metricOf(response.body, 'channel_net.tiket-com')?.value).toBe(
    '225000',
  );
  expect(metricOf(response.body, 'channel_bookings.tiket-com')?.value).toBe(
    '1',
  );
  expect(metricOf(response.body, 'channel_gross_total')?.value).toBe('250000');
  expect(metricOf(response.body, 'channel_commission_total')?.value).toBe(
    '25000',
  );
  expect(metricOf(response.body, 'channel_net_total')?.value).toBe('225000');
});

test('multi-property portfolio is homogeneous, authorized and fail-closed', async () => {
  const response = await readTenantReport({
    kind: 'PORTFOLIO',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
  });
  expect(response.status).toBe(200);
  expect(response.body.kind).toBe('PORTFOLIO');
  // Suites share one database in `--runInBand`, so the tenant-wide portfolio is
  // asserted for internal consistency and per-property values instead of an
  // absolute total that other suites' seeded revenue would inflate.
  const perProperty = (response.body.metrics ?? []).filter((entry) =>
    String(entry.key).startsWith('portfolio_revenue.'),
  );
  expect(
    Number(metricOf(response.body, 'portfolio_revenue_total')?.value),
  ).toBe(perProperty.reduce((sum, entry) => sum + Number(entry.value), 0));
  expect(Number(metricOf(response.body, 'portfolio_properties')?.value)).toBe(
    perProperty.length,
  );
  expect(metricOf(response.body, 'portfolio_single_currency')?.value).toBe(
    'IDR',
  );
  expect(
    metricOf(response.body, `portfolio_revenue.${main.property.code}`)?.value,
  ).toBe('300000');
  expect(
    metricOf(response.body, `portfolio_revenue.${portfolioB.property.code}`)
      ?.value,
  ).toBe('50000');

  const narrowed = await readTenantReport({
    kind: 'PORTFOLIO',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
    property_ids: [main.property.id],
  });
  expect(narrowed.status).toBe(200);
  expect(metricOf(narrowed.body, 'portfolio_revenue_total')?.value).toBe(
    '300000',
  );
  expect(metricOf(narrowed.body, 'portfolio_properties')?.value).toBe('1');

  const unknown = await readTenantReport({
    kind: 'PORTFOLIO',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
    property_ids: ['00000000-0000-4000-8000-000000000000'],
  });
  expect(unknown.status).toBe(404);

  // A property of another tenant can never be reached through scope inputs.
  const foreign = await apiRequest(
    ownerB.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: `P11F-FOREIGN-${runId}`,
        name: 'foreign',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(foreign.status).toBe(403);
  const ownerBProperty = await apiRequest(
    ownerB.context,
    'GET',
    `/tenants/${ownerB.session.body.session.active_tenant_id}/properties`,
  );
  expect(ownerBProperty.status).toBe(200);

  const wrongKind = await readTenantReport({
    kind: 'REVENUE',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
  });
  expect(wrongKind.status).toBe(400);

  // Property-level reads reject extra scope fields instead of widening them.
  const widened = await readReport(main.property.id, {
    kind: 'REVENUE',
    period: {
      date_from: main.openDay,
      date_to: addBusinessDays(main.openDay, 1),
    },
    currency: 'IDR',
    property_ids: [portfolioB.property.id],
  });
  expect(widened.status).toBe(400);
  expect(widened.body.code).toBe('INVALID_REQUEST');
});

test('financial reports respect report.financial.view and stay read-only', async () => {
  const memberAttempt = await readReport(
    main.property.id,
    {
      kind: 'REVENUE',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    member.context,
  );
  expect(memberAttempt.status).toBe(403);

  const auditorAttempt = await readReport(
    main.property.id,
    {
      kind: 'REVENUE',
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    },
    auditor.context,
  );
  expect(auditorAttempt.status).toBe(200);

  const before = await dbOne(
    `select count(*)::int as "count" from "journal" where "property_id" = $1`,
    [main.property.id],
  );
  for (const kind of ['REVENUE', 'TAX', 'SETTLEMENTS', 'CHANNEL_PERFORMANCE']) {
    const response = await readReport(main.property.id, {
      kind,
      period: {
        date_from: main.openDay,
        date_to: addBusinessDays(main.openDay, 1),
      },
      currency: 'IDR',
    });
    expect(response.status).toBe(200);
  }
  const after = await dbOne(
    `select count(*)::int as "count" from "journal" where "property_id" = $1`,
    [main.property.id],
  );
  expect(after.count).toBe(before.count);
  expect(owner).toBeTruthy();
});

test('F-RVW11-03: refunds settle by the property-local day, not UTC', async () => {
  const payment = await recordPayment(
    main.property.id,
    {
      folio_id: folio.id,
      method: 'CASH',
      money: { amount: '50000', currency: 'IDR' },
      business_date: main.openDay,
      external_reference: `tz-${runId}`,
      source_ref: `p11f-tz-${runId}`,
    },
    'tz',
  );
  expect(payment.status).toBe(200);

  const localDay = addDays(-1);
  // 18:30Z on the previous UTC day is 01:30 in Asia/Jakarta on `localDay`.
  const utcStamp = `${addDays(-2)}T18:30:00Z`;
  await dbRows(
    `insert into "folio_refund"
       ("tenant_id", "property_id", "payment_id", "folio_id", "currency",
        "amount", "reason", "state", "created_at", "updated_at")
     values ($1, $2, $3, $4, 'IDR', 10000, 'timezone probe', 'RESERVED',
             $5::timestamptz, $5::timestamptz)`,
    [tenantA, main.property.id, payment.body.id, folio.id, utcStamp],
  );

  const local = await readReport(main.property.id, {
    kind: 'SETTLEMENTS',
    period: { date_from: localDay, date_to: addDays(0) },
    currency: 'IDR',
  });
  expect(local.status).toBe(200);
  expect(metricOf(local.body, 'refunds_reserved')?.value).toBe('10000');

  const utcDay = await readReport(main.property.id, {
    kind: 'SETTLEMENTS',
    period: { date_from: addDays(-2), date_to: addDays(-1) },
    currency: 'IDR',
  });
  expect(utcDay.status).toBe(200);
  expect(metricOf(utcDay.body, 'refunds_reserved')).toBeUndefined();
});
