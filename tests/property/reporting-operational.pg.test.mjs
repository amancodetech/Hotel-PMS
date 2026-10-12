import { readFileSync } from 'node:fs';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { phase11Operations } from '../../apps/api/dist/reporting/operations.js';
import {
  apiRequest,
  closeBrowser,
  closeSessions,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';
import { addBusinessDays, todayInTimeZone } from './support/business-dates.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
const tenantB = process.env.IDENTITY_TENANT_B;

// Fixed synthetic seed, no real guest data.
const seed = 20261101;
const runId = `P11A${seed}`;
const key = (name) => `p11-${name}-${runId}-${String(name).length}`;

let admin;
let ownerB;
let member;
let auditor;

// Anchor every relative date to the facility's business timezone (Asia/Jakarta).
// A UTC-derived date can equal the local business date around midnight and
// collapse a one-night period into `date_from == date_to`.
const businessToday = todayInTimeZone('Asia/Jakarta');

function addDays(days) {
  return addBusinessDays(businessToday, days);
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

async function dbOne(sql, params = []) {
  return withOwner(async (client) => {
    const result = await client.query(sql, params);
    return result.rows[0];
  });
}

function base(propertyId) {
  return `/tenants/${tenantA}/properties/${propertyId}`;
}

async function createResource(propertyId, code, type, capacity = 2) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/resources`,
    {
      body: { code, type, capacity },
    },
  );
  expect(response.status).toBe(201);
  return response.body.resource;
}

async function createProduct(propertyId, code, kind, options = {}) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/products`,
    {
      body: {
        code,
        name: code,
        kind,
        occupancy_adults_max: options.occupancy_adults_max ?? 2,
      },
    },
  );
  expect(response.status).toBe(201);
  const product = response.body.product;
  for (const resourceId of options.resource_ids ?? []) {
    const candidate = await apiRequest(
      admin.context,
      'POST',
      `${base(propertyId)}/products/${product.id}/candidates`,
      { body: { resource_id: resourceId } },
    );
    expect(candidate.status).toBe(201);
  }
  if (options.activate === false) return product;
  return activateProduct(propertyId, product);
}

async function activateProduct(propertyId, product) {
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base(propertyId)}/products/${product.id}`,
    { body: { version: product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  return activated.body.product;
}

async function createComposition(
  propertyId,
  productId,
  resourceIds,
  arrival,
  departure,
) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/compositions`,
    {
      body: {
        product_id: productId,
        effective_period: { arrival, departure },
        resource_ids: resourceIds,
        nested_version_ids: [],
      },
    },
  );
  expect(created.status).toBe(201);
  const activated = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/compositions/${created.body.composition.id}/activate`,
    { body: { reason: 'reporting fixture activation' } },
  );
  expect(activated.status).toBe(200);
  return activated.body.composition;
}

async function createRatePlan(propertyId, code, productId) {
  const plan = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/rate-plans`,
    {
      body: { code, name: code, product_id: productId, currency: 'IDR' },
    },
  );
  expect(plan.status).toBe(201);
  const planId = plan.body.rate_plan.id;
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base(propertyId)}/rate-plans/${planId}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  return planId;
}

async function setRates(propertyId, planId, amount = '300000') {
  const cells = [];
  for (let offset = 0; offset <= 45; offset += 1) {
    cells.push({
      rate_plan_id: planId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount, currency: 'IDR' },
    });
  }
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/rates/batch`,
    {
      body: { cells },
    },
  );
  expect(response.status).toBe(200);
}

async function quote(
  propertyId,
  productId,
  planId,
  arrival,
  departure,
  quantity = 1,
) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/quotes`,
    {
      body: {
        product_id: productId,
        rate_plan_id: planId,
        period: { arrival, departure },
        occupancy: { adults: 2, child_ages: [] },
        quantity,
      },
    },
  );
  if (response.status !== 201)
    throw new Error(
      `quote failed ${response.status}: ${JSON.stringify(response.body)}`,
    );
  return response.body.quote.id;
}

async function createConfirmed(
  propertyId,
  productId,
  planId,
  arrival,
  departure,
  quantity = 1,
) {
  const draft = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: [
          {
            product_id: productId,
            period: { arrival, departure },
            occupancy: { adults: 2, child_ages: [] },
            quantity,
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
    `${base(propertyId)}/reservations/${reservationId}`,
  );
  expect(detail.status).toBe(200);
  const itemId = detail.body.items[0].id;
  const rates = await apiRequest(
    admin.context,
    'GET',
    `${base(propertyId)}/rates?from=${addDays(0)}&to=${addDays(45)}`,
  );
  expect(rates.status).toBe(200);
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/reservations`,
    {
      body: {
        reservation_id: reservationId,
        inventory_version: rates.body.inventory_version,
        items: [
          {
            item_id: itemId,
            price_snapshot_id: await quote(
              propertyId,
              productId,
              planId,
              arrival,
              departure,
              quantity,
            ),
          },
        ],
      },
    },
  );
  expect(confirmed.status).toBe(200);
  return { reservationId, itemId };
}

async function markNoShow(propertyId, reservationId, itemId) {
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base(propertyId)}/reservations/${reservationId}`,
  );
  const row = detail.body.items.find((entry) => entry.id === itemId);
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/reservation-items/${itemId}/no-show`,
    {
      body: {
        version: row.version,
        reason: 'synthetic no-show for reporting matrix',
      },
      headers: { 'idempotency-key': key(`noshow-${itemId}`) },
    },
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function cancelItem(propertyId, reservationId, itemId) {
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base(propertyId)}/reservations/${reservationId}`,
  );
  const row = detail.body.items.find((entry) => entry.id === itemId);
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/reservation-items/${itemId}/cancel`,
    {
      body: { version: row.version, reason: 'synthetic pickup cancellation' },
      headers: { 'idempotency-key': key(`cancel-${itemId}`) },
    },
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function createWorkOrder(
  propertyId,
  resourceId,
  impact,
  arrival,
  departure,
  suffix,
) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base(propertyId)}/work-orders`,
    {
      body: {
        resource_id: resourceId,
        category: 'GENERAL',
        severity: 'HIGH',
        impact,
        description: `synthetic ${impact} ${suffix}`,
        period: { arrival, departure },
      },
      headers: { 'idempotency-key': key(`wo-${suffix}`) },
    },
  );
  expect(response.status).toBe(201);
  return response.body.work_order;
}

async function readReport(propertyId, body, context = admin.context) {
  return apiRequest(context, 'POST', `${base(propertyId)}/reports/query`, {
    body,
  });
}

function metricOf(report, key) {
  return (report.metrics ?? []).find((entry) => entry.key === key);
}

async function captureSnapshot(propertyId, body = {}, context = admin.context) {
  return apiRequest(context, 'POST', `${base(propertyId)}/reports/snapshots`, {
    body,
    headers: {
      'idempotency-key': key(`snap-${body.reference_date ?? 'default'}`),
    },
  });
}

async function setupProperty(suffix, { rooms, beds }) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: `P11-${suffix}-${runId}`,
        name: `P11 ${suffix} ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  const property = created.body.property;
  const roomResources = [];
  for (let index = 1; index <= rooms; index += 1)
    roomResources.push(
      await createResource(
        property.id,
        `P11-${suffix}-R${index}-${runId}`,
        'ROOM',
      ),
    );
  const bedResources = [];
  for (let index = 1; index <= beds; index += 1)
    bedResources.push(
      await createResource(
        property.id,
        `P11-${suffix}-B${index}-${runId}`,
        'BED',
        2,
      ),
    );
  return { property, roomResources, bedResources };
}

let matrix;
let bedBooking;
let zeroProperty;

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  ownerB = await loginAs('owner-b');
  member = await loginAs('member-a');
  auditor = await loginAs('auditor-a');

  // Matrix property: villa (composition of 3 rooms) + 6 exclusive beds + a
  // standalone room used for arrivals/no-show. No real guest data.
  matrix = await setupProperty('MATRIX', { rooms: 5, beds: 6 });
  const draftVilla = await createProduct(
    matrix.property.id,
    `P11-VILLA-${runId}`,
    'VILLA',
    {
      activate: false,
    },
  );
  await createComposition(
    matrix.property.id,
    draftVilla.id,
    matrix.roomResources.slice(0, 3).map((resource) => resource.id),
    addDays(0),
    addDays(45),
  );
  const villaProduct = await activateProduct(matrix.property.id, draftVilla);
  const villaPlan = await createRatePlan(
    matrix.property.id,
    `P11-VILLARP-${runId}`,
    villaProduct.id,
  );
  await setRates(matrix.property.id, villaPlan);
  const bedProduct = await createProduct(
    matrix.property.id,
    `P11-BED-${runId}`,
    'BED',
    {
      resource_ids: matrix.bedResources.map((resource) => resource.id),
    },
  );
  const bedPlan = await createRatePlan(
    matrix.property.id,
    `P11-BEDRP-${runId}`,
    bedProduct.id,
  );
  await setRates(matrix.property.id, bedPlan);
  const roomProduct = await createProduct(
    matrix.property.id,
    `P11-ROOM-${runId}`,
    'ROOM',
    {
      resource_ids: [matrix.roomResources[3].id],
    },
  );
  // roomResources[4] stays free for the OOS window test.
  const roomPlan = await createRatePlan(
    matrix.property.id,
    `P11-ROOMRP-${runId}`,
    roomProduct.id,
  );
  await setRates(matrix.property.id, roomPlan);
  matrix.villa = { product: villaProduct, plan: villaPlan };
  matrix.bed = { product: bedProduct, plan: bedPlan };
  matrix.room = { product: roomProduct, plan: roomPlan };

  await createConfirmed(
    matrix.property.id,
    villaProduct.id,
    villaPlan,
    addDays(0),
    addDays(2),
  );
  bedBooking = await createConfirmed(
    matrix.property.id,
    bedProduct.id,
    bedPlan,
    addDays(0),
    addDays(1),
    6,
  );

  // Zero-denominator property: three rooms all OOO for the whole period.
  zeroProperty = await setupProperty('ZERO', { rooms: 3, beds: 0 });
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('P11 phase 11 contract lists exactly the implemented operations', () => {
  const contract = JSON.parse(
    readFileSync('docs/contracts/phase11.openapi.json', 'utf8'),
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
  const manifest = [...phase11Operations].sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  );
  expect(manifest).toEqual(
    operations.sort((a, b) => a.operationId.localeCompare(b.operationId)),
  );
  const read = phase11Operations.find(
    (operation) => operation.operationId === 'ReadReport',
  );
  expect(read?.permission).toBe('report.operational.view');
  expect(read?.csrf).toBe(true);
});

test('AT-22/23: composite villa nights and beds stay separate from persons', async () => {
  const response = await readReport(matrix.property.id, {
    kind: 'OCCUPANCY',
    period: { date_from: addDays(0), date_to: addDays(2) },
  });
  expect(response.status).toBe(200);
  const report = response.body;
  expect(report.kind).toBe('OCCUPANCY');
  expect(report.cutoff.property_timezone).toBe('Asia/Jakarta');
  expect(report.data_basis).toBe('OPERATING_DB');

  // AT-22: villa of 3 rooms for 2 nights => 2 display nights and 6 reserved
  // room-nights, never summed into one figure.
  expect(metricOf(report, 'display_nights.VILLA')?.value).toBe('2');
  expect(metricOf(report, 'resource_nights_reserved.ROOM')?.value).toBe('6');
  expect(
    (report.metrics ?? []).some(
      (entry) =>
        entry.value === '8' &&
        ['item_night', 'person', 'ratio'].includes(entry.unit),
    ),
  ).toBe(false);

  // AT-23: 6 exclusive bed resources with 2 persons, kept separate.
  expect(metricOf(report, 'display_nights.BED')?.value).toBe('1');
  expect(metricOf(report, 'resource_nights_reserved.BED')?.value).toBe('6');
  expect(metricOf(report, 'persons.BED')?.value).toBe('2');

  // Each ratio declares numerator and denominator and uses the same basis.
  const occupancy = metricOf(report, 'occupancy_physical.ROOM');
  expect(occupancy?.numerator).toBe('0');
  expect(occupancy?.denominator).toBe('10');
  expect(occupancy?.zero_denominator).toBe(false);
  expect(occupancy?.value).toBe('0.000000');

  // Beds are never mixed with rooms: every metric key names one unit only.
  const units = new Set((report.metrics ?? []).map((entry) => entry.unit));
  expect(units.has('resource_night')).toBe(true);
  expect(units.has('item_night')).toBe(true);
  expect(units.has('person')).toBe(true);
});

test('D-08: OOS stays in the operational denominator and OOO leaves it', async () => {
  // Future OOS window outside the current booking, so availability is intact.
  await createWorkOrder(
    matrix.property.id,
    matrix.roomResources[4].id,
    'OOS',
    addDays(5),
    addDays(6),
    'oos',
  );
  const response = await readReport(matrix.property.id, {
    kind: 'OCCUPANCY',
    period: { date_from: addDays(5), date_to: addDays(6) },
  });
  expect(response.status).toBe(200);
  expect(metricOf(response.body, 'resource_nights_oos.ROOM')?.value).toBe('1');
  expect(
    metricOf(response.body, 'resource_nights_available_operational.ROOM')
      ?.value,
  ).toBe('5');
  expect(metricOf(response.body, 'resource_nights_available.ROOM')?.value).toBe(
    '5',
  );
});

test('SET-07.5: housekeeping and maintenance counts stay per resource type', async () => {
  const roomIds = matrix.roomResources.map((resource) => resource.id);
  const bedIds = matrix.bedResources.map((resource) => resource.id);
  const allRows = await withOwner(async (client) => {
    await client.query(
      `update "resource" set "housekeeping_state" = 'DIRTY' where "id" = $1`,
      [roomIds[3]],
    );
    await client.query(
      `update "resource" set "housekeeping_state" = 'CLEANING' where "id" = $1`,
      [roomIds[2]],
    );
    await client.query(
      `update "resource" set "maintenance_state" = 'OOO' where "id" = $1`,
      [roomIds[4]],
    );
    await client.query(
      `update "resource" set "housekeeping_state" = 'INSPECTED' where "id" = $1`,
      [bedIds[0]],
    );
    await client.query(
      `update "resource" set "maintenance_state" = 'OOS' where "id" = $1`,
      [bedIds[1]],
    );
    const result = await client.query(
      `select "resource_type", "housekeeping_state", "maintenance_state"
         from "resource"
        where "property_id" = $1 and "state" = 'ACTIVE'`,
      [matrix.property.id],
    );
    return result.rows;
  });
  const roomRows = allRows.filter((row) => row.resource_type === 'ROOM');
  const bedRows = allRows.filter((row) => row.resource_type === 'BED');
  const count = (rows, field, state) =>
    String(rows.filter((row) => row[field] === state).length);

  const response = await readReport(matrix.property.id, {
    kind: 'OCCUPANCY',
    period: { date_from: addDays(0), date_to: addDays(1) },
  });
  expect(response.status).toBe(200);
  expect(metricOf(response.body, 'housekeeping_clean.ROOM')?.value).toBe(
    count(roomRows, 'housekeeping_state', 'CLEAN'),
  );
  expect(metricOf(response.body, 'housekeeping_dirty.ROOM')?.value).toBe(
    count(roomRows, 'housekeeping_state', 'DIRTY'),
  );
  expect(metricOf(response.body, 'housekeeping_cleaning.ROOM')?.value).toBe(
    count(roomRows, 'housekeeping_state', 'CLEANING'),
  );
  expect(metricOf(response.body, 'housekeeping_inspected.ROOM')?.value).toBe(
    count(roomRows, 'housekeeping_state', 'INSPECTED'),
  );
  expect(metricOf(response.body, 'maintenance_ooo.ROOM')?.value).toBe(
    count(roomRows, 'maintenance_state', 'OOO'),
  );
  expect(metricOf(response.body, 'maintenance_oos.ROOM')?.value).toBe(
    count(roomRows, 'maintenance_state', 'OOS'),
  );
  expect(metricOf(response.body, 'maintenance_none.ROOM')?.value).toBe(
    count(roomRows, 'maintenance_state', 'NONE'),
  );
  expect(metricOf(response.body, 'housekeeping_inspected.BED')?.value).toBe(
    count(bedRows, 'housekeeping_state', 'INSPECTED'),
  );
  expect(metricOf(response.body, 'maintenance_oos.BED')?.value).toBe(
    count(bedRows, 'maintenance_state', 'OOS'),
  );
  const notReady = metricOf(response.body, 'resources_not_ready_current.ROOM');
  expect(notReady?.value).toBe(
    String(
      Number(count(roomRows, 'maintenance_state', 'OOO')) +
        Number(count(roomRows, 'maintenance_state', 'OOS')) +
        Number(count(roomRows, 'housekeeping_state', 'DIRTY')) +
        Number(count(roomRows, 'housekeeping_state', 'CLEANING')),
    ),
  );
  expect(notReady?.basis).toBe('CURRENT_STATE');
});

test('zero division is a declared null, never a misleading zero', async () => {
  for (let index = 0; index < zeroProperty.roomResources.length; index += 1) {
    await createWorkOrder(
      zeroProperty.property.id,
      zeroProperty.roomResources[index].id,
      'OOO',
      addDays(0),
      addDays(1),
      `ooo-${index}`,
    );
  }
  const response = await readReport(zeroProperty.property.id, {
    kind: 'OCCUPANCY',
    period: { date_from: addDays(0), date_to: addDays(1) },
  });
  expect(response.status).toBe(200);
  expect(metricOf(response.body, 'resource_nights_ooo.ROOM')?.value).toBe('3');
  expect(
    metricOf(response.body, 'resource_nights_available_operational.ROOM')
      ?.value,
  ).toBe('0');
  const operational = metricOf(response.body, 'occupancy_operational.ROOM');
  expect(operational?.value).toBe(null);
  expect(operational?.zero_denominator).toBe(true);
  expect(operational?.null_reason).toBe('DENOMINATOR_ZERO');
  const physical = metricOf(response.body, 'occupancy_physical.ROOM');
  expect(physical?.value).toBe('0.000000');
  expect(physical?.zero_denominator).toBe(false);
});

test('arrivals and departures reflect actual item states without hiding no-shows', async () => {
  const today = localToday('Asia/Jakarta');
  const noShow = await createConfirmed(
    matrix.property.id,
    matrix.room.product.id,
    matrix.room.plan,
    today,
    addBusinessDays(today, 1),
  );
  await markNoShow(matrix.property.id, noShow.reservationId, noShow.itemId);

  const arrivals = await readReport(matrix.property.id, {
    kind: 'ARRIVALS',
    period: { date_from: today, date_to: addBusinessDays(today, 1) },
  });
  expect(arrivals.status).toBe(200);
  expect(metricOf(arrivals.body, 'arrivals_state_no_show')?.value).toBe('1');
  expect(metricOf(arrivals.body, 'arrivals_total')?.value).toBe('3');
  expect(
    (arrivals.body.rows ?? []).some((row) => row.state === 'NO_SHOW'),
  ).toBe(true);

  const departures = await readReport(matrix.property.id, {
    kind: 'DEPARTURES',
    period: { date_from: addDays(1), date_to: addDays(3) },
  });
  expect(departures.status).toBe(200);
  expect(metricOf(departures.body, 'departures_state_no_show')?.value).toBe(
    '1',
  );
  expect(metricOf(departures.body, 'departures_total')?.value).toBe('3');
});

test('pickup diffs a declared snapshot against current bookings, fail-closed', async () => {
  const reference = localToday('Asia/Jakarta');
  const missing = await readReport(matrix.property.id, {
    kind: 'PICKUP',
    period: { date_from: addDays(0), date_to: addDays(30) },
    reference_date: '2000-01-01',
  });
  expect(missing.status).toBe(404);
  expect(missing.body.code).toBe('NOT_FOUND');
  expect(missing.body.details.reason).toBe('report_snapshot_not_found');

  const captured = await captureSnapshot(matrix.property.id, {
    reference_date: reference,
  });
  expect(captured.status).toBe(200);
  expect(captured.body.replayed).toBe(false);

  // Re-capturing the same reference date replays instead of rewriting history.
  const replay = await captureSnapshot(matrix.property.id, {
    reference_date: reference,
  });
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.snapshot.id).toBe(captured.body.snapshot.id);

  // Net change after the snapshot: +2 nights new booking, -1 cancelled bed night.
  const added = await createConfirmed(
    matrix.property.id,
    matrix.room.product.id,
    matrix.room.plan,
    addDays(10),
    addDays(12),
  );
  expect(added.reservationId).toBeTruthy();
  await cancelItem(
    matrix.property.id,
    bedBooking.reservationId,
    bedBooking.itemId,
  );

  const pickup = await readReport(matrix.property.id, {
    kind: 'PICKUP',
    period: { date_from: addDays(0), date_to: addDays(30) },
    reference_date: reference,
  });
  expect(pickup.status).toBe(200);
  expect(metricOf(pickup.body, 'pickup_nights_added')?.value).toBe('2');
  expect(metricOf(pickup.body, 'pickup_nights_removed')?.value).toBe('1');
  expect(metricOf(pickup.body, 'pickup_nights_net')?.value).toBe('1');
  expect(
    (pickup.body.metrics ?? []).every(
      (entry) => entry.basis === 'SNAPSHOT_DIFF_ACTIVE_ITEM_NIGHTS',
    ),
  ).toBe(true);
  expect(pickup.body.snapshot.reference_date).toBe(reference);
});

test('reports are scoped and read-only: no posted record changes', async () => {
  const before = {};
  for (const table of [
    'journal',
    'business_day',
    'folio_charge',
    'night_audit_run',
  ]) {
    before[table] = await dbOne(
      `select count(*)::int as "count" from "${table}" where "property_id" = $1`,
      [matrix.property.id],
    );
  }
  const beforeSnapshots = await dbOne(
    `select count(*)::int as "count" from "report_snapshot" where "property_id" = $1`,
    [matrix.property.id],
  );

  for (const kind of ['OCCUPANCY', 'ARRIVALS', 'DEPARTURES', 'PICKUP']) {
    const response = await readReport(matrix.property.id, {
      kind,
      period: { date_from: addDays(0), date_to: addDays(30) },
      ...(kind === 'PICKUP'
        ? { reference_date: localToday('Asia/Jakarta') }
        : {}),
    });
    expect(response.status).toBe(200);
  }
  await captureSnapshot(matrix.property.id, { reference_date: addDays(20) });

  for (const table of [
    'journal',
    'business_day',
    'folio_charge',
    'night_audit_run',
  ]) {
    const after = await dbOne(
      `select count(*)::int as "count" from "${table}" where "property_id" = $1`,
      [matrix.property.id],
    );
    expect(after.count).toBe(before[table].count);
  }
  const afterSnapshots = await dbOne(
    `select count(*)::int as "count" from "report_snapshot" where "property_id" = $1`,
    [matrix.property.id],
  );
  expect(afterSnapshots.count).toBe(beforeSnapshots.count + 1);
  const audit = await dbOne(
    `select count(*)::int as "count" from "audit_event"
      where "property_id" = $1 and "action" = 'report.snapshot_captured'`,
    [matrix.property.id],
  );
  expect(audit.count).toBe(2);
});

test('permission and tenant isolation fail closed', async () => {
  const members = await readReport(
    matrix.property.id,
    {
      kind: 'OCCUPANCY',
      period: { date_from: addDays(0), date_to: addDays(2) },
    },
    member.context,
  );
  expect(members.status).toBe(403);

  const auditorRead = await readReport(
    matrix.property.id,
    {
      kind: 'OCCUPANCY',
      period: { date_from: addDays(0), date_to: addDays(2) },
    },
    auditor.context,
  );
  expect(auditorRead.status).toBe(200);

  const crossTenant = await apiRequest(
    ownerB.context,
    'POST',
    `/tenants/${tenantA}/properties/${matrix.property.id}/reports/query`,
    {
      body: {
        kind: 'OCCUPANCY',
        period: { date_from: addDays(0), date_to: addDays(2) },
      },
    },
  );
  expect([403, 404]).toContain(crossTenant.status);
  expect(crossTenant.body.code).not.toBe('INTERNAL_ERROR');
  expect(tenantB).toBeTruthy();
});

test('unknown kinds and malformed periods are rejected', async () => {
  const kind = await readReport(matrix.property.id, {
    kind: 'NOPE',
    period: { date_from: addDays(0), date_to: addDays(1) },
  });
  expect(kind.status).toBe(400);
  const period = await readReport(matrix.property.id, {
    kind: 'OCCUPANCY',
    period: { date_from: addDays(2), date_to: addDays(1) },
  });
  expect(period.status).toBe(400);
  expect(period.body.code).toBe('INVALID_REQUEST');
});

test('F-RVW11-01: pickup keeps stays that extend beyond the period', async () => {
  const longStay = await createConfirmed(
    matrix.property.id,
    matrix.bed.product.id,
    matrix.bed.plan,
    addDays(3),
    addDays(30),
    1,
  );
  expect(longStay.reservationId).toBeTruthy();
  const reference = addDays(3);
  const captured = await captureSnapshot(matrix.property.id, {
    reference_date: reference,
  });
  expect(captured.status).toBe(200);
  expect(captured.body.replayed).toBe(false);

  // A stay spanning past `date_to` is unchanged, so pickup must stay silent
  // instead of reporting a phantom removal.
  const unchanged = await readReport(matrix.property.id, {
    kind: 'PICKUP',
    period: { date_from: addDays(3), date_to: addDays(10) },
    reference_date: reference,
  });
  expect(unchanged.status).toBe(200);
  expect(metricOf(unchanged.body, 'pickup_nights_added')?.value).toBe('0');
  expect(metricOf(unchanged.body, 'pickup_nights_removed')?.value).toBe('0');
  expect(metricOf(unchanged.body, 'pickup_nights_net')?.value).toBe('0');
  expect(unchanged.body.rows).toEqual([]);

  // A new stay that also extends past `date_to` must still count its nights
  // inside the period.
  const extended = await createConfirmed(
    matrix.property.id,
    matrix.bed.product.id,
    matrix.bed.plan,
    addDays(10),
    addDays(30),
    1,
  );
  expect(extended.reservationId).toBeTruthy();
  const pickup = await readReport(matrix.property.id, {
    kind: 'PICKUP',
    period: { date_from: addDays(10), date_to: addDays(12) },
    reference_date: reference,
  });
  expect(pickup.status).toBe(200);
  expect(metricOf(pickup.body, 'pickup_nights_added')?.value).toBe('2');
  expect(metricOf(pickup.body, 'pickup_nights_removed')?.value).toBe('0');
  expect(metricOf(pickup.body, 'pickup_nights_net')?.value).toBe('2');
});

test('F-RVW11-02: concurrent captures of one reference date replay cleanly', async () => {
  const reference = addDays(21);
  const capture = (suffix) =>
    apiRequest(
      admin.context,
      'POST',
      `${base(matrix.property.id)}/reports/snapshots`,
      {
        body: { reference_date: reference },
        headers: {
          'idempotency-key': key(`snap-race-${suffix}-${reference}`),
        },
      },
    );
  const responses = await Promise.all([capture('a'), capture('b')]);
  expect(responses.map((entry) => entry.status)).toEqual([200, 200]);
  const captures = responses.filter((entry) => entry.body.replayed === false);
  const replays = responses.filter((entry) => entry.body.replayed === true);
  expect(captures).toHaveLength(1);
  expect(replays).toHaveLength(1);
  expect(replays[0].body.snapshot.id).toBe(captures[0].body.snapshot.id);

  const stored = await dbOne(
    `select count(*)::int as "count" from "report_snapshot"
      where "property_id" = $1 and "reference_date" = $2`,
    [matrix.property.id, reference],
  );
  expect(stored.count).toBe(1);
});
