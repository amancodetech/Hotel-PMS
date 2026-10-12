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
let member;
let property;
let productA;
let planA;
let productB;
let planB;
let rooms;
let roomSuffixes;

// Fixed synthetic seed: no user data, deterministic codes and fixtures.
const seed = 20260915;
const runId = `P07S${seed}`;
const key = (name) => `p07-02-${name}-${runId}`;

function addDays(days) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type).value;
  const base = `${value('year')}-${value('month')}-${value('day')}`;
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function base() {
  return `/tenants/${tenant}/properties/${property.id}`;
}

async function quote(productId, planId, arrival, departure) {
  const response = await apiRequest(admin.context, 'POST', `${base()}/quotes`, {
    body: {
      product_id: productId,
      rate_plan_id: planId,
      period: { arrival: addDays(arrival), departure: addDays(departure) },
      occupancy: { adults: 2, child_ages: [] },
      quantity: 1,
    },
  });
  if (response.status !== 201)
    throw new Error(
      `quote failed: ${response.status} ${JSON.stringify(response.body)}`,
    );
  return response.body.quote.id;
}

async function createDraft(items, guests) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: items.map((item) => ({
          product_id: item.productId,
          period: {
            arrival: addDays(item.arrival),
            departure: addDays(item.departure),
          },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        })),
        ...(guests ? { guests } : {}),
      },
    },
  );
  if (response.status !== 201)
    throw new Error(
      `draft failed: ${response.status} ${JSON.stringify(response.body)}`,
    );
  return response.body.reservation;
}

async function currentInventoryVersion() {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=${addDays(0)}&to=${addDays(14)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function detail(reservationId) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/reservations/${reservationId}`,
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function createConfirmed(productId, planId, arrival, departure, guests) {
  const draft = await createDraft([{ productId, arrival, departure }], guests);
  const quoteId = await quote(productId, planId, arrival, departure);
  const itemId = (await detail(draft.id)).items[0].id;
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations`,
    {
      body: {
        reservation_id: draft.id,
        inventory_version: await currentInventoryVersion(),
        items: [{ item_id: itemId, price_snapshot_id: quoteId }],
      },
    },
  );
  expect(confirmed.status).toBe(200);
  const after = await detail(draft.id);
  return {
    reservationId: draft.id,
    itemId,
    itemVersion: after.items[0].version,
  };
}

async function createGuest(fullName) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/guests`,
    { body: { full_name: fullName } },
  );
  expect(response.status).toBe(201);
  return response.body.guest.id;
}

async function assign(item, resourceId, version, idempotencyKey) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/assignments`,
    {
      body: { resource_id: resourceId, version },
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
}

async function checkIn(item, version, idempotencyKey, resourceId) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-in`,
    {
      body: {
        version,
        ...(resourceId ? { resource_id: resourceId } : {}),
      },
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    },
  );
}

async function move(item, resourceId, effectiveDate, version, idempotencyKey) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/move`,
    {
      body: {
        to_resource_id: resourceId,
        effective_date: effectiveDate,
        version,
      },
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
}

async function createBlock(resourceId, mode, from = 0, to = 2) {
  return apiRequest(admin.context, 'POST', `${base()}/blocks`, {
    body: {
      resource_ids: [resourceId],
      period: { arrival: addDays(from), departure: addDays(to) },
      reason: `P07-02 synthetic ${mode} block`,
      mode,
    },
  });
}

async function releaseBlock(blockId) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/blocks/${blockId}/release`,
    { body: { reason: 'P07-02 release' } },
  );
}

async function extend(item, newDeparture, version, idempotencyKey) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/extend`,
    {
      body: { new_departure: newDeparture, version },
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
}

async function split(item, atDate, version, idempotencyKey) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/split`,
    {
      body: { at_date: atDate, version },
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
}

async function earlyDeparture(item, effectiveDate, version, idempotencyKey) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/early-departure`,
    {
      body: { effective_date: effectiveDate, version },
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
}

async function partialDeparture(item, guestIds, version, idempotencyKey) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/partial-departure`,
    {
      body: { guest_ids: guestIds, version },
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
}

async function dbItem(itemId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "state", "arrival"::text as "arrival",
              "departure"::text as "departure", "version",
              "price_snapshot_id", "checked_in_at"
         from "reservation_item"
        where "id" = $1`,
      [itemId],
    );
    return result.rows[0];
  });
}

async function dbAssignments(itemId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "id", "resource_id", "state", "start_date"::text as "start_date",
              "end_date"::text as "end_date", "version"
         from "room_assignment"
        where "item_id" = $1
        order by "assigned_at", "id"`,
      [itemId],
    );
    return result.rows;
  });
}

async function dbSegments(itemId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "start_date"::text as "start_date", "end_date"::text as "end_date",
              "state"
         from "stay_segment"
        where "item_id" = $1
        order by "start_date"`,
      [itemId],
    );
    return result.rows;
  });
}

async function dbActiveAllocations(itemId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select pa."resource_id", pa."start_date"::text as "start_date",
              pa."end_date"::text as "end_date", pa."commitment_id",
              c."state" as "commitment_state"
         from "plan_allocation" pa
         join "commitment" c on c."id" = pa."commitment_id"
        where c."source_kind" = 'ITEM' and c."source_id" = $1
          and pa."state" = 'ACTIVE'
        order by pa."start_date"`,
      [itemId],
    );
    return result.rows;
  });
}

async function dbEventCounts(itemId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "type", count(*)::int as "count"
         from "stay_event"
        where "item_id" = $1
        group by "type"`,
      [itemId],
    );
    const counts = {};
    for (const row of result.rows) counts[row.type] = row.count;
    return counts;
  });
}

async function dbAuditCount(action, resourceId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "audit_event"
        where "action" = $1 and "resource_id" = $2`,
      [action, resourceId],
    );
    return result.rows[0].count;
  });
}

async function createProduct(code, suffixes) {
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code,
        name: `P07-02 ${code}`,
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(product.status).toBe(201);
  for (const suffix of suffixes) {
    const candidate = await apiRequest(
      admin.context,
      'POST',
      `${base()}/products/${product.body.product.id}/candidates`,
      { body: { resource_id: rooms[suffix].id } },
    );
    expect(candidate.status).toBe(201);
  }
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/products/${product.body.product.id}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  return product.body.product.id;
}

async function createRatePlan(productId, code) {
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: {
      code,
      name: `P07-02 ${code}`,
      product_id: productId,
      currency: 'IDR',
    },
  });
  expect(plan.status).toBe(201);
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/rate-plans/${plan.body.rate_plan.id}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  const cells = [];
  for (let offset = 0; offset <= 14; offset += 1) {
    cells.push({
      rate_plan_id: plan.body.rate_plan.id,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '250000', currency: 'IDR' },
    });
  }
  const rates = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rates/batch`,
    { body: { cells } },
  );
  expect(rates.status).toBe(200);
  return plan.body.rate_plan.id;
}

let moveItem;
let moveDirtyItem;
let moveConflictItem;
let extendItem;
let extendStaleItem;
let conflictE1;
let splitItem;
let splitBadItem;
let earlyItem;
let raceItem;
let partialItem;
let partialGuests;

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  member = await loginAs('member-a');
  tenant = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P07-S-${runId}`,
        name: `P07-02 ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  rooms = {};
  roomSuffixes = Array.from({ length: 18 }, (_, index) => `R${index + 1}`);
  for (const suffix of roomSuffixes) {
    const resource = await apiRequest(
      admin.context,
      'POST',
      `${base()}/resources`,
      {
        body: { code: `P07-02-${suffix}-${runId}`, type: 'ROOM', capacity: 2 },
      },
    );
    expect(resource.status).toBe(201);
    rooms[suffix] = resource.body.resource;
  }
  const ooo = await apiRequest(
    admin.context,
    'POST',
    `${base()}/resources/${rooms.R3.id}/maintenance`,
    {
      body: {
        version: rooms.R3.version,
        state: 'OOO',
        reason: 'P07-02 synthetic out of order',
      },
    },
  );
  expect(ooo.status).toBe(200);
  await withOwner(async (client) => {
    await client.query(
      `update "resource" set "housekeeping_state" = 'DIRTY' where "id" = $1`,
      [rooms.R2.id],
    );
  });

  productA = await createProduct(
    `P07-02-PA-${runId}`,
    roomSuffixes.filter((suffix) => suffix !== 'R17' && suffix !== 'R18'),
  );
  planA = await createRatePlan(productA, `P07-02-RA-${runId}`);
  productB = await createProduct(`P07-02-PB-${runId}`, ['R17']);
  planB = await createRatePlan(productB, `P07-02-RB-${runId}`);

  moveItem = await createConfirmed(productA, planA, 0, 3);
  expect(
    (await checkIn(moveItem, moveItem.itemVersion, key('move-ci'), rooms.R1.id))
      .status,
  ).toBe(200);

  moveDirtyItem = await createConfirmed(productA, planA, 0, 3);
  expect(
    (
      await checkIn(
        moveDirtyItem,
        moveDirtyItem.itemVersion,
        key('dirty-ci'),
        rooms.R4.id,
      )
    ).status,
  ).toBe(200);

  moveConflictItem = await createConfirmed(productA, planA, 0, 3);
  expect(
    (
      await checkIn(
        moveConflictItem,
        moveConflictItem.itemVersion,
        key('conflict-ci'),
        rooms.R6.id,
      )
    ).status,
  ).toBe(200);
  const blocker = await createConfirmed(productA, planA, 0, 3);
  expect(
    (
      await assign(
        blocker,
        rooms.R7.id,
        blocker.itemVersion,
        key('blocker-assign'),
      )
    ).status,
  ).toBe(200);

  extendItem = await createConfirmed(productA, planA, 0, 2);
  expect(
    (
      await checkIn(
        extendItem,
        extendItem.itemVersion,
        key('extend-ci'),
        rooms.R8.id,
      )
    ).status,
  ).toBe(200);

  extendStaleItem = await createConfirmed(productA, planA, 0, 2);
  expect(
    (
      await checkIn(
        extendStaleItem,
        extendStaleItem.itemVersion,
        key('stale-ci'),
        rooms.R9.id,
      )
    ).status,
  ).toBe(200);

  conflictE1 = await createConfirmed(productB, planB, 0, 2);
  expect(
    (
      await checkIn(
        conflictE1,
        conflictE1.itemVersion,
        key('conflict-e1-ci'),
        rooms.R17.id,
      )
    ).status,
  ).toBe(200);
  await createConfirmed(productB, planB, 2, 4);

  splitItem = await createConfirmed(productA, planA, 0, 4);
  expect(
    (
      await checkIn(
        splitItem,
        splitItem.itemVersion,
        key('split-ci'),
        rooms.R10.id,
      )
    ).status,
  ).toBe(200);

  splitBadItem = await createConfirmed(productA, planA, 0, 3);
  expect(
    (
      await checkIn(
        splitBadItem,
        splitBadItem.itemVersion,
        key('split-bad-ci'),
        rooms.R5.id,
      )
    ).status,
  ).toBe(200);

  earlyItem = await createConfirmed(productA, planA, 0, 4);
  expect(
    (
      await checkIn(
        earlyItem,
        earlyItem.itemVersion,
        key('early-ci'),
        rooms.R11.id,
      )
    ).status,
  ).toBe(200);

  raceItem = await createConfirmed(productA, planA, 0, 2);
  expect(
    (
      await checkIn(
        raceItem,
        raceItem.itemVersion,
        key('race-ci'),
        rooms.R13.id,
      )
    ).status,
  ).toBe(200);

  const guestOne = await createGuest(`P07-02 Guest One ${runId}`);
  const guestTwo = await createGuest(`P07-02 Guest Two ${runId}`);
  partialGuests = { one: guestOne, two: guestTwo };
  partialItem = await createConfirmed(productA, planA, 0, 3, [
    { guest_id: guestOne, role: 'LEAD' },
    { guest_id: guestTwo, role: 'ACCOMPANYING' },
  ]);
  expect(
    (
      await checkIn(
        partialItem,
        partialItem.itemVersion,
        key('partial-ci'),
        rooms.R15.id,
      )
    ).status,
  ).toBe(200);
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('P07-02 move secures the alternative first, closes the old range and replays once', async () => {
  const current = await dbItem(moveItem.itemId);
  const result = await move(
    moveItem,
    rooms.R16.id,
    addDays(1),
    current.version,
    key('move-success'),
  );
  expect(result.status).toBe(200);
  expect(result.body.replayed).toBe(false);
  expect(result.body.state).toBe('IN_HOUSE');
  expect(result.body.assignment.state).toBe('ACTIVE');
  expect(result.body.assignment.resource_id).toBe(rooms.R16.id);
  expect(result.body.assignment.start_date).toBe(addDays(1));
  expect(result.body.assignment.end_date).toBe(addDays(3));
  expect(result.body.assignment.checked_in_at).toBeTruthy();
  expect(result.body.previous_assignment_id).toBeTruthy();

  const assignments = await dbAssignments(moveItem.itemId);
  const previous = assignments.find(
    (row) => row.id === result.body.previous_assignment_id,
  );
  expect(previous.state).toBe('COMPLETED');
  expect(previous.end_date).toBe(addDays(1));
  expect(previous.resource_id).toBe(rooms.R1.id);
  expect(
    assignments.filter((row) => row.state === 'ACTIVE').map((row) => row.id),
  ).toEqual([result.body.assignment.id]);
  const assignmentId = result.body.assignment.id;
  const overlaps = await withOwner(async (client) => {
    const query = await client.query(
      `select count(*)::int as "count" from "room_assignment"
        where "resource_id" = $1 and "state" in ('PLANNED', 'ACTIVE')
          and "id" <> $2
          and daterange("start_date", "end_date", '[)')
              && daterange($3::date, $4::date, '[)')`,
      [rooms.R16.id, assignmentId, addDays(1), addDays(3)],
    );
    return query.rows[0].count;
  });
  expect(overlaps).toBe(0);

  const item = await dbItem(moveItem.itemId);
  expect(item.departure).toBe(addDays(3));
  expect(item.state).toBe('IN_HOUSE');
  expect(await dbEventCounts(moveItem.itemId)).toEqual({
    STAY_CHECKED_IN: 1,
    STAY_MOVED: 1,
  });
  expect(await dbAuditCount('stay.moved', moveItem.itemId)).toBe(1);

  const replay = await move(
    moveItem,
    rooms.R16.id,
    addDays(1),
    current.version,
    key('move-success'),
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.assignment.id).toBe(result.body.assignment.id);
  expect(await dbEventCounts(moveItem.itemId)).toEqual({
    STAY_CHECKED_IN: 1,
    STAY_MOVED: 1,
  });
});

test('P07-02 move rejects dirty and out-of-order rooms and preserves the old assignment on conflict', async () => {
  const dirtyItem = await dbItem(moveDirtyItem.itemId);
  const dirty = await move(
    moveDirtyItem,
    rooms.R2.id,
    addDays(1),
    dirtyItem.version,
    key('move-dirty'),
  );
  expect(dirty.status).toBe(400);
  expect(dirty.body.code).toBe('INVALID_REQUEST');
  expect(dirty.body.details.reason).toBe('DIRTY');
  const blocked = await move(
    moveDirtyItem,
    rooms.R3.id,
    addDays(1),
    dirtyItem.version,
    key('move-ooo'),
  );
  expect(blocked.status).toBe(400);
  expect(blocked.body.code).toBe('INVALID_REQUEST');
  expect(blocked.body.details.reason).toBe('OOO');

  const conflictCurrent = await dbItem(moveConflictItem.itemId);
  const conflict = await move(
    moveConflictItem,
    rooms.R7.id,
    addDays(1),
    conflictCurrent.version,
    key('move-conflict'),
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.code).toBe('CONFLICT');
  const afterItem = await dbItem(moveConflictItem.itemId);
  expect(afterItem.version).toBe(conflictCurrent.version);
  expect(afterItem.departure).toBe(addDays(3));
  const assignments = await dbAssignments(moveConflictItem.itemId);
  expect(
    assignments.filter((row) => row.state === 'ACTIVE').map((row) => row.id),
  ).toHaveLength(1);
  expect(assignments.find((row) => row.state === 'ACTIVE').resource_id).toBe(
    rooms.R6.id,
  );
  expect(await dbEventCounts(moveConflictItem.itemId)).toEqual({
    STAY_CHECKED_IN: 1,
  });
});

test('P07-02 extend books new nights, keeps the price snapshot and rejects stale versions', async () => {
  const before = await dbItem(extendItem.itemId);
  expect(before.price_snapshot_id).toBeTruthy();
  const extended = await extend(
    extendItem,
    addDays(5),
    before.version,
    key('extend-success'),
  );
  expect(extended.status).toBe(200);
  expect(extended.body.replayed).toBe(false);
  expect(extended.body.departure).toBe(addDays(5));
  expect(extended.body.assignment.end_date).toBe(addDays(5));

  const after = await dbItem(extendItem.itemId);
  expect(after.departure).toBe(addDays(5));
  expect(after.price_snapshot_id).toBe(before.price_snapshot_id);
  expect(after.state).toBe('IN_HOUSE');
  const allocations = await dbActiveAllocations(extendItem.itemId);
  expect(allocations.length).toBeGreaterThanOrEqual(1);
  for (const allocation of allocations) {
    expect(allocation.start_date).toBe(addDays(0));
    expect(allocation.end_date).toBe(addDays(5));
  }
  const segments = await dbSegments(extendItem.itemId);
  expect(segments[0].end_date).toBe(addDays(5));
  expect(await dbEventCounts(extendItem.itemId)).toEqual({
    STAY_CHECKED_IN: 1,
    STAY_EXTENDED: 1,
  });
  expect(await dbAuditCount('stay.extended', extendItem.itemId)).toBe(1);

  const replay = await extend(
    extendItem,
    addDays(5),
    before.version,
    key('extend-success'),
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);

  const staleCurrent = await dbItem(extendStaleItem.itemId);
  const stale = await extend(
    extendStaleItem,
    addDays(5),
    staleCurrent.version + 5,
    key('extend-stale'),
  );
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');
});

test('P07-02 extend conflict with another allocation stays CONFLICT and preserves the old period', async () => {
  const before = await dbItem(conflictE1.itemId);
  const conflict = await extend(
    conflictE1,
    addDays(4),
    before.version,
    key('extend-conflict'),
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.code).toBe('CONFLICT');
  const after = await dbItem(conflictE1.itemId);
  expect(after.version).toBe(before.version);
  expect(after.departure).toBe(addDays(2));
  const allocations = await dbActiveAllocations(conflictE1.itemId);
  expect(allocations).toHaveLength(1);
  expect(allocations[0].start_date).toBe(addDays(0));
  expect(allocations[0].end_date).toBe(addDays(2));
  expect(await dbEventCounts(conflictE1.itemId)).toEqual({
    STAY_CHECKED_IN: 1,
  });
});

test('P07-02 split keeps both items in-house, non-overlapping and stock neutral', async () => {
  const before = await dbItem(splitItem.itemId);
  const atDate = addDays(2);
  const result = await split(
    splitItem,
    atDate,
    before.version,
    key('split-success'),
  );
  expect(result.status).toBe(200);
  expect(result.body.replayed).toBe(false);
  expect(result.body.departure).toBe(atDate);
  expect(result.body.follow_up_departure).toBe(addDays(4));
  expect(result.body.follow_up_item_id).toBeTruthy();
  expect(result.body.follow_up_assignment.resource_id).toBe(rooms.R10.id);
  expect(result.body.follow_up_assignment.start_date).toBe(atDate);

  const original = await dbItem(splitItem.itemId);
  const followUp = await dbItem(result.body.follow_up_item_id);
  expect(original.state).toBe('IN_HOUSE');
  expect(followUp.state).toBe('IN_HOUSE');
  expect(original.departure).toBe(atDate);
  expect(followUp.arrival).toBe(atDate);
  expect(followUp.departure).toBe(addDays(4));
  expect(followUp.price_snapshot_id).toBe(original.price_snapshot_id);

  const originalAssignments = await dbAssignments(splitItem.itemId);
  expect(originalAssignments).toHaveLength(1);
  expect(originalAssignments[0].state).toBe('COMPLETED');
  expect(originalAssignments[0].end_date).toBe(atDate);
  const followAssignments = await dbAssignments(result.body.follow_up_item_id);
  expect(followAssignments).toHaveLength(1);
  expect(followAssignments[0].state).toBe('ACTIVE');
  expect(followAssignments[0].resource_id).toBe(rooms.R10.id);
  expect(followAssignments[0].start_date).toBe(atDate);

  const originalSegments = await dbSegments(splitItem.itemId);
  const followSegments = await dbSegments(result.body.follow_up_item_id);
  expect(originalSegments[0].end_date).toBe(atDate);
  expect(followSegments[0].start_date).toBe(atDate);
  expect(followSegments[0].end_date).toBe(addDays(4));
  const followUpItemId = result.body.follow_up_item_id;
  const segmentOverlap = await withOwner(async (client) => {
    const query = await client.query(
      `select count(*)::int as "count" from "stay_segment" a
         join "stay_segment" b on b."item_id" <> a."item_id"
        where a."item_id" = any($1::uuid[])
          and b."item_id" = any($1::uuid[])
          and a."id" < b."id"
          and daterange(a."start_date", a."end_date", '[)')
              && daterange(b."start_date", b."end_date", '[)')`,
      [[splitItem.itemId, followUpItemId]],
    );
    return query.rows[0].count;
  });
  expect(segmentOverlap).toBe(0);

  const allocations = [
    ...(await dbActiveAllocations(splitItem.itemId)),
    ...(await dbActiveAllocations(result.body.follow_up_item_id)),
  ];
  expect(allocations).toHaveLength(2);
  const byResource = new Map();
  for (const allocation of allocations) {
    const list = byResource.get(allocation.resource_id) ?? [];
    list.push(allocation);
    byResource.set(allocation.resource_id, list);
  }
  let totalNights = 0;
  for (const list of byResource.values()) {
    list.sort((a, b) => a.start_date.localeCompare(b.start_date));
    for (let index = 0; index < list.length; index += 1) {
      const allocation = list[index];
      const start = Date.parse(allocation.start_date);
      const end = Date.parse(allocation.end_date);
      totalNights += (end - start) / 86400000;
      if (index > 0) {
        const previous = list[index - 1];
        expect(allocation.start_date >= previous.end_date).toBe(true);
      }
    }
  }
  expect(totalNights).toBe(4);
  expect(await dbEventCounts(splitItem.itemId)).toEqual({
    STAY_CHECKED_IN: 1,
    STAY_SPLIT: 1,
  });
  expect(await dbAuditCount('stay.split', splitItem.itemId)).toBe(1);
});

test('P07-02 split rejects dates outside the stay period', async () => {
  const before = await dbItem(splitBadItem.itemId);
  const atArrival = await split(
    splitBadItem,
    before.arrival,
    before.version,
    key('split-arrival'),
  );
  expect(atArrival.status).toBe(400);
  expect(atArrival.body.code).toBe('INVALID_REQUEST');
  const atDeparture = await split(
    splitBadItem,
    before.departure,
    before.version,
    key('split-departure'),
  );
  expect(atDeparture.status).toBe(400);
  expect(atDeparture.body.code).toBe('INVALID_REQUEST');
  const after = await dbItem(splitBadItem.itemId);
  expect(after.version).toBe(before.version);
  expect(after.departure).toBe(before.departure);
});

test('P07-02 early departure shortens the future, keeps the past and stays in-house', async () => {
  const before = await dbItem(earlyItem.itemId);
  const effective = addDays(2);
  const result = await earlyDeparture(
    earlyItem,
    effective,
    before.version,
    key('early-success'),
  );
  expect(result.status).toBe(200);
  expect(result.body.departure).toBe(effective);
  expect(result.body.assignment.state).toBe('ACTIVE');
  expect(result.body.assignment.end_date).toBe(effective);

  const after = await dbItem(earlyItem.itemId);
  expect(after.state).toBe('IN_HOUSE');
  expect(after.departure).toBe(effective);
  expect(after.price_snapshot_id).toBe(before.price_snapshot_id);
  const allocations = await dbActiveAllocations(earlyItem.itemId);
  expect(allocations.length).toBeGreaterThanOrEqual(1);
  for (const allocation of allocations) {
    expect(allocation.start_date).toBe(before.arrival);
    expect(allocation.end_date).toBe(effective);
  }
  const segments = await dbSegments(earlyItem.itemId);
  expect(segments[0].start_date).toBe(before.arrival);
  expect(segments[0].end_date).toBe(effective);
  expect(await dbEventCounts(earlyItem.itemId)).toEqual({
    STAY_CHECKED_IN: 1,
    STAY_EARLY_DEPARTURE: 1,
  });
  expect(await dbAuditCount('stay.early_departure', earlyItem.itemId)).toBe(1);
});

test('P07-02 partial departure marks only new guests and rejects an empty new request', async () => {
  const before = await dbItem(partialItem.itemId);
  const first = await partialDeparture(
    partialItem,
    [partialGuests.one],
    before.version,
    key('partial-one'),
  );
  expect(first.status).toBe(200);
  expect(first.body.replayed).toBe(false);
  expect(first.body.state).toBe('IN_HOUSE');
  expect(first.body.departed_guest_ids).toEqual([partialGuests.one]);

  const stored = await withOwner(async (client) => {
    const result = await client.query(
      `select "guest_id", "departed_at" from "reservation_guest"
        where "reservation_id" = $1 order by "created_at"`,
      [partialItem.reservationId],
    );
    return result.rows;
  });
  expect(stored).toHaveLength(2);
  for (const row of stored) {
    if (row.guest_id === partialGuests.one)
      expect(row.departed_at).not.toBeNull();
    else expect(row.departed_at).toBeNull();
  }
  expect(await dbEventCounts(partialItem.itemId)).toEqual({
    STAY_CHECKED_IN: 1,
    STAY_PARTIAL_DEPARTURE: 1,
  });
  expect(await dbAuditCount('stay.partial_departure', partialItem.itemId)).toBe(
    1,
  );

  const replay = await partialDeparture(
    partialItem,
    [partialGuests.one],
    before.version,
    key('partial-one'),
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);

  const again = await partialDeparture(
    partialItem,
    [partialGuests.one],
    first.body.item_version,
    key('partial-one-again'),
  );
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('CONFLICT');
  const item = await dbItem(partialItem.itemId);
  expect(item.version).toBe(first.body.item_version);
  expect(await dbEventCounts(partialItem.itemId)).toEqual({
    STAY_CHECKED_IN: 1,
    STAY_PARTIAL_DEPARTURE: 1,
  });

  const unknown = await partialDeparture(
    partialItem,
    ['00000000-0000-4000-8000-000000000000'],
    first.body.item_version,
    key('partial-unknown'),
  );
  expect(unknown.status).toBe(422);
  expect(unknown.body.code).toBe('CROSS_SCOPE_REFERENCE');

  const second = await partialDeparture(
    partialItem,
    [partialGuests.two],
    first.body.item_version,
    key('partial-two'),
  );
  expect(second.status).toBe(200);
  expect(second.body.departed_guest_ids).toEqual([partialGuests.two]);
  expect((await dbEventCounts(partialItem.itemId)).STAY_PARTIAL_DEPARTURE).toBe(
    2,
  );
});

test('P07-02 concurrent move and extend leave a single winner and a consistent stay', async () => {
  const before = await dbItem(raceItem.itemId);
  const [moveResult, extendResult] = await Promise.all([
    move(raceItem, rooms.R14.id, addDays(1), before.version, key('race-move')),
    extend(raceItem, addDays(4), before.version, key('race-extend')),
  ]);
  const statuses = [moveResult.status, extendResult.status].sort();
  expect(statuses[0]).toBe(200);
  expect(statuses[1]).toBe(412);

  const item = await dbItem(raceItem.itemId);
  const winner = moveResult.status === 200 ? moveResult : extendResult;
  expect(item.version).toBe(winner.body.item_version);
  const assignments = await dbAssignments(raceItem.itemId);
  const active = assignments.filter((row) => row.state === 'ACTIVE');
  expect(active).toHaveLength(1);
  if (moveResult.status === 200) {
    expect(active[0].resource_id).toBe(rooms.R14.id);
    expect(active[0].start_date).toBe(addDays(1));
    expect(active[0].end_date).toBe(addDays(2));
    expect(item.departure).toBe(addDays(2));
    expect(await dbEventCounts(raceItem.itemId)).toEqual({
      STAY_CHECKED_IN: 1,
      STAY_MOVED: 1,
    });
  } else {
    expect(active[0].resource_id).toBe(rooms.R13.id);
    expect(active[0].end_date).toBe(addDays(4));
    expect(item.departure).toBe(addDays(4));
    expect(await dbEventCounts(raceItem.itemId)).toEqual({
      STAY_CHECKED_IN: 1,
      STAY_EXTENDED: 1,
    });
  }
  const overlap = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "room_assignment" a
         join "room_assignment" b
           on b."resource_id" = a."resource_id" and b."id" <> a."id"
        where a."item_id" = $1 and b."item_id" = $1
          and a."state" in ('PLANNED', 'ACTIVE')
          and b."state" in ('PLANNED', 'ACTIVE')
          and a."id" < b."id"
          and daterange(a."start_date", a."end_date", '[)')
              && daterange(b."start_date", b."end_date", '[)')`,
      [raceItem.itemId],
    );
    return result.rows[0].count;
  });
  expect(overlap).toBe(0);
});

test('P07-02 movement operations enforce permissions and idempotency keys', async () => {
  const item = await dbItem(moveDirtyItem.itemId);
  const memberMove = await apiRequest(
    member.context,
    'POST',
    `${base()}/reservations/${moveDirtyItem.reservationId}/items/${moveDirtyItem.itemId}/move`,
    {
      body: {
        to_resource_id: rooms.R14.id,
        effective_date: addDays(1),
        version: item.version,
      },
    },
  );
  expect(memberMove.status).toBe(403);
  const memberPartial = await apiRequest(
    member.context,
    'POST',
    `${base()}/reservations/${partialItem.reservationId}/items/${partialItem.itemId}/partial-departure`,
    {
      body: {
        guest_ids: [partialGuests.two],
        version: item.version,
      },
    },
  );
  expect(memberPartial.status).toBe(403);
  const memberExtend = await apiRequest(
    member.context,
    'POST',
    `${base()}/reservations/${moveDirtyItem.reservationId}/items/${moveDirtyItem.itemId}/extend`,
    { body: { new_departure: addDays(4), version: item.version } },
  );
  expect(memberExtend.status).toBe(403);
  const missingKey = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${moveDirtyItem.reservationId}/items/${moveDirtyItem.itemId}/move`,
    {
      body: {
        to_resource_id: rooms.R14.id,
        effective_date: addDays(1),
        version: item.version,
      },
      idempotency: false,
    },
  );
  expect(missingKey.status).toBe(400);
  expect(missingKey.body.code).toBe('INVALID_REQUEST');
  expect(missingKey.body.details.field).toBe('idempotency_key');
});

test('P07-02 move rejects an actively blocked room and accepts it after release', async () => {
  const item = await createConfirmed(productA, planA, 0, 3);
  const checkedIn = await checkIn(
    item,
    item.itemVersion,
    key('block-move-ci'),
    rooms.R12.id,
  );
  expect(checkedIn.status).toBe(200);
  const before = await dbItem(item.itemId);
  const block = await createBlock(rooms.R18.id, 'PLANNED', 0, 3);
  expect(block.status).toBe(201);
  const rejected = await move(
    item,
    rooms.R18.id,
    addDays(0),
    before.version,
    key('block-move'),
  );
  expect(rejected.status).toBe(400);
  expect(rejected.body.code).toBe('INVALID_REQUEST');
  expect(rejected.body.details.reason).toBe('BLOCKED');
  const afterReject = await dbItem(item.itemId);
  expect(afterReject.version).toBe(before.version);
  const assignments = await dbAssignments(item.itemId);
  expect(assignments.filter((row) => row.state === 'ACTIVE')).toHaveLength(1);
  expect(assignments.find((row) => row.state === 'ACTIVE').resource_id).toBe(
    rooms.R12.id,
  );
  expect(await dbEventCounts(item.itemId)).toEqual({ STAY_CHECKED_IN: 1 });

  const released = await releaseBlock(block.body.block.id);
  expect(released.status).toBe(200);
  const accepted = await move(
    item,
    rooms.R18.id,
    addDays(0),
    before.version,
    key('block-move-released'),
  );
  expect(accepted.status).toBe(200);
  expect(accepted.body.assignment.resource_id).toBe(rooms.R18.id);
  expect(accepted.body.assignment.state).toBe('ACTIVE');
});
