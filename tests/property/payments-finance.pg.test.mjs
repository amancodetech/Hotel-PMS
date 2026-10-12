import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  closeSessions,
  loginAs,
  startApi,
  stopApi,
  withOwner,
  withTestRole,
} from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;

const seed = 20260918;
const runId = `P08C${seed}`;
const key = (name) => `p08-03-${name}-${runId}`;

let admin;
let owner;
let auditor;
let member;
let property;
let openDay;
let folio;
let cashPayment;
let otaPayment;
let unknownPayment;

function base() {
  return `/tenants/${tenantA}/properties/${property.id}`;
}

function money(value) {
  return String(Number(value));
}

async function dbOne(sql, params = []) {
  return withOwner(async (client) => {
    const result = await client.query(sql, params);
    return result.rows[0];
  });
}

async function dbRows(sql, params = []) {
  return withOwner(async (client) => {
    const result = await client.query(sql, params);
    return result.rows;
  });
}

async function recordPayment(body, name) {
  return apiRequest(admin.context, 'POST', `${base()}/payments`, {
    body,
    headers: { 'idempotency-key': key(name) },
  });
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
        code: `P08-C-${runId}`,
        name: `P08-03 ${runId}`,
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
  const folioResponse = await apiRequest(
    admin.context,
    'POST',
    `${base()}/folios`,
    {
      body: { payer_label: `Guest ${runId}`, currency: 'IDR' },
      headers: { 'idempotency-key': key('folio') },
    },
  );
  expect(folioResponse.status).toBe(200);
  folio = folioResponse.body.folio;
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P08-03 payments honour payment.record for writes and folio.read for reads', async () => {
  const forbidden = await apiRequest(
    member.context,
    'POST',
    `${base()}/payments`,
    {
      body: {
        folio_id: folio.id,
        method: 'CASH',
        money: { amount: '1000', currency: 'IDR' },
        business_date: openDay,
        external_reference: 'x',
        source_ref: `member-${runId}`,
      },
      headers: { 'idempotency-key': key('member') },
    },
  );
  expect(forbidden.status).toBe(403);
  const read = await apiRequest(auditor.context, 'GET', `${base()}/payments`);
  expect(read.status).toBe(200);
  expect(read.body.payments).toEqual([]);
});

test('P08-03 a cash collection posts one balanced journal and rejects a duplicate source (AT-F01)', async () => {
  const response = await recordPayment(
    {
      folio_id: folio.id,
      method: 'CASH',
      money: { amount: '100000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `cash-${runId}`,
      source_ref: `cash-${runId}`,
    },
    'cash',
  );
  expect(response.status).toBe(200);
  cashPayment = response.body;
  expect(cashPayment.state).toBe('SUCCEEDED');
  expect(cashPayment.amount).toBe('100000');

  const detail = await apiRequest(
    auditor.context,
    'GET',
    `${base()}/payments/${cashPayment.id}`,
  );
  expect(detail.status).toBe(200);
  expect(
    detail.body.journal_lines.map((line) => ({
      account_code: line.account_code,
      debit: money(line.debit),
      credit: money(line.credit),
    })),
  ).toEqual([
    { account_code: 'CASH', debit: '100000', credit: '0' },
    { account_code: 'FOLIO_GUEST', debit: '0', credit: '100000' },
  ]);

  const duplicate = await recordPayment(
    {
      folio_id: folio.id,
      method: 'CASH',
      money: { amount: '100000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `cash-${runId}`,
      source_ref: `cash-${runId}`,
    },
    'cash-duplicate',
  );
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe('SOURCE_ALREADY_POSTED');
  const count = await dbOne(
    `select count(*)::int as "count" from "folio_payment"
      where "tenant_id" = $1 and "source_ref" = $2`,
    [tenantA, `cash-${runId}`],
  );
  expect(count.count).toBe(1);
});

test('P08-03 the same idempotency key repeats and a different amount under it rejects (AT-F02)', async () => {
  const replay = await apiRequest(admin.context, 'POST', `${base()}/payments`, {
    body: {
      folio_id: folio.id,
      method: 'CASH',
      money: { amount: '100000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `cash-${runId}`,
      source_ref: `cash-${runId}`,
    },
    headers: { 'idempotency-key': key('cash') },
  });
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.id).toBe(cashPayment.id);
  const conflict = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments`,
    {
      body: {
        folio_id: folio.id,
        method: 'CASH',
        money: { amount: '999', currency: 'IDR' },
        business_date: openDay,
        external_reference: `cash-${runId}`,
        source_ref: `cash-${runId}`,
      },
      headers: { 'idempotency-key': key('cash') },
    },
  );
  expect(conflict.status).toBe(409);
});

test('P08-03 OTA settlements keep gross, net and commission separate (F-08)', async () => {
  const revenueBefore = await dbOne(
    `select count(*)::int as "count" from "journal_line"
      where "account_code" like 'REVENUE%'`,
  );
  const response = await recordPayment(
    {
      folio_id: folio.id,
      method: 'OTA_SETTLEMENT',
      money: { amount: '1000000', currency: 'IDR' },
      gross_money: { amount: '1150000', currency: 'IDR' },
      commission_money: { amount: '150000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `ota-${runId}`,
      evidence_ref: randomUUID(),
      source_ref: `ota-${runId}`,
    },
    'ota',
  );
  expect(response.status).toBe(200);
  otaPayment = response.body;
  expect(otaPayment.gross_amount).toBe('1150000');
  expect(otaPayment.commission_amount).toBe('150000');
  const lines = await dbRows(
    `select "account_code", "debit"::text as "debit", "credit"::text as "credit"
       from "journal_line" where "journal_id" = $1 order by "line_no"`,
    [otaPayment.journal_id],
  );
  expect(
    lines.map((line) => ({
      account_code: line.account_code,
      debit: money(line.debit),
      credit: money(line.credit),
    })),
  ).toEqual([
    { account_code: 'BANK', debit: '1000000', credit: '0' },
    { account_code: 'COMMISSION_EXPENSE', debit: '150000', credit: '0' },
    { account_code: 'OTA_CLEARING', debit: '0', credit: '1150000' },
  ]);
  const revenueAfter = await dbOne(
    `select count(*)::int as "count" from "journal_line"
      where "account_code" like 'REVENUE%'`,
  );
  expect(revenueAfter.count).toBe(revenueBefore.count);

  const badMath = await recordPayment(
    {
      folio_id: folio.id,
      method: 'OTA_SETTLEMENT',
      money: { amount: '1000000', currency: 'IDR' },
      gross_money: { amount: '1200000', currency: 'IDR' },
      commission_money: { amount: '150000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `ota-bad-${runId}`,
      evidence_ref: randomUUID(),
      source_ref: `ota-bad-${runId}`,
    },
    'ota-bad',
  );
  expect(badMath.status).toBe(400);
  expect(badMath.body.details.reason).toBe(
    'gross_must_equal_net_plus_commission',
  );
  const missingSettlement = await recordPayment(
    {
      folio_id: folio.id,
      method: 'OTA_SETTLEMENT',
      money: { amount: '1000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `ota-ns-${runId}`,
      evidence_ref: randomUUID(),
      source_ref: `ota-ns-${runId}`,
    },
    'ota-no-settlement',
  );
  expect(missingSettlement.status).toBe(400);
});

test('P08-03 POS evidence is required and collections pass through POS clearing', async () => {
  const missing = await recordPayment(
    {
      folio_id: folio.id,
      method: 'EXTERNAL_POS',
      money: { amount: '50000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `pos-${runId}`,
      source_ref: `pos-missing-${runId}`,
    },
    'pos-missing',
  );
  expect(missing.status).toBe(400);
  expect(missing.body.details.reason).toBe('evidence_required');
  const pos = await recordPayment(
    {
      folio_id: folio.id,
      method: 'EXTERNAL_POS',
      money: { amount: '50000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `pos-${runId}`,
      evidence_ref: randomUUID(),
      source_ref: `pos-${runId}`,
    },
    'pos',
  );
  expect(pos.status).toBe(200);
  const line = await dbOne(
    `select "account_code" from "journal_line"
      where "journal_id" = $1 and "debit" > 0`,
    [pos.body.journal_id],
  );
  expect(line.account_code).toBe('POS_CLEARING');
});

test('P08-03 an unknown provider success stays unresolved and reconciles without another collection (AT-F03)', async () => {
  const response = await recordPayment(
    {
      folio_id: folio.id,
      method: 'BANK_TRANSFER',
      money: { amount: '250000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `trf-${runId}`,
      evidence_ref: randomUUID(),
      source_ref: `trf-${runId}`,
      certainty: 'UNKNOWN',
    },
    'unknown',
  );
  expect(response.status).toBe(200);
  unknownPayment = response.body;
  expect(unknownPayment.state).toBe('UNKNOWN');
  expect(unknownPayment.journal_id).toBeNull();
  const journalsBefore = await dbOne(
    `select count(*)::int as "count" from "journal"
      where "tenant_id" = $1 and "source_type" = 'PAYMENT'`,
    [tenantA],
  );

  const firstReconcile = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments/${unknownPayment.id}/reconcile`,
    {
      body: {
        outcome: 'SUCCEEDED',
        reconciliation_reference: `bank-statement-${runId}`,
      },
      headers: { 'idempotency-key': key('reconcile') },
    },
  );
  expect(firstReconcile.status).toBe(200);
  expect(firstReconcile.body.state).toBe('SUCCEEDED');
  expect(firstReconcile.body.journal_id).not.toBeNull();
  const journalsAfter = await dbOne(
    `select count(*)::int as "count" from "journal"
      where "tenant_id" = $1 and "source_type" = 'PAYMENT'`,
    [tenantA],
  );
  expect(journalsAfter.count).toBe(journalsBefore.count + 1);

  const secondReconcile = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments/${unknownPayment.id}/reconcile`,
    {
      body: { outcome: 'SUCCEEDED' },
      headers: { 'idempotency-key': key('reconcile-again') },
    },
  );
  expect(secondReconcile.status).toBe(409);
  const reCollection = await recordPayment(
    {
      folio_id: folio.id,
      method: 'BANK_TRANSFER',
      money: { amount: '250000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `trf-${runId}`,
      evidence_ref: randomUUID(),
      source_ref: `trf-${runId}`,
    },
    'unknown-recollect',
  );
  expect(reCollection.status).toBe(409);
  expect(reCollection.body.code).toBe('SOURCE_ALREADY_POSTED');

  const failedUnknown = await recordPayment(
    {
      folio_id: folio.id,
      method: 'BANK_TRANSFER',
      money: { amount: '300000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `trf-fail-${runId}`,
      evidence_ref: randomUUID(),
      source_ref: `trf-fail-${runId}`,
      certainty: 'UNKNOWN',
    },
    'unknown-fail',
  );
  expect(failedUnknown.status).toBe(200);
  const failed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments/${failedUnknown.body.id}/reconcile`,
    {
      body: {
        outcome: 'FAILED',
        reconciliation_reference: 'statement-no-match',
      },
      headers: { 'idempotency-key': key('reconcile-failed') },
    },
  );
  expect(failed.status).toBe(200);
  expect(failed.body.state).toBe('FAILED');
  expect(failed.body.journal_id).toBeNull();
});

test('P08-03 a late payment never seizes an expired hold nor touches inventory (AT-R06)', async () => {
  const resourceId = randomUUID();
  const commitmentId = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "resource" ("id", "tenant_id", "property_id", "code", "resource_type", "capacity")
       values ($1, $2, $3, $4, 'ROOM', 2)`,
      [resourceId, tenantA, property.id, `P08-C-${runId}`],
    );
    await client.query(
      `insert into "commitment"
         ("id", "tenant_id", "property_id", "source_kind", "source_id", "state",
          "expires_at", "inventory_version")
       values ($1, $2, $3, 'HOLD', $4, 'ACTIVE', now() - interval '1 hour', 1)`,
      [commitmentId, tenantA, property.id, randomUUID()],
    );
    await client.query(
      `insert into "plan_allocation"
         ("commitment_id", "tenant_id", "property_id", "resource_id", "start_date", "end_date", "state")
       values ($1, $2, $3, $4, $5::date, $6::date, 'ACTIVE')`,
      [
        commitmentId,
        tenantA,
        property.id,
        resourceId,
        openDay,
        new Date(new Date(`${openDay}T00:00:00Z`).getTime() + 86400000)
          .toISOString()
          .slice(0, 10),
      ],
    );
  });
  const before = await dbOne(
    `select "state", "version", "expires_at" from "commitment" where "id" = $1`,
    [commitmentId],
  );
  const allocationsBefore = await dbOne(
    `select count(*)::int as "count" from "plan_allocation"
      where "commitment_id" = $1 and "state" = 'ACTIVE'`,
    [commitmentId],
  );
  const late = await recordPayment(
    {
      folio_id: folio.id,
      method: 'BANK_TRANSFER',
      money: { amount: '77000', currency: 'IDR' },
      business_date: openDay,
      external_reference: `late-${runId}`,
      evidence_ref: randomUUID(),
      source_ref: `late-${runId}`,
    },
    'late',
  );
  expect(late.status).toBe(200);
  expect(late.body.state).toBe('SUCCEEDED');
  const after = await dbOne(
    `select "state", "version", "expires_at" from "commitment" where "id" = $1`,
    [commitmentId],
  );
  expect(after.state).toBe(before.state);
  expect(after.version).toBe(before.version);
  expect(new Date(after.expires_at).getTime()).toBe(
    new Date(before.expires_at).getTime(),
  );
  const allocationsAfter = await dbOne(
    `select count(*)::int as "count" from "plan_allocation"
      where "commitment_id" = $1 and "state" = 'ACTIVE'`,
    [commitmentId],
  );
  expect(allocationsAfter.count).toBe(allocationsBefore.count);
});

test('P08-03 folio totals include resolved payments and reduce the balance', async () => {
  await apiRequest(admin.context, 'POST', `${base()}/charges`, {
    body: {
      folio_id: folio.id,
      business_date: openDay,
      money: { amount: '1500000', currency: 'IDR' },
      account_code: 'REVENUE_OTHER',
      source_ref: `charge-${runId}`,
    },
    headers: { 'idempotency-key': key('charge') },
  });
  const detail = await apiRequest(
    owner.context,
    'GET',
    `${base()}/folios/${folio.id}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body.totals.charges_total).toBe('1500000');
  // 100000 cash + 1000000 OTA net + 50000 POS + 250000 reconciled transfer + 77000 late
  expect(detail.body.totals.payments_total).toBe('1477000');
  expect(detail.body.totals.balance_due).toBe('23000');
  const unknown = detail.body.payments.filter((row) => row.state === 'UNKNOWN');
  expect(unknown).toEqual([]);
});

test('P08-03 payment states are guarded at the database level', async () => {
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(
        `update "folio_payment" set "state" = 'FAILED'
          where "id" = $1`,
        [cashPayment.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(
        `insert into "folio_payment"
           ("tenant_id", "property_id", "folio_id", "method", "currency",
            "amount", "business_date", "external_reference", "source_ref", "state")
         values ($1, $2, $3, 'CASH', 'IDR', 10, $4, 'x', $5, 'SUCCEEDED')`,
        [tenantA, property.id, folio.id, openDay, `db-${runId}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
});
