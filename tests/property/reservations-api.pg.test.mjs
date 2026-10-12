import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let tenantA;
let owner;
let admin;
let auditor;
let member;
let ownerB;
let property;

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function base() {
  return `/tenants/${tenantA}/properties/${property.id}`;
}

async function createGuest(name, email) {
  return apiRequest(owner.context, 'POST', `/tenants/${tenantA}/guests`, {
    body: { full_name: name, email },
  });
}

async function createDraft(items, guests) {
  return apiRequest(owner.context, 'POST', `${base()}/reservations/drafts`, {
    body: { source: 'DIRECT', items, guests },
  });
}

function item(offset, quantity = 1) {
  return {
    period: { arrival: addDays(offset), departure: addDays(offset + 2) },
    occupancy: { adults: 2, child_ages: [] },
    quantity,
  };
}

beforeAll(async () => {
  await startApi();
  owner = await loginAs('owner-a');
  admin = await loginAs('admin-a');
  auditor = await loginAs('auditor-a');
  member = await loginAs('member-a');
  ownerB = await loginAs('owner-b');
  tenantA = owner.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'P06A',
        name: 'P06 Draft property',
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

test('P06-01 guests are never merged by name', async () => {
  const first = await createGuest('P06 Similar Name', 'p06.first@example.com');
  expect(first.status).toBe(201);
  const second = await createGuest(
    'P06 Similar Name',
    'p06.second@example.com',
  );
  expect(second.status).toBe(201);
  expect(second.body.guest.id).not.toBe(first.body.guest.id);
  const list = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/guests?search=P06%20Similar`,
  );
  expect(list.status).toBe(200);
  expect(list.body.items.length).toBeGreaterThanOrEqual(2);
  const detail = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/guests/${first.body.guest.id}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body.guest.email).toBe('p06.first@example.com');
});

test('P06-01 guest search treats LIKE wildcards literally', async () => {
  const marker = randomUUID().slice(0, 8);
  const guests = [
    {
      name: `P06 Percent% ${marker}`,
      email: `p06.percent.${marker}@example.com`,
    },
    {
      name: `P06 Under_score ${marker}`,
      email: `p06.under.${marker}@example.com`,
    },
    {
      name: `P06 Back\\slash ${marker}`,
      email: `p06.back.${marker}@example.com`,
    },
  ];
  for (const guest of guests) {
    const created = await createGuest(guest.name, guest.email);
    expect(created.status).toBe(201);
    guest.id = created.body.guest.id;
  }
  const listed = async (search) => {
    const response = await apiRequest(
      owner.context,
      'GET',
      `/tenants/${tenantA}/guests?search=${encodeURIComponent(search)}`,
    );
    expect(response.status).toBe(200);
    return response.body.items.map((item) => item.id);
  };
  const all = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/guests`,
  );
  expect(all.status).toBe(200);
  const wildcard = await listed('%');
  expect(wildcard.length).toBeLessThan(all.body.items.length);
  expect(wildcard).toContain(guests[0].id);
  expect(wildcard).not.toContain(guests[1].id);
  const underscore = await listed('_');
  expect(underscore).toContain(guests[1].id);
  expect(underscore).not.toContain(guests[0].id);
  const literalPercent = await listed('Percent%');
  expect(literalPercent).toContain(guests[0].id);
  expect(literalPercent).not.toContain(guests[1].id);
  const literalUnderscore = await listed('Under_score');
  expect(literalUnderscore).toContain(guests[1].id);
  const literalBackslash = await listed('Back\\slash');
  expect(literalBackslash).toContain(guests[2].id);
});

test('P06-01 draft creation has no inventory effect and hides guests without guest.read', async () => {
  const guest = await createGuest('P06 Lead', 'p06.lead@example.com');
  expect(guest.status).toBe(201);
  const draft = await createDraft(
    [item(10), item(12, 2)],
    [{ guest_id: guest.body.guest.id, role: 'LEAD' }],
  );
  expect(draft.status).toBe(201);
  expect(draft.body.reservation.state).toBe('INQUIRY');
  const reservationId = draft.body.reservation.id;
  const detail = await apiRequest(
    owner.context,
    'GET',
    `${base()}/reservations/${reservationId}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body.items).toHaveLength(2);
  expect(detail.body.items[0].segments).toHaveLength(1);
  expect(detail.body.guests).toHaveLength(1);
  expect(detail.body.guests[0].role).toBe('LEAD');
  expect(detail.body.guests[0].full_name).toBe('P06 Lead');
  const inventory = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "commitments" from "commitment"
        where "property_id" = $1`,
      [property.id],
    );
    return result.rows[0].commitments;
  });
  expect(inventory).toBe(0);
  const auditorView = await apiRequest(
    auditor.context,
    'GET',
    `${base()}/reservations/${reservationId}`,
  );
  expect(auditorView.status).toBe(200);
  expect(auditorView.body.guests).toBeNull();
  const auditorGuests = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/guests`,
  );
  expect(auditorGuests.status).toBe(403);
});

test('P06-01 overall state is derived from item states', async () => {
  const single = await createDraft([item(20)]);
  expect(single.status).toBe(201);
  const singleId = single.body.reservation.id;
  await withOwner(async (client) => {
    await client.query(
      `update "reservation_item" set "state" = 'CONFIRMED' where "reservation_id" = $1`,
      [singleId],
    );
  });
  const confirmed = await apiRequest(
    owner.context,
    'GET',
    `${base()}/reservations/${singleId}`,
  );
  expect(confirmed.body.reservation.state).toBe('CONFIRMED');

  const pair = await createDraft([item(25), item(28)]);
  expect(pair.status).toBe(201);
  const pairId = pair.body.reservation.id;
  await withOwner(async (client) => {
    const items = await client.query(
      `select "id" from "reservation_item" where "reservation_id" = $1 order by "created_at"`,
      [pairId],
    );
    await client.query(
      `update "reservation_item" set "state" = 'CONFIRMED' where "id" = $1`,
      [items.rows[0].id],
    );
  });
  const partial = await apiRequest(
    owner.context,
    'GET',
    `${base()}/reservations/${pairId}`,
  );
  expect(partial.body.reservation.state).toBe('PARTIALLY_CONFIRMED');
  await withOwner(async (client) => {
    await client.query(
      `update "reservation_item" set "state" = 'CANCELLED' where "reservation_id" = $1`,
      [pairId],
    );
  });
  const cancelled = await apiRequest(
    owner.context,
    'GET',
    `${base()}/reservations/${pairId}`,
  );
  expect(cancelled.body.reservation.state).toBe('CANCELLED');
});

test('P06-01 cross-scope, strict DTO and confirmation deferral hold', async () => {
  const missingProperty = await apiRequest(
    owner.context,
    'GET',
    `/tenants/${tenantA}/properties/${randomUUID()}/reservations`,
  );
  expect(missingProperty.status).toBe(404);
  const foreignReservation = await apiRequest(
    owner.context,
    'GET',
    `${base()}/reservations/${randomUUID()}`,
  );
  expect(foreignReservation.status).toBe(404);
  const invalidConfirm = await apiRequest(
    owner.context,
    'POST',
    `${base()}/reservations`,
    { body: { items: [item(30)] } },
  );
  expect(invalidConfirm.status).toBe(400);
  expect(invalidConfirm.body.code).toBe('INVALID_REQUEST');
  const foreignConnection = await createDraftWithConnection(randomUUID());
  expect(foreignConnection.status).toBe(422);
  expect(foreignConnection.body.code).toBe('CROSS_SCOPE_REFERENCE');
  const reversed = await createDraft([
    {
      period: { arrival: addDays(32), departure: addDays(31) },
      occupancy: { adults: 2, child_ages: [] },
    },
  ]);
  expect(reversed.status).toBe(400);
  const extraField = await apiRequest(
    owner.context,
    'POST',
    `${base()}/reservations/drafts`,
    { body: { items: [item(34)], surprise: true } },
  );
  expect(extraField.status).toBe(400);
  const memberList = await apiRequest(
    member.context,
    'GET',
    `${base()}/reservations`,
  );
  expect(memberList.status).toBe(403);
  const otherTenant = await apiRequest(
    ownerB.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/reservations`,
  );
  expect(otherTenant.status).toBe(403);
  expect(otherTenant.body.code).toBe('TENANT_CONTEXT_MISMATCH');
});

async function createDraftWithConnection(connectionId) {
  return apiRequest(owner.context, 'POST', `${base()}/reservations/drafts`, {
    body: {
      source: 'OTA',
      channel_connection_id: connectionId,
      external_booking_key: 'P06-EXT-1',
      items: [item(36)],
    },
  });
}
