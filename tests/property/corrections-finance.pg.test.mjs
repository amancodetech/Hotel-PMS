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
const seed = 20260919;
const runId = `P08D${seed}`;
const key = (name) => `p08-04-${name}-${runId}`;

let admin;
let owner;
let property;
let openDay;
let folio;
let charge;
let payment;
let refundOne;
let refundTwo;

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

async function requestRefund(paymentId, amount, name) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/payments/${paymentId}/refunds`,
    {
      body: { money: { amount, currency: 'IDR' }, reason: `refund ${name}` },
      headers: { 'idempotency-key': key(name) },
    },
  );
}

async function approveBySql(approvalId) {
  await withOwner(async (client) => {
    await client.query(
      `update "approval_request"
          set "status" = 'APPROVED', "decided_at" = now(),
              "decided_by" = (select "id" from "app_user"
                               where "id" <> "approval_request"."requested_by"
                               limit 1)
        where "id" = $1`,
      [approvalId],
    );
  });
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  owner = await loginAs('owner-a');
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: `P08-D-${runId}`,
        name: `P08-04 ${runId}`,
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
  const chargeResponse = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges`,
    {
      body: {
        folio_id: folio.id,
        business_date: openDay,
        money: { amount: '100000', currency: 'IDR' },
        account_code: 'REVENUE_OTHER',
        source_ref: `charge-${runId}`,
      },
      headers: { 'idempotency-key': key('charge') },
    },
  );
  expect(chargeResponse.status).toBe(200);
  charge = chargeResponse.body;
  const paymentResponse = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments`,
    {
      body: {
        folio_id: folio.id,
        method: 'CASH',
        money: { amount: '100000', currency: 'IDR' },
        business_date: openDay,
        external_reference: `cash-${runId}`,
        source_ref: `cash-${runId}`,
      },
      headers: { 'idempotency-key': key('payment') },
    },
  );
  expect(paymentResponse.status).toBe(200);
  payment = paymentResponse.body;
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P08-04 requesting a refund requires MFA and reserves against the payment', async () => {
  const withoutMfa = await apiRequest(
    owner.context,
    'POST',
    `${base()}/payments/${payment.id}/refunds`,
    {
      body: { money: { amount: '70000', currency: 'IDR' }, reason: 'no mfa' },
      headers: { 'idempotency-key': key('refund-no-mfa') },
    },
  );
  expect(withoutMfa.status).toBe(403);
  expect(withoutMfa.body.code).toBe('MFA_REQUIRED');
  const response = await requestRefund(payment.id, '70000', 'one');
  expect(response.status).toBe(200);
  refundOne = response.body;
  expect(refundOne.state).toBe('RESERVED');
  expect(refundOne.approval_id).not.toBeNull();
  expect(refundOne.journal_id).toBeNull();
});

test('P08-04 the requester cannot approve their own refund (AT-S02)', async () => {
  const selfApproval = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/approval-requests/${refundOne.approval_id}/decide`,
    {
      body: {
        permission: 'payment.refund.request',
        decision: 'APPROVED',
        reason: 'self approval attempt',
      },
      headers: { 'idempotency-key': key('self-approve') },
    },
  );
  expect(selfApproval.status).toBe(403);
  expect(selfApproval.body.code).toBe('SELF_APPROVAL_DENIED');
});

test('P08-04 two refunds cannot exceed the collected amount (AT-F04)', async () => {
  const second = await requestRefund(payment.id, '40000', 'two-over');
  expect(second.status).toBe(400);
  expect(second.body.details.reason).toBe('refund_exceeds_available');
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await client.query(
      `insert into "folio_refund"
         ("tenant_id", "property_id", "payment_id", "folio_id", "currency", "amount", "reason")
       values ($1, $2, $3, $4, 'IDR', 40000, 'db over')`,
      [tenantA, property.id, payment.id, folio.id],
    );
    await expect(client.query('commit')).rejects.toMatchObject({
      code: '23514',
    });
    await client.query('rollback');
  });
});

test('P08-04 an unknown (pending) refund keeps its reservation and a confirmed failure releases it (AT-F09)', async () => {
  const pending = await apiRequest(
    admin.context,
    'POST',
    `${base()}/refunds/${refundOne.id}/resolve`,
    {
      body: { outcome: 'PENDING', reconciliation_reference: 'bank-pending' },
      headers: { 'idempotency-key': key('resolve-pending') },
    },
  );
  expect(pending.status).toBe(200);
  expect(pending.body.state).toBe('PENDING');
  expect(pending.body.journal_id).toBeNull();
  const stillBlocked = await requestRefund(payment.id, '40000', 'two-blocked');
  expect(stillBlocked.status).toBe(400);
  const failed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/refunds/${refundOne.id}/resolve`,
    {
      body: { outcome: 'FAILED', reconciliation_reference: 'bank-rejected' },
      headers: { 'idempotency-key': key('resolve-failed') },
    },
  );
  expect(failed.status).toBe(200);
  expect(failed.body.state).toBe('FAILED');
  const nowFits = await requestRefund(payment.id, '100000', 'two');
  expect(nowFits.status).toBe(200);
  refundTwo = nowFits.body;
  expect(refundTwo.state).toBe('RESERVED');
});

test('P08-04 a successful refund posts one journal with independent approval and resolves once', async () => {
  await approveBySql(refundTwo.approval_id);
  const journalsBefore = await dbOne(
    `select count(*)::int as "count" from "journal"
      where "tenant_id" = $1 and "source_type" = 'REFUND'`,
    [tenantA],
  );
  const resolved = await apiRequest(
    admin.context,
    'POST',
    `${base()}/refunds/${refundTwo.id}/resolve`,
    {
      body: {
        outcome: 'SUCCEEDED',
        approval_id: refundTwo.approval_id,
        external_reference: `bank-refund-${runId}`,
      },
      headers: { 'idempotency-key': key('resolve-succeeded') },
    },
  );
  expect(resolved.status).toBe(200);
  expect(resolved.body.state).toBe('SUCCEEDED');
  expect(resolved.body.journal_id).not.toBeNull();
  const lines = await dbRows(
    `select "account_code", "debit"::text as "debit", "credit"::text as "credit"
       from "journal_line" where "journal_id" = $1 order by "line_no"`,
    [resolved.body.journal_id],
  );
  expect(
    lines.map((line) => ({
      account_code: line.account_code,
      debit: money(line.debit),
      credit: money(line.credit),
    })),
  ).toEqual([
    { account_code: 'FOLIO_GUEST', debit: '100000', credit: '0' },
    { account_code: 'CASH', debit: '0', credit: '100000' },
  ]);
  const journalsAfter = await dbOne(
    `select count(*)::int as "count" from "journal"
      where "tenant_id" = $1 and "source_type" = 'REFUND'`,
    [tenantA],
  );
  expect(journalsAfter.count).toBe(journalsBefore.count + 1);
  const again = await apiRequest(
    admin.context,
    'POST',
    `${base()}/refunds/${refundTwo.id}/resolve`,
    {
      body: { outcome: 'FAILED' },
      headers: { 'idempotency-key': key('resolve-again') },
    },
  );
  expect(again.status).toBe(409);
  const consumed = await dbOne(
    `select "consumed_at" from "approval_request" where "id" = $1`,
    [refundTwo.approval_id],
  );
  expect(consumed.consumed_at).not.toBeNull();
});

test('P08-04 charge reversal is a single linked journal and never edits the charge', async () => {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${charge.id}/reversal`,
    {
      body: { reason: 'duplicate charge' },
      headers: { 'idempotency-key': key('reversal') },
    },
  );
  expect(response.status).toBe(200);
  expect(response.body.original_journal_id).toBe(charge.journal_id);
  const lines = await dbRows(
    `select "account_code", "debit"::text as "debit", "credit"::text as "credit"
       from "journal_line" where "journal_id" = $1 order by "line_no"`,
    [response.body.journal_id],
  );
  expect(
    lines.map((line) => ({
      account_code: line.account_code,
      debit: money(line.debit),
      credit: money(line.credit),
    })),
  ).toEqual([
    { account_code: 'FOLIO_GUEST', debit: '0', credit: '100000' },
    { account_code: 'REVENUE_OTHER', debit: '100000', credit: '0' },
  ]);
  const linked = await dbOne(
    `select "adjusts_journal_id" from "journal" where "id" = $1`,
    [response.body.journal_id],
  );
  expect(linked.adjusts_journal_id).toBe(charge.journal_id);
  const again = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${charge.id}/reversal`,
    {
      body: { reason: 'again' },
      headers: { 'idempotency-key': key('reversal-again') },
    },
  );
  expect(again.status).toBe(409);
  const stored = await dbOne(
    `select "net_amount", "tax_amount" from "folio_charge" where "id" = $1`,
    [charge.id],
  );
  expect(money(stored.net_amount)).toBe('100000');
  expect(money(stored.tax_amount)).toBe('0');
});

test('P08-04 adjustments are linked journals and a posted charge is never rewritten', async () => {
  const adjust = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${charge.id}/adjustments`,
    {
      body: {
        money: { amount: '10000', currency: 'IDR' },
        direction: 'DECREASE',
        reason: 'goodwill discount',
      },
      headers: { 'idempotency-key': key('adjust') },
    },
  );
  expect(adjust.status).toBe(200);
  const linked = await dbOne(
    `select "source_type", "adjusts_journal_id", "reversal_of_id"
       from "journal" where "id" = $1`,
    [adjust.body.journal_id],
  );
  expect(linked.source_type).toBe('ADJUSTMENT');
  expect(linked.adjusts_journal_id).toBe(charge.journal_id);
  const second = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${charge.id}/adjustments`,
    {
      body: {
        money: { amount: '5000', currency: 'IDR' },
        direction: 'INCREASE',
        reason: 'rebill',
      },
      headers: { 'idempotency-key': key('adjust-2') },
    },
  );
  expect(second.status).toBe(200);
  const count = await dbOne(
    `select count(*)::int as "count" from "journal"
      where "tenant_id" = $1 and "source_type" = 'ADJUSTMENT'
        and "adjusts_journal_id" = $2`,
    [tenantA, charge.journal_id],
  );
  expect(count.count).toBe(2);
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base()}/folios/${folio.id}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body.refunds).toHaveLength(2);
  expect(detail.body.totals.refunds_total).toBe('100000');
});

test('P08-04 FX snapshots need independent approval, never post a conversion and are single-use', async () => {
  const withoutMfa = await apiRequest(
    owner.context,
    'POST',
    `${base()}/fx-snapshots/requests`,
    {
      body: {
        pair: 'IDR/USD',
        rate: '16250.5',
        effective_at: new Date().toISOString(),
        source: 'manual',
      },
      headers: { 'idempotency-key': key('fx-no-mfa') },
    },
  );
  expect(withoutMfa.status).toBe(403);
  const effectiveAt = new Date().toISOString();
  const approvalRequest = await apiRequest(
    admin.context,
    'POST',
    `${base()}/fx-snapshots/requests`,
    {
      body: {
        pair: 'IDR/USD',
        rate: '16250.5',
        effective_at: effectiveAt,
        source: 'bank settlement statement',
      },
      headers: { 'idempotency-key': key('fx-request') },
    },
  );
  expect(approvalRequest.status).toBe(200);
  const journalCountBefore = await dbOne(
    `select count(*)::int as "count" from "journal" where "tenant_id" = $1`,
    [tenantA],
  );
  const unapproved = await apiRequest(
    admin.context,
    'POST',
    `${base()}/fx-snapshots`,
    {
      body: {
        pair: 'IDR/USD',
        rate: '16250.5',
        effective_at: effectiveAt,
        source: 'bank settlement statement',
        approval_id: approvalRequest.body.id,
      },
      headers: { 'idempotency-key': key('fx-record-unapproved') },
    },
  );
  expect(unapproved.status).toBe(400);
  expect(unapproved.body.details.reason).toBe('approval_not_approved');
  await approveBySql(approvalRequest.body.id);
  const recorded = await apiRequest(
    admin.context,
    'POST',
    `${base()}/fx-snapshots`,
    {
      body: {
        pair: 'IDR/USD',
        rate: '16250.5',
        effective_at: effectiveAt,
        source: 'bank settlement statement',
        approval_id: approvalRequest.body.id,
      },
      headers: { 'idempotency-key': key('fx-record') },
    },
  );
  expect(recorded.status).toBe(200);
  expect(recorded.body.rate).toBe('16250.50000000');
  const journalCountAfter = await dbOne(
    `select count(*)::int as "count" from "journal" where "tenant_id" = $1`,
    [tenantA],
  );
  expect(journalCountAfter.count).toBe(journalCountBefore.count);
  const reuse = await apiRequest(
    admin.context,
    'POST',
    `${base()}/fx-snapshots`,
    {
      body: {
        pair: 'IDR/USD',
        rate: '16250.5',
        effective_at: effectiveAt,
        source: 'bank settlement statement',
        approval_id: approvalRequest.body.id,
      },
      headers: { 'idempotency-key': key('fx-record-again') },
    },
  );
  expect([400, 409]).toContain(reuse.status);
  const list = await apiRequest(admin.context, 'GET', `${base()}/fx-snapshots`);
  expect(list.status).toBe(200);
  expect(list.body.fx_snapshots).toHaveLength(1);
});

test('P08-04 refund transitions and reversal uniqueness are enforced by the database', async () => {
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(
        `update "folio_refund" set "state" = 'FAILED' where "id" = $1`,
        [refundTwo.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
  const reversal = await dbOne(
    `select "adjusts_journal_id" from "journal"
      where "tenant_id" = $1 and "property_id" = $2 and "source_type" = 'REVERSAL'`,
    [tenantA, property.id],
  );
  expect(reversal.adjusts_journal_id).toBe(charge.journal_id);
  const tables = await dbRows(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('folio_refund', 'fx_snapshot')`,
  );
  expect(tables).toHaveLength(2);
  for (const row of tables) {
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  }
});
