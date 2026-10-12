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
let arrivalItem;
let inHouseItem;
let assignItem;
let overlapItem;
let ciItem;
let ciAssignedItem;
let ciDirtyItem;
let raceItem;
let draftOnlyItem;
let blockItem;
let emergencyItem;
let plannedBlockId;
let emergencyBlockId;

const runId = String(Date.now()).slice(-6);
const phase7Contract = JSON.parse(
  readFileSync('docs/contracts/phase7.openapi.json', 'utf8'),
);

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

const today = addDays(0);

function base() {
  return `/tenants/${tenant}/properties/${property.id}`;
}

async function quote(arrival, departure, adults = 2, quantity = 1) {
  const response = await apiRequest(admin.context, 'POST', `${base()}/quotes`, {
    body: {
      product_id: productId,
      rate_plan_id: planId,
      period: { arrival: addDays(arrival), departure: addDays(departure) },
      occupancy: { adults, child_ages: [] },
      quantity,
    },
  });
  if (response.status !== 201)
    throw new Error(
      `quote failed: ${response.status} ${JSON.stringify(response.body)}`,
    );
  return response.body.quote.id;
}

async function createDraft(items) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: items.map((item) => ({
          product_id: productId,
          period: {
            arrival: addDays(item[0]),
            departure: addDays(item[1]),
          },
          occupancy: { adults: 2, child_ages: [] },
          quantity: 1,
        })),
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

async function createConfirmed(arrival, departure) {
  const draft = await createDraft([[arrival, departure]]);
  const quoteId = await quote(arrival, departure);
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
    reservationVersion: confirmed.body.version,
    itemId,
    itemVersion: after.items[0].version,
  };
}

async function assign(item, resourceId, version, key, extra = {}) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/assignments`,
    {
      body: { resource_id: resourceId, version, ...extra },
      headers: { 'idempotency-key': key },
    },
  );
}

async function checkIn(item, version, key, resourceId) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-in`,
    {
      body: {
        version,
        ...(resourceId ? { resource_id: resourceId } : {}),
      },
      headers: key ? { 'idempotency-key': key } : {},
    },
  );
}

async function board(date = today) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/front-desk/board?date=${date}`,
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function createBlock(resourceId, mode, from = 0, to = 2) {
  return apiRequest(admin.context, 'POST', `${base()}/blocks`, {
    body: {
      resource_ids: [resourceId],
      period: { arrival: addDays(from), departure: addDays(to) },
      reason: `P07-01 synthetic ${mode} block`,
      mode,
    },
  });
}

async function releaseBlock(blockId) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/blocks/${blockId}/release`,
    { body: { reason: 'P07-01 release' } },
  );
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
        code: `P07-B-${runId}`,
        name: `P07-01 ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
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
    'R13',
    'R14',
    'R15',
    'R16',
  ]) {
    const resource = await apiRequest(
      admin.context,
      'POST',
      `${base()}/resources`,
      {
        body: { code: `P07-${suffix}-${runId}`, type: 'ROOM', capacity: 2 },
      },
    );
    expect(resource.status).toBe(201);
    rooms[suffix] = resource.body.resource;
  }
  const plannedBlock = await createBlock(rooms.R13.id, 'PLANNED');
  expect(plannedBlock.status).toBe(201);
  plannedBlockId = plannedBlock.body.block.id;
  const emergencyBlock = await createBlock(rooms.R14.id, 'EMERGENCY');
  expect(emergencyBlock.status).toBe(201);
  emergencyBlockId = emergencyBlock.body.block.id;
  const ooo = await apiRequest(
    admin.context,
    'POST',
    `${base()}/resources/${rooms.R3.id}/maintenance`,
    {
      body: {
        version: rooms.R3.version,
        state: 'OOO',
        reason: 'P07-01 synthetic out of order',
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
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code: `P07-P-${runId}`,
        name: 'P07-01 room',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
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
      code: `P07-RATE-${runId}`,
      name: 'P07-01 rate',
      product_id: productId,
      currency: 'IDR',
    },
  });
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
    { body: { cells } },
  );
  expect(rates.status).toBe(200);

  arrivalItem = await createConfirmed(0, 3);
  inHouseItem = await createConfirmed(0, 1);
  const seededCheckIn = await checkIn(
    inHouseItem,
    inHouseItem.itemVersion,
    `p07-seed-stay-${runId}`,
    rooms.R5.id,
  );
  expect(seededCheckIn.status).toBe(200);
  assignItem = await createConfirmed(0, 3);
  overlapItem = await createConfirmed(0, 3);
  ciItem = await createConfirmed(0, 2);
  ciAssignedItem = await createConfirmed(0, 2);
  ciDirtyItem = await createConfirmed(0, 2);
  raceItem = await createConfirmed(0, 2);
  blockItem = await createConfirmed(0, 2);
  emergencyItem = await createConfirmed(0, 2);
  const draft = await createDraft([[0, 2]]);
  const draftDetail = await detail(draft.id);
  draftOnlyItem = {
    reservationId: draft.id,
    itemId: draftDetail.items[0].id,
    itemVersion: draftDetail.items[0].version,
  };
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

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

test('implemented route manifest matches the Phase 7 contract', () => {
  const fromCode = [...phase7Operations].sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );
  expect(fromCode).toEqual(contractOperations());
  for (const operation of contractOperations()) {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method))
      expect(operation.csrf).toBe(true);
  }
});

test('P07-01 board lists arrivals, departures, in-house stays and rooms with readiness', async () => {
  const result = await board();
  expect(result.date).toBe(today);
  const arrival = result.arrivals.find(
    (row) => row.item_id === arrivalItem.itemId,
  );
  expect(arrival).toBeTruthy();
  expect(arrival.reservation_id).toBe(arrivalItem.reservationId);
  expect(arrival.state).toBe('CONFIRMED');
  expect(arrival.arrival).toBe(today);
  expect(arrival.item_version).toBeGreaterThanOrEqual(1);
  expect(arrival.commitment_id).toBeTruthy();
  expect(arrival.assignment).toBeNull();
  const candidates = new Map(
    arrival.candidates.map((row) => [row.resource_id, row]),
  );
  expect(candidates.get(rooms.R1.id).eligible).toBe(true);
  expect(candidates.get(rooms.R1.id).reason).toBeNull();
  expect(candidates.get(rooms.R2.id).eligible).toBe(false);
  expect(candidates.get(rooms.R2.id).reason).toBe('DIRTY');
  expect(candidates.get(rooms.R3.id).eligible).toBe(false);
  expect(candidates.get(rooms.R3.id).reason).toBe('OOO');
  const departure = result.departures.find(
    (row) => row.item_id === inHouseItem.itemId,
  );
  expect(departure).toBeUndefined();
  const tomorrowBoard = await board(addDays(1));
  const departureTomorrow = tomorrowBoard.departures.find(
    (row) => row.item_id === inHouseItem.itemId,
  );
  expect(departureTomorrow).toBeTruthy();
  expect(departureTomorrow.departure).toBe(addDays(1));
  expect(departureTomorrow.assignment.state).toBe('ACTIVE');
  expect(departureTomorrow.assignment.resource_id).toBe(rooms.R5.id);
  expect(departureTomorrow.room.resource_id).toBe(rooms.R5.id);
  expect(departureTomorrow.room.housekeeping_state).toBe('CLEAN');
  const inHouseRow = result.inHouse.find(
    (row) => row.item_id === inHouseItem.itemId,
  );
  expect(inHouseRow).toBeTruthy();
  const roomRows = new Map(result.rooms.map((row) => [row.resource_id, row]));
  expect(roomRows.size).toBe(Object.keys(rooms).length);
  expect(roomRows.get(rooms.R2.id).housekeeping_state).toBe('DIRTY');
  expect(roomRows.get(rooms.R3.id).maintenance_state).toBe('OOO');
  expect(roomRows.get(rooms.R5.id).assignment.state).toBe('ACTIVE');
});

test('P07-01 board without a date uses the property-local date and echoes timezone', async () => {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/front-desk/board`,
  );
  expect(response.status).toBe(200);
  const expectedParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const expectedValue = (type) =>
    expectedParts.find((part) => part.type === type).value;
  const expected = `${expectedValue('year')}-${expectedValue('month')}-${expectedValue('day')}`;
  expect(response.body.date).toBe(expected);
  expect(response.body.timezone).toBe('Asia/Jakarta');
  const explicit = await board(addDays(1));
  expect(explicit.date).toBe(addDays(1));
  expect(explicit.timezone).toBe('Asia/Jakarta');
});

test('P07-01 check-in accepts an arrival on the property-local date across the UTC window', async () => {
  const utcToday = new Date().toISOString().slice(0, 10);
  const localToday = jakartaToday();
  const item = await createConfirmed(0, 2);
  const response = await checkIn(
    item,
    item.itemVersion,
    `p07-local-ci-${runId}`,
    rooms.R12.id,
  );
  expect(response.status).toBe(200);
  expect(response.body.state).toBe('IN_HOUSE');
  expect(response.body.assignment.resource_id).toBe(rooms.R12.id);
  if (localToday > utcToday) {
    expect(localToday).toBe(addDays(0));
  } else {
    expect(localToday).toBe(utcToday);
  }
});

test('P07-01 an active inventory block prevents assignment and check-in and shows BLOCKED on the board', async () => {
  const blockedAssign = await assign(
    blockItem,
    rooms.R13.id,
    blockItem.itemVersion,
    `p07-block-${runId}`,
  );
  expect(blockedAssign.status).toBe(400);
  expect(blockedAssign.body.code).toBe('INVALID_REQUEST');
  expect(blockedAssign.body.details.reason).toBe('BLOCKED');
  const blockedCheckIn = await checkIn(
    blockItem,
    blockItem.itemVersion,
    `p07-block-ci-${runId}`,
    rooms.R13.id,
  );
  expect(blockedCheckIn.status).toBe(400);
  expect(blockedCheckIn.body.code).toBe('INVALID_REQUEST');
  expect(blockedCheckIn.body.details.reason).toBe('BLOCKED');
  const afterRejections = await withOwner(async (client) => {
    const item = await client.query(
      `select "state", "version" from "reservation_item" where "id" = $1`,
      [blockItem.itemId],
    );
    const assignments = await client.query(
      `select count(*)::int as "count" from "room_assignment" where "item_id" = $1`,
      [blockItem.itemId],
    );
    return { item: item.rows[0], assignments: assignments.rows[0].count };
  });
  expect(afterRejections.item.state).toBe('CONFIRMED');
  expect(afterRejections.item.version).toBe(blockItem.itemVersion);
  expect(afterRejections.assignments).toBe(0);

  const blockedBoard = await board();
  const blockedCandidate = blockedBoard.arrivals
    .find((row) => row.item_id === blockItem.itemId)
    .candidates.find((row) => row.resource_id === rooms.R13.id);
  expect(blockedCandidate.eligible).toBe(false);
  expect(blockedCandidate.reason).toBe('BLOCKED');

  const released = await releaseBlock(plannedBlockId);
  expect(released.status).toBe(200);
  expect(released.body.block.state).toBe('RELEASED');
  const unblocked = await assign(
    blockItem,
    rooms.R13.id,
    blockItem.itemVersion,
    `p07-block-released-${runId}`,
  );
  expect(unblocked.status).toBe(200);
  expect(unblocked.body.assignment.state).toBe('PLANNED');

  expect(emergencyBlockId).toBeTruthy();
  const emergencyAssign = await assign(
    emergencyItem,
    rooms.R14.id,
    emergencyItem.itemVersion,
    `p07-emergency-${runId}`,
  );
  expect(emergencyAssign.status).toBe(400);
  expect(emergencyAssign.body.details.reason).toBe('BLOCKED');
  const emergencyCheckIn = await checkIn(
    emergencyItem,
    emergencyItem.itemVersion,
    `p07-emergency-ci-${runId}`,
    rooms.R14.id,
  );
  expect(emergencyCheckIn.status).toBe(400);
  expect(emergencyCheckIn.body.details.reason).toBe('BLOCKED');
  const emergencyBoard = await board();
  const emergencyCandidate = emergencyBoard.arrivals
    .find((row) => row.item_id === emergencyItem.itemId)
    .candidates.find((row) => row.resource_id === rooms.R14.id);
  expect(emergencyCandidate.eligible).toBe(false);
  expect(emergencyCandidate.reason).toBe('BLOCKED');
});

test('P07-01 assign binds clean rooms, rejects dirty/blocked, replaces and replays', async () => {
  const first = await assign(
    assignItem,
    rooms.R1.id,
    assignItem.itemVersion,
    `p07-assign-${runId}`,
  );
  expect(first.status).toBe(200);
  expect(first.body.replayed).toBe(false);
  expect(first.body.assignment.state).toBe('PLANNED');
  expect(first.body.assignment.resource_id).toBe(rooms.R1.id);
  const firstItemVersion = first.body.item_version;
  const replay = await assign(
    assignItem,
    rooms.R1.id,
    assignItem.itemVersion,
    `p07-assign-${runId}`,
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.assignment.id).toBe(first.body.assignment.id);
  const keyConflict = await assign(
    assignItem,
    rooms.R4.id,
    firstItemVersion,
    `p07-assign-${runId}`,
  );
  expect(keyConflict.status).toBe(409);
  expect(keyConflict.body.code).toBe('CONFLICT');
  const replacement = await assign(
    assignItem,
    rooms.R4.id,
    firstItemVersion,
    `p07-assign-2-${runId}`,
  );
  expect(replacement.status).toBe(200);
  expect(replacement.body.assignment.resource_id).toBe(rooms.R4.id);
  expect(replacement.body.assignment.id).not.toBe(first.body.assignment.id);
  const stored = await withOwner(async (client) => {
    const rows = await client.query(
      `select "id", "resource_id", "state" from "room_assignment"
        where "item_id" = $1 order by "assigned_at", "id"`,
      [assignItem.itemId],
    );
    const audit = await client.query(
      `select count(*)::int as "count" from "audit_event"
        where "action" = 'stay.assignment.created' and "resource_id" = $1`,
      [replacement.body.assignment.id],
    );
    return { rows: rows.rows, audit: audit.rows[0].count };
  });
  expect(
    stored.rows.filter((row) => row.state === 'CANCELLED').map((row) => row.id),
  ).toEqual([first.body.assignment.id]);
  expect(
    stored.rows.filter((row) => row.state === 'PLANNED').map((row) => row.id),
  ).toEqual([replacement.body.assignment.id]);
  expect(stored.audit).toBe(1);
  const overlap = await assign(
    overlapItem,
    rooms.R4.id,
    overlapItem.itemVersion,
    `p07-overlap-${runId}`,
  );
  expect(overlap.status).toBe(409);
  expect(overlap.body.code).toBe('CONFLICT');
  const overlapBoard = await board();
  const overlapRow = overlapBoard.arrivals.find(
    (row) => row.item_id === overlapItem.itemId,
  );
  const occupied = overlapRow.candidates.find(
    (row) => row.resource_id === rooms.R4.id,
  );
  expect(occupied.eligible).toBe(false);
  expect(occupied.reason).toBe('OCCUPIED');
  const dirty = await assign(
    overlapItem,
    rooms.R2.id,
    overlapItem.itemVersion,
    `p07-dirty-${runId}`,
  );
  expect(dirty.status).toBe(400);
  expect(dirty.body.code).toBe('INVALID_REQUEST');
  expect(dirty.body.details.reason).toBe('DIRTY');
  const blocked = await assign(
    overlapItem,
    rooms.R3.id,
    overlapItem.itemVersion,
    `p07-ooo-block-${runId}`,
  );
  expect(blocked.status).toBe(400);
  expect(blocked.body.code).toBe('INVALID_REQUEST');
  expect(blocked.body.details.reason).toBe('OOO');
});

test('P07-01 check-in transitions item, segment, assignment and writes one durable event', async () => {
  const prior = await detail(ciAssignedItem.reservationId);
  const itemVersion = prior.items[0].version;
  const assignment = await assign(
    ciAssignedItem,
    rooms.R6.id,
    itemVersion,
    `p07-ci-assign-${runId}`,
  );
  expect(assignment.status).toBe(200);
  const key = `p07-checkin-${runId}`;
  const first = await checkIn(
    ciAssignedItem,
    assignment.body.item_version,
    key,
  );
  expect(first.status).toBe(200);
  expect(first.body.replayed).toBe(false);
  expect(first.body.state).toBe('IN_HOUSE');
  expect(first.body.segment_id).toBeTruthy();
  expect(first.body.assignment.state).toBe('ACTIVE');
  expect(first.body.assignment.resource_id).toBe(rooms.R6.id);
  const stored = await withOwner(async (client) => {
    const item = await client.query(
      `select "state", "checked_in_at", "version" from "reservation_item" where "id" = $1`,
      [ciAssignedItem.itemId],
    );
    const segment = await client.query(
      `select "state", "checked_in_at" from "stay_segment" where "id" = $1`,
      [first.body.segment_id],
    );
    const assignmentRow = await client.query(
      `select "state", "checked_in_at", "version" from "room_assignment" where "id" = $1`,
      [first.body.assignment.id],
    );
    const reservation = await client.query(
      `select "state", "version", "financial_clearance_state" from "reservation" where "id" = $1`,
      [ciAssignedItem.reservationId],
    );
    const events = await client.query(
      `select count(*)::int as "count" from "stay_event"
        where "item_id" = $1 and "type" = 'STAY_CHECKED_IN'`,
      [ciAssignedItem.itemId],
    );
    const audit = await client.query(
      `select count(*)::int as "count" from "audit_event"
        where "action" = 'stay.checked_in' and "resource_id" = $1`,
      [ciAssignedItem.itemId],
    );
    return {
      item: item.rows[0],
      segment: segment.rows[0],
      assignment: assignmentRow.rows[0],
      reservation: reservation.rows[0],
      events: events.rows[0].count,
      audit: audit.rows[0].count,
    };
  });
  expect(stored.item.state).toBe('IN_HOUSE');
  expect(stored.item.checked_in_at).not.toBeNull();
  expect(stored.segment.state).toBe('IN_HOUSE');
  expect(stored.segment.checked_in_at).not.toBeNull();
  expect(stored.assignment.state).toBe('ACTIVE');
  expect(stored.assignment.checked_in_at).not.toBeNull();
  expect(stored.reservation.state).toBe('IN_HOUSE');
  expect(stored.reservation.version).toBe(first.body.reservation_version);
  expect(stored.reservation.financial_clearance_state).toBe('PENDING');
  expect(stored.events).toBe(1);
  expect(stored.audit).toBe(1);
  const replay = await checkIn(
    ciAssignedItem,
    assignment.body.item_version,
    key,
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.item_id).toBe(first.body.item_id);
  expect(replay.body.assignment.state).toBe('ACTIVE');
  const again = await checkIn(
    ciAssignedItem,
    first.body.item_version,
    `p07-checkin-2-${runId}`,
  );
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
  const eventsAfter = await withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "stay_event"
            where "item_id" = $1 and "type" = 'STAY_CHECKED_IN'`,
          [ciAssignedItem.itemId],
        )
      ).rows[0].count,
    ),
  );
  expect(eventsAfter).toBe(1);
});

test('P07-01 check-in without assignment, dirty rejection, stale version and state rejection', async () => {
  const fresh = await detail(ciItem.reservationId);
  const created = await checkIn(
    ciItem,
    fresh.items[0].version,
    `p07-ci-direct-${runId}`,
    rooms.R1.id,
  );
  expect(created.status).toBe(200);
  expect(created.body.state).toBe('IN_HOUSE');
  expect(created.body.assignment.state).toBe('ACTIVE');
  expect(created.body.assignment.resource_id).toBe(rooms.R1.id);
  const dirty = await checkIn(
    ciDirtyItem,
    ciDirtyItem.itemVersion,
    `p07-ci-dirty-${runId}`,
    rooms.R2.id,
  );
  expect(dirty.status).toBe(400);
  expect(dirty.body.code).toBe('INVALID_REQUEST');
  expect(dirty.body.details.reason).toBe('DIRTY');
  const stale = await checkIn(
    ciDirtyItem,
    ciDirtyItem.itemVersion + 5,
    `p07-ci-stale-${runId}`,
    rooms.R1.id,
  );
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');
  const notConfirmed = await checkIn(
    draftOnlyItem,
    draftOnlyItem.itemVersion,
    `p07-ci-draft-${runId}`,
    rooms.R1.id,
  );
  expect(notConfirmed.status).toBe(409);
  expect(notConfirmed.body.code).toBe('INVALID_STATE_TRANSITION');
  const missingKey = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${ciDirtyItem.reservationId}/items/${ciDirtyItem.itemId}/check-in`,
    {
      body: { version: ciDirtyItem.itemVersion, resource_id: rooms.R1.id },
      idempotency: false,
    },
  );
  expect(missingKey.status).toBe(400);
  expect(missingKey.body.code).toBe('INVALID_REQUEST');
  expect(missingKey.body.details.field).toBe('idempotency_key');
});

test('P07-01 concurrent check-ins for one item end with a single winner and one event', async () => {
  const raceVersion = raceItem.itemVersion;
  const [first, second] = await Promise.all([
    checkIn(raceItem, raceVersion, `p07-race-a-${runId}`, rooms.R7.id),
    checkIn(raceItem, raceVersion, `p07-race-b-${runId}`, rooms.R7.id),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(statuses[0]).toBe(200);
  expect([409, 412]).toContain(statuses[1]);
  const stored = await withOwner(async (client) => {
    const events = await client.query(
      `select count(*)::int as "count" from "stay_event"
        where "item_id" = $1 and "type" = 'STAY_CHECKED_IN'`,
      [raceItem.itemId],
    );
    const assignments = await client.query(
      `select count(*)::int as "count" from "room_assignment"
        where "item_id" = $1 and "state" = 'ACTIVE'`,
      [raceItem.itemId],
    );
    const item = await client.query(
      `select "state" from "reservation_item" where "id" = $1`,
      [raceItem.itemId],
    );
    return {
      events: events.rows[0].count,
      assignments: assignments.rows[0].count,
      state: item.rows[0].state,
    };
  });
  expect(stored.events).toBe(1);
  expect(stored.assignments).toBe(1);
  expect(stored.state).toBe('IN_HOUSE');
});

test('P07-01 a whole-villa arrival exposes and activates every reserved room as one group', async () => {
  const villaRooms = [];
  for (const suffix of ['V1', 'V2']) {
    const created = await apiRequest(
      admin.context,
      'POST',
      `${base()}/resources`,
      {
        body: {
          code: `P07-${suffix}-${runId}`,
          type: 'ROOM',
          capacity: 2,
        },
      },
    );
    expect(created.status).toBe(201);
    villaRooms.push(created.body.resource);
  }
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code: `P07-VILLA-${runId}`,
        name: 'P07 whole villa',
        kind: 'VILLA',
        occupancy_adults_max: 4,
      },
    },
  );
  expect(product.status).toBe(201);
  const composition = await apiRequest(
    admin.context,
    'POST',
    `${base()}/compositions`,
    {
      body: {
        product_id: product.body.product.id,
        effective_period: { arrival: addDays(0), departure: addDays(14) },
        resource_ids: villaRooms.map((room) => room.id),
        nested_version_ids: [],
      },
    },
  );
  expect(composition.status).toBe(201);
  const compositionActivation = await apiRequest(
    admin.context,
    'POST',
    `${base()}/compositions/${composition.body.composition.id}/activate`,
    { body: { reason: 'P07 whole-villa group check-in test' } },
  );
  expect(compositionActivation.status).toBe(200);
  const productActivation = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/products/${product.body.product.id}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(productActivation.status).toBe(200);
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: {
      code: `P07-VILLA-RATE-${runId}`,
      name: 'P07 whole villa rate',
      product_id: product.body.product.id,
      currency: 'IDR',
    },
  });
  expect(plan.status).toBe(201);
  const planActivation = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/rate-plans/${plan.body.rate_plan.id}`,
    {
      body: {
        version: plan.body.rate_plan.version,
        status: 'ACTIVE',
      },
    },
  );
  expect(planActivation.status).toBe(200);
  const rates = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rates/batch`,
    {
      body: {
        cells: [0, 1].map((offset) => ({
          rate_plan_id: plan.body.rate_plan.id,
          date: addDays(offset),
          occupancy: 2,
          money: { amount: '1200000', currency: 'IDR' },
        })),
      },
    },
  );
  expect(rates.status).toBe(200);
  const draft = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: [
          {
            product_id: product.body.product.id,
            period: { arrival: addDays(0), departure: addDays(2) },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
      },
    },
  );
  expect(draft.status).toBe(201);
  const draftDetail = await detail(draft.body.reservation.id);
  const villaItem = draftDetail.items[0];
  const quoteResponse = await apiRequest(
    admin.context,
    'POST',
    `${base()}/quotes`,
    {
      body: {
        product_id: product.body.product.id,
        rate_plan_id: plan.body.rate_plan.id,
        period: { arrival: addDays(0), departure: addDays(2) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    },
  );
  expect(quoteResponse.status).toBe(201);
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations`,
    {
      body: {
        reservation_id: draft.body.reservation.id,
        inventory_version: await currentInventoryVersion(),
        items: [
          {
            item_id: villaItem.id,
            price_snapshot_id: quoteResponse.body.quote.id,
          },
        ],
      },
    },
  );
  expect(confirmed.status).toBe(200);
  const afterConfirmation = await detail(draft.body.reservation.id);
  const boardBefore = await board();
  const villaArrival = boardBefore.arrivals.find(
    (row) => row.item_id === villaItem.id,
  );
  expect(villaArrival.group_assignment).toBe(true);
  expect(villaArrival.assignment).toBeNull();
  expect(villaArrival.assignments).toEqual([]);
  expect(
    villaArrival.allocated_rooms.map((room) => room.resource_id).sort(),
  ).toEqual(villaRooms.map((room) => room.id).sort());
  expect(
    villaArrival.candidates.map((room) => room.resource_id).sort(),
  ).toEqual(villaRooms.map((room) => room.id).sort());
  expect(villaArrival.candidates.every((room) => room.eligible)).toBe(true);

  const checkedIn = await checkIn(
    {
      reservationId: draft.body.reservation.id,
      itemId: villaItem.id,
    },
    afterConfirmation.items[0].version,
    `p07-villa-checkin-${runId}`,
  );
  expect(checkedIn.status).toBe(200);
  expect(checkedIn.body.assignments).toHaveLength(2);
  expect(
    checkedIn.body.assignments.map((row) => row.resource_id).sort(),
  ).toEqual(villaRooms.map((room) => room.id).sort());
  expect(
    checkedIn.body.assignments.every((row) => row.state === 'ACTIVE'),
  ).toBe(true);

  const boardAfter = await board();
  const villaInHouse = boardAfter.inHouse.find(
    (row) => row.item_id === villaItem.id,
  );
  expect(villaInHouse.group_assignment).toBe(true);
  expect(villaInHouse.assignments).toHaveLength(2);
  expect(villaInHouse.rooms).toHaveLength(2);
});

test('P07-01 front desk permissions are enforced', async () => {
  const memberBoard = await apiRequest(
    member.context,
    'GET',
    `${base()}/front-desk/board?date=${today}`,
  );
  expect(memberBoard.status).toBe(403);
  const memberAssign = await apiRequest(
    member.context,
    'POST',
    `${base()}/reservations/${overlapItem.reservationId}/items/${overlapItem.itemId}/assignments`,
    {
      body: {
        resource_id: rooms.R6.id,
        version: overlapItem.itemVersion,
      },
    },
  );
  expect(memberAssign.status).toBe(403);
  const memberCheckIn = await apiRequest(
    member.context,
    'POST',
    `${base()}/reservations/${overlapItem.reservationId}/items/${overlapItem.itemId}/check-in`,
    { body: { version: overlapItem.itemVersion } },
  );
  expect(memberCheckIn.status).toBe(403);
});
