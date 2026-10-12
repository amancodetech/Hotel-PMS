import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { phase10Operations } from '../../apps/api/dist/night-audit/operations.js';
import {
  claimRun,
  executeNightAuditRun,
  runScopedTransaction,
} from '../../packages/backend/dist/index.js';
import { createOrm } from '../../packages/backend/dist/persistence/orm.js';
import {
  apiRequest,
  closeBrowser,
  closeSessions,
  loginAs,
  startApi,
  stopApi,
  testDatabaseUrl,
  withOwner,
  withRuntimeRole,
} from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
const tenantB = process.env.IDENTITY_TENANT_B;

// Fixed synthetic seed, no real guest data.
const seed = 20261001;
const runId = `P10A${seed}`;
const key = (name) => `p10-${name}-${runId}-${String(name).length}`;

let admin;
let ownerB;
let member;

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextIsoDay(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function localToday(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
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

async function createProperty(suffix, roomCount = 4) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: `P10-${suffix}-${runId}`,
        name: `P10 ${suffix} ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  const property = created.body.property;
  const rooms = [];
  for (let index = 1; index <= roomCount; index += 1) {
    const resource = await apiRequest(
      admin.context,
      'POST',
      `${base(property.id)}/resources`,
      {
        body: {
          code: `P10-${suffix}-R${index}-${runId}`,
          type: 'ROOM',
          capacity: 2,
        },
      },
    );
    expect(resource.status).toBe(201);
    rooms.push(resource.body.resource);
  }
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base(property.id)}/products`,
    {
      body: {
        code: `P10-${suffix}-P-${runId}`,
        name: `P10 ${suffix} ${runId}`,
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(product.status).toBe(201);
  const productId = product.body.product.id;
  for (const room of rooms) {
    const candidate = await apiRequest(
      admin.context,
      'POST',
      `${base(property.id)}/products/${productId}/candidates`,
      { body: { resource_id: room.id } },
    );
    expect(candidate.status).toBe(201);
  }
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base(property.id)}/products/${productId}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  const plan = await apiRequest(
    admin.context,
    'POST',
    `${base(property.id)}/rate-plans`,
    {
      body: {
        code: `P10-${suffix}-RP-${runId}`,
        name: `P10 ${suffix} ${runId}`,
        product_id: productId,
        currency: 'IDR',
      },
    },
  );
  expect(plan.status).toBe(201);
  const planId = plan.body.rate_plan.id;
  expect(
    (
      await apiRequest(
        admin.context,
        'PATCH',
        `${base(property.id)}/rate-plans/${planId}`,
        { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
      )
    ).status,
  ).toBe(200);
  const cells = [];
  for (let offset = 0; offset <= 40; offset += 1) {
    cells.push({
      rate_plan_id: planId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '300000', currency: 'IDR' },
    });
  }
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
  return { property, rooms, productId, planId };
}

async function quote(scope, productId, planId, arrival, departure) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/quotes`,
    {
      body: {
        product_id: productId,
        rate_plan_id: planId,
        period: { arrival: addDays(arrival), departure: addDays(departure) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    },
  );
  expect(response.status).toBe(201);
  return response.body.quote.id;
}

async function createConfirmed(scope, arrival, departure) {
  const draft = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: [
          {
            product_id: scope.productId,
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
    `${base(scope.property.id)}/reservations/${reservationId}`,
  );
  expect(detail.status).toBe(200);
  const itemId = detail.body.items[0].id;
  const rates = await apiRequest(
    admin.context,
    'GET',
    `${base(scope.property.id)}/rates?from=${addDays(0)}&to=${addDays(40)}`,
  );
  expect(rates.status).toBe(200);
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/reservations`,
    {
      body: {
        reservation_id: reservationId,
        inventory_version: rates.body.inventory_version,
        items: [
          {
            item_id: itemId,
            price_snapshot_id: await quote(
              scope,
              scope.productId,
              scope.planId,
              arrival,
              departure,
            ),
          },
        ],
      },
    },
  );
  expect(confirmed.status).toBe(200);
  return { reservationId, itemId };
}

async function checkIn(scope, item, resourceId) {
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base(scope.property.id)}/reservations/${item.reservationId}`,
  );
  const row = detail.body.items.find((entry) => entry.id === item.itemId);
  return apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/reservations/${item.reservationId}/items/${item.itemId}/check-in`,
    {
      body: { version: row.version, resource_id: resourceId },
      headers: { 'idempotency-key': key(`ci-${item.itemId}`) },
    },
  );
}

async function openFolio(scope, reservationId) {
  const response = await apiRequest(
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
      headers: { 'idempotency-key': key(`folio-${randomUUID()}`) },
    },
  );
  expect(response.status).toBe(200);
  return response.body.folio;
}

async function runAudit(scope, date, name = 'audit', context = admin.context) {
  return apiRequest(
    context,
    'POST',
    `${base(scope.property.id)}/night-audits`,
    {
      body: { business_date: date },
      headers: { 'idempotency-key': key(name) },
    },
  );
}

async function overview(scope, date, context = admin.context) {
  const query = date ? `?date=${date}` : '';
  return apiRequest(
    context,
    'GET',
    `${base(scope.property.id)}/night-audits${query}`,
  );
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  ownerB = await loginAs('owner-b');
  member = await loginAs('member-a');
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P10 phase 10 contract lists exactly the implemented operations', () => {
  const contract = JSON.parse(
    readFileSync('docs/contracts/phase10.openapi.json', 'utf8'),
  );
  const operations = [];
  for (const [path, item] of Object.entries(contract.paths)) {
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
  const manifest = [...phase10Operations].sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );
  expect(manifest).toEqual(
    operations.sort((a, b) => a.operationId.localeCompare(b.operationId)),
  );
  expect(operations.map((operation) => operation.operationId)).toContain(
    'StartNightAudit',
  );
  const start = phase10Operations.find(
    (operation) => operation.operationId === 'StartNightAudit',
  );
  expect(start?.permission).toBe('business_day.close');
  expect(start?.csrf).toBe(true);
});

test('P10-01 night audit posts one stay-night charge and closes the day', async () => {
  const scope = await createProperty('CLOSE');
  const stay = await createConfirmed(scope, 0, 2);
  expect((await checkIn(scope, stay, scope.rooms[0].id)).status).toBe(200);
  const folio = await openFolio(scope, stay.reservationId);
  const today = localToday('Asia/Jakarta');

  const response = await runAudit(scope, today, 'close');
  expect(response.status).toBe(200);
  expect(response.body.closed.state).toBe('CLOSED');
  expect(response.body.closed.business_date).toBe(today);
  expect(response.body.opened.state).toBe('OPEN');
  expect(response.body.business_day.business_date).toBe(nextIsoDay(today));
  expect(response.body.run.state).toBe('SUCCEEDED');
  expect(response.body.steps.every((step) => step.state === 'DONE')).toBe(true);
  expect(response.body.replayed).toBe(false);

  const charges = await dbRows(
    `select "id", "net_amount"::text as "net_amount", "source_kind", "source_ref",
            "business_date"::text as "business_date", "journal_id"
       from "folio_charge"
      where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'`,
    [scope.property.id],
  );
  expect(charges).toHaveLength(1);
  expect(charges[0].source_ref).toBe(`${stay.itemId}:${today}`);
  expect(Number(charges[0].net_amount)).toBe(300000);
  expect(charges[0].business_date).toBe(today);

  const journal = await dbOne(
    `select j."total_debit"::text as "total_debit", j."total_credit"::text as "total_credit",
            (select count(*)::int from "journal_line" l where l."journal_id" = j."id") as "lines"
       from "journal" j where j."id" = $1`,
    [charges[0].journal_id],
  );
  expect(journal.total_debit).toBe(journal.total_credit);
  expect(journal.lines).toBeGreaterThanOrEqual(2);

  const day = await dbOne(
    `select "state" from "business_day" where "property_id" = $1 and "business_date" = $2`,
    [scope.property.id, today],
  );
  expect(day.state).toBe('CLOSED');

  const replay = await runAudit(scope, today, 'close');
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  const again = await dbRows(
    `select "id" from "folio_charge"
      where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'`,
    [scope.property.id],
  );
  expect(again).toHaveLength(1);

  const newKey = await runAudit(scope, today, 'close-again');
  expect(newKey.status).toBe(200);
  expect(newKey.body.replayed).toBe(true);
  expect(newKey.body.closed.business_date).toBe(today);
  const third = await dbRows(
    `select "id" from "folio_charge"
      where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'`,
    [scope.property.id],
  );
  expect(third).toHaveLength(1);

  const view = await overview(scope, today);
  expect(view.status).toBe(200);
  expect(view.body.run.state).toBe('SUCCEEDED');
  expect(view.body.business_day.state).toBe('CLOSED');
  expect(view.body.exceptions).toHaveLength(1);
  expect(view.body.exceptions[0].code).toBe('OUTSTANDING_BALANCE');
  expect(view.body.exceptions[0].details.balance_due).toBe('300000');
  expect(view.body.open_blocking).toBe(0);
  expect(folio.id).toBeTruthy();
});

test('P10-01 unresolved arrivals block the close, are never auto no-show, and acknowledge then close', async () => {
  const scope = await createProperty('ARRIVAL');
  const stay = await createConfirmed(scope, 0, 2);
  const today = localToday('Asia/Jakarta');

  const blocked = await runAudit(scope, today, 'arrival-blocked');
  expect(blocked.status).toBe(422);
  expect(blocked.body.code).toBe('AUDIT_EXCEPTIONS_OPEN');
  expect(blocked.body.details.open_blocking).toBe(1);

  const itemState = await dbOne(
    `select "state" from "reservation_item" where "id" = $1`,
    [stay.itemId],
  );
  expect(itemState.state).toBe('CONFIRMED');
  const day = await dbOne(
    `select "state" from "business_day" where "property_id" = $1 and "business_date" = $2`,
    [scope.property.id, today],
  );
  expect(day.state).toBe('AUDIT_VALIDATION');

  const exception = await dbOne(
    `select e."id", e."code", e."severity", e."state", e."owner_label"
       from "night_audit_exception" e
      where e."property_id" = $1 and e."code" = 'ARRIVAL_NOT_RESOLVED'`,
    [scope.property.id],
  );
  expect(exception.severity).toBe('BLOCKING');
  expect(exception.state).toBe('OPEN');
  expect(exception.owner_label).toBeNull();

  const missingOwner = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/night-audits/exceptions/${exception.id}/resolution`,
    {
      body: { reason: 'ننتظر وصول النزيل', owner_label: '' },
      headers: { 'idempotency-key': key('resolve-empty') },
    },
  );
  expect(missingOwner.status).toBe(400);

  const resolved = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/night-audits/exceptions/${exception.id}/resolution`,
    {
      body: { reason: 'تم التواصل مع النزيل وتأكيد الوصول متأخراً' },
      headers: { 'idempotency-key': key('resolve-arrival') },
    },
  );
  expect(resolved.status).toBe(200);
  expect(resolved.body.exception.state).toBe('ACKNOWLEDGED');
  expect(resolved.body.exception.owner_label).toBeTruthy();
  expect(resolved.body.exception.resolution_reason).toContain('النزيل');

  const closed = await runAudit(scope, today, 'arrival-close');
  expect(closed.status).toBe(200);
  expect(closed.body.closed.state).toBe('CLOSED');
  const afterItem = await dbOne(
    `select "state" from "reservation_item" where "id" = $1`,
    [stay.itemId],
  );
  expect(afterItem.state).toBe('CONFIRMED');
  const afterException = await dbOne(
    `select "state", "resolution_reason" from "night_audit_exception" where "id" = $1`,
    [exception.id],
  );
  expect(afterException.state).toBe('ACKNOWLEDGED');
});

test('P10-01 outstanding balances and in-house departures are surfaced, not hidden or auto-resolved', async () => {
  const scope = await createProperty('WARN');
  const overdue = await createConfirmed(scope, 0, 1);
  expect((await checkIn(scope, overdue, scope.rooms[0].id)).status).toBe(200);
  const today = localToday('Asia/Jakarta');
  // Synthetic fixture (F-RVW10-01): a one-night stay due out on the business date
  // and still in house; segment dates derive from the business date, not UTC today.
  await withOwner(async (client) => {
    await client.query(
      `update "stay_segment"
          set "start_date" = $3::date - 1, "end_date" = $3
        where "item_id" = $1 and "property_id" = $2`,
      [overdue.itemId, scope.property.id, today],
    );
  });
  const stay = await createConfirmed(scope, 0, 2);
  expect((await checkIn(scope, stay, scope.rooms[1].id)).status).toBe(200);
  const folio = await openFolio(scope, stay.reservationId);
  const charge = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/charges`,
    {
      body: {
        folio_id: folio.id,
        business_date: today,
        money: { amount: '125000', currency: 'IDR' },
        account_code: 'REVENUE_OTHER',
        source_ref: `p10-warn-${runId}`,
      },
      headers: { 'idempotency-key': key('warn-charge') },
    },
  );
  expect(charge.status).toBe(200);

  const blocked = await runAudit(scope, today, 'warn-blocked');
  expect(blocked.status).toBe(422);
  expect(blocked.body.details.open_blocking).toBe(1);
  const exception = await dbOne(
    `select "code", "severity", "state", "details"
       from "night_audit_exception"
      where "property_id" = $1 and "code" = 'DEPARTURE_NOT_RESOLVED'`,
    [scope.property.id],
  );
  expect(exception.severity).toBe('BLOCKING');
  const segment = await dbOne(
    `select "state" from "stay_segment" where "item_id" = $1`,
    [overdue.itemId],
  );
  expect(segment.state).toBe('IN_HOUSE');

  const resolved = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/night-audits/exceptions/${
      (
        await dbOne(
          `select "id" from "night_audit_exception"
          where "property_id" = $1 and "code" = 'DEPARTURE_NOT_RESOLVED'`,
          [scope.property.id],
        )
      ).id
    }/resolution`,
    {
      body: { reason: 'تأخر المغادرة بموافقة إدارية' },
      headers: { 'idempotency-key': key('warn-resolve') },
    },
  );
  expect(resolved.status).toBe(200);

  const closed = await runAudit(scope, today, 'warn-close');
  expect(closed.status).toBe(200);
  const warning = closed.body.exceptions.find(
    (entry) => entry.code === 'OUTSTANDING_BALANCE',
  );
  expect(warning.severity).toBe('WARNING');
  expect(warning.details.balance_due).toBe('425000');
  const afterSegment = await dbOne(
    `select "state" from "stay_segment" where "item_id" = $1`,
    [overdue.itemId],
  );
  expect(afterSegment.state).toBe('IN_HOUSE');
});

test('P10-01 missing folio keeps the day open and reports the missing charge', async () => {
  const scope = await createProperty('NOFOLIO');
  const stay = await createConfirmed(scope, 0, 2);
  expect((await checkIn(scope, stay, scope.rooms[0].id)).status).toBe(200);
  const today = localToday('Asia/Jakarta');

  const blocked = await runAudit(scope, today, 'nofolio');
  expect(blocked.status).toBe(422);
  expect(blocked.body.details.open_blocking).toBe(1);
  const exception = await dbOne(
    `select "code", "subject_id", "state" from "night_audit_exception"
      where "property_id" = $1 and "code" = 'MISSING_FOLIO'`,
    [scope.property.id],
  );
  expect(exception.subject_id).toBe(stay.reservationId);
  const charges = await dbRows(
    `select "id" from "folio_charge" where "property_id" = $1`,
    [scope.property.id],
  );
  expect(charges).toHaveLength(0);
  const day = await dbOne(
    `select "state" from "business_day"
      where "property_id" = $1 and "business_date" = $2`,
    [scope.property.id, today],
  );
  expect(day.state).toBe('AUDIT_VALIDATION');
});

test('P10-02 a posting racing the close either lands before the barrier or gets a retryable BUSY', async () => {
  const scope = await createProperty('RACE');
  const stay = await createConfirmed(scope, 0, 2);
  expect((await checkIn(scope, stay, scope.rooms[0].id)).status).toBe(200);
  const folio = await openFolio(scope, stay.reservationId);
  const today = localToday('Asia/Jakarta');
  const next = nextIsoDay(today);

  const [audit, posting] = await Promise.all([
    runAudit(scope, today, 'race-audit'),
    apiRequest(admin.context, 'POST', `${base(scope.property.id)}/charges`, {
      body: {
        folio_id: folio.id,
        business_date: today,
        money: { amount: '90000', currency: 'IDR' },
        account_code: 'REVENUE_OTHER',
        source_ref: `p10-race-${runId}`,
      },
      headers: { 'idempotency-key': key('race-charge') },
    }),
  ]);
  expect(audit.status).toBe(200);
  expect(posting.status).toBe(200);
  const todayCharges = await dbRows(
    `select c."id", j."business_date"::text as "business_date"
       from "folio_charge" c join "journal" j on j."id" = c."journal_id"
      where c."property_id" = $1 and c."source_kind" = 'MANUAL'`,
    [scope.property.id],
  );
  expect(todayCharges).toHaveLength(1);
  expect(todayCharges[0].business_date).toBe(today);

  const closedCharge = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/charges`,
    {
      body: {
        folio_id: folio.id,
        business_date: next,
        money: { amount: '1000', currency: 'IDR' },
        account_code: 'REVENUE_OTHER',
        source_ref: `p10-after-close-${runId}`,
      },
      headers: { 'idempotency-key': key('after-close') },
    },
  );
  expect(closedCharge.status).toBe(200);
  const day = await dbOne(
    `select "state" from "business_day"
      where "property_id" = $1 and "business_date" = $2`,
    [scope.property.id, next],
  );
  expect(day.state).toBe('OPEN');
});

test('P10-02 concurrent closes leave exactly one closed day and one open next day', async () => {
  const scope = await createProperty('DOUBLE');
  const stay = await createConfirmed(scope, 0, 2);
  expect((await checkIn(scope, stay, scope.rooms[0].id)).status).toBe(200);
  await openFolio(scope, stay.reservationId);
  const today = localToday('Asia/Jakarta');
  const next = nextIsoDay(today);

  const [first, second] = await Promise.all([
    runAudit(scope, today, 'double-a'),
    runAudit(scope, today, 'double-b'),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(
    statuses.filter((status) => status === 200).length,
  ).toBeGreaterThanOrEqual(1);
  for (const status of statuses) expect([200, 409]).toContain(status);

  const closed = await dbRows(
    `select "id" from "business_day"
      where "property_id" = $1 and "business_date" = $2 and "state" = 'CLOSED'`,
    [scope.property.id, today],
  );
  expect(closed).toHaveLength(1);
  const open = await dbRows(
    `select "id" from "business_day"
      where "property_id" = $1 and "state" <> 'CLOSED'`,
    [scope.property.id],
  );
  expect(open).toHaveLength(1);
  const openDay = await dbOne(
    `select "business_date"::text as "business_date" from "business_day"
      where "property_id" = $1 and "state" <> 'CLOSED'`,
    [scope.property.id],
  );
  expect(openDay.business_date).toBe(next);
  const charges = await dbRows(
    `select "id" from "folio_charge"
      where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'`,
    [scope.property.id],
  );
  expect(charges).toHaveLength(1);
  const runs = await dbRows(
    `select "id" from "night_audit_run" where "property_id" = $1`,
    [scope.property.id],
  );
  expect(runs).toHaveLength(1);
});

test('P10-02 CLOSING barrier returns a retryable BUSY and the resume closes exactly once (AT-F07)', async () => {
  const scope = await createProperty('BARRIER');
  const stay = await createConfirmed(scope, 0, 2);
  expect((await checkIn(scope, stay, scope.rooms[0].id)).status).toBe(200);
  const folio = await openFolio(scope, stay.reservationId);
  const today = localToday('Asia/Jakarta');
  const next = nextIsoDay(today);

  const started = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/night-audits/runs`,
    {
      body: { business_date: today },
      headers: { 'idempotency-key': key('barrier-start') },
    },
  );
  expect(started.status).toBe(202);
  expect(started.body.run.state).toBe('PENDING');
  const runId = started.body.run.id;

  const orm = await createOrm(testDatabaseUrl);
  try {
    const claimed = await runScopedTransaction(
      orm,
      { tenantId: tenantA },
      (em) =>
        claimRun(em, {
          tenantId: tenantA,
          propertyId: scope.property.id,
          runId,
          leaseOwner: 'p10-barrier-owner',
          leaseMs: 120000,
        }),
    );
    expect(claimed?.state).toBe('RUNNING');
    const half = await executeNightAuditRun(orm, runId, {
      tenantId: tenantA,
      propertyId: scope.property.id,
      timezone: 'Asia/Jakarta',
      actor: { actorType: 'SERVICE', actorId: null, actorLabel: 'p10-test' },
      correlationId: null,
      leaseOwner: 'p10-barrier-owner',
      leaseMs: 120000,
      lockProperty: true,
      maxSteps: 8,
    });
    expect(half.run.state).toBe('RUNNING');
    expect(half.run.current_step).toBe('CLOSING_BARRIER');
    const closing = await dbOne(
      `select "state" from "business_day"
        where "property_id" = $1 and "business_date" = $2`,
      [scope.property.id, today],
    );
    expect(closing.state).toBe('CLOSING');

    const blocked = await apiRequest(
      admin.context,
      'POST',
      `${base(scope.property.id)}/charges`,
      {
        body: {
          folio_id: folio.id,
          business_date: today,
          money: { amount: '7500', currency: 'IDR' },
          account_code: 'REVENUE_OTHER',
          source_ref: `p10-barrier-${runId}`,
        },
        headers: { 'idempotency-key': key('barrier-charge') },
      },
    );
    expect(blocked.status).toBe(409);
    expect(['BUSINESS_DAY_BUSY', 'BUSINESS_DAY_CLOSED']).toContain(
      blocked.body.code,
    );

    const finished = await executeNightAuditRun(orm, runId, {
      tenantId: tenantA,
      propertyId: scope.property.id,
      timezone: 'Asia/Jakarta',
      actor: { actorType: 'SERVICE', actorId: null, actorLabel: 'p10-test' },
      correlationId: null,
      leaseOwner: 'p10-barrier-owner',
      leaseMs: 120000,
      lockProperty: true,
    });
    expect(finished.run.state).toBe('SUCCEEDED');
  } finally {
    await orm.close(true);
  }

  const closedCharge = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/charges`,
    {
      body: {
        folio_id: folio.id,
        business_date: today,
        money: { amount: '7500', currency: 'IDR' },
        account_code: 'REVENUE_OTHER',
        source_ref: `p10-barrier-${runId}`,
      },
      headers: { 'idempotency-key': key('barrier-charge') },
    },
  );
  expect(closedCharge.status).toBe(409);
  expect(closedCharge.body.code).toBe('BUSINESS_DAY_CLOSED');
  const retry = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/charges`,
    {
      body: {
        folio_id: folio.id,
        business_date: next,
        money: { amount: '7500', currency: 'IDR' },
        account_code: 'REVENUE_OTHER',
        source_ref: `p10-barrier-${runId}`,
      },
      headers: { 'idempotency-key': key('barrier-charge-next') },
    },
  );
  expect(retry.status).toBe(200);
  const charges = await dbRows(
    `select "id" from "folio_charge"
      where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'`,
    [scope.property.id],
  );
  expect(charges).toHaveLength(1);
});

test('P10-02 retry resumes a failed run after acknowledgement without a second charge', async () => {
  const scope = await createProperty('RETRY');
  const overdue = await createConfirmed(scope, 0, 1);
  expect((await checkIn(scope, overdue, scope.rooms[0].id)).status).toBe(200);
  const today = localToday('Asia/Jakarta');
  // Synthetic fixture (F-RVW10-01): due-out-today stay, business-date-derived segment.
  await withOwner(async (client) => {
    await client.query(
      `update "stay_segment"
          set "start_date" = $3::date - 1, "end_date" = $3
        where "item_id" = $1 and "property_id" = $2`,
      [overdue.itemId, scope.property.id, today],
    );
  });
  const stay = await createConfirmed(scope, 0, 2);
  expect((await checkIn(scope, stay, scope.rooms[1].id)).status).toBe(200);
  await openFolio(scope, stay.reservationId);
  await openFolio(scope, overdue.reservationId);

  const blocked = await runAudit(scope, today, 'retry-blocked');
  expect(blocked.status).toBe(422);
  const runs = await dbRows(
    `select "id", "state" from "night_audit_run" where "property_id" = $1`,
    [scope.property.id],
  );
  expect(runs).toHaveLength(1);
  expect(runs[0].state).toBe('VALIDATION_FAILED');
  const exception = await dbOne(
    `select "id" from "night_audit_exception"
      where "property_id" = $1 and "code" = 'DEPARTURE_NOT_RESOLVED'`,
    [scope.property.id],
  );
  const acknowledged = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/night-audits/exceptions/${exception.id}/resolution`,
    {
      body: { reason: 'مغادرة متأخرة مصرح بها ليلة واحدة' },
      headers: { 'idempotency-key': key('retry-ack') },
    },
  );
  expect(acknowledged.status).toBe(200);

  const retried = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/night-audits/runs/${runs[0].id}/retry`,
    {
      headers: { 'idempotency-key': key('retry-run') },
    },
  );
  expect(retried.status).toBe(200);
  expect(retried.body.run.state).toBe('SUCCEEDED');
  expect(retried.body.closed.state).toBe('CLOSED');
  const charges = await dbRows(
    `select "id" from "folio_charge"
      where "property_id" = $1 and "source_kind" = 'STAY_NIGHT'`,
    [scope.property.id],
  );
  expect(charges).toHaveLength(1);

  const replay = await apiRequest(
    admin.context,
    'POST',
    `${base(scope.property.id)}/night-audits/runs/${runs[0].id}/retry`,
    {
      headers: { 'idempotency-key': key('retry-run') },
    },
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
});

test('P10-01 night audit is scoped: member is denied, owner-b cannot see tenant A runs', async () => {
  const scope = await createProperty('SCOPE');
  const today = localToday('Asia/Jakarta');
  const seeded = await runAudit(scope, today, 'scope-seed');
  expect(seeded.status).toBe(200);
  const forbidden = await apiRequest(
    member.context,
    'GET',
    `${base(scope.property.id)}/night-audits`,
  );
  expect(forbidden.status).toBe(403);
  const crossTenant = await apiRequest(
    ownerB.context,
    'GET',
    `/tenants/${tenantB}/properties/${scope.property.id}/night-audits`,
  );
  expect([403, 404]).toContain(crossTenant.status);
  const noMfa = await runAudit(
    scope,
    today,
    'no-mfa',
    (await loginAs('owner-a')).context,
  );
  expect(noMfa.status).toBe(403);
  expect(noMfa.body.code).toBe('MFA_REQUIRED');
  const runs = await dbRows(
    `select "id" from "night_audit_run" where "property_id" = $1`,
    [scope.property.id],
  );
  expect(runs.length).toBeGreaterThanOrEqual(1);
  await withRuntimeRole('api', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantB,
    ]);
    const hidden = await client.query(
      `select count(*)::int as "count" from "night_audit_run"
        where "property_id" = $1`,
      [scope.property.id],
    );
    expect(hidden.rows[0].count).toBe(0);
    await client.query('rollback');
  });
  await withRuntimeRole('worker', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(`delete from "night_audit_run" where "id" = $1`, [
        runs[0].id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('rollback');
  });
  await withRuntimeRole('worker', async (client) => {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [
      tenantA,
    ]);
    await expect(
      client.query(
        `update "night_audit_run" set "state" = 'SUCCEEDED' where "id" = $1`,
        [runs[0].id],
      ),
    ).resolves.toBeTruthy();
    await client.query('rollback');
  });
});
