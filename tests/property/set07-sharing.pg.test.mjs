import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let tenant;
let admin;
let restricted;
let mixed;
let groupMixed;

const runId = String(Date.now()).slice(-6);
const key = (name) => `set07-sharing-${runId}-${name}`;

function jakartaToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function addDays(days) {
  const date = new Date(`${jakartaToday()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function base(scope) {
  return `/tenants/${tenant}/properties/${scope.property.id}`;
}

async function currentInventoryVersion(scope) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base(scope)}/rates?from=${addDays(0)}&to=${addDays(14)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function createGuest(name, gender) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/guests`,
    {
      body: { full_name: name, ...(gender === undefined ? {} : { gender }) },
      headers: { 'idempotency-key': key(`guest-${name}`) },
    },
  );
  return response;
}

async function setupFixture(suffix, sharingScope) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `SET07-SH-${suffix}-${runId}`,
        name: `SET07 sharing ${suffix} ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  const scope = { property: created.body.property };
  const resource = await apiRequest(
    admin.context,
    'POST',
    `${base(scope)}/resources`,
    { body: { code: `BED-${suffix}-${runId}`, type: 'BED', capacity: 1 } },
  );
  expect(resource.status).toBe(201);
  scope.resource = resource.body.resource;
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base(scope)}/products`,
    {
      body: {
        code: `BED-P-${suffix}-${runId}`,
        name: `Bed ${suffix} ${runId}`,
        kind: 'BED',
        occupancy_adults_max: 1,
      },
    },
  );
  expect(product.status).toBe(201);
  scope.product = product.body.product;
  const candidate = await apiRequest(
    admin.context,
    'POST',
    `${base(scope)}/products/${scope.product.id}/candidates`,
    { body: { resource_id: scope.resource.id } },
  );
  expect(candidate.status).toBe(201);
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base(scope)}/products/${scope.product.id}`,
    { body: { version: scope.product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  const plan = await apiRequest(
    admin.context,
    'POST',
    `${base(scope)}/rate-plans`,
    {
      body: {
        code: `BED-RP-${suffix}-${runId}`,
        name: `Bed rate ${suffix} ${runId}`,
        product_id: scope.product.id,
        currency: 'IDR',
      },
    },
  );
  expect(plan.status).toBe(201);
  scope.planId = plan.body.rate_plan.id;
  const planActive = await apiRequest(
    admin.context,
    'PATCH',
    `${base(scope)}/rate-plans/${scope.planId}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  expect(planActive.status).toBe(200);
  const rates = await apiRequest(
    admin.context,
    'POST',
    `${base(scope)}/rates/batch`,
    {
      body: {
        cells: [0, 1, 2, 3, 4, 5, 6, 7].map((offset) => ({
          rate_plan_id: scope.planId,
          date: addDays(offset),
          occupancy: 1,
          money: { amount: '350000', currency: 'IDR' },
        })),
      },
    },
  );
  expect(rates.status).toBe(200);
  if (sharingScope) {
    await withOwner((client) =>
      client.query(
        `update "product" set "sharing_scope" = $2 where "id" = $1`,
        [scope.product.id, sharingScope],
      ),
    );
    await withOwner((client) =>
      client.query(
        `update "resource" set "housekeeping_state" = 'CLEAN' where "id" = $1`,
        [scope.resource.id],
      ),
    );
  }
  return scope;
}

function draftBody(scope, guestId) {
  return {
    source: 'DIRECT',
    items: [
      {
        product_id: scope.product.id,
        period: { arrival: addDays(0), departure: addDays(2) },
        occupancy: { adults: 1, child_ages: [] },
        quantity: 1,
      },
    ],
    guests: guestId ? [{ guest_id: guestId }] : [],
  };
}

async function createDraft(scope, guestId, name) {
  return apiRequest(
    admin.context,
    'POST',
    `${base(scope)}/reservations/drafts`,
    {
      body: draftBody(scope, guestId),
      headers: { 'idempotency-key': key(name) },
    },
  );
}

async function confirmDraft(scope, draft, name) {
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base(scope)}/reservations/${draft.body.reservation.id}`,
  );
  expect(detail.status).toBe(200);
  const itemId = detail.body.items[0].id;
  const quote = await apiRequest(
    admin.context,
    'POST',
    `${base(scope)}/quotes`,
    {
      body: {
        product_id: scope.product.id,
        rate_plan_id: scope.planId,
        period: { arrival: addDays(0), departure: addDays(2) },
        occupancy: { adults: 1, child_ages: [] },
        quantity: 1,
      },
    },
  );
  expect(quote.status).toBe(201);
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base(scope)}/reservations`,
    {
      body: {
        reservation_id: draft.body.reservation.id,
        inventory_version: await currentInventoryVersion(scope),
        items: [{ item_id: itemId, price_snapshot_id: quote.body.quote.id }],
      },
      headers: { 'idempotency-key': key(`${name}-confirm`) },
    },
  );
  expect(confirmed.status).toBe(200);
  const after = await apiRequest(
    admin.context,
    'GET',
    `${base(scope)}/reservations/${draft.body.reservation.id}`,
  );
  return {
    reservationId: draft.body.reservation.id,
    itemId,
    itemVersion: after.body.items.find((item) => item.id === itemId).version,
  };
}

async function assignmentVersion(scope, stay) {
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base(scope)}/reservations/${stay.reservationId}`,
  );
  return detail.body.items.find((item) => item.id === stay.itemId).version;
}

async function checkIn(scope, stay, name) {
  return apiRequest(
    admin.context,
    'POST',
    `${base(scope)}/reservations/${stay.reservationId}/items/${stay.itemId}/check-in`,
    {
      body: { version: await assignmentVersion(scope, stay) },
      headers: { 'idempotency-key': key(name) },
    },
  );
}

async function setGuestGender(guestId, gender) {
  await withOwner((client) =>
    client.query(`update "guest" set "gender" = $2 where "id" = $1`, [
      guestId,
      gender,
    ]),
  );
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
  restricted = await setupFixture('F', 'FEMALE');
  mixed = await setupFixture('M', null);
  groupMixed = await setupFixture('G', null);
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('SET-07.6 guest gender is declared or explicitly unknown, never guessed', async () => {
  const male = await createGuest(`SET07 API Male ${runId}`, 'MALE');
  expect(male.status).toBe(201);
  expect(male.body.guest.gender).toBe('MALE');
  const unknown = await createGuest(`SET07 API Unknown ${runId}`, null);
  expect(unknown.status).toBe(201);
  expect(unknown.body.guest.gender).toBe(null);
  const invalid = await createGuest(`SET07 API Invalid ${runId}`, 'OTHER');
  expect(invalid.status).toBe(400);

  const listed = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenant}/guests?search=SET07%20API`,
  );
  expect(listed.status).toBe(200);
  const row = listed.body.items.find((item) => item.id === male.body.guest.id);
  expect(row.gender).toBe('MALE');
  const detail = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenant}/guests/${unknown.body.guest.id}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body.guest.gender).toBe(null);
});

test('SET-07.6 a FEMALE bed rejects male and unknown guests at sale and entry', async () => {
  const noGuest = await createDraft(restricted, null, 'restricted-none');
  expect(noGuest.status).toBe(422);
  expect(noGuest.body.code).toBe('GUEST_GENDER_REQUIRED');
  expect(noGuest.body.details.reason).toBe('no_guest_declared');

  const unknown = await createGuest(`SET07 R Unknown ${runId}`, null);
  const unknownDraft = await createDraft(
    restricted,
    unknown.body.guest.id,
    'restricted-unknown',
  );
  expect(unknownDraft.status).toBe(422);
  expect(unknownDraft.body.code).toBe('GUEST_GENDER_REQUIRED');
  expect(unknownDraft.body.details.reason).toBe('gender_unknown');

  const male = await createGuest(`SET07 R Male ${runId}`, 'MALE');
  const maleDraft = await createDraft(
    restricted,
    male.body.guest.id,
    'restricted-male',
  );
  expect(maleDraft.status).toBe(422);
  expect(maleDraft.body.code).toBe('SHARING_POLICY_VIOLATION');
  expect(maleDraft.body.details.scope).toBe('FEMALE');
  expect(maleDraft.body.details.guest_id).toBe(male.body.guest.id);
  expect(maleDraft.body.details.gender).toBe('MALE');

  const female = await createGuest(`SET07 R Female ${runId}`, 'FEMALE');
  const femaleDraft = await createDraft(
    restricted,
    female.body.guest.id,
    'restricted-female',
  );
  expect(femaleDraft.status).toBe(201);
  const stay = await confirmDraft(restricted, femaleDraft, 'restricted');

  const assigned = await apiRequest(
    admin.context,
    'POST',
    `${base(restricted)}/reservations/${stay.reservationId}/items/${stay.itemId}/assignments`,
    {
      body: { resource_id: restricted.resource.id, version: stay.itemVersion },
      headers: { 'idempotency-key': key(`assign-${stay.itemId}`) },
    },
  );
  expect(assigned.status).toBe(200);

  // Entry re-checks the declared gender: a correction after confirmation
  // blocks check-in instead of silently housing a mismatched guest.
  await setGuestGender(female.body.guest.id, 'MALE');
  const mismatched = await checkIn(restricted, stay, 'entry-male');
  expect(mismatched.status).toBe(422);
  expect(mismatched.body.code).toBe('SHARING_POLICY_VIOLATION');

  await setGuestGender(female.body.guest.id, null);
  const unknownEntry = await checkIn(restricted, stay, 'entry-unknown');
  expect(unknownEntry.status).toBe(422);
  expect(unknownEntry.body.code).toBe('GUEST_GENDER_REQUIRED');

  await setGuestGender(female.body.guest.id, 'FEMALE');
  const allowed = await checkIn(restricted, stay, 'entry-female');
  expect(allowed.status).toBe(200);
});

test('SET-07.6 import and group-allotment pickup enforce the restricted scope', async () => {
  // A CSV row carries no guests, so a FEMALE/MALE product cannot be imported.
  const restrictedCsv = [
    'external_key,arrival,departure,adults,quantity,product_code',
    `${key('imp-restricted')},${addDays(0)},${addDays(2)},1,1,${restricted.product.code}`,
  ].join('\n');
  const restrictedImport = await apiRequest(
    admin.context,
    'POST',
    `${base(restricted)}/imports`,
    {
      body: {
        mode: 'APPLY',
        source: 'UPLOAD',
        file_name: 'set07-restricted.csv',
        content_type: 'text/csv',
        content: restrictedCsv,
      },
    },
  );
  expect(restrictedImport.status).toBe(200);
  expect(restrictedImport.body.rows_accepted).toBe(0);
  expect(restrictedImport.body.rows_rejected).toBe(1);
  expect(restrictedImport.body.rows[0].error_code).toBe(
    'GUEST_GENDER_REQUIRED',
  );

  // A MIXED product still imports and can be picked up with no guests.
  const mixedCsv = [
    'external_key,arrival,departure,adults,quantity,product_code',
    `${key('imp-mixed')},${addDays(0)},${addDays(2)},1,1,${groupMixed.product.code}`,
  ].join('\n');
  const mixedImport = await apiRequest(
    admin.context,
    'POST',
    `${base(groupMixed)}/imports`,
    {
      body: {
        mode: 'APPLY',
        source: 'UPLOAD',
        file_name: 'set07-mixed.csv',
        content_type: 'text/csv',
        content: mixedCsv,
      },
    },
  );
  expect(mixedImport.status).toBe(200);
  expect(mixedImport.body.rows_accepted).toBe(1);

  const draft = await createDraft(groupMixed, null, 'group-mixed-draft');
  expect(draft.status).toBe(201);
  const reservationId = draft.body.reservation.id;
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base(groupMixed)}/reservations/${reservationId}`,
  );
  expect(detail.status).toBe(200);
  const itemId = detail.body.items[0].id;
  const period = { arrival: addDays(0), departure: addDays(2) };
  const quote = await apiRequest(
    admin.context,
    'POST',
    `${base(groupMixed)}/quotes`,
    {
      body: {
        product_id: groupMixed.product.id,
        rate_plan_id: groupMixed.planId,
        period,
        occupancy: { adults: 1, child_ages: [] },
        quantity: 1,
      },
    },
  );
  expect(quote.status).toBe(201);
  const priceSnapshotId = quote.body.quote.id;

  // A restricted scope blocks the allotment itself while it is holding.
  await withOwner((client) =>
    client.query(
      `update "product" set "sharing_scope" = 'FEMALE' where "id" = $1`,
      [groupMixed.product.id],
    ),
  );
  const blockedAllotment = await apiRequest(
    admin.context,
    'POST',
    `${base(groupMixed)}/reservations/${reservationId}/group-allotment`,
    {
      body: {
        product_id: groupMixed.product.id,
        period,
        quantity: 1,
        inventory_version: await currentInventoryVersion(groupMixed),
      },
    },
  );
  expect(blockedAllotment.status).toBe(422);
  expect(blockedAllotment.body.code).toBe('GUEST_GENDER_REQUIRED');
  await withOwner((client) =>
    client.query(
      `update "product" set "sharing_scope" = null where "id" = $1`,
      [groupMixed.product.id],
    ),
  );

  const allotment = await apiRequest(
    admin.context,
    'POST',
    `${base(groupMixed)}/reservations/${reservationId}/group-allotment`,
    {
      body: {
        product_id: groupMixed.product.id,
        period,
        quantity: 1,
        inventory_version: await currentInventoryVersion(groupMixed),
      },
    },
  );
  expect(allotment.status).toBe(200);

  // Pickup confirms the item, so a scope changed after the allotment keeps
  // blocking until a matching guest is declared; going back to MIXED works.
  await withOwner((client) =>
    client.query(
      `update "product" set "sharing_scope" = 'FEMALE' where "id" = $1`,
      [groupMixed.product.id],
    ),
  );
  const blockedPickup = await apiRequest(
    admin.context,
    'POST',
    `${base(groupMixed)}/reservations/${reservationId}/group-allotment/pickup`,
    { body: { item_id: itemId, price_snapshot_id: priceSnapshotId } },
  );
  expect(blockedPickup.status).toBe(422);
  expect(blockedPickup.body.code).toBe('GUEST_GENDER_REQUIRED');
  await withOwner((client) =>
    client.query(
      `update "product" set "sharing_scope" = null where "id" = $1`,
      [groupMixed.product.id],
    ),
  );
  const pickup = await apiRequest(
    admin.context,
    'POST',
    `${base(groupMixed)}/reservations/${reservationId}/group-allotment/pickup`,
    { body: { item_id: itemId, price_snapshot_id: priceSnapshotId } },
  );
  expect(pickup.status).toBe(200);
  expect(pickup.body.item_id).toBe(itemId);
  const stored = await withOwner(async (client) => {
    const item = await client.query(
      `select "state" from "reservation_item" where "id" = $1`,
      [itemId],
    );
    const guests = await client.query(
      `select count(*)::int as "count" from "reservation_guest" where "reservation_id" = $1`,
      [reservationId],
    );
    return { state: item.rows[0].state, guests: guests.rows[0].count };
  });
  expect(stored.state).toBe('CONFIRMED');
  expect(stored.guests).toBe(0);
});

test('SET-07.6 MIXED beds keep selling and checking in for any declared guest', async () => {
  const male = await createGuest(`SET07 M Male ${runId}`, 'MALE');
  const draft = await createDraft(mixed, male.body.guest.id, 'mixed-male');
  expect(draft.status).toBe(201);
  const stay = await confirmDraft(mixed, draft, 'mixed');
  const assigned = await apiRequest(
    admin.context,
    'POST',
    `${base(mixed)}/reservations/${stay.reservationId}/items/${stay.itemId}/assignments`,
    {
      body: { resource_id: mixed.resource.id, version: stay.itemVersion },
      headers: { 'idempotency-key': key(`assign-${stay.itemId}`) },
    },
  );
  expect(assigned.status).toBe(200);
  const checkedIn = await checkIn(mixed, stay, 'mixed-entry');
  expect(checkedIn.status).toBe(200);
});
