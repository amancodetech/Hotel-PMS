import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { phase6Operations } from '../../apps/api/dist/reservations/operations.js';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

const contract = JSON.parse(
  readFileSync('docs/contracts/phase6.openapi.json', 'utf8'),
);

let admin;
let tenant;
let property;

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function base() {
  return `/tenants/${tenant}/properties/${property.id}`;
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P6I-${randomUUID().slice(0, 8)}`,
        name: 'P06 idempotency',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

function contractOperations() {
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
  return operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
}

test('implemented route manifest matches the Phase 6 contract', () => {
  const fromContract = contractOperations();
  const fromCode = [...phase6Operations].sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );
  expect(fromCode).toEqual(fromContract);
});

test('mutating Phase 6 operations require CSRF and a permission', () => {
  for (const operation of contractOperations()) {
    expect(typeof operation.permission).toBe('string');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method))
      expect(operation.csrf).toBe(true);
  }
});

test('CreateReservationDraft requires and honors Idempotency-Key', async () => {
  const key = `p6-draft-${randomUUID()}`;
  const body = {
    source: 'DIRECT',
    items: [
      {
        period: { arrival: addDays(40), departure: addDays(41) },
        occupancy: { adults: 2, child_ages: [] },
      },
    ],
  };
  const missing = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    { body, idempotency: false },
  );
  expect(missing.status).toBe(400);
  expect(missing.body.code).toBe('INVALID_REQUEST');
  expect(missing.body.details.field).toBe('idempotency_key');
  const first = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    { body, headers: { 'idempotency-key': key } },
  );
  expect(first.status).toBe(201);
  const replay = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    { body, headers: { 'idempotency-key': key } },
  );
  expect(replay.status).toBe(201);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.reservation).toEqual(first.body.reservation);
  const count = await withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "reservation" where "id" = $1`,
          [first.body.reservation.id],
        )
      ).rows[0].count,
    ),
  );
  expect(count).toBe(1);
  const conflict = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    {
      body: {
        ...body,
        items: [
          {
            period: { arrival: addDays(42), departure: addDays(43) },
            occupancy: { adults: 2, child_ages: [] },
          },
        ],
      },
      headers: { 'idempotency-key': key },
    },
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.code).toBe('CONFLICT');
});

test('CreateGuest requires and honors Idempotency-Key', async () => {
  const key = `p6-guest-${randomUUID()}`;
  const body = { full_name: `Idempotent ${randomUUID()}` };
  const missing = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/guests`,
    { body, idempotency: false },
  );
  expect(missing.status).toBe(400);
  expect(missing.body.code).toBe('INVALID_REQUEST');
  expect(missing.body.details.field).toBe('idempotency_key');
  const first = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/guests`,
    { body, headers: { 'idempotency-key': key } },
  );
  expect(first.status).toBe(201);
  const replay = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/guests`,
    { body, headers: { 'idempotency-key': key } },
  );
  expect(replay.status).toBe(201);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.guest).toEqual(first.body.guest);
  const count = await withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "guest" where "id" = $1`,
          [first.body.guest.id],
        )
      ).rows[0].count,
    ),
  );
  expect(count).toBe(1);
  const conflict = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/guests`,
    {
      body: { full_name: `Different ${randomUUID()}` },
      headers: { 'idempotency-key': key },
    },
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.code).toBe('CONFLICT');
});

test('ImportReservations requires and honors Idempotency-Key', async () => {
  const key = `p6-import-${randomUUID()}`;
  const externalKey = `P6I-${randomUUID().slice(0, 8)}`;
  const content = [
    'external_key,arrival,departure,adults,quantity,product_code',
    `${externalKey},${addDays(40)},${addDays(42)},2,1,`,
    '',
  ].join('\n');
  const body = {
    mode: 'DRY_RUN',
    source: 'UPLOAD',
    file_name: 'p6-idempotency.csv',
    content_type: 'text/csv',
    content,
  };
  const missing = await apiRequest(admin.context, 'POST', `${base()}/imports`, {
    body,
    idempotency: false,
  });
  expect(missing.status).toBe(400);
  expect(missing.body.code).toBe('INVALID_REQUEST');
  expect(missing.body.details.field).toBe('idempotency_key');
  const first = await apiRequest(admin.context, 'POST', `${base()}/imports`, {
    body,
    headers: { 'idempotency-key': key },
  });
  expect(first.status).toBe(200);
  const replay = await apiRequest(admin.context, 'POST', `${base()}/imports`, {
    body,
    headers: { 'idempotency-key': key },
  });
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.run_id).toBe(first.body.run_id);
  const count = await withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "reservation_import_run" where "id" = $1`,
          [first.body.run_id],
        )
      ).rows[0].count,
    ),
  );
  expect(count).toBe(1);
  const conflict = await apiRequest(
    admin.context,
    'POST',
    `${base()}/imports`,
    {
      body: { ...body, content: `${content}\n` },
      headers: { 'idempotency-key': key },
    },
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.code).toBe('CONFLICT');
});

test('ConfirmReservation, ModifyReservation and CancelItem require Idempotency-Key', async () => {
  const draft = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: [
          {
            period: { arrival: addDays(44), departure: addDays(45) },
            occupancy: { adults: 2, child_ages: [] },
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
  const itemVersion = detail.body.items[0].version;

  const confirmMissing = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations`,
    {
      body: {
        reservation_id: reservationId,
        inventory_version: 1,
        items: [{ item_id: itemId, price_snapshot_id: randomUUID() }],
      },
      idempotency: false,
    },
  );
  expect(confirmMissing.status).toBe(400);
  expect(confirmMissing.body.code).toBe('INVALID_REQUEST');
  expect(confirmMissing.body.details.field).toBe('idempotency_key');

  const modifyMissing = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/reservations/${reservationId}`,
    {
      body: { version: 1, items: [{ item_id: itemId, quantity: 2 }] },
      idempotency: false,
    },
  );
  expect(modifyMissing.status).toBe(400);
  expect(modifyMissing.body.code).toBe('INVALID_REQUEST');
  expect(modifyMissing.body.details.field).toBe('idempotency_key');

  const cancelMissing = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${itemId}/cancel`,
    {
      body: { version: itemVersion, reason: 'p06 contract missing key' },
      idempotency: false,
    },
  );
  expect(cancelMissing.status).toBe(400);
  expect(cancelMissing.body.code).toBe('INVALID_REQUEST');
  expect(cancelMissing.body.details.field).toBe('idempotency_key');
});
