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
let property;
const rooms = {};
const products = {};

const runId = String(Date.now()).slice(-6);
const key = (name) => `set07-${runId}-${name}`;

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

async function currentInventoryVersion() {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=${addDays(0)}&to=${addDays(14)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function createResource(code, type, options = {}) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/resources`,
    { body: { code, type, capacity: options.capacity ?? 2 } },
  );
  expect(response.status).toBe(201);
  return response.body.resource;
}

async function createOffering(input) {
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code: input.code,
        name: input.name,
        kind: input.kind,
        occupancy_adults_max: input.adultsMax,
      },
    },
  );
  expect(product.status).toBe(201);
  if (input.leafResourceIds?.length) {
    const composition = await apiRequest(
      admin.context,
      'POST',
      `${base()}/compositions`,
      {
        body: {
          product_id: product.body.product.id,
          effective_period: { arrival: addDays(0), departure: addDays(14) },
          resource_ids: input.leafResourceIds,
          nested_version_ids: [],
        },
      },
    );
    expect(composition.status).toBe(201);
    const activated = await apiRequest(
      admin.context,
      'POST',
      `${base()}/compositions/${composition.body.composition.id}/activate`,
      { body: { reason: `SET-07 ${input.code} composition` } },
    );
    expect(activated.status).toBe(200);
  } else {
    for (const resourceId of input.candidateResourceIds ?? []) {
      const candidate = await apiRequest(
        admin.context,
        'POST',
        `${base()}/products/${product.body.product.id}/candidates`,
        { body: { resource_id: resourceId } },
      );
      expect(candidate.status).toBe(201);
    }
  }
  const activatedProduct = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/products/${product.body.product.id}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(activatedProduct.status).toBe(200);
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: {
      code: `${input.code}-RATE`,
      name: `${input.name} rate`,
      product_id: product.body.product.id,
      currency: 'IDR',
    },
  });
  expect(plan.status).toBe(201);
  const planActivation = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/rate-plans/${plan.body.rate_plan.id}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  expect(planActivation.status).toBe(200);
  const rates = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rates/batch`,
    {
      body: {
        cells: [0, 1, 2, 3, 4, 5, 6, 7].map((offset) => ({
          rate_plan_id: plan.body.rate_plan.id,
          date: addDays(offset),
          occupancy: input.rateOccupancy ?? 2,
          money: { amount: '950000', currency: 'IDR' },
        })),
      },
    },
  );
  expect(rates.status).toBe(200);
  return {
    productId: product.body.product.id,
    planId: plan.body.rate_plan.id,
  };
}

async function book(name, from = 0, to = 2, adults = 2) {
  const offering = products[name];
  const draft = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: [
          {
            product_id: offering.productId,
            period: { arrival: addDays(from), departure: addDays(to) },
            occupancy: { adults, child_ages: [] },
            quantity: 1,
          },
        ],
      },
    },
  );
  expect(draft.status).toBe(201);
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base()}/reservations/${draft.body.reservation.id}`,
  );
  expect(detail.status).toBe(200);
  const itemId = detail.body.items[0].id;
  const quote = await apiRequest(admin.context, 'POST', `${base()}/quotes`, {
    body: {
      product_id: offering.productId,
      rate_plan_id: offering.planId,
      period: { arrival: addDays(from), departure: addDays(to) },
      occupancy: { adults, child_ages: [] },
      quantity: 1,
    },
  });
  expect(quote.status).toBe(201);
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations`,
    {
      body: {
        reservation_id: draft.body.reservation.id,
        inventory_version: await currentInventoryVersion(),
        items: [{ item_id: itemId, price_snapshot_id: quote.body.quote.id }],
      },
    },
  );
  expect(confirmed.status).toBe(200);
  const after = await apiRequest(
    admin.context,
    'GET',
    `${base()}/reservations/${draft.body.reservation.id}`,
  );
  expect(after.status).toBe(200);
  const row = after.body.items.find((item) => item.id === itemId);
  return {
    reservationId: draft.body.reservation.id,
    itemId,
    itemVersion: row.version,
    reservationVersion: confirmed.body.version,
  };
}

async function itemVersion(reservationId, itemId) {
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base()}/reservations/${reservationId}`,
  );
  expect(detail.status).toBe(200);
  return detail.body.items.find((item) => item.id === itemId).version;
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

async function assign(item, resourceId, version) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/assignments`,
    {
      body: { resource_id: resourceId, version },
      headers: { 'idempotency-key': key(`assign-${resourceId}-${version}`) },
    },
  );
}

async function checkIn(item, version) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-in`,
    {
      body: { version },
      headers: { 'idempotency-key': key(`checkin-${item.itemId}-${version}`) },
    },
  );
}

async function checkOut(item, version) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-out`,
    {
      body: { version },
      headers: { 'idempotency-key': key(`checkout-${item.itemId}-${version}`) },
    },
  );
}

async function stayDbState(itemId) {
  return withOwner(async (client) => {
    const assignments = await client.query(
      `select "resource_id", "state", "start_date"::text as start_date,
              "end_date"::text as end_date
         from "room_assignment" where "item_id" = $1 order by "resource_id"`,
      [itemId],
    );
    const item = await client.query(
      `select "state", "arrival"::text as arrival, "departure"::text as departure
         from "reservation_item" where "id" = $1`,
      [itemId],
    );
    const allocations = await client.query(
      `select a."resource_id", a."start_date"::text as start_date,
              a."end_date"::text as end_date, a."state"
         from "plan_allocation" a
         join "commitment" c on c."id" = a."commitment_id"
        where c."source_id" = $1 and c."source_kind" = 'ITEM'
          and c."state" = 'ACTIVE' and a."state" = 'ACTIVE'
        order by a."resource_id"`,
      [itemId],
    );
    return {
      assignments: assignments.rows,
      item: item.rows[0],
      allocations: allocations.rows,
    };
  });
}

async function resourceHousekeeping(resourceId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "housekeeping_state", "maintenance_state" from "resource" where "id" = $1`,
      [resourceId],
    );
    return result.rows[0];
  });
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
        code: `SET07-${runId}`,
        name: `SET-07 templates ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  for (const [name, type] of [
    ['SITE_A', 'SITE'],
    ['DORM_A', 'ROOM'],
    ['BED_A1', 'BED'],
    ['BED_A2', 'BED'],
    ['DORM_B', 'ROOM'],
    ['BED_B1', 'BED'],
    ['BED_B2', 'BED'],
    ['V1A', 'ROOM'],
    ['V2A', 'ROOM'],
    ['ROOM_L', 'ROOM'],
    ['BED_L1', 'BED'],
    ['BED_L2', 'BED'],
    ['DORM_L', 'ROOM'],
    ['VL1', 'ROOM'],
    ['VL2', 'ROOM'],
    ['TENT_L', 'TENT'],
    ['CABIN_L', 'CABIN'],
    ['DORM_C', 'ROOM'],
    ['BED_C1', 'BED'],
    ['DORM_D', 'ROOM'],
    ['BED_D1', 'BED'],
    ['BED_D2', 'BED'],
  ]) {
    rooms[name] = await createResource(`SET07-${name}-${runId}`, type, {
      capacity: type === 'BED' ? 1 : 2,
    });
  }
  await withOwner(async (client) => {
    for (const [parent, beds] of [
      ['DORM_A', ['BED_A1', 'BED_A2']],
      ['DORM_B', ['BED_B1', 'BED_B2']],
      ['DORM_L', ['BED_L1', 'BED_L2']],
      ['DORM_C', ['BED_C1']],
      ['DORM_D', ['BED_D1', 'BED_D2']],
    ])
      for (const bed of beds)
        await client.query(
          `update "resource" set "parent_resource_id" = $1 where "id" = $2`,
          [rooms[parent].id, rooms[bed].id],
        );
  });
  products.SITE_A = await createOffering({
    code: `SET07-SITE-${runId}`,
    name: 'SET-07 exclusive site',
    kind: 'SITE',
    adultsMax: 2,
    candidateResourceIds: [rooms.SITE_A.id],
  });
  products.BED_SOLO = await createOffering({
    code: `SET07-BEDS-${runId}`,
    name: 'SET-07 dorm bed solo',
    kind: 'BED',
    adultsMax: 1,
    candidateResourceIds: [rooms.BED_B1.id],
    rateOccupancy: 1,
  });
  products.DORM_A = await createOffering({
    code: `SET07-DORMA-${runId}`,
    name: 'SET-07 whole dorm room A',
    kind: 'ROOM',
    adultsMax: 2,
    leafResourceIds: [rooms.BED_A1.id, rooms.BED_A2.id],
  });
  products.VILLA_A = await createOffering({
    code: `SET07-VILLA-${runId}`,
    name: 'SET-07 whole villa A',
    kind: 'VILLA',
    adultsMax: 4,
    leafResourceIds: [rooms.V1A.id, rooms.V2A.id],
  });
  products.ROOM_L = await createOffering({
    code: `SET07-ROOML-${runId}`,
    name: 'SET-07 room L',
    kind: 'ROOM',
    adultsMax: 2,
    candidateResourceIds: [rooms.ROOM_L.id],
  });
  products.BED_L = await createOffering({
    code: `SET07-BEDL-${runId}`,
    name: 'SET-07 dorm bed L',
    kind: 'BED',
    adultsMax: 1,
    candidateResourceIds: [rooms.BED_B2.id],
    rateOccupancy: 1,
  });
  products.DORM_L = await createOffering({
    code: `SET07-DORML-${runId}`,
    name: 'SET-07 whole dorm room L',
    kind: 'ROOM',
    adultsMax: 2,
    leafResourceIds: [rooms.BED_L1.id, rooms.BED_L2.id],
  });
  products.VILLA_L = await createOffering({
    code: `SET07-VILLAL-${runId}`,
    name: 'SET-07 whole villa L',
    kind: 'VILLA',
    adultsMax: 4,
    leafResourceIds: [rooms.VL1.id, rooms.VL2.id],
  });
  products.TENT_L = await createOffering({
    code: `SET07-TENT-${runId}`,
    name: 'SET-07 fixed tent',
    kind: 'TENT',
    adultsMax: 2,
    candidateResourceIds: [rooms.TENT_L.id],
  });
  products.CABIN_L = await createOffering({
    code: `SET07-CABIN-${runId}`,
    name: 'SET-07 cabin',
    kind: 'CABIN',
    adultsMax: 2,
    candidateResourceIds: [rooms.CABIN_L.id],
  });
  products.BED_C = await createOffering({
    code: `SET07-BEDC-${runId}`,
    name: 'SET-07 dorm bed C',
    kind: 'BED',
    adultsMax: 1,
    candidateResourceIds: [rooms.BED_C1.id],
    rateOccupancy: 1,
  });
  products.DORM_D = await createOffering({
    code: `SET07-DORMD-${runId}`,
    name: 'SET-07 whole dorm room D',
    kind: 'ROOM',
    adultsMax: 2,
    leafResourceIds: [rooms.BED_D1.id, rooms.BED_D2.id],
  });
});

afterAll(async () => {
  await closeBrowser();
  await stopApi();
});

test('SET-07.1 the rack exposes every sellable unit by type and keeps composite parents out', async () => {
  const result = await board();
  const byCode = new Map(result.rooms.map((room) => [room.code, room]));
  for (const name of [
    'SITE_A',
    'BED_A1',
    'BED_A2',
    'V1A',
    'V2A',
    'ROOM_L',
    'BED_L1',
    'TENT_L',
    'CABIN_L',
  ])
    expect(byCode.has(rooms[name].code)).toBe(true);
  for (const name of ['DORM_A', 'DORM_L', 'DORM_C', 'DORM_D'])
    expect(byCode.has(rooms[name].code)).toBe(false);
  expect(byCode.get(rooms.BED_A1.code).resource_type).toBe('BED');
  expect(byCode.get(rooms.BED_A1.code).parent_code).toBe(rooms.DORM_A.code);
  expect(byCode.get(rooms.SITE_A.code).resource_type).toBe('SITE');
  expect(byCode.get(rooms.CABIN_L.code).resource_type).toBe('CABIN');
});

test('SET-07.1 arrivals carry product kind, per-component readiness and explicit capabilities', async () => {
  const bed = await book('BED_SOLO', 0, 2, 1);
  const dorm = await book('DORM_A', 0, 2, 2);
  const villa = await book('VILLA_A', 0, 2, 2);
  const result = await board();
  const bedRow = result.arrivals.find((row) => row.item_id === bed.itemId);
  const dormRow = result.arrivals.find((row) => row.item_id === dorm.itemId);
  const villaRow = result.arrivals.find((row) => row.item_id === villa.itemId);

  expect(bedRow.product_kind).toBe('BED');
  expect(bedRow.group_assignment).toBe(false);
  expect(bedRow.capabilities.check_in.supported).toBe(true);
  expect(bedRow.capabilities.check_in.reason).toBeNull();
  expect(bedRow.capabilities.move.supported).toBe(false);
  expect(bedRow.capabilities.move.reason).toBe('STATE_NOT_IN_HOUSE');

  for (const row of [dormRow, villaRow]) {
    expect(row.group_assignment).toBe(true);
    expect(row.allocated_rooms.length).toBe(2);
    expect(row.allocation_readiness.length).toBe(2);
    expect(
      row.allocation_readiness.every((entry) => entry.eligible === true),
    ).toBe(true);
    expect(row.capabilities.assign.supported).toBe(false);
    expect(row.capabilities.assign.reason).toBe(
      'GROUP_COMPONENT_SELECTION_REQUIRED',
    );
    expect(row.capabilities.move.reason).toBe('STATE_NOT_IN_HOUSE');
    expect(row.capabilities.split.reason).toBe('STATE_NOT_IN_HOUSE');
    expect(row.capabilities.extend.supported).toBe(true);
    expect(row.capabilities.early_departure.supported).toBe(false);
    expect(row.capabilities.early_departure.reason).toBe('STATE_NOT_IN_HOUSE');
  }
});

test('SET-07.2 a dirty parent unit blocks its beds with a parent reason', async () => {
  await withOwner(async (client) => {
    await client.query(
      `update "resource" set "housekeeping_state" = 'DIRTY' where "id" = $1`,
      [rooms.DORM_C.id],
    );
  });
  const bed = await book('BED_C', 0, 2, 1);
  const result = await board();
  const row = result.arrivals.find((entry) => entry.item_id === bed.itemId);
  const candidate = row.candidates.find(
    (entry) => entry.resource_id === rooms.BED_C1.id,
  );
  expect(candidate.eligible).toBe(false);
  expect(candidate.reason).toBe('PARENT_DIRTY');
  const rejected = await assign(bed, rooms.BED_C1.id, bed.itemVersion);
  expect(rejected.status).toBe(400);
  expect(rejected.body.details.reason).toBe('PARENT_DIRTY');
  await withOwner(async (client) => {
    await client.query(
      `update "resource" set "housekeeping_state" = 'CLEAN' where "id" = $1`,
      [rooms.DORM_C.id],
    );
  });
});

test('SET-07.2 a composite parent is not assignable as a unit', async () => {
  const bed = await book('BED_C', 4, 6, 1);
  const rejected = await assign(bed, rooms.DORM_C.id, bed.itemVersion);
  expect(rejected.status).toBe(409);
  expect(rejected.body.code).toBe('RESOURCE_HAS_CHILDREN');
});

test('SET-07.2 readiness inheritance walks every ancestor level, not just the direct parent', async () => {
  const grandParent = await createResource(`SET07-GP-B-${runId}`, 'ROOM', {
    capacity: 2,
  });
  await withOwner(async (client) => {
    await client.query(
      `update "resource" set "parent_resource_id" = $1 where "id" = $2`,
      [grandParent.id, rooms.DORM_B.id],
    );
    await client.query(
      `update "resource" set "housekeeping_state" = 'DIRTY' where "id" = $1`,
      [grandParent.id],
    );
  });
  const bed = await book('BED_SOLO', 4, 6, 1);
  const result = await board(addDays(4));
  const row = result.arrivals.find((entry) => entry.item_id === bed.itemId);
  const candidate = row.candidates.find(
    (entry) => entry.resource_id === rooms.BED_B1.id,
  );
  expect(candidate.eligible).toBe(false);
  expect(candidate.reason).toBe('PARENT_DIRTY');
  const rejected = await assign(bed, rooms.BED_B1.id, bed.itemVersion);
  expect(rejected.status).toBe(400);
  expect(rejected.body.details.reason).toBe('PARENT_DIRTY');
  await withOwner(async (client) => {
    await client.query(
      `update "resource" set "housekeeping_state" = 'CLEAN' where "id" = $1`,
      [grandParent.id],
    );
  });
});

test('SET-07.2 the cycle check-in, extend, early departure and checkout works for beds, dorm rooms and villas', async () => {
  for (const [name, adults, expectedComponents] of [
    ['ROOM_L', 2, 1],
    ['BED_L', 1, 1],
    ['TENT_L', 2, 1],
    ['CABIN_L', 2, 1],
    ['DORM_L', 2, 2],
    ['VILLA_L', 2, 2],
  ]) {
    const item = await book(name, 0, 3, adults);
    if (expectedComponents === 1) {
      const resourceByTemplate = {
        ROOM_L: rooms.ROOM_L.id,
        BED_L: rooms.BED_B2.id,
        TENT_L: rooms.TENT_L.id,
        CABIN_L: rooms.CABIN_L.id,
      };
      const assigned = await assign(
        item,
        resourceByTemplate[name],
        item.itemVersion,
      );
      expect(assigned.status).toBe(200);
    }
    const version = await itemVersion(item.reservationId, item.itemId);
    const checkedIn = await checkIn(item, version);
    expect(checkedIn.status).toBe(200);
    const afterCheckIn = await stayDbState(item.itemId);
    expect(afterCheckIn.item.state).toBe('IN_HOUSE');
    expect(afterCheckIn.assignments.length).toBe(expectedComponents);
    expect(
      afterCheckIn.assignments.every((row) => row.state === 'ACTIVE'),
    ).toBe(true);

    const extended = await apiRequest(
      admin.context,
      'POST',
      `${base()}/reservations/${item.reservationId}/items/${item.itemId}/extend`,
      {
        body: {
          new_departure: addDays(4),
          version: await itemVersion(item.reservationId, item.itemId),
        },
        headers: { 'idempotency-key': key(`extend-${item.itemId}`) },
      },
    );
    expect(extended.status).toBe(200);
    const afterExtend = await stayDbState(item.itemId);
    expect(afterExtend.item.departure).toBe(addDays(4));
    for (const row of afterExtend.assignments)
      expect(row.end_date).toBe(addDays(4));
    for (const row of afterExtend.allocations)
      expect(row.end_date).toBe(addDays(4));
    expect(afterExtend.allocations.length).toBe(expectedComponents);

    const early = await apiRequest(
      admin.context,
      'POST',
      `${base()}/reservations/${item.reservationId}/items/${item.itemId}/early-departure`,
      {
        body: {
          effective_date: addDays(1),
          version: await itemVersion(item.reservationId, item.itemId),
        },
        headers: { 'idempotency-key': key(`early-${item.itemId}`) },
      },
    );
    expect(early.status).toBe(200);
    const afterEarly = await stayDbState(item.itemId);
    expect(afterEarly.item.departure).toBe(addDays(1));
    for (const row of afterEarly.assignments)
      expect(row.end_date).toBe(addDays(1));
    for (const row of afterEarly.allocations)
      expect(row.end_date).toBe(addDays(1));

    const checkedOut = await checkOut(
      item,
      await itemVersion(item.reservationId, item.itemId),
    );
    expect(checkedOut.status).toBe(200);
    const afterCheckOut = await stayDbState(item.itemId);
    expect(afterCheckOut.item.state).toBe('CHECKED_OUT');
    expect(
      afterCheckOut.assignments.every((row) => row.state === 'COMPLETED'),
    ).toBe(true);
    for (const row of afterCheckOut.assignments) {
      const state = await resourceHousekeeping(row.resource_id);
      expect(state.housekeeping_state).toBe('DIRTY');
    }
  }
});

test('SET-07.3 group move and split fail closed with a clear reason and treatment', async () => {
  const dorm = await book('DORM_D', 0, 3, 2);
  const checkedIn = await checkIn(
    dorm,
    await itemVersion(dorm.reservationId, dorm.itemId),
  );
  expect(checkedIn.status).toBe(200);
  const boardResult = await board();
  const boardRow = boardResult.inHouse.find(
    (entry) => entry.item_id === dorm.itemId,
  );
  expect(boardRow).toBeTruthy();
  expect(boardRow.capabilities.assign.reason).toBe('ALREADY_IN_HOUSE');
  expect(boardRow.capabilities.check_in.reason).toBe('ALREADY_IN_HOUSE');
  expect(boardRow.capabilities.move.reason).toBe(
    'GROUP_COMPONENT_SELECTION_REQUIRED',
  );
  expect(boardRow.capabilities.split.reason).toBe(
    'GROUP_COMPONENT_SELECTION_REQUIRED',
  );
  const before = await stayDbState(dorm.itemId);
  const move = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${dorm.reservationId}/items/${dorm.itemId}/move`,
    {
      body: {
        to_resource_id: rooms.ROOM_L.id,
        effective_date: addDays(1),
        version: await itemVersion(dorm.reservationId, dorm.itemId),
      },
      headers: { 'idempotency-key': key(`group-move-${dorm.itemId}`) },
    },
  );
  expect(move.status).toBe(422);
  expect(move.body.code).toBe('GROUP_STAY_OPERATION_UNSUPPORTED');
  expect(move.body.details.operation).toBe('move');
  expect(move.body.details.components).toBe(2);
  expect(move.body.details.reason).toBe('GROUP_COMPONENT_SELECTION_REQUIRED');
  expect(move.body.details.treatment).toBe('REBOOK_AFTER_EARLY_DEPARTURE');
  const split = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${dorm.reservationId}/items/${dorm.itemId}/split`,
    {
      body: {
        at_date: addDays(1),
        version: await itemVersion(dorm.reservationId, dorm.itemId),
      },
      headers: { 'idempotency-key': key(`group-split-${dorm.itemId}`) },
    },
  );
  expect(split.status).toBe(422);
  expect(split.body.code).toBe('GROUP_STAY_OPERATION_UNSUPPORTED');
  expect(split.body.details.operation).toBe('split');
  const after = await stayDbState(dorm.itemId);
  expect(after).toEqual(before);
});

test('SET-07.4 the setup operations step applies the inspection policy server-side', async () => {
  const draftBody = {
    property: {
      name: `SET-07 templates ${runId}`,
      code: `SET07-${runId}`,
      country: 'Indonesia',
      timezone: 'Asia/Jakarta',
      base_currency: 'IDR',
      types: ['ROOM'],
    },
    unit_groups: [
      {
        template_code: 'TENT',
        pattern: '701-702',
        exclusions: [],
        capacity: 2,
        rental_mode: 'EXCLUSIVE',
      },
    ],
    operations: {
      check_in: '14:00',
      check_out: '12:00',
      inspection_required: true,
      explicit_states: true,
    },
    pricing: { postponed: true },
  };
  const saved = await apiRequest(
    admin.context,
    'PUT',
    `${base()}/setup-draft`,
    {
      body: draftBody,
      headers: { 'idempotency-key': key('set07-draft-save') },
    },
  );
  expect(saved.status).toBe(200);
  const preview = await apiRequest(
    admin.context,
    'POST',
    `${base()}/setup-draft/preview`,
  );
  expect(preview.status).toBe(200);
  expect(preview.body.blockers).toEqual([]);
  const draft = await apiRequest(admin.context, 'GET', `${base()}/setup-draft`);
  const applied = await apiRequest(
    admin.context,
    'POST',
    `${base()}/setup-draft/apply`,
    {
      body: { preview_version: preview.body.preview_version },
      headers: {
        'idempotency-key': key('set07-draft-apply'),
        'if-match': `"${draft.body.draft.draft_id}:${draft.body.draft.revision}"`,
      },
    },
  );
  expect(applied.status).toBe(200);
  expect(applied.body.result.follow_up_tasks).toContain('rate_plan_follow_up');
  const policy = await apiRequest(
    admin.context,
    'GET',
    `${base()}/operations-policy`,
  );
  expect(policy.status).toBe(200);
  expect(policy.body.policy.inspection_required).toBe(true);

  const confirmed = await withOwner(async (client) => {
    const result = await client.query(
      `select i."id", i."reservation_id", i."version", i."arrival"::text as arrival
         from "reservation_item" i
         join "product" p on p."id" = i."product_id"
        where i."property_id" = $1 and p."code" = $2 and i."state" = 'CONFIRMED'
        order by i."created_at" desc limit 1`,
      [property.id, `SET07-BEDC-${runId}`],
    );
    return result.rows[0];
  });
  expect(confirmed).toBeTruthy();
  const rejected = await assign(
    {
      reservationId: confirmed.reservation_id,
      itemId: confirmed.id,
    },
    rooms.BED_C1.id,
    confirmed.version,
  );
  expect(rejected.status).toBe(400);
  expect(rejected.body.details.reason).toBe('INSPECTION_REQUIRED');
});
