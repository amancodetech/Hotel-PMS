import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { phase7Operations } from '../../apps/api/dist/front-office/operations.js';
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
let productId;
let planId;
let rooms;
let successItem;
let rejectItem;
let staleItem;
let oooItem;
let raceItem;
let multi;

// Fixed synthetic seed: no user data, deterministic codes and fixtures.
const seed = 20260915;
const runId = `P07C${seed}`;
const key = (name) => `p07-03-${name}-${runId}`;

const phase7Contract = JSON.parse(
  readFileSync('docs/contracts/phase7.openapi.json', 'utf8'),
);

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The synthetic property runs Asia/Jakarta (UTC+7); checkout records the
// property-local business date, so the fixture date must match it.
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

function base() {
  return `/tenants/${tenant}/properties/${property.id}`;
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
        items: items.map(([arrival, departure]) => ({
          product_id: productId,
          period: {
            arrival: addDays(arrival),
            departure: addDays(departure),
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

async function confirmDraft(draftId, itemIds) {
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations`,
    {
      body: {
        reservation_id: draftId,
        inventory_version: await currentInventoryVersion(),
        items: itemIds,
      },
    },
  );
  expect(confirmed.status).toBe(200);
  return confirmed;
}

async function createConfirmed(arrival, departure) {
  const draft = await createDraft([[arrival, departure]]);
  const quoteId = await quote(arrival, departure);
  const itemId = (await detail(draft.id)).items[0].id;
  await confirmDraft(draft.id, [
    { item_id: itemId, price_snapshot_id: quoteId },
  ]);
  const after = await detail(draft.id);
  return {
    reservationId: draft.id,
    itemId,
    itemVersion: after.items[0].version,
  };
}

async function createConfirmedMulti(items) {
  const draft = await createDraft(items);
  const draftDetail = await detail(draft.id);
  // Sequential confirmation keeps one unit per request so the resolver picks a
  // distinct room for each item of the same product.
  for (let index = 0; index < items.length; index += 1) {
    const [arrival, departure] = items[index];
    await confirmDraft(draft.id, [
      {
        item_id: draftDetail.items[index].id,
        price_snapshot_id: await quote(arrival, departure),
      },
    ]);
  }
  const after = await detail(draft.id);
  return {
    reservationId: draft.id,
    items: after.items.map((row) => ({
      reservationId: draft.id,
      itemId: row.id,
      itemVersion: row.version,
    })),
  };
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

async function checkOut(item, version, idempotencyKey) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-out`,
    {
      body: { version },
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    },
  );
}

async function dbItem(itemId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "state", "arrival"::text as "arrival",
              "departure"::text as "departure", "version",
              "price_snapshot_id", "checked_in_at", "checked_out_at"
         from "reservation_item"
        where "id" = $1`,
      [itemId],
    );
    return result.rows[0];
  });
}

async function dbReservation(reservationId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "state", "version", "financial_clearance_state"
         from "reservation"
        where "id" = $1`,
      [reservationId],
    );
    return result.rows[0];
  });
}

async function dbSegments(itemId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "id", "state", "start_date"::text as "start_date",
              "end_date"::text as "end_date"
         from "stay_segment"
        where "item_id" = $1
        order by "start_date", "id"`,
      [itemId],
    );
    return result.rows;
  });
}

async function dbAssignments(itemId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "id", "resource_id", "state", "checked_out_at", "version"
         from "room_assignment"
        where "item_id" = $1
        order by "assigned_at", "id"`,
      [itemId],
    );
    return result.rows;
  });
}

async function dbRoom(resourceId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "housekeeping_state", "maintenance_state", "version"
         from "resource"
        where "id" = $1`,
      [resourceId],
    );
    return result.rows[0];
  });
}

async function dbEvents(itemId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "id", "item_id", "resource_id", "segment_id", "payload",
              "item_version"
         from "stay_event"
        where "item_id" = $1 and "type" = 'STAY_CHECKED_OUT'
        order by "occurred_at", "id"`,
      [itemId],
    );
    return result.rows;
  });
}

async function dbAudit(action, resourceId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count",
              count("correlation_id")::int as "with_correlation"
         from "audit_event"
        where "action" = $1 and "resource_id" = $2`,
      [action, resourceId],
    );
    return result.rows[0];
  });
}

function contractOperations() {
  const operations = [];
  for (const [path, item] of Object.entries(phase7Contract.paths)) {
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
  member = await loginAs('member-a');
  tenant = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P07-C-${runId}`,
        name: `P07-03 ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  rooms = {};
  for (const suffix of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']) {
    const resource = await apiRequest(
      admin.context,
      'POST',
      `${base()}/resources`,
      {
        body: { code: `P07-03-${suffix}-${runId}`, type: 'ROOM', capacity: 2 },
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
        code: `P07-03-P-${runId}`,
        name: `P07-03 ${runId}`,
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
      code: `P07-03-R-${runId}`,
      name: `P07-03 ${runId}`,
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
  for (let offset = 0; offset <= 14; offset += 1) {
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

  successItem = await createConfirmed(0, 4);
  const successCheckIn = await checkIn(
    successItem,
    successItem.itemVersion,
    key('success-ci'),
    rooms.R1.id,
  );
  expect(successCheckIn.status).toBe(200);
  // Synthetic split of the in-house segment so checkout proves both branches:
  // the in-house segment closes and the future planned one is cancelled.
  await withOwner(async (client) => {
    await client.query(
      `update "stay_segment" set "end_date" = $2::date
        where "item_id" = $1 and "state" = 'IN_HOUSE'`,
      [successItem.itemId, addDays(2)],
    );
    await client.query(
      `insert into "stay_segment"
         ("tenant_id", "property_id", "item_id", "start_date", "end_date", "state")
       values ($1, $2, $3, $4::date, $5::date, 'PLANNED')`,
      [tenant, property.id, successItem.itemId, addDays(2), addDays(4)],
    );
  });

  rejectItem = await createConfirmed(0, 2);
  staleItem = await createConfirmed(0, 2);
  expect(
    (
      await checkIn(
        staleItem,
        staleItem.itemVersion,
        key('stale-ci'),
        rooms.R2.id,
      )
    ).status,
  ).toBe(200);
  oooItem = await createConfirmed(0, 2);
  expect(
    (await checkIn(oooItem, oooItem.itemVersion, key('ooo-ci'), rooms.R3.id))
      .status,
  ).toBe(200);
  raceItem = await createConfirmed(0, 2);
  expect(
    (await checkIn(raceItem, raceItem.itemVersion, key('race-ci'), rooms.R4.id))
      .status,
  ).toBe(200);

  multi = await createConfirmedMulti([
    [0, 2],
    [0, 2],
  ]);
  for (const [index, resourceId] of [
    [0, rooms.R5.id],
    [1, rooms.R6.id],
  ]) {
    const current = await dbItem(multi.items[index].itemId);
    expect(
      (
        await checkIn(
          {
            reservationId: multi.reservationId,
            itemId: multi.items[index].itemId,
          },
          current.version,
          key(`multi-ci-${index}`),
          resourceId,
        )
      ).status,
    ).toBe(200);
  }
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('P07-03 implemented route manifest matches the Phase 7 contract', () => {
  const fromCode = [...phase7Operations].sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );
  expect(fromCode).toEqual(contractOperations());
  expect(
    fromCode.filter((row) => row.operationId === 'CheckOutStay'),
  ).toHaveLength(1);
});

test('P07-03 checkout closes the item, assignment and room with one P09 event and replays safely', async () => {
  const beforeItem = await dbItem(successItem.itemId);
  const beforeRoom = await dbRoom(rooms.R1.id);
  const beforeAssignment = (await dbAssignments(successItem.itemId))[0];
  const result = await checkOut(
    successItem,
    beforeItem.version,
    key('success'),
  );
  expect(result.status).toBe(200);
  expect(result.body.replayed).toBe(false);
  expect(result.body.state).toBe('CHECKED_OUT');
  expect(result.body.reservation_state).toBe('CHECKED_OUT');
  expect(result.body.financial_clearance_state).toBe('PENDING');
  expect(result.body.checked_out_at).toBeTruthy();
  expect(result.body.segment_ids).toHaveLength(2);
  expect(result.body.assignment.state).toBe('COMPLETED');
  expect(result.body.assignment.resource_id).toBe(rooms.R1.id);

  const item = await dbItem(successItem.itemId);
  expect(item.state).toBe('CHECKED_OUT');
  expect(item.checked_out_at).not.toBeNull();
  expect(item.version).toBe(beforeItem.version + 1);
  expect(item.price_snapshot_id).toBe(beforeItem.price_snapshot_id);

  const reservation = await dbReservation(successItem.reservationId);
  expect(reservation.state).toBe('CHECKED_OUT');
  expect(reservation.financial_clearance_state).toBe('PENDING');
  expect(reservation.version).toBe(result.body.reservation_version);

  const segments = await dbSegments(successItem.itemId);
  expect(segments.map((row) => row.state)).toEqual([
    'CHECKED_OUT',
    'CANCELLED',
  ]);
  expect(segments[0].end_date).toBe(addDays(2));
  expect(segments[1].start_date).toBe(addDays(2));

  const assignments = await dbAssignments(successItem.itemId);
  expect(assignments).toHaveLength(1);
  expect(assignments[0].id).toBe(beforeAssignment.id);
  expect(assignments[0].state).toBe('COMPLETED');
  expect(assignments[0].checked_out_at).not.toBeNull();
  expect(assignments[0].version).toBe(beforeAssignment.version + 1);

  const room = await dbRoom(rooms.R1.id);
  expect(room.housekeeping_state).toBe('DIRTY');
  expect(room.maintenance_state).toBe('NONE');
  expect(room.version).toBe(beforeRoom.version + 1);

  const events = await dbEvents(successItem.itemId);
  expect(events).toHaveLength(1);
  expect(events[0].item_id).toBe(successItem.itemId);
  expect(events[0].resource_id).toBe(rooms.R1.id);
  expect(events[0].segment_id).toBe(segments[0].id);
  expect(events[0].item_version).toBe(item.version);
  expect(events[0].payload.item_id).toBe(successItem.itemId);
  expect(events[0].payload.resource_id).toBe(rooms.R1.id);
  expect(events[0].payload.assignment_id).toBe(result.body.assignment.id);
  expect(events[0].payload.departure).toBe(today);
  expect(events[0].payload.segment_ids).toEqual(result.body.segment_ids);
  expect(events[0].payload.segments.map((row) => row.state).sort()).toEqual([
    'CANCELLED',
    'CHECKED_OUT',
  ]);

  const audit = await dbAudit('stay.checked_out', successItem.itemId);
  expect(audit.count).toBe(1);
  expect(audit.with_correlation).toBe(1);

  // P09 consumption contract: the unique key makes a retried insert a no-op.
  const duplicate = await withOwner(async (client) =>
    client.query(
      `insert into "stay_event"
         ("tenant_id", "property_id", "reservation_id", "item_id",
          "segment_id", "type", "resource_id", "payload", "item_version")
       values ($1, $2, $3, $4, $5, 'STAY_CHECKED_OUT', $6, '{}'::jsonb, $7)
       on conflict ("tenant_id", "property_id", "item_id", "type", "item_version")
       do nothing
       returning "id"`,
      [
        tenant,
        property.id,
        successItem.reservationId,
        successItem.itemId,
        events[0].segment_id,
        rooms.R1.id,
        events[0].item_version,
      ],
    ),
  );
  expect(duplicate.rowCount).toBe(0);
  expect(await dbEvents(successItem.itemId)).toHaveLength(1);

  const replay = await checkOut(
    successItem,
    beforeItem.version,
    key('success'),
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.item_version).toBe(result.body.item_version);
  expect(replay.body.checked_out_at).toBe(result.body.checked_out_at);
  expect(replay.body.segment_ids).toEqual(result.body.segment_ids);
  expect(await dbEvents(successItem.itemId)).toHaveLength(1);
  expect((await dbRoom(rooms.R1.id)).version).toBe(room.version);

  const again = await checkOut(
    successItem,
    result.body.item_version,
    key('success-again'),
  );
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
  expect(await dbEvents(successItem.itemId)).toHaveLength(1);
  expect((await dbRoom(rooms.R1.id)).version).toBe(room.version);
  expect((await dbItem(successItem.itemId)).version).toBe(item.version);
});

test('P07-03 checkout aggregates a multi-item reservation without COMPLETED', async () => {
  const [itemOne, itemTwo] = multi.items;
  const firstCurrent = await dbItem(itemOne.itemId);
  const first = await checkOut(itemOne, firstCurrent.version, key('multi-one'));
  expect(first.status).toBe(200);
  expect(first.body.reservation_state).toBe('PARTIALLY_CHECKED_OUT');
  expect((await dbItem(itemTwo.itemId)).state).toBe('IN_HOUSE');
  expect((await dbReservation(multi.reservationId)).state).toBe(
    'PARTIALLY_CHECKED_OUT',
  );

  const secondCurrent = await dbItem(itemTwo.itemId);
  const second = await checkOut(
    itemTwo,
    secondCurrent.version,
    key('multi-two'),
  );
  expect(second.status).toBe(200);
  expect(second.body.reservation_state).toBe('CHECKED_OUT');
  const reservation = await dbReservation(multi.reservationId);
  expect(reservation.state).toBe('CHECKED_OUT');
  expect(reservation.state).not.toBe('COMPLETED');
  expect(await dbEvents(itemOne.itemId)).toHaveLength(1);
  expect(await dbEvents(itemTwo.itemId)).toHaveLength(1);
});

test('P07-03 checkout rejects items that are not in house', async () => {
  const item = await dbItem(rejectItem.itemId);
  const result = await checkOut(rejectItem, item.version, key('reject'));
  expect(result.status).toBe(409);
  expect(result.body.code).toBe('INVALID_STATE_TRANSITION');
  expect(result.body.details.state).toBe('CONFIRMED');
  expect((await dbItem(rejectItem.itemId)).state).toBe('CONFIRMED');
  expect(await dbEvents(rejectItem.itemId)).toHaveLength(0);
});

test('P07-03 checkout rejects stale versions without side effects', async () => {
  const item = await dbItem(staleItem.itemId);
  const stale = await checkOut(staleItem, item.version + 5, key('stale'));
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');
  expect(stale.body.details.current).toBe(item.version);
  expect((await dbItem(staleItem.itemId)).state).toBe('IN_HOUSE');
  expect(await dbEvents(staleItem.itemId)).toHaveLength(0);
});

test('P07-03 checkout is not blocked by maintenance and keeps its state', async () => {
  const roomBefore = await dbRoom(rooms.R3.id);
  const maintenance = await apiRequest(
    admin.context,
    'POST',
    `${base()}/resources/${rooms.R3.id}/maintenance`,
    {
      body: {
        version: roomBefore.version,
        state: 'OOO',
        reason: 'P07-03 synthetic maintenance during stay',
      },
    },
  );
  expect(maintenance.status).toBe(200);
  const marked = await dbRoom(rooms.R3.id);
  expect(marked.maintenance_state).toBe('OOO');

  const item = await dbItem(oooItem.itemId);
  const result = await checkOut(oooItem, item.version, key('ooo'));
  expect(result.status).toBe(200);
  const room = await dbRoom(rooms.R3.id);
  expect(room.housekeeping_state).toBe('DIRTY');
  expect(room.maintenance_state).toBe('OOO');
  expect(room.version).toBe(marked.version + 1);
});

test('P07-03 concurrent checkouts leave one winner, one event and one dirty transition', async () => {
  const beforeItem = await dbItem(raceItem.itemId);
  const beforeRoom = await dbRoom(rooms.R4.id);
  const [first, second] = await Promise.all([
    checkOut(raceItem, beforeItem.version, key('race-a')),
    checkOut(raceItem, beforeItem.version, key('race-b')),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(statuses[0]).toBe(200);
  expect([409, 412]).toContain(statuses[1]);
  const winner = first.status === 200 ? first : second;

  const item = await dbItem(raceItem.itemId);
  expect(item.state).toBe('CHECKED_OUT');
  expect(item.version).toBe(winner.body.item_version);
  expect(await dbEvents(raceItem.itemId)).toHaveLength(1);
  const assignments = await dbAssignments(raceItem.itemId);
  expect(assignments.filter((row) => row.state === 'COMPLETED')).toHaveLength(
    1,
  );
  const room = await dbRoom(rooms.R4.id);
  expect(room.housekeeping_state).toBe('DIRTY');
  expect(room.version).toBe(beforeRoom.version + 1);
  expect((await dbAudit('stay.checked_out', raceItem.itemId)).count).toBe(1);
});

test('P07-03 checkout enforces permissions and idempotency keys', async () => {
  const item = await dbItem(staleItem.itemId);
  const memberOut = await apiRequest(
    member.context,
    'POST',
    `${base()}/reservations/${staleItem.reservationId}/items/${staleItem.itemId}/check-out`,
    {
      body: { version: item.version },
      headers: { 'idempotency-key': key('member') },
    },
  );
  expect(memberOut.status).toBe(403);
  const missingKey = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${staleItem.reservationId}/items/${staleItem.itemId}/check-out`,
    {
      body: { version: item.version },
      idempotency: false,
    },
  );
  expect(missingKey.status).toBe(400);
  expect(missingKey.body.code).toBe('INVALID_REQUEST');
  expect(missingKey.body.details.field).toBe('idempotency_key');
  expect((await dbItem(staleItem.itemId)).state).toBe('IN_HOUSE');
  expect(await dbEvents(staleItem.itemId)).toHaveLength(0);
  expect((await dbRoom(rooms.R2.id)).housekeeping_state).toBe('CLEAN');
});
