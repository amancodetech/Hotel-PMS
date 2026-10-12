import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  closeSessions,
  loginAs,
  startApi,
  stopApi,
  withOwner,
  withRuntimeRole,
  withTestRole,
} from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
const tenantB = process.env.IDENTITY_TENANT_B;

const seed = 20260917;
const runId = `P08B${seed}`;
const key = (name) => `p08-02-${name}-${runId}`;

let admin;
let owner;
let auditor;
let member;
let property;
let openDay;
let guestFolio;
let payerFolioOne;
let payerFolioTwo;
let roomCharge;
let miscCharge;
let schedule;
let entitlement;
let deposit;

function base() {
  return `/tenants/${tenantA}/properties/${property.id}`;
}

function money(value) {
  return String(Number(value));
}

function addIsoDays(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function dbRows(sql, params = []) {
  return withOwner(async (client) => {
    const result = await client.query(sql, params);
    return result.rows;
  });
}

async function dbOne(sql, params = []) {
  const rows = await dbRows(sql, params);
  return rows[0];
}

async function openFolio(body, name) {
  const response = await apiRequest(admin.context, 'POST', `${base()}/folios`, {
    body,
    headers: { 'idempotency-key': key(name) },
  });
  expect(response.status).toBe(200);
  return response.body.folio;
}

async function postCharge(body, name) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges`,
    {
      body,
      headers: { 'idempotency-key': key(name) },
    },
  );
  return response;
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  owner = await loginAs('owner-a');
  auditor = await loginAs('auditor-a');
  member = await loginAs('member-a');
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: `P08-B-${runId}`,
        name: `P08-02 ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  const day = await apiRequest(
    admin.context,
    'GET',
    `${base()}/finance/business-day`,
  );
  expect(day.status).toBe(200);
  openDay = day.body.date;
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P08-02 folios respect folio.read/folio.charge and open with a payer and currency', async () => {
  const forbidden = await apiRequest(
    member.context,
    'POST',
    `${base()}/folios`,
    {
      body: { payer_label: 'X', currency: 'IDR' },
      headers: { 'idempotency-key': key('member') },
    },
  );
  expect(forbidden.status).toBe(403);
  const readForbidden = await apiRequest(
    member.context,
    'GET',
    `${base()}/folios`,
  );
  expect(readForbidden.status).toBe(403);
  const readAllowed = await apiRequest(
    auditor.context,
    'GET',
    `${base()}/folios`,
  );
  expect(readAllowed.status).toBe(200);
  expect(readAllowed.body.folios).toEqual([]);

  guestFolio = await openFolio(
    { payer_label: `Guest ${runId}`, currency: 'IDR' },
    'guest',
  );
  payerFolioOne = await openFolio(
    { kind: 'COMPANY', payer_label: `Company One ${runId}`, currency: 'IDR' },
    'company-one',
  );
  payerFolioTwo = await openFolio(
    { kind: 'COMPANY', payer_label: `Company Two ${runId}`, currency: 'IDR' },
    'company-two',
  );
  const list = await apiRequest(owner.context, 'GET', `${base()}/folios`);
  expect(list.status).toBe(200);
  expect(list.body.folios).toHaveLength(3);
  const detail = await apiRequest(
    owner.context,
    'GET',
    `${base()}/folios/${guestFolio.id}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body.charges).toEqual([]);
  expect(detail.body.totals.balance_due).toBe('0');
});

test('P08-02 posting a charge captures its tax policy and rejects a duplicate source', async () => {
  const response = await postCharge(
    {
      folio_id: guestFolio.id,
      business_date: openDay,
      money: { amount: '100000', currency: 'IDR' },
      tax_money: { amount: '11000', currency: 'IDR' },
      tax_policy: { rate: '0.11', mode: 'EXCLUSIVE', source: 'synthetic' },
      account_code: 'REVENUE_ROOM',
      source_ref: `room-${runId}`,
      memo: 'room charge',
    },
    'charge-room',
  );
  expect(response.status).toBe(200);
  roomCharge = response.body;
  expect(roomCharge.net_amount).toBe('100000');
  expect(roomCharge.tax_amount).toBe('11000');
  expect(roomCharge.tax_policy).toMatchObject({
    rate: '0.11',
    mode: 'EXCLUSIVE',
  });
  expect(roomCharge.source_ref).toBe(`room-${runId}`);

  const duplicate = await postCharge(
    {
      folio_id: guestFolio.id,
      business_date: openDay,
      money: { amount: '999999', currency: 'IDR' },
      source_ref: `room-${runId}`,
    },
    'charge-room-duplicate',
  );
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe('SOURCE_ALREADY_POSTED');

  const journal = await dbOne(
    `select j."id", j."total_debit", j."total_credit",
            count(l."id")::int as "lines",
            sum(l."debit")::text as "debits", sum(l."credit")::text as "credits"
       from "journal" j join "journal_line" l on l."journal_id" = j."id"
      where j."id" = $1
      group by j."id"`,
    [roomCharge.journal_id],
  );
  expect(money(journal.total_debit)).toBe('111000');
  expect(money(journal.total_credit)).toBe('111000');
  expect(money(journal.debits)).toBe(money(journal.credits));
  const revenueLines = await dbOne(
    `select count(*)::int as "count" from "journal_line"
      where "journal_id" = $1 and "account_code" = 'REVENUE_ROOM'`,
    [roomCharge.journal_id],
  );
  expect(revenueLines.count).toBe(1);
  const taxLines = await dbOne(
    `select count(*)::int as "count" from "journal_line"
      where "journal_id" = $1 and "account_code" = 'TAX_PAYABLE'`,
    [roomCharge.journal_id],
  );
  expect(taxLines.count).toBe(1);
});

test('P08-02 posted charges are immutable and a tax-policy change never rewrites them (AT-F05/AT-R04)', async () => {
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(
        `update "folio_charge" set "tax_amount" = 0 where "id" = $1`,
        [roomCharge.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });
  const later = await postCharge(
    {
      folio_id: guestFolio.id,
      business_date: openDay,
      money: { amount: '50000', currency: 'IDR' },
      tax_money: { amount: '10000', currency: 'IDR' },
      tax_policy: {
        rate: '0.20',
        mode: 'EXCLUSIVE',
        source: 'synthetic-updated',
      },
      account_code: 'REVENUE_OTHER',
      source_ref: `other-${runId}`,
    },
    'charge-other',
  );
  expect(later.status).toBe(200);
  expect(later.body.tax_policy.rate).toBe('0.20');
  const reread = await dbOne(
    `select "tax_policy", "tax_amount" from "folio_charge" where "id" = $1`,
    [roomCharge.id],
  );
  expect(reread.tax_policy.rate).toBe('0.11');
  expect(money(reread.tax_amount)).toBe('11000');
});

test('P08-02 routing a charge across two payers never duplicates the revenue (AT-F08)', async () => {
  const before = await dbOne(
    `select count(*)::int as "count" from "journal_line"
      where "account_code" = 'REVENUE_ROOM'`,
  );
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${roomCharge.id}/allocations`,
    {
      body: {
        allocations: [
          {
            payer_folio_id: payerFolioOne.id,
            money: { amount: '60000', currency: 'IDR' },
          },
          {
            payer_folio_id: payerFolioTwo.id,
            money: { amount: '51000', currency: 'IDR' },
          },
        ],
      },
      headers: { 'idempotency-key': key('route-room') },
    },
  );
  expect(response.status).toBe(200);
  expect(response.body.allocations).toHaveLength(2);
  const after = await dbOne(
    `select count(*)::int as "count" from "journal_line"
      where "account_code" = 'REVENUE_ROOM'`,
  );
  expect(after.count).toBe(before.count);
  const routing = await dbOne(
    `select j."total_debit", j."total_credit" from "journal" j where j."id" = $1`,
    [response.body.journal_id],
  );
  expect(money(routing.total_debit)).toBe('111000');
  expect(money(routing.total_credit)).toBe('111000');
  const routingAccounts = await dbRows(
    `select "account_code", "debit"::text as "debit", "credit"::text as "credit"
       from "journal_line" where "journal_id" = $1 order by "line_no"`,
    [response.body.journal_id],
  );
  expect(
    routingAccounts.filter((row) => row.account_code === 'AR_GUEST'),
  ).toHaveLength(2);
  expect(
    routingAccounts.filter((row) => row.account_code === 'FOLIO_GUEST'),
  ).toHaveLength(1);
  expect(
    routingAccounts.filter((row) => row.account_code.startsWith('REVENUE')),
  ).toHaveLength(0);

  const over = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${roomCharge.id}/allocations`,
    {
      body: {
        allocations: [
          {
            payer_folio_id: payerFolioOne.id,
            money: { amount: '1', currency: 'IDR' },
          },
        ],
      },
      headers: { 'idempotency-key': key('route-over') },
    },
  );
  expect(over.status).toBe(400);
  expect(over.body.details.reason).toBe('allocations_exceed_charge');
  const sameFolio = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${roomCharge.id}/allocations`,
    {
      body: {
        allocations: [
          {
            payer_folio_id: guestFolio.id,
            money: { amount: '1', currency: 'IDR' },
          },
        ],
      },
      headers: { 'idempotency-key': key('route-same') },
    },
  );
  expect(sameFolio.status).toBe(400);
});

test('P08-02 recurring charges post each period exactly once (AT-F10)', async () => {
  const created = await apiRequest(
    admin.context,
    'POST',
    `${base()}/folios/${guestFolio.id}/charge-schedules`,
    {
      body: {
        code: `WEEKLY-${runId}`,
        account_code: 'REVENUE_OTHER',
        quantity: 1,
        money: { amount: '50000', currency: 'IDR' },
        interval: 'WEEK',
        starts_on: openDay,
        ends_on: addIsoDays(openDay, 7),
      },
      headers: { 'idempotency-key': key('schedule') },
    },
  );
  expect(created.status).toBe(200);
  schedule = created.body;
  expect(schedule.interval).toBe('WEEK');
  expect(schedule.state).toBe('ACTIVE');

  const first = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charge-schedules/${schedule.id}/post`,
    {
      body: { business_date: openDay },
      headers: { 'idempotency-key': key('schedule-post-1') },
    },
  );
  expect(first.status).toBe(200);
  expect(first.body.source_ref).toBe(`schedule:${schedule.id}:${openDay}`);
  expect(first.body.schedule_state).toBe('ACTIVE');
  expect(first.body.net_amount).toBe('50000');

  const replay = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charge-schedules/${schedule.id}/post`,
    {
      body: { business_date: openDay },
      headers: { 'idempotency-key': key('schedule-post-1') },
    },
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  const again = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charge-schedules/${schedule.id}/post`,
    {
      body: { business_date: openDay, period_start: openDay },
      headers: { 'idempotency-key': key('schedule-post-replay') },
    },
  );
  expect(again.status).toBe(400);
  expect(again.body.details.reason).toBe('period_out_of_order');
  const count = await dbOne(
    `select count(*)::int as "count" from "folio_charge"
      where "source_kind" = 'ACCRUAL'
        and "source_ref" like $1`,
    [`schedule:${schedule.id}:%`],
  );
  expect(count.count).toBe(1);

  const wrongPeriod = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charge-schedules/${schedule.id}/post`,
    {
      body: { business_date: openDay, period_start: addIsoDays(openDay, 3) },
      headers: { 'idempotency-key': key('schedule-post-wrong') },
    },
  );
  expect(wrongPeriod.status).toBe(400);
  expect(wrongPeriod.body.details.reason).toBe('period_out_of_order');

  const second = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charge-schedules/${schedule.id}/post`,
    {
      body: {
        business_date: openDay,
        period_start: addIsoDays(openDay, 7),
      },
      headers: { 'idempotency-key': key('schedule-post-2') },
    },
  );
  expect(second.status).toBe(200);
  expect(second.body.schedule_state).toBe('STOPPED');
  const total = await dbOne(
    `select count(*)::int as "count" from "folio_charge"
      where "source_kind" = 'ACCRUAL' and "source_ref" like $1`,
    [`schedule:${schedule.id}:%`],
  );
  expect(total.count).toBe(2);
});

test('P08-02 package consumption is idempotent per source and cannot exceed the entitlement (AT-O05)', async () => {
  const created = await apiRequest(
    admin.context,
    'POST',
    `${base()}/folios/${guestFolio.id}/packages`,
    {
      body: {
        code: `SPA-${runId}`,
        account_code: 'REVENUE_OTHER',
        quantity_total: 3,
        unit_money: { amount: '20000', currency: 'IDR' },
      },
      headers: { 'idempotency-key': key('package') },
    },
  );
  expect(created.status).toBe(200);
  entitlement = created.body;
  const first = await apiRequest(
    admin.context,
    'POST',
    `${base()}/package-entitlements/${entitlement.id}/consumptions`,
    {
      body: {
        quantity: 1,
        source_ref: `spa-${runId}-1`,
        business_date: openDay,
      },
      headers: { 'idempotency-key': key('consume-1') },
    },
  );
  expect(first.status).toBe(200);
  expect(first.body.quantity_consumed).toBe(1);
  expect(first.body.charge.net_amount).toBe('20000');
  const duplicate = await apiRequest(
    admin.context,
    'POST',
    `${base()}/package-entitlements/${entitlement.id}/consumptions`,
    {
      body: {
        quantity: 1,
        source_ref: `spa-${runId}-1`,
        business_date: openDay,
      },
      headers: { 'idempotency-key': key('consume-1-again') },
    },
  );
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe('CONFLICT');
  expect(duplicate.body.details.reason).toBe('duplicate_consumption');
  const rest = await apiRequest(
    admin.context,
    'POST',
    `${base()}/package-entitlements/${entitlement.id}/consumptions`,
    {
      body: {
        quantity: 2,
        source_ref: `spa-${runId}-2`,
        business_date: openDay,
      },
      headers: { 'idempotency-key': key('consume-2') },
    },
  );
  expect(rest.status).toBe(200);
  expect(rest.body.state).toBe('EXHAUSTED');
  const beyond = await apiRequest(
    admin.context,
    'POST',
    `${base()}/package-entitlements/${entitlement.id}/consumptions`,
    {
      body: {
        quantity: 1,
        source_ref: `spa-${runId}-3`,
        business_date: openDay,
      },
      headers: { 'idempotency-key': key('consume-3') },
    },
  );
  expect(beyond.status).toBe(409);
  const charges = await dbOne(
    `select count(*)::int as "count", coalesce(sum("net_amount"), 0)::text as "total"
       from "folio_charge" where "source_kind" = 'PACKAGE' and "source_ref" like $1`,
    [`package:${entitlement.id}:%`],
  );
  expect(charges.count).toBe(2);
  expect(money(charges.total)).toBe('60000');
});

test('P08-02 a damage deposit is a liability, applied and released with reference, never revenue', async () => {
  const collected = await apiRequest(
    admin.context,
    'POST',
    `${base()}/folios/${guestFolio.id}/deposits`,
    {
      body: {
        kind: 'DAMAGE',
        method: 'CASH',
        money: { amount: '500000', currency: 'IDR' },
        business_date: openDay,
        external_reference: `cash-receipt-${runId}`,
        source_ref: `damage-${runId}`,
      },
      headers: { 'idempotency-key': key('deposit') },
    },
  );
  expect(collected.status).toBe(200);
  deposit = collected.body;
  const depositJournal = await dbRows(
    `select "account_code", "debit"::text as "debit", "credit"::text as "credit"
       from "journal_line" where "journal_id" = $1 order by "line_no"`,
    [deposit.journal_id],
  );
  expect(
    depositJournal.map((row) => ({
      account_code: row.account_code,
      debit: money(row.debit),
      credit: money(row.credit),
    })),
  ).toEqual([
    { account_code: 'CASH', debit: '500000', credit: '0' },
    { account_code: 'DAMAGE_DEPOSIT_LIABILITY', debit: '0', credit: '500000' },
  ]);
  const misc = await postCharge(
    {
      folio_id: guestFolio.id,
      business_date: openDay,
      money: { amount: '111000', currency: 'IDR' },
      account_code: 'REVENUE_OTHER',
      source_ref: `misc-${runId}`,
    },
    'charge-misc',
  );
  expect(misc.status).toBe(200);
  miscCharge = misc.body;
  const revenueBefore = await dbOne(
    `select count(*)::int as "count" from "journal_line"
      where "account_code" like 'REVENUE%'`,
  );

  const applied = await apiRequest(
    admin.context,
    'POST',
    `${base()}/deposits/${deposit.id}/applications`,
    {
      body: {
        charge_id: miscCharge.id,
        money: { amount: '111000', currency: 'IDR' },
        business_date: openDay,
        reason: 'damage settlement per signed report',
      },
      headers: { 'idempotency-key': key('deposit-apply') },
    },
  );
  expect(applied.status).toBe(200);
  expect(applied.body.held_remaining).toBe('389000');
  const appliedJournal = await dbRows(
    `select "account_code", "debit"::text as "debit", "credit"::text as "credit"
       from "journal_line" where "journal_id" = $1 order by "line_no"`,
    [applied.body.journal_id],
  );
  expect(
    appliedJournal.map((row) => ({
      account_code: row.account_code,
      debit: money(row.debit),
      credit: money(row.credit),
    })),
  ).toEqual([
    { account_code: 'DAMAGE_DEPOSIT_LIABILITY', debit: '111000', credit: '0' },
    { account_code: 'FOLIO_GUEST', debit: '0', credit: '111000' },
  ]);

  const released = await apiRequest(
    admin.context,
    'POST',
    `${base()}/deposits/${deposit.id}/releases`,
    {
      body: {
        money: { amount: '200000', currency: 'IDR' },
        business_date: openDay,
        reason: 'damage deposit release',
      },
      headers: { 'idempotency-key': key('deposit-release') },
    },
  );
  expect(released.status).toBe(200);
  expect(released.body.held_remaining).toBe('189000');
  const overRelease = await apiRequest(
    admin.context,
    'POST',
    `${base()}/deposits/${deposit.id}/releases`,
    {
      body: {
        money: { amount: '300000', currency: 'IDR' },
        business_date: openDay,
        reason: 'too much',
      },
      headers: { 'idempotency-key': key('deposit-over') },
    },
  );
  expect(overRelease.status).toBe(400);
  const revenueAfter = await dbOne(
    `select count(*)::int as "count" from "journal_line"
      where "account_code" like 'REVENUE%'`,
  );
  expect(revenueAfter.count).toBe(revenueBefore.count);
  const duplicateDeposit = await apiRequest(
    admin.context,
    'POST',
    `${base()}/folios/${guestFolio.id}/deposits`,
    {
      body: {
        kind: 'DAMAGE',
        method: 'CASH',
        money: { amount: '1000', currency: 'IDR' },
        business_date: openDay,
        external_reference: `cash-receipt-2-${runId}`,
        source_ref: `damage-${runId}`,
      },
      headers: { 'idempotency-key': key('deposit-duplicate') },
    },
  );
  expect(duplicateDeposit.status).toBe(409);
  expect(duplicateDeposit.body.code).toBe('SOURCE_ALREADY_POSTED');
});

test('P08-02 folio totals reconcile charges, routing and deposit applications', async () => {
  const detail = await apiRequest(
    owner.context,
    'GET',
    `${base()}/folios/${guestFolio.id}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body.totals.charges_total).toBe('442000');
  expect(detail.body.totals.routed_out).toBe('111000');
  expect(detail.body.totals.deposits_held).toBe('189000');
  expect(detail.body.totals.deposits_applied).toBe('111000');
  expect(detail.body.totals.balance_due).toBe('220000');
  expect(detail.body.entitlements[0].state).toBe('EXHAUSTED');
  expect(detail.body.schedules[0].state).toBe('STOPPED');
  const payerOne = await apiRequest(
    owner.context,
    'GET',
    `${base()}/folios/${payerFolioOne.id}`,
  );
  expect(payerOne.body.totals.routed_in).toBe('60000');
  expect(payerOne.body.totals.balance_due).toBe('60000');
});

test('P08-02 charges outside an open business day are rejected', async () => {
  const closedDay = new Date(`${openDay}T00:00:00Z`);
  closedDay.setUTCDate(closedDay.getUTCDate() - 1);
  const response = await postCharge(
    {
      folio_id: guestFolio.id,
      business_date: closedDay.toISOString().slice(0, 10),
      money: { amount: '1000', currency: 'IDR' },
      source_ref: `old-${runId}`,
    },
    'charge-closed',
  );
  expect(response.status).toBe(409);
  expect(['BUSINESS_DAY_CLOSED', 'BUSINESS_DAY_NOT_OPEN']).toContain(
    response.body.code,
  );
});

test('P08-02 the database enforces allocation and consumption limits at commit', async () => {
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await client.query(
      `insert into "payer_allocation"
         ("tenant_id", "property_id", "charge_id", "payer_folio_id", "amount", "journal_id")
       values ($1, $2, $3, $4, 1, $5)`,
      [
        tenantA,
        property.id,
        roomCharge.id,
        payerFolioOne.id,
        roomCharge.journal_id,
      ],
    );
    await expect(client.query('commit')).rejects.toMatchObject({
      code: '23514',
    });
    await client.query('rollback');
  });
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    const journal = await client.query(
      `insert into "journal"
         ("tenant_id", "property_id", "business_date", "currency", "source_type",
          "total_debit", "total_credit")
       values ($1, $2, $3, 'IDR', 'DB_TEST', 10, 10)
       returning "id"`,
      [tenantA, property.id, openDay],
    );
    const charge = await client.query(
      `insert into "folio_charge"
         ("tenant_id", "property_id", "folio_id", "business_date", "currency",
          "kind", "account_code", "net_amount", "tax_amount", "source_kind",
          "source_ref", "journal_id")
       values ($1, $2, $3, $4, 'IDR', 'MANUAL', 'REVENUE_OTHER', 10, 0,
               'MANUAL', $5, $6)
       returning "id"`,
      [
        tenantA,
        property.id,
        guestFolio.id,
        openDay,
        `db-${runId}`,
        journal.rows[0].id,
      ],
    );
    const lines = await client.query(
      `insert into "journal_line"
         ("tenant_id", "property_id", "journal_id", "line_no", "account_code", "debit", "credit")
       values ($1, $2, $3, 1, 'FOLIO_GUEST', 10, 0),
              ($1, $2, $3, 2, 'REVENUE_OTHER', 0, 10)`,
      [tenantA, property.id, journal.rows[0].id],
    );
    void lines;
    await client.query(
      `insert into "package_consumption"
         ("tenant_id", "property_id", "entitlement_id", "quantity", "source_kind", "source_ref", "charge_id")
       values ($1, $2, $3, 100, 'CONSUMPTION', 'over', $4)`,
      [tenantA, property.id, entitlement.id, charge.rows[0].id],
    );
    await expect(client.query('commit')).rejects.toMatchObject({
      code: '23514',
    });
    await client.query('rollback');
  });
});

test('P08-02 finance tables force RLS and least privilege for runtime roles', async () => {
  const inventory = await withOwner(async (client) => {
    const tables = await client.query(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('folio', 'folio_charge', 'payer_allocation',
                           'charge_schedule', 'package_entitlement',
                           'package_consumption', 'folio_deposit', 'deposit_application')
    `);
    const privileges = await client.query(`
      select
        has_table_privilege('hotel_api', 'folio_charge', 'insert') as api_charge_insert,
        has_table_privilege('hotel_api', 'folio_charge', 'update') as api_charge_update,
        has_table_privilege('hotel_api', 'folio_deposit', 'delete') as api_deposit_delete,
        has_table_privilege('hotel_worker', 'folio', 'select') as worker_select,
        has_table_privilege('hotel_worker', 'folio_deposit', 'insert') as worker_insert
    `);
    return { tables: tables.rows, privileges: privileges.rows[0] };
  });
  expect(inventory.tables).toHaveLength(8);
  for (const row of inventory.tables) {
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  }
  expect(inventory.privileges.api_charge_insert).toBe(true);
  expect(inventory.privileges.api_charge_update).toBe(false);
  expect(inventory.privileges.api_deposit_delete).toBe(false);
  expect(inventory.privileges.worker_select).toBe(true);
  expect(inventory.privileges.worker_insert).toBe(false);

  const hidden = await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantB,
    ]);
    const result = await client.query(
      `select count(*)::int as "count" from "folio" where "id" = $1`,
      [guestFolio.id],
    );
    await client.query('rollback');
    return result.rows[0].count;
  });
  expect(hidden).toBe(0);
});

test('P08-02 every journal in the property is balanced with matching totals', async () => {
  const unbalanced = await dbRows(
    `select j."id"
       from "journal" j
       left join "journal_line" l on l."journal_id" = j."id"
      where j."tenant_id" = $1 and j."property_id" = $2
      group by j."id", j."total_debit", j."total_credit"
     having coalesce(sum(l."debit"), 0) <> coalesce(sum(l."credit"), 0)
         or coalesce(sum(l."debit"), 0) <> j."total_debit"
         or coalesce(sum(l."credit"), 0) <> j."total_credit"`,
    [tenantA, property.id],
  );
  expect(unbalanced).toEqual([]);
  const empty = await dbOne(
    `select count(*)::int as "count" from "journal"
      where "tenant_id" = $1 and "property_id" = $2`,
    [tenantA, property.id],
  );
  expect(empty.count).toBeGreaterThanOrEqual(7);
});
