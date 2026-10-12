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
const seed = 20260920;
const runId = `P08E${seed}`;
const key = (name) => `p08-05-${name}-${runId}`;

let admin;
let property;
let openDay;
let folio;
let invoice;

function base() {
  return `/tenants/${tenantA}/properties/${property.id}`;
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: `P08-E-${runId}`,
        name: `P08-05 ${runId}`,
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
  folio = folioResponse.body.folio;
  const payment = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments`,
    {
      body: {
        folio_id: folio.id,
        method: 'CASH',
        money: { amount: '70000', currency: 'IDR' },
        business_date: openDay,
        external_reference: `cash-${runId}`,
        source_ref: `cash-${runId}`,
      },
      headers: { 'idempotency-key': key('cash') },
    },
  );
  expect(payment.status).toBe(200);
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P08-05 an invoice gets one series number and a duplicate source never burns a number', async () => {
  const first = await apiRequest(admin.context, 'POST', `${base()}/invoices`, {
    body: {
      folio_id: folio.id,
      series: 'INV',
      source_ref: `inv-${runId}`,
      business_date: openDay,
      money: { amount: '100000', currency: 'IDR' },
      tax_money: { amount: '11000', currency: 'IDR' },
    },
    headers: { 'idempotency-key': key('invoice') },
  });
  expect(first.status).toBe(200);
  invoice = first.body;
  expect(invoice.number).toBe('1');
  expect(invoice.total_amount).toBe('111000');
  const duplicate = await apiRequest(
    admin.context,
    'POST',
    `${base()}/invoices`,
    {
      body: {
        folio_id: folio.id,
        series: 'INV',
        source_ref: `inv-${runId}`,
        business_date: openDay,
        money: { amount: '100000', currency: 'IDR' },
      },
      headers: { 'idempotency-key': key('invoice-dup') },
    },
  );
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe('SOURCE_ALREADY_POSTED');
  const next = await apiRequest(admin.context, 'POST', `${base()}/invoices`, {
    body: {
      folio_id: folio.id,
      series: 'INV',
      source_ref: `inv2-${runId}`,
      business_date: openDay,
      money: { amount: '50000', currency: 'IDR' },
    },
    headers: { 'idempotency-key': key('invoice-2') },
  });
  expect(next.status).toBe(200);
  expect(next.body.number).toBe('2');
});

test('P08-05 a PRODUCTION series is refused without an approved EX-03 profile', async () => {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/invoices`,
    {
      body: {
        folio_id: folio.id,
        series: 'PRD',
        kind: 'PRODUCTION',
        source_ref: `prod-${runId}`,
        business_date: openDay,
        money: { amount: '1000', currency: 'IDR' },
      },
      headers: { 'idempotency-key': key('production') },
    },
  );
  expect(response.status).toBe(422);
  expect(response.body.code).toBe('EX03_NOT_APPROVED');
});

test('P08-05 a credit note is linked and never exceeds the invoice', async () => {
  const over = await apiRequest(
    admin.context,
    'POST',
    `${base()}/invoices/${invoice.id}/credit-notes`,
    {
      body: {
        money: { amount: '200000', currency: 'IDR' },
        reason: 'over',
        source_ref: `cn-over-${runId}`,
      },
      headers: { 'idempotency-key': key('cn-over') },
    },
  );
  expect(over.status).toBe(400);
  expect(over.body.details.reason).toBe('credit_note_exceeds_invoice');
  const note = await apiRequest(
    admin.context,
    'POST',
    `${base()}/invoices/${invoice.id}/credit-notes`,
    {
      body: {
        money: { amount: '11000', currency: 'IDR' },
        reason: 'tax correction',
        source_ref: `cn-${runId}`,
      },
      headers: { 'idempotency-key': key('cn') },
    },
  );
  expect(note.status).toBe(200);
  expect(note.body.number).toBe('1');
  const lines = await withOwner(async (client) => {
    const result = await client.query(
      `select "account_code", "debit"::text as "debit", "credit"::text as "credit"
         from "journal_line" where "journal_id" = $1 order by "line_no"`,
      [note.body.journal_id],
    );
    return result.rows;
  });
  expect(lines.map((l) => l.account_code)).toEqual([
    'REVENUE_OTHER',
    'FOLIO_GUEST',
  ]);
  const list = await apiRequest(admin.context, 'GET', `${base()}/invoices`);
  expect(list.status).toBe(200);
  expect(list.body.invoices).toHaveLength(2);
  expect(list.body.invoices[0].credit_notes).toHaveLength(1);
});

test('P08-05 cashier count records the variance and closing preserves it', async () => {
  const open = await apiRequest(
    admin.context,
    'POST',
    `${base()}/cashier-sessions`,
    {
      body: { currency: 'IDR', opening_float: '50000' },
      headers: { 'idempotency-key': key('cashier') },
    },
  );
  expect(open.status).toBe(200);
  const session = open.body;
  expect(session.state).toBe('OPEN');
  const duplicate = await apiRequest(
    admin.context,
    'POST',
    `${base()}/cashier-sessions`,
    {
      body: { currency: 'IDR' },
      headers: { 'idempotency-key': key('cashier-dup') },
    },
  );
  expect(duplicate.status).toBe(409);
  const inSessionPayment = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments`,
    {
      body: {
        folio_id: folio.id,
        method: 'CASH',
        money: { amount: '70000', currency: 'IDR' },
        business_date: openDay,
        external_reference: `cash2-${runId}`,
        source_ref: `cash2-${runId}`,
      },
      headers: { 'idempotency-key': key('cash2') },
    },
  );
  expect(inSessionPayment.status).toBe(200);
  const counted = await apiRequest(
    admin.context,
    'POST',
    `${base()}/cashier-sessions/${session.id}/count`,
    {
      body: { counted_money: '119000' },
      headers: { 'idempotency-key': key('cashier-count') },
    },
  );
  expect(counted.status).toBe(200);
  expect(counted.body.state).toBe('RECONCILED');
  expect(counted.body.expected_amount).toBe('120000');
  expect(counted.body.variance).toBe('-1000');
  const closed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/cashier-sessions/${session.id}/close`,
    {
      body: {},
      headers: { 'idempotency-key': key('cashier-close') },
    },
  );
  expect(closed.status).toBe(200);
  expect(closed.body.state).toBe('CLOSED');
  expect(closed.body.variance).toBe('-1000');
  const countAgain = await apiRequest(
    admin.context,
    'POST',
    `${base()}/cashier-sessions/${session.id}/count`,
    {
      body: { counted_money: '1' },
      headers: { 'idempotency-key': key('cashier-count-again') },
    },
  );
  expect(countAgain.status).toBe(409);
});

test('P08-05 a closed cashier session is immutable in the database', async () => {
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    const session = await client.query(
      `select "id" from "cashier_session" where "property_id" = $1 and "state" = 'CLOSED' limit 1`,
      [property.id],
    );
    await expect(
      client.query(
        `update "cashier_session" set "variance" = 0 where "id" = $1`,
        [session.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
});
