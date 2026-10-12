import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { phase8Operations } from '../../apps/api/dist/finance/operations.js';
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

// Fixed synthetic seed: no user data, deterministic codes and fixtures.
const seed = 20260920;
const runId = `P08I${seed}`;
const key = (name) => `p08-06-${name}-${runId}`;

const phase8Contract = JSON.parse(
  readFileSync('docs/contracts/phase8.openapi.json', 'utf8'),
);

let admin;
let owner;
let auditor;
let member;
let property;
let productId;
let planId;
let openDay;
let rooms;
let longStayItem;

function base() {
  return `/tenants/${tenantA}/properties/${property.id}`;
}

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonth(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  const day = parsed.getUTCDate();
  parsed.setUTCDate(1);
  parsed.setUTCMonth(parsed.getUTCMonth() + 1);
  const daysInMonth = new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0),
  ).getUTCDate();
  parsed.setUTCDate(Math.min(day, daysInMonth));
  return parsed.toISOString().slice(0, 10);
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

async function dbAudit(action, resourceId) {
  return dbOne(
    `select count(*)::int as "count"
       from "audit_event"
      where "action" = $1 and "resource_id" = $2`,
    [action, resourceId],
  );
}

async function dbReservation(reservationId) {
  return dbOne(
    `select "state", "version", "financial_clearance_state",
            "financial_cleared_at", "financial_clearance_basis",
            "financial_clearance_reference", "financial_clearance_payer_folio_id"
       from "reservation" where "id" = $1`,
    [reservationId],
  );
}

async function quote(arrival, departure) {
  const response = await apiRequest(admin.context, 'POST', `${base()}/quotes`, {
    body: {
      product_id: productId,
      rate_plan_id: planId,
      period: { arrival: addDays(arrival), departure: addDays(departure) },
      occupancy: { adults: 2, child_ages: [] },
      quantity: 1,
    },
  });
  expect(response.status).toBe(201);
  return response.body.quote.id;
}

async function createConfirmed(arrival, departure) {
  const draft = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: [
          {
            product_id: productId,
            period: {
              arrival: addDays(arrival),
              departure: addDays(departure),
            },
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
    `${base()}/reservations/${reservationId}`,
  );
  expect(detail.status).toBe(200);
  const itemId = detail.body.items[0].id;
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations`,
    {
      body: {
        reservation_id: reservationId,
        inventory_version: (
          await apiRequest(
            admin.context,
            'GET',
            `${base()}/rates?from=${addDays(0)}&to=${addDays(70)}`,
          )
        ).body.inventory_version,
        items: [
          {
            item_id: itemId,
            price_snapshot_id: await quote(arrival, departure),
          },
        ],
      },
    },
  );
  expect(confirmed.status).toBe(200);
  return { reservationId, itemId };
}

async function checkIn(item, resourceId) {
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base()}/reservations/${item.reservationId}`,
  );
  const row = detail.body.items.find((entry) => entry.id === item.itemId);
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-in`,
    {
      body: { version: row.version, resource_id: resourceId },
      headers: { 'idempotency-key': key(`ci-${item.itemId}`) },
    },
  );
}

async function checkOut(item) {
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base()}/reservations/${item.reservationId}`,
  );
  const row = detail.body.items.find((entry) => entry.id === item.itemId);
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-out`,
    {
      body: { version: row.version },
      headers: { 'idempotency-key': key(`co-${item.itemId}`) },
    },
  );
}

async function openFolio(
  reservationId,
  kind = 'GUEST',
  payerLabel = `Guest ${runId}`,
) {
  const response = await apiRequest(admin.context, 'POST', `${base()}/folios`, {
    body: {
      ...(reservationId ? { reservation_id: reservationId } : {}),
      kind,
      payer_label: payerLabel,
      currency: 'IDR',
    },
    headers: { 'idempotency-key': key(`folio-${randomUUID()}`) },
  });
  expect(response.status).toBe(200);
  return response.body.folio;
}

async function postCharge(folioId, amount, sourceRef) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges`,
    {
      body: {
        folio_id: folioId,
        business_date: openDay,
        money: { amount, currency: 'IDR' },
        account_code: 'REVENUE_OTHER',
        source_ref: sourceRef,
      },
      headers: { 'idempotency-key': key(`charge-${sourceRef}`) },
    },
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function recordPayment(folioId, amount, name, extra = {}) {
  return apiRequest(admin.context, 'POST', `${base()}/payments`, {
    body: {
      folio_id: folioId,
      method: 'CASH',
      money: { amount, currency: 'IDR' },
      business_date: openDay,
      external_reference: `ref-${name}-${runId}`,
      source_ref: `src-${name}-${runId}`,
      ...extra,
    },
    headers: { 'idempotency-key': key(`pay-${name}`) },
  });
}

async function reservationVersion(reservationId) {
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base()}/reservations/${reservationId}`,
  );
  expect(detail.status).toBe(200);
  return detail.body.reservation.version;
}

async function settle(reservationId, body, name, options = {}) {
  const { context = admin.context, ...rest } = options;
  return apiRequest(
    context,
    'POST',
    `${base()}/reservations/${reservationId}/clearance`,
    {
      body,
      ...rest,
      headers: {
        ...(name ? { 'idempotency-key': key(name) } : {}),
        ...(rest.headers ?? {}),
      },
    },
  );
}

async function clearance(reservationId, context = admin.context) {
  return apiRequest(
    context,
    'GET',
    `${base()}/reservations/${reservationId}/clearance`,
  );
}

function contractOperations() {
  const operations = [];
  for (const [path, item] of Object.entries(phase8Contract.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const entry = {
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: `/api/v1${path}`,
        access: 'permission',
        permission: operation['x-permission'],
      };
      if (operation['x-csrf']) entry.csrf = true;
      operations.push(entry);
    }
  }
  return operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
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
        code: `P08-I-${runId}`,
        name: `P08-06 ${runId}`,
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

  rooms = {};
  for (const suffix of [
    'R1',
    'R2',
    'R3',
    'R4',
    'R5',
    'R6',
    'R7',
    'R8',
    'R9',
    'R10',
    'R11',
    'R12',
  ]) {
    const resource = await apiRequest(
      admin.context,
      'POST',
      `${base()}/resources`,
      {
        body: { code: `P08-I-${suffix}-${runId}`, type: 'ROOM', capacity: 2 },
      },
    );
    expect(resource.status).toBe(201);
    rooms[suffix] = resource.body.resource;
  }
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code: `P08-I-P-${runId}`,
        name: `P08-06 ${runId}`,
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(product.status).toBe(201);
  productId = product.body.product.id;
  for (const suffix of Object.keys(rooms)) {
    const candidate = await apiRequest(
      admin.context,
      'POST',
      `${base()}/products/${productId}/candidates`,
      { body: { resource_id: rooms[suffix].id } },
    );
    expect(candidate.status).toBe(201);
  }
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/products/${productId}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: {
      code: `P08-I-R-${runId}`,
      name: `P08-06 ${runId}`,
      product_id: productId,
      currency: 'IDR',
    },
  });
  expect(plan.status).toBe(201);
  planId = plan.body.rate_plan.id;
  const planActive = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/rate-plans/${planId}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  expect(planActive.status).toBe(200);
  const cells = [];
  for (let offset = 0; offset <= 70; offset += 1) {
    cells.push({
      rate_plan_id: planId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '250000', currency: 'IDR' },
    });
  }
  const rates = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rates/batch`,
    {
      body: { cells },
    },
  );
  expect(rates.status).toBe(200);

  longStayItem = await createConfirmed(0, 45);
  expect((await checkIn(longStayItem, rooms.R8.id)).status).toBe(200);
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P08-06 phase 8 contract lists the clearance and external-settlement operations', () => {
  const manifest = [...phase8Operations].sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );
  expect(manifest).toEqual(contractOperations());
  const ids = contractOperations().map((operation) => operation.operationId);
  expect(ids).toContain('GetReservationClearance');
  expect(ids).toContain('SettleClearance');
  expect(ids).toContain('ListExternalSettlements');
});

test('P08-06 clearance settles only after the ledger is actually at zero and replays safely (AT-R07)', async () => {
  const item = await createConfirmed(0, 2);
  expect((await checkIn(item, rooms.R1.id)).status).toBe(200);
  const folio = await openFolio(item.reservationId);
  await postCharge(folio.id, '150000', `cleared-${runId}`);
  const checkout = await checkOut(item);
  expect(checkout.status).toBe(200);
  expect(checkout.body.financial_clearance_state).toBe('PENDING');

  const departed = await clearance(item.reservationId);
  expect(departed.status).toBe(200);
  expect(departed.body.reservation.departed).toBe(true);
  expect(departed.body.reservation.financial_clearance_state).toBe('PENDING');
  expect(departed.body.settled).toBe(false);
  expect(departed.body.balanced).toBe(false);
  expect(departed.body.outstanding).toBe(true);
  expect(departed.body.totals_by_currency).toHaveLength(1);
  expect(departed.body.totals_by_currency[0].currency).toBe('IDR');
  expect(departed.body.totals_by_currency[0].balance_due).toBe('150000');

  const early = await settle(
    item.reservationId,
    { version: await reservationVersion(item.reservationId), basis: 'SETTLED' },
    'early',
  );
  expect(early.status).toBe(422);
  expect(early.body.code).toBe('CLEARANCE_OUTSTANDING');
  expect(early.body.details.balance_due).toBe('150000');
  expect(
    (await dbReservation(item.reservationId)).financial_clearance_state,
  ).toBe('PENDING');

  const payment = await recordPayment(folio.id, '150000', `clear-${runId}`);
  expect(payment.status).toBe(200);
  const version = await reservationVersion(item.reservationId);
  const settled = await settle(
    item.reservationId,
    { version, basis: 'SETTLED' },
    'settled',
  );
  expect(settled.status).toBe(200);
  expect(settled.body.financial_clearance_state).toBe('CLEARED');
  expect(settled.body.financial_cleared_at).toBeTruthy();
  expect(settled.body.financial_clearance_basis).toBe('SETTLED');
  expect(settled.body.reservation_version).toBe(version + 1);

  const stored = await dbReservation(item.reservationId);
  expect(stored.financial_clearance_state).toBe('CLEARED');
  expect(stored.financial_clearance_basis).toBe('SETTLED');
  expect(stored.financial_cleared_at).not.toBeNull();
  expect(
    await dbAudit('finance.clearance_cleared', item.reservationId),
  ).toEqual({
    count: 1,
  });

  const replay = await settle(
    item.reservationId,
    { version, basis: 'SETTLED' },
    'settled',
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.financial_cleared_at).toEqual(
    settled.body.financial_cleared_at,
  );

  const again = await settle(
    item.reservationId,
    { version: settled.body.reservation_version, basis: 'SETTLED' },
    'settled-again',
  );
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
  expect((await dbReservation(item.reservationId)).version).toBe(
    settled.body.reservation_version,
  );
});

test('P08-06 a later financial posting reopens a CLEARED reservation', async () => {
  const item = await createConfirmed(0, 3);
  expect((await checkIn(item, rooms.R2.id)).status).toBe(200);
  const folio = await openFolio(item.reservationId);
  expect((await checkOut(item)).status).toBe(200);
  const settleNow = await settle(
    item.reservationId,
    { version: await reservationVersion(item.reservationId), basis: 'SETTLED' },
    'reopen-settle',
  );
  expect(settleNow.status).toBe(200);
  expect(settleNow.body.financial_clearance_state).toBe('CLEARED');

  await postCharge(folio.id, '50000', `reopen-${runId}`);
  const reopened = await dbReservation(item.reservationId);
  expect(reopened.financial_clearance_state).toBe('PENDING');
  expect(reopened.financial_cleared_at).toBeNull();
  expect(reopened.financial_clearance_basis).toBeNull();
  expect(
    await dbAudit('finance.clearance_reopened', item.reservationId),
  ).toEqual({ count: 1 });

  const view = await clearance(item.reservationId);
  expect(view.status).toBe(200);
  expect(view.body.reservation.financial_clearance_state).toBe('PENDING');
  expect(view.body.outstanding).toBe(true);
  expect(view.body.totals_by_currency[0].balance_due).toBe('50000');
});

test('P08-06 liability transfer to a COMPANY city-ledger payer clears with a documented plan (D-13)', async () => {
  const item = await createConfirmed(0, 4);
  expect((await checkIn(item, rooms.R3.id)).status).toBe(200);
  const guestFolio = await openFolio(item.reservationId);
  await postCharge(guestFolio.id, '250000', `transfer-a-${runId}`);
  await postCharge(guestFolio.id, '150000', `transfer-b-${runId}`);
  expect(
    (await recordPayment(guestFolio.id, '100000', `transfer-${runId}`)).status,
  ).toBe(200);
  expect((await checkOut(item)).status).toBe(200);
  const version = await reservationVersion(item.reservationId);

  const missingPlan = await settle(
    item.reservationId,
    { version, basis: 'TRANSFER_TO_PAYER', payer_folio_id: randomUUID() },
    'transfer-missing-plan',
  );
  expect(missingPlan.status).toBe(400);
  expect(missingPlan.body.details.field).toBe('collection_plan_ref');

  const linkedPayer = await openFolio(
    item.reservationId,
    'COMPANY',
    `Linked ${runId}`,
  );
  const linked = await settle(
    item.reservationId,
    {
      version,
      basis: 'TRANSFER_TO_PAYER',
      payer_folio_id: linkedPayer.id,
      collection_plan_ref: `plan-${runId}`,
    },
    'transfer-linked',
  );
  expect(linked.status).toBe(400);
  expect(linked.body.details.reason).toBe('payer_must_be_city_ledger_account');

  const guestPayer = await openFolio(null, 'GUEST', `Guest payer ${runId}`);
  const wrongKind = await settle(
    item.reservationId,
    {
      version,
      basis: 'TRANSFER_TO_PAYER',
      payer_folio_id: guestPayer.id,
      collection_plan_ref: `plan-${runId}`,
    },
    'transfer-kind',
  );
  expect(wrongKind.status).toBe(400);
  expect(wrongKind.body.details.reason).toBe(
    'authorized_company_payer_required',
  );

  const company = await openFolio(null, 'COMPANY', `P08 Agent ${runId}`);
  const revenueBefore = await dbOne(
    `select count(*)::int as "count" from "journal_line"
      where "account_code" like 'REVENUE%'`,
  );
  const transferred = await settle(
    item.reservationId,
    {
      version,
      basis: 'TRANSFER_TO_PAYER',
      payer_folio_id: company.id,
      collection_plan_ref: `plan-${runId}`,
    },
    'transfer',
  );
  expect(transferred.status).toBe(200);
  expect(transferred.body.financial_clearance_state).toBe('CLEARED');
  expect(transferred.body.financial_clearance_basis).toBe('TRANSFER_TO_PAYER');
  expect(transferred.body.financial_clearance_reference).toBe(`plan-${runId}`);
  expect(transferred.body.financial_clearance_payer_folio_id).toBe(company.id);
  expect(transferred.body.transfer_allocations).toHaveLength(2);
  expect(
    transferred.body.transfer_allocations.map(
      (allocation) => allocation.amount,
    ),
  ).toEqual(['250000', '50000']);

  const stored = await dbReservation(item.reservationId);
  expect(stored.financial_clearance_reference).toBe(`plan-${runId}`);
  expect(stored.financial_clearance_payer_folio_id).toBe(company.id);

  const guestDetail = await apiRequest(
    admin.context,
    'GET',
    `${base()}/folios/${guestFolio.id}`,
  );
  expect(guestDetail.body.totals.balance_due).toBe('0');
  expect(guestDetail.body.totals.routed_out).toBe('300000');
  const companyDetail = await apiRequest(
    admin.context,
    'GET',
    `${base()}/folios/${company.id}`,
  );
  expect(companyDetail.body.totals.balance_due).toBe('300000');
  expect(companyDetail.body.totals.routed_in).toBe('300000');

  const journal = await dbRows(
    `select "account_code", "debit"::text as "debit", "credit"::text as "credit"
       from "journal_line"
      where "journal_id" = (
        select "journal_id" from "payer_allocation"
         where "charge_id" = $1 and "payer_folio_id" = $2
      )
      order by "line_no"`,
    [transferred.body.transfer_allocations[0].charge_id, company.id],
  );
  expect(
    journal.map((line) => ({
      account_code: line.account_code,
      debit: money(line.debit),
      credit: money(line.credit),
    })),
  ).toEqual([
    { account_code: 'AR_GUEST', debit: '250000', credit: '0' },
    { account_code: 'AR_GUEST', debit: '50000', credit: '0' },
    { account_code: 'FOLIO_GUEST', debit: '0', credit: '300000' },
  ]);
  const revenueAfter = await dbOne(
    `select count(*)::int as "count" from "journal_line"
      where "account_code" like 'REVENUE%'`,
  );
  expect(revenueAfter.count).toBe(revenueBefore.count);
  expect(
    await dbAudit('finance.clearance_cleared', item.reservationId),
  ).toEqual({
    count: 1,
  });
});

test('P08-06 concurrent clearance resolutions leave one winner and one audit', async () => {
  const raceItem = await createConfirmed(0, 5);
  expect((await checkIn(raceItem, rooms.R4.id)).status).toBe(200);
  expect((await checkOut(raceItem)).status).toBe(200);
  const version = await reservationVersion(raceItem.reservationId);
  const [first, second] = await Promise.all([
    settle(raceItem.reservationId, { version, basis: 'SETTLED' }, 'race-a'),
    settle(raceItem.reservationId, { version, basis: 'SETTLED' }, 'race-b'),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(statuses[0]).toBe(200);
  expect([409, 412]).toContain(statuses[1]);
  const winner = first.status === 200 ? first : second;
  expect(winner.body.financial_clearance_state).toBe('CLEARED');
  const stored = await dbReservation(raceItem.reservationId);
  expect(stored.financial_clearance_state).toBe('CLEARED');
  expect(stored.version).toBe(winner.body.reservation_version);
  expect(
    await dbAudit('finance.clearance_cleared', raceItem.reservationId),
  ).toEqual({
    count: 1,
  });
});

test('P08-06 clearance respects permissions, CSRF, idempotency and rejects card data', async () => {
  const item = await createConfirmed(0, 6);
  expect((await checkIn(item, rooms.R5.id)).status).toBe(200);
  expect((await checkOut(item)).status).toBe(200);
  const version = await reservationVersion(item.reservationId);

  const memberRead = await clearance(item.reservationId, member.context);
  expect(memberRead.status).toBe(403);
  const memberWrite = await settle(
    item.reservationId,
    { version, basis: 'SETTLED' },
    'member',
    { context: member.context },
  );
  expect(memberWrite.status).toBe(403);
  const auditorRead = await clearance(item.reservationId, auditor.context);
  expect(auditorRead.status).toBe(200);
  const auditorWrite = await settle(
    item.reservationId,
    { version, basis: 'SETTLED' },
    'auditor',
    { context: auditor.context },
  );
  expect(auditorWrite.status).toBe(403);
  const ownerRead = await clearance(item.reservationId, owner.context);
  expect(ownerRead.status).toBe(200);

  const noKey = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/clearance`,
    { body: { version, basis: 'SETTLED' }, idempotency: false },
  );
  expect(noKey.status).toBe(400);
  expect(noKey.body.details.field).toBe('idempotency_key');

  const noCsrf = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/clearance`,
    {
      body: { version, basis: 'SETTLED' },
      headers: { 'idempotency-key': key('no-csrf') },
      csrf: false,
    },
  );
  expect(noCsrf.status).toBe(403);
  expect(noCsrf.body.code).toBe('CSRF_INVALID');

  const card = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/clearance`,
    {
      body: { version, basis: 'SETTLED', pan: '4111111111111111', cvv: '123' },
      headers: { 'idempotency-key': key('card') },
    },
  );
  expect(card.status).toBe(400);
  expect(card.body.code).toBe('INVALID_REQUEST');
  const serialized = JSON.stringify(card.body);
  expect(serialized.includes('4111111111111111')).toBe(false);
  expect(serialized.includes('"cvv"')).toBe(false);

  const crossTenant = await clearance(
    item.reservationId,
    (await loginAs('owner-b')).context,
  );
  expect(crossTenant.status).toBe(403);
  expect(crossTenant.body.code).toBe('TENANT_CONTEXT_MISMATCH');
  expect(
    (await dbReservation(item.reservationId)).financial_clearance_state,
  ).toBe('PENDING');
});

test('P08-06 external settlements keep gross, net and commission separate and link to the external booking (F-08)', async () => {
  const connection = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections`,
    {
      body: {
        provider_key: 'CHANNEX',
        environment: 'STAGING',
        channel_key: 'BOOKING_COM',
        external_property_id: `p86-${runId}`,
        secret_ref: 'local:hotel/p8-06',
      },
    },
  );
  expect(connection.status).toBe(201);
  const connectionId = connection.body.connection.id;
  const externalKey = `P86-EXT-${runId}`;
  const draft = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    {
      body: {
        source: 'OTA',
        channel_connection_id: connectionId,
        external_booking_key: externalKey,
        items: [
          {
            product_id: productId,
            period: { arrival: addDays(10), departure: addDays(12) },
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
    `${base()}/reservations/${reservationId}`,
  );
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations`,
    {
      body: {
        reservation_id: reservationId,
        inventory_version: (
          await apiRequest(
            admin.context,
            'GET',
            `${base()}/rates?from=${addDays(0)}&to=${addDays(20)}`,
          )
        ).body.inventory_version,
        items: [
          {
            item_id: detail.body.items[0].id,
            price_snapshot_id: await quote(10, 12),
          },
        ],
      },
    },
  );
  expect(confirmed.status).toBe(200);
  await withOwner(async (client) => {
    await client.query(
      `insert into "distribution_external_booking"
         ("id", "connection_id", "property_id", "channel_key",
          "external_booking_id", "provider_booking_id", "state",
          "reservation_ref")
       values ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)`,
      [
        randomUUID(),
        connectionId,
        property.id,
        'BOOKING_COM',
        externalKey,
        `prov-${runId}`,
        reservationId,
      ],
    );
  });
  const folio = await openFolio(reservationId);
  const currencyMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments`,
    {
      body: {
        folio_id: folio.id,
        method: 'OTA_SETTLEMENT',
        money: { amount: '1000000', currency: 'IDR' },
        currency: 'USD',
        gross_money: { amount: '1150000', currency: 'IDR' },
        commission_money: { amount: '150000', currency: 'IDR' },
        business_date: openDay,
        external_reference: `ota-usd-${runId}`,
        evidence_ref: randomUUID(),
        source_ref: `ota-usd-${runId}`,
      },
      headers: { 'idempotency-key': key('ota-usd') },
    },
  );
  expect(currencyMismatch.status).toBe(400);
  expect(currencyMismatch.body.details.reason).toBe('folio_currency_mismatch');
  const ota = await apiRequest(admin.context, 'POST', `${base()}/payments`, {
    body: {
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
    headers: { 'idempotency-key': key('ota') },
  });
  expect(ota.status).toBe(200);
  expect(ota.body.gross_amount).toBe('1150000');
  expect(ota.body.commission_amount).toBe('150000');
  expect(ota.body.amount).toBe('1000000');

  const settlements = await apiRequest(
    admin.context,
    'GET',
    `${base()}/external-settlements?reservation_id=${reservationId}`,
  );
  expect(settlements.status).toBe(200);
  expect(settlements.body.settlements).toHaveLength(1);
  const row = settlements.body.settlements[0];
  expect(row.method).toBe('OTA_SETTLEMENT');
  expect(row.currency).toBe('IDR');
  expect(row.amount).toBe('1000000');
  expect(row.gross_amount).toBe('1150000');
  expect(row.commission_amount).toBe('150000');
  expect(row.evidence_ref).toBeTruthy();
  expect(row.external_reference).toBe(`ota-${runId}`);
  expect(row.linked_to_external_booking).toBe(true);
  expect(row.external_booking.channel_key).toBe('BOOKING_COM');
  expect(row.external_booking.provider_booking_id).toBe(`prov-${runId}`);
  expect(row.reservation.source).toBe('OTA');
  expect(row.reservation.external_booking_key).toBe(externalKey);

  const filtered = await apiRequest(
    admin.context,
    'GET',
    `${base()}/external-settlements?state=FAILED`,
  );
  expect(filtered.status).toBe(200);
  expect(filtered.body.settlements).toEqual([]);

  const lines = await dbRows(
    `select "account_code", "debit"::text as "debit", "credit"::text as "credit"
       from "journal_line" where "journal_id" = $1 order by "line_no"`,
    [ota.body.journal_id],
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
});

test('P08-06 long-stay schedules and packages post once and surface in the clearance view', async () => {
  const folio = await openFolio(
    longStayItem.reservationId,
    'GUEST',
    `Long ${runId}`,
  );
  const schedule = await apiRequest(
    admin.context,
    'POST',
    `${base()}/folios/${folio.id}/charge-schedules`,
    {
      body: {
        code: `MONTH-${runId}`.slice(0, 32),
        quantity: 1,
        money: { amount: '500000', currency: 'IDR' },
        interval: 'MONTH',
        starts_on: openDay,
      },
      headers: { 'idempotency-key': key('schedule') },
    },
  );
  expect(schedule.status).toBe(200);
  const scheduleId = schedule.body.id;

  const firstPost = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charge-schedules/${scheduleId}/post`,
    {
      body: { business_date: openDay, period_start: openDay },
      headers: { 'idempotency-key': key('schedule-post') },
    },
  );
  expect(firstPost.status).toBe(200);
  expect(firstPost.body.period_start).toBe(openDay);
  const replay = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charge-schedules/${scheduleId}/post`,
    {
      body: { business_date: openDay, period_start: openDay },
      headers: { 'idempotency-key': key('schedule-post') },
    },
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  const duplicate = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charge-schedules/${scheduleId}/post`,
    {
      body: { business_date: openDay, period_start: openDay },
      headers: { 'idempotency-key': key('schedule-post-again') },
    },
  );
  expect(duplicate.status).toBe(400);
  expect(duplicate.body.details.reason).toBe('period_out_of_order');
  const scheduleCharges = await dbOne(
    `select count(*)::int as "count" from "folio_charge"
      where "source_kind" = 'ACCRUAL' and "source_ref" = $1`,
    [`schedule:${scheduleId}:${openDay}`],
  );
  expect(scheduleCharges.count).toBe(1);

  const entitlement = await apiRequest(
    admin.context,
    'POST',
    `${base()}/folios/${folio.id}/packages`,
    {
      body: {
        code: `SPA-${runId}`.slice(0, 32),
        quantity_total: 2,
        unit_money: { amount: '100000', currency: 'IDR' },
      },
      headers: { 'idempotency-key': key('package') },
    },
  );
  expect(entitlement.status).toBe(200);
  const consumeBody = {
    quantity: 1,
    source_ref: `spa-1-${runId}`,
    business_date: openDay,
  };
  const consume = await apiRequest(
    admin.context,
    'POST',
    `${base()}/package-entitlements/${entitlement.body.id}/consumptions`,
    {
      body: consumeBody,
      headers: { 'idempotency-key': key('consume') },
    },
  );
  expect(consume.status).toBe(200);
  const consumeReplay = await apiRequest(
    admin.context,
    'POST',
    `${base()}/package-entitlements/${entitlement.body.id}/consumptions`,
    {
      body: consumeBody,
      headers: { 'idempotency-key': key('consume') },
    },
  );
  expect(consumeReplay.status).toBe(200);
  expect(consumeReplay.body.replayed).toBe(true);
  const packageCharges = await dbOne(
    `select count(*)::int as "count" from "folio_charge"
      where "source_kind" = 'PACKAGE' and "source_ref" = $1`,
    [`package:${entitlement.body.id}:spa-1-${runId}`],
  );
  expect(packageCharges.count).toBe(1);

  const view = await clearance(longStayItem.reservationId);
  expect(view.status).toBe(200);
  expect(view.body.reservation.financial_clearance_state).toBe('PENDING');
  const folioView = view.body.folios.find(
    (entry) => entry.folio.id === folio.id,
  );
  expect(folioView.schedules).toHaveLength(1);
  expect(folioView.schedules[0].posted_periods).toBe(1);
  expect(folioView.schedules[0].next_period_start).toBe(addMonth(openDay));
  expect(folioView.entitlements[0].quantity_consumed).toBe(1);
  expect(folioView.totals.charges_total).toBe('600000');
  expect(folioView.totals.balance_due).toBe('600000');
});

test('P08-06 posted corrections change the clearance balance without editing the charge', async () => {
  const item = await createConfirmed(0, 7);
  expect((await checkIn(item, rooms.R6.id)).status).toBe(200);
  const folio = await openFolio(item.reservationId);
  const charge = await postCharge(folio.id, '100000', `correction-${runId}`);
  expect((await checkOut(item)).status).toBe(200);

  const before = await clearance(item.reservationId);
  expect(before.body.totals_by_currency[0].balance_due).toBe('100000');

  const reversal = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${charge.id}/reversal`,
    {
      body: { reason: 'posted in error' },
      headers: { 'idempotency-key': key('reversal') },
    },
  );
  expect(reversal.status).toBe(200);
  const after = await clearance(item.reservationId);
  expect(after.body.totals_by_currency[0].adjustments_total).toBe('-100000');
  expect(after.body.totals_by_currency[0].balance_due).toBe('0');
  expect(after.body.balanced).toBe(true);
  const storedCharge = await dbOne(
    `select "net_amount"::text as "net_amount" from "folio_charge" where "id" = $1`,
    [charge.id],
  );
  expect(storedCharge.net_amount).toBe('100000.000000');

  const settled = await settle(
    item.reservationId,
    { version: await reservationVersion(item.reservationId), basis: 'SETTLED' },
    'correction-settle',
  );
  expect(settled.status).toBe(200);
  expect(settled.body.financial_clearance_state).toBe('CLEARED');
});

test('P08-06 a reversal after CLEARED reopens the reservation and keeps the ledger balance', async () => {
  const item = await createConfirmed(0, 9);
  expect((await checkIn(item, rooms.R9.id)).status).toBe(200);
  const folio = await openFolio(item.reservationId);
  const charge = await postCharge(
    folio.id,
    '120000',
    `reopen-reversal-${runId}`,
  );
  expect((await checkOut(item)).status).toBe(200);
  expect(
    (await recordPayment(folio.id, '120000', `reopen-reversal-pay-${runId}`))
      .status,
  ).toBe(200);
  const settled = await settle(
    item.reservationId,
    { version: await reservationVersion(item.reservationId), basis: 'SETTLED' },
    'reopen-reversal-settle',
  );
  expect(settled.status).toBe(200);
  expect(settled.body.financial_clearance_state).toBe('CLEARED');

  const reversal = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${charge.id}/reversal`,
    {
      body: { reason: 'guest dispute' },
      headers: { 'idempotency-key': key('reopen-reversal') },
    },
  );
  expect(reversal.status).toBe(200);

  const stored = await dbReservation(item.reservationId);
  expect(stored.financial_clearance_state).toBe('PENDING');
  expect(stored.financial_cleared_at).toBeNull();
  expect(stored.financial_clearance_basis).toBeNull();
  expect(
    await dbAudit('finance.clearance_reopened', item.reservationId),
  ).toEqual({ count: 1 });

  const view = await clearance(item.reservationId);
  expect(view.status).toBe(200);
  expect(view.body.reservation.financial_clearance_state).toBe('PENDING');
  expect(view.body.settled).toBe(false);
  expect(view.body.credit).toBe(true);
  expect(view.body.totals_by_currency[0].adjustments_total).toBe('-120000');
  expect(view.body.totals_by_currency[0].balance_due).toBe('-120000');
});

test('P08-06 an adjustment after CLEARED reopens the reservation and changes the balance', async () => {
  const item = await createConfirmed(0, 10);
  expect((await checkIn(item, rooms.R10.id)).status).toBe(200);
  const folio = await openFolio(item.reservationId);
  const charge = await postCharge(folio.id, '200000', `reopen-adjust-${runId}`);
  expect((await checkOut(item)).status).toBe(200);
  expect(
    (await recordPayment(folio.id, '200000', `reopen-adjust-pay-${runId}`))
      .status,
  ).toBe(200);
  const settled = await settle(
    item.reservationId,
    { version: await reservationVersion(item.reservationId), basis: 'SETTLED' },
    'reopen-adjust-settle',
  );
  expect(settled.status).toBe(200);

  const adjustment = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${charge.id}/adjustments`,
    {
      body: {
        money: { amount: '50000', currency: 'IDR' },
        direction: 'INCREASE',
        reason: 'late checkout fee',
      },
      headers: { 'idempotency-key': key('reopen-adjust') },
    },
  );
  expect(adjustment.status).toBe(200);

  const stored = await dbReservation(item.reservationId);
  expect(stored.financial_clearance_state).toBe('PENDING');
  expect(stored.financial_cleared_at).toBeNull();
  expect(
    await dbAudit('finance.clearance_reopened', item.reservationId),
  ).toEqual({ count: 1 });

  const view = await clearance(item.reservationId);
  expect(view.body.outstanding).toBe(true);
  expect(view.body.totals_by_currency[0].adjustments_total).toBe('50000');
  expect(view.body.totals_by_currency[0].balance_due).toBe('50000');

  const folioView = await apiRequest(
    admin.context,
    'GET',
    `${base()}/folios/${folio.id}`,
  );
  expect(folioView.status).toBe(200);
  expect(folioView.body.totals.adjustments_total).toBe('50000');
  expect(folioView.body.totals.balance_due).toBe('50000');
});

test('P08-06 a credit note corrects the folio balance, reopens clearance and blocks clearing as credit', async () => {
  const item = await createConfirmed(0, 11);
  expect((await checkIn(item, rooms.R11.id)).status).toBe(200);
  const folio = await openFolio(item.reservationId);
  await postCharge(folio.id, '200000', `credit-note-${runId}`);
  expect((await checkOut(item)).status).toBe(200);
  expect(
    (await recordPayment(folio.id, '200000', `credit-note-pay-${runId}`))
      .status,
  ).toBe(200);
  const settled = await settle(
    item.reservationId,
    { version: await reservationVersion(item.reservationId), basis: 'SETTLED' },
    'credit-note-settle',
  );
  expect(settled.status).toBe(200);
  expect(settled.body.financial_clearance_state).toBe('CLEARED');

  const invoice = await apiRequest(
    admin.context,
    'POST',
    `${base()}/invoices`,
    {
      body: {
        folio_id: folio.id,
        series: 'INV',
        kind: 'SYNTHETIC',
        source_ref: `credit-note-inv-${runId}`,
        business_date: openDay,
        money: { amount: '200000', currency: 'IDR' },
      },
      headers: { 'idempotency-key': key('credit-note-inv') },
    },
  );
  expect(invoice.status).toBe(200);
  const note = await apiRequest(
    admin.context,
    'POST',
    `${base()}/invoices/${invoice.body.id}/credit-notes`,
    {
      body: {
        money: { amount: '50000', currency: 'IDR' },
        reason: 'service recovery',
        source_ref: `credit-note-cn-${runId}`,
      },
      headers: { 'idempotency-key': key('credit-note-cn') },
    },
  );
  expect(note.status).toBe(200);

  const stored = await dbReservation(item.reservationId);
  expect(stored.financial_clearance_state).toBe('PENDING');
  expect(stored.financial_cleared_at).toBeNull();
  expect(
    await dbAudit('finance.clearance_reopened', item.reservationId),
  ).toEqual({ count: 1 });

  const folioView = await apiRequest(
    admin.context,
    'GET',
    `${base()}/folios/${folio.id}`,
  );
  expect(folioView.status).toBe(200);
  expect(folioView.body.totals.adjustments_total).toBe('-50000');
  expect(folioView.body.totals.balance_due).toBe('-50000');
  const invoices = await apiRequest(
    admin.context,
    'GET',
    `${base()}/invoices?folio_id=${folio.id}`,
  );
  expect(invoices.status).toBe(200);
  expect(invoices.body.invoices).toHaveLength(1);
  expect(invoices.body.invoices[0].credit_notes).toHaveLength(1);

  const view = await clearance(item.reservationId);
  expect(view.body.credit).toBe(true);
  expect(view.body.totals_by_currency[0].balance_due).toBe('-50000');
  const blocked = await settle(
    item.reservationId,
    { version: await reservationVersion(item.reservationId), basis: 'SETTLED' },
    'credit-note-blocked',
  );
  expect(blocked.status).toBe(422);
  expect(blocked.body.code).toBe('CLEARANCE_CREDIT');
});

test('P08-06 declared money currency must match the ledger currency on every money field', async () => {
  const item = await createConfirmed(0, 12);
  expect((await checkIn(item, rooms.R12.id)).status).toBe(200);
  const folio = await openFolio(item.reservationId);
  const charge = await postCharge(
    folio.id,
    '100000',
    `currency-guard-${runId}`,
  );
  const usd = { amount: '1000', currency: 'USD' };

  const mismatch = async (response, field) => {
    expect(response.status).toBe(400);
    expect(response.body.details.field).toBe(field);
    expect(response.body.details.reason).toBe('currency_mismatch');
  };

  const taxMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges`,
    {
      body: {
        folio_id: folio.id,
        business_date: openDay,
        money: { amount: '1000', currency: 'IDR' },
        tax_money: usd,
        account_code: 'REVENUE_OTHER',
        source_ref: `currency-tax-${runId}`,
      },
      headers: { 'idempotency-key': key('currency-tax') },
    },
  );
  await mismatch(taxMismatch, 'tax_money.currency');

  const paymentMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments`,
    {
      body: {
        folio_id: folio.id,
        method: 'CASH',
        money: usd,
        business_date: openDay,
        external_reference: `currency-money-${runId}`,
        source_ref: `currency-money-${runId}`,
      },
      headers: { 'idempotency-key': key('currency-money') },
    },
  );
  await mismatch(paymentMismatch, 'money.currency');

  const grossMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments`,
    {
      body: {
        folio_id: folio.id,
        method: 'OTA_SETTLEMENT',
        money: { amount: '100000', currency: 'IDR' },
        gross_money: { amount: '105000', currency: 'USD' },
        commission_money: { amount: '5000', currency: 'IDR' },
        business_date: openDay,
        external_reference: `currency-gross-${runId}`,
        evidence_ref: randomUUID(),
        source_ref: `currency-gross-${runId}`,
      },
      headers: { 'idempotency-key': key('currency-gross') },
    },
  );
  await mismatch(grossMismatch, 'gross_money.currency');

  const payment = await recordPayment(
    folio.id,
    '100000',
    `currency-pay-${runId}`,
  );
  expect(payment.status).toBe(200);
  const refundMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/payments/${payment.body.id}/refunds`,
    {
      body: { money: usd, reason: 'currency probe' },
      headers: { 'idempotency-key': key('currency-refund') },
    },
  );
  await mismatch(refundMismatch, 'money.currency');

  const adjustmentMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${charge.id}/adjustments`,
    {
      body: { money: usd, direction: 'DECREASE', reason: 'currency probe' },
      headers: { 'idempotency-key': key('currency-adjust') },
    },
  );
  await mismatch(adjustmentMismatch, 'money.currency');

  const invoiceMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/invoices`,
    {
      body: {
        folio_id: folio.id,
        series: 'INV',
        kind: 'SYNTHETIC',
        source_ref: `currency-inv-${runId}`,
        business_date: openDay,
        money: usd,
      },
      headers: { 'idempotency-key': key('currency-inv') },
    },
  );
  await mismatch(invoiceMismatch, 'money.currency');

  const invoice = await apiRequest(
    admin.context,
    'POST',
    `${base()}/invoices`,
    {
      body: {
        folio_id: folio.id,
        series: 'INV',
        kind: 'SYNTHETIC',
        source_ref: `currency-inv-ok-${runId}`,
        business_date: openDay,
        money: { amount: '100000', currency: 'IDR' },
      },
      headers: { 'idempotency-key': key('currency-inv-ok') },
    },
  );
  expect(invoice.status).toBe(200);
  const noteMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/invoices/${invoice.body.id}/credit-notes`,
    {
      body: {
        money: usd,
        reason: 'currency probe',
        source_ref: `currency-cn-${runId}`,
      },
      headers: { 'idempotency-key': key('currency-cn') },
    },
  );
  await mismatch(noteMismatch, 'money.currency');

  const depositMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/folios/${folio.id}/deposits`,
    {
      body: {
        kind: 'DEPOSIT',
        method: 'CASH',
        money: usd,
        business_date: openDay,
        external_reference: `currency-dep-${runId}`,
        source_ref: `currency-dep-${runId}`,
      },
      headers: { 'idempotency-key': key('currency-dep') },
    },
  );
  await mismatch(depositMismatch, 'money.currency');

  const scheduleMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/folios/${folio.id}/charge-schedules`,
    {
      body: {
        code: `CUR-${runId}`.slice(0, 32),
        quantity: 1,
        money: usd,
        interval: 'MONTH',
        starts_on: openDay,
      },
      headers: { 'idempotency-key': key('currency-schedule') },
    },
  );
  await mismatch(scheduleMismatch, 'money.currency');

  const packageMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/folios/${folio.id}/packages`,
    {
      body: {
        code: `CUR-${runId}`.slice(0, 32),
        quantity_total: 1,
        unit_money: usd,
      },
      headers: { 'idempotency-key': key('currency-package') },
    },
  );
  await mismatch(packageMismatch, 'unit_money.currency');

  const company = await openFolio(null, 'COMPANY', `Currency payer ${runId}`);
  const routeMismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/charges/${charge.id}/allocations`,
    {
      body: {
        allocations: [
          {
            payer_folio_id: company.id,
            money: { amount: '1000', currency: 'USD' },
          },
        ],
      },
      headers: { 'idempotency-key': key('currency-route') },
    },
  );
  await mismatch(routeMismatch, 'allocations[0].money.currency');

  const folioAfter = await apiRequest(
    admin.context,
    'GET',
    `${base()}/folios/${folio.id}`,
  );
  expect(folioAfter.body.totals.balance_due).toBe('0');
});

test('P08-06 clearance evidence is enforced at the database level', async () => {
  const item = await createConfirmed(0, 8);
  expect((await checkIn(item, rooms.R7.id)).status).toBe(200);
  expect((await checkOut(item)).status).toBe(200);
  await withTestRole(async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(
        `update "reservation"
            set "financial_clearance_state" = 'CLEARED'
          where "id" = $1`,
        [item.reservationId],
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
        `update "reservation"
            set "financial_clearance_state" = 'CLEARED',
                "financial_cleared_at" = now(),
                "financial_clearance_basis" = 'TRANSFER_TO_PAYER'
          where "id" = $1`,
        [item.reservationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query('rollback');
  });
  const stored = await dbReservation(item.reservationId);
  expect(stored.financial_clearance_state).toBe('PENDING');
  expect(stored.financial_cleared_at).toBeNull();
});
