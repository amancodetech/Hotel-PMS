import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  closeSessions,
  loginAs,
  readIdentityUsers,
  startApi,
  stopApi,
  withOwner,
  withRuntimeRole,
} from './support/harness.mjs';

let tenant;
let tenantB;
let admin;
let owner;
let member;
let adminMembershipId;
let property;
let productId;
let planId;
let rooms;
let inHouseItem;

// Fixed synthetic seed: no user data, deterministic codes and fixtures.
const seed = 20260916;
const runId = `P09W${seed}`;
const key = (name) => `p09-02-${name}-${runId}`;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

function addDays(days) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function base() {
  return `/tenants/${tenant}/properties/${property.id}`;
}

async function dbRows(sql, params) {
  return withOwner(async (client) => {
    const result = await client.query(sql, params);
    return result.rows;
  });
}

async function dbRoom(resourceId) {
  const [room] = await dbRows(
    `select "housekeeping_state", "maintenance_state", "version"
       from "resource" where "id" = $1`,
    [resourceId],
  );
  return room;
}

async function quote(arrival, departure) {
  const response = await apiRequest(admin.context, 'POST', `${base()}/quotes`, {
    body: {
      product_id: productId,
      rate_plan_id: planId,
      period: { arrival, departure },
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

async function createConfirmedItem(arrival, departure) {
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
            period: { arrival, departure },
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
  const quoteId = await quote(arrival, departure);
  const rates = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=${addDays(0)}&to=${addDays(40)}`,
  );
  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations`,
    {
      body: {
        reservation_id: reservationId,
        inventory_version: rates.body.inventory_version,
        items: [{ item_id: itemId, price_snapshot_id: quoteId }],
      },
    },
  );
  expect(confirmed.status).toBe(200);
  const after = await apiRequest(
    admin.context,
    'GET',
    `${base()}/reservations/${reservationId}`,
  );
  return {
    reservationId,
    itemId,
    itemVersion: after.body.items[0].version,
  };
}

async function itemVersion(itemId) {
  const [row] = await dbRows(
    `select "version" from "reservation_item" where "id" = $1`,
    [itemId],
  );
  return row.version;
}

async function createWorkOrder(body, idempotencyKey) {
  return apiRequest(admin.context, 'POST', `${base()}/work-orders`, {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

async function transition(workOrder, status, note) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${workOrder.id}/transitions`,
    {
      body: {
        status,
        version: workOrder.version,
        ...(note ? { note } : {}),
      },
      headers: { 'idempotency-key': key(`tr-${workOrder.id}-${status}`) },
    },
  );
}

async function close(workOrder) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${workOrder.id}/close`,
    {
      body: { version: workOrder.version },
      headers: { 'idempotency-key': key(`close-${workOrder.id}`) },
    },
  );
}

async function runLifecycle(workOrder, resolutionNote) {
  let current = workOrder;
  const steps =
    current.status === 'OPEN' ? ['TRIAGED', 'IN_PROGRESS'] : ['IN_PROGRESS'];
  for (const status of steps) {
    const response = await transition(current, status);
    expect(response.status).toBe(200);
    current = response.body.work_order;
  }
  const resolved = await transition(current, 'RESOLVED', resolutionNote);
  expect(resolved.status).toBe(200);
  current = resolved.body.work_order;
  const verified = await transition(current, 'VERIFIED');
  expect(verified.status).toBe(200);
  return verified.body.work_order;
}

async function assignRoom(item, resourceId) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/assignments`,
    {
      body: {
        resource_id: resourceId,
        version: await itemVersion(item.itemId),
      },
      headers: {
        'idempotency-key': key(`as-${item.itemId}-${resourceId}-${Date.now()}`),
      },
    },
  );
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  owner = await loginAs('owner-a');
  member = await loginAs('member-a');
  tenant = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P09-W-${runId}`,
        name: `P09-02 ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  rooms = {};
  for (const suffix of ['R1', 'R2', 'R3', 'R4']) {
    const resource = await apiRequest(
      admin.context,
      'POST',
      `${base()}/resources`,
      {
        body: { code: `P09-02-${suffix}-${runId}`, type: 'ROOM', capacity: 2 },
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
        code: `P09-02-P-${runId}`,
        name: `P09-02 ${runId}`,
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
      code: `P09-02-R-${runId}`,
      name: `P09-02 ${runId}`,
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
  for (let offset = 0; offset <= 40; offset += 1)
    cells.push({
      rate_plan_id: planId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '250000', currency: 'IDR' },
    });
  const rates = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rates/batch`,
    { body: { cells } },
  );
  expect(rates.status).toBe(200);

  const identityUsers = readIdentityUsers();
  const adminSubject = identityUsers.users['admin-a'].id;
  [adminMembershipId] = (
    await dbRows(
      `select m."id" from "membership" m
        join "app_user" u on u."id" = m."user_id"
       where m."tenant_id" = $1 and u."identity_subject" = $2`,
      [tenant, adminSubject],
    )
  ).map((row) => row.id);

  // In-house stay on R3 for the emergency scenario.
  inHouseItem = await createConfirmedItem(today, addDays(4));
  const checkIn = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${inHouseItem.reservationId}/items/${inHouseItem.itemId}/check-in`,
    {
      body: { version: inHouseItem.itemVersion, resource_id: rooms.R3.id },
      headers: { 'idempotency-key': key('ci-inhouse') },
    },
  );
  expect(checkIn.status).toBe(200);
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('work order lifecycle applies and clears OOO impact', async () => {
  const created = await createWorkOrder(
    {
      resource_id: rooms.R1.id,
      category: 'PLUMBING',
      severity: 'HIGH',
      impact: 'OOO',
      description: 'Leaking bathroom pipe',
    },
    key('lifecycle'),
  );
  expect(created.status).toBe(201);
  let order = created.body.work_order;
  expect(order.status).toBe('OPEN');
  expect(order.impact).toBe('OOO');
  expect((await dbRoom(rooms.R1.id)).maintenance_state).toBe('OOO');

  const assigned = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${order.id}/assign`,
    {
      body: { membership_id: adminMembershipId, version: order.version },
      headers: { 'idempotency-key': key('assign-lifecycle') },
    },
  );
  expect(assigned.status).toBe(200);
  order = assigned.body.work_order;
  expect(order.status).toBe('ASSIGNED');

  order = await runLifecycle(order, 'Pipe replaced and pressure tested');
  expect(order.status).toBe('VERIFIED');
  expect(order.verified_at).toBeTruthy();

  const closed = await close(order);
  expect(closed.status).toBe(200);
  order = closed.body.work_order;
  expect(order.status).toBe('CLOSED');
  expect(order.closed_at).toBeTruthy();
  expect((await dbRoom(rooms.R1.id)).maintenance_state).toBe('NONE');

  const audit = await dbRows(
    `select count(*)::int as "count" from "audit_event"
      where "resource_id" = $1 and "action" like 'ops.work_order%'`,
    [order.id],
  );
  expect(audit[0].count).toBeGreaterThanOrEqual(6);

  const reopened = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${order.id}/reopen`,
    {
      body: { reason: 'Leak returned after two days', version: order.version },
      headers: { 'idempotency-key': key('reopen-lifecycle') },
    },
  );
  expect(reopened.status).toBe(200);
  order = reopened.body.work_order;
  expect(order.status).toBe('OPEN');
  expect(order.reopen_count).toBe(1);
  expect(order.last_reopen_reason).toBe('Leak returned after two days');
  expect((await dbRoom(rooms.R1.id)).maintenance_state).toBe('OOO');
});

test('closing one order never lifts another block or open reason (AT-O03)', async () => {
  const first = await createWorkOrder(
    {
      resource_id: rooms.R2.id,
      category: 'HVAC',
      severity: 'MEDIUM',
      impact: 'OOO',
      description: 'AC unit noise',
    },
    key('two-orders-a'),
  );
  expect(first.status).toBe(201);
  const second = await createWorkOrder(
    {
      resource_id: rooms.R2.id,
      category: 'ELECTRICAL',
      severity: 'HIGH',
      impact: 'OOO',
      description: 'Faulty socket',
    },
    key('two-orders-b'),
  );
  expect(second.status).toBe(201);
  expect((await dbRoom(rooms.R2.id)).maintenance_state).toBe('OOO');

  const block = await apiRequest(admin.context, 'POST', `${base()}/blocks`, {
    body: {
      resource_ids: [rooms.R2.id],
      period: { arrival: today, departure: addDays(2) },
      reason: 'Deep maintenance window',
      mode: 'PLANNED',
    },
  });
  expect(block.status).toBe(201);

  let firstOrder = await runLifecycle(
    first.body.work_order,
    'Compressor serviced',
  );
  const firstClosed = await close(firstOrder);
  expect(firstClosed.status).toBe(200);
  // Second order still open: the closure must not clear OOO.
  expect((await dbRoom(rooms.R2.id)).maintenance_state).toBe('OOO');

  const secondOrder = await runLifecycle(
    second.body.work_order,
    'Socket replaced',
  );
  const secondClosed = await close(secondOrder);
  expect(secondClosed.status).toBe(200);
  expect((await dbRoom(rooms.R2.id)).maintenance_state).toBe('NONE');

  // The independent inventory block stays ACTIVE and keeps blocking delivery.
  const blocks = await apiRequest(admin.context, 'GET', `${base()}/blocks`);
  expect(blocks.status).toBe(200);
  const active = blocks.body.items.find(
    (row) => row.id === block.body.block.id,
  );
  expect(active.state).toBe('ACTIVE');

  const arrival = await createConfirmedItem(today, addDays(2));
  const blocked = await assignRoom(arrival, rooms.R2.id);
  expect(blocked.status).toBe(400);
  expect(blocked.body.details.reason).toBe('BLOCKED');

  const released = await apiRequest(
    admin.context,
    'POST',
    `${base()}/blocks/${block.body.block.id}/release`,
    { body: { reason: 'Maintenance window finished' } },
  );
  expect(released.status).toBe(200);
  const delivered = await assignRoom(arrival, rooms.R2.id);
  expect(delivered.status).toBe(200);
});

test('emergency work order keeps the reservation and records disruption without erasing it', async () => {
  const before = await dbRows(
    `select i."state", i."version", c."id" as "commitment_id"
       from "reservation_item" i
       join "commitment" c on c."source_id" = i."id" and c."source_kind" = 'ITEM'
      where i."id" = $1`,
    [inHouseItem.itemId],
  );
  expect(before).toHaveLength(1);

  const emergency = await createWorkOrder(
    {
      resource_id: rooms.R3.id,
      category: 'SAFETY',
      severity: 'CRITICAL',
      impact: 'OOO',
      emergency: true,
      description: 'Water leak in the occupied room',
      period: { arrival: today, departure: addDays(3) },
    },
    key('emergency'),
  );
  expect(emergency.status).toBe(201);
  const order = emergency.body.work_order;
  expect(order.emergency).toBe(true);
  expect(order.block_id).toBeTruthy();
  expect((await dbRoom(rooms.R3.id)).maintenance_state).toBe('OOO');

  const after = await dbRows(
    `select i."state", i."version", c."id" as "commitment_id"
       from "reservation_item" i
       join "commitment" c on c."source_id" = i."id" and c."source_kind" = 'ITEM'
      where i."id" = $1`,
    [inHouseItem.itemId],
  );
  expect(after[0]).toEqual(before[0]);

  const disruptions = await dbRows(
    `select "state", "resolved_at" from "inventory_disruption"
      where "block_id" = $1 order by "created_at"`,
    [order.block_id],
  );
  expect(disruptions.length).toBeGreaterThanOrEqual(1);
  expect(disruptions[0].state).toBe('OPEN');

  // The affected room cannot be delivered to another arrival while blocked.
  const otherArrival = await createConfirmedItem(today, addDays(2));
  const blocked = await assignRoom(otherArrival, rooms.R3.id);
  expect(blocked.status).toBe(400);
  expect(blocked.body.details.reason).toBe('OOO');

  const verifiedOrder = await runLifecycle(order, 'Leak isolated and repaired');
  const closed = await close(verifiedOrder);
  expect(closed.status).toBe(200);

  const resolved = await dbRows(
    `select "state", "resolved_at" from "inventory_disruption"
      where "block_id" = $1`,
    [order.block_id],
  );
  expect(resolved.every((row) => row.state === 'RESOLVED')).toBe(true);
  expect(resolved.every((row) => row.resolved_at !== null)).toBe(true);

  const blocks = await dbRows(
    `select "state" from "inventory_block" where "id" = $1`,
    [order.block_id],
  );
  expect(blocks[0].state).toBe('ACTIVE');
  expect((await dbRoom(rooms.R3.id)).maintenance_state).toBe('NONE');
});

test('emergency requires the emergency permission and impact OOO with a period', async () => {
  const ownerEmergency = await apiRequest(
    owner.context,
    'POST',
    `${base()}/work-orders`,
    {
      body: {
        resource_id: rooms.R4.id,
        category: 'SAFETY',
        severity: 'CRITICAL',
        impact: 'OOO',
        emergency: true,
        description: 'Emergency without MFA',
        period: { arrival: today, departure: addDays(2) },
      },
      headers: { 'idempotency-key': key('owner-emergency') },
    },
  );
  expect(ownerEmergency.status).toBe(403);
  expect(ownerEmergency.body.code).toBe('MFA_REQUIRED');

  const wrongImpact = await createWorkOrder(
    {
      resource_id: rooms.R4.id,
      category: 'GENERAL',
      severity: 'LOW',
      impact: 'NONE',
      emergency: true,
      description: 'Emergency without OOO',
      period: { arrival: today, departure: addDays(2) },
    },
    key('emergency-impact'),
  );
  expect(wrongImpact.status).toBe(400);
  expect(wrongImpact.body.details.reason).toBe('emergency_requires_ooo');

  const missingPeriod = await createWorkOrder(
    {
      resource_id: rooms.R4.id,
      category: 'GENERAL',
      severity: 'LOW',
      impact: 'OOO',
      emergency: true,
      description: 'Emergency without period',
    },
    key('emergency-period'),
  );
  expect(missingPeriod.status).toBe(400);
  expect(missingPeriod.body.details.field).toBe('period');
});

test('work order permissions, scoping and state guards fail closed', async () => {
  const memberList = await apiRequest(
    member.context,
    'GET',
    `${base()}/work-orders`,
  );
  expect(memberList.status).toBe(403);
  const memberCreate = await apiRequest(
    member.context,
    'POST',
    `${base()}/work-orders`,
    {
      body: {
        resource_id: rooms.R4.id,
        category: 'GENERAL',
        severity: 'LOW',
        impact: 'NONE',
        description: 'Should not be allowed',
      },
      headers: { 'idempotency-key': key('member-create-wo') },
    },
  );
  expect(memberCreate.status).toBe(403);

  const created = await createWorkOrder(
    {
      resource_id: rooms.R4.id,
      category: 'GENERAL',
      severity: 'LOW',
      impact: 'NONE',
      description: 'Loose door handle',
    },
    key('guards'),
  );
  expect(created.status).toBe(201);
  const order = created.body.work_order;

  const stale = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${order.id}/transitions`,
    {
      body: { status: 'TRIAGED', version: order.version + 5 },
      headers: { 'idempotency-key': key('stale-guard') },
    },
  );
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');

  const closeTooSoon = await close(order);
  expect(closeTooSoon.status).toBe(409);
  expect(closeTooSoon.body.code).toBe('INVALID_STATE_TRANSITION');

  const reopenOpen = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${order.id}/reopen`,
    {
      body: { reason: 'Not closed yet', version: order.version },
      headers: { 'idempotency-key': key('reopen-open') },
    },
  );
  expect(reopenOpen.status).toBe(409);

  const resolvedWithoutNote = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${order.id}/transitions`,
    {
      body: { status: 'IN_PROGRESS', version: order.version },
      headers: { 'idempotency-key': key('to-progress') },
    },
  );
  expect(resolvedWithoutNote.status).toBe(409);
  const toTriaged = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${order.id}/transitions`,
    {
      body: { status: 'TRIAGED', version: order.version },
      headers: { 'idempotency-key': key('to-triaged') },
    },
  );
  expect(toTriaged.status).toBe(200);
  const toProgress = await transition(toTriaged.body.work_order, 'IN_PROGRESS');
  expect(toProgress.status).toBe(200);
  const noNote = await transition(toProgress.body.work_order, 'RESOLVED');
  expect(noNote.status).toBe(400);
  expect(noNote.body.details.field).toBe('note');

  const identityUsers = readIdentityUsers();
  const ownerB = await loginAs('owner-b');
  tenantB = ownerB.session.body.session.active_tenant_id;
  const crossTenant = await apiRequest(
    ownerB.context,
    'GET',
    `${base()}/work-orders`,
  );
  expect([403, 404]).toContain(crossTenant.status);

  const tenantBRows = await withRuntimeRole('api', async (client) => {
    await client.query(`select set_config('app.tenant_id', $1, false)`, [
      tenantB,
    ]);
    const result = await client.query(
      `select count(*)::int as "count" from "ops_work_order"`,
    );
    return result.rows[0].count;
  });
  expect(tenantBRows).toBe(0);
  expect(identityUsers.users['member-a']).toBeTruthy();
});

test('emergency disrupts divergent and aligned stays exactly once (F-RVW9F-02)', async () => {
  const extraRooms = [];
  for (const suffix of ['R5', 'R6']) {
    const resource = await apiRequest(
      admin.context,
      'POST',
      `${base()}/resources`,
      {
        body: { code: `P09-02-${suffix}-${runId}`, type: 'ROOM', capacity: 2 },
      },
    );
    expect(resource.status).toBe(201);
    const candidate = await apiRequest(
      admin.context,
      'POST',
      `${base()}/products/${productId}/candidates`,
      { body: { resource_id: resource.body.resource.id } },
    );
    expect(candidate.status).toBe(201);
    extraRooms.push(resource.body.resource);
  }

  const arrival = today;
  const departure = addDays(2);
  const divergent = await createConfirmedItem(arrival, departure);
  const aligned = await createConfirmedItem(arrival, departure);
  const allocationFor = async (itemId) => {
    const [row] = await dbRows(
      `select a."id", a."resource_id"
         from "plan_allocation" a
         join "commitment" c on c."id" = a."commitment_id"
        where c."source_kind" = 'ITEM' and c."source_id" = $1
          and a."state" = 'ACTIVE'`,
      [itemId],
    );
    return row;
  };
  const divergentAllocation = await allocationFor(divergent.itemId);
  const alignedAllocation = await allocationFor(aligned.itemId);
  expect(divergentAllocation).toBeTruthy();
  expect(alignedAllocation).toBeTruthy();
  expect(divergentAllocation.resource_id).not.toBe(
    alignedAllocation.resource_id,
  );

  const eligibleRooms = [rooms.R4, ...extraRooms];
  const physicalRoom = eligibleRooms.find(
    (room) =>
      room.id !== divergentAllocation.resource_id &&
      room.id !== alignedAllocation.resource_id,
  );
  expect(physicalRoom).toBeTruthy();

  const divergentCheckIn = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${divergent.reservationId}/items/${divergent.itemId}/check-in`,
    {
      body: { version: divergent.itemVersion, resource_id: physicalRoom.id },
      headers: { 'idempotency-key': key('ci-divergent') },
    },
  );
  expect(divergentCheckIn.status).toBe(200);
  expect(divergentCheckIn.body.assignment.resource_id).toBe(physicalRoom.id);
  const [untouched] = await dbRows(
    `select "resource_id" from "plan_allocation" where "id" = $1`,
    [divergentAllocation.id],
  );
  expect(untouched.resource_id).toBe(divergentAllocation.resource_id);

  const alignedPlanned = await assignRoom(
    aligned,
    alignedAllocation.resource_id,
  );
  expect(alignedPlanned.status).toBe(200);
  const alignedCheckIn = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${aligned.reservationId}/items/${aligned.itemId}/check-in`,
    {
      body: { version: await itemVersion(aligned.itemId) },
      headers: { 'idempotency-key': key('ci-aligned') },
    },
  );
  expect(alignedCheckIn.status).toBe(200);
  expect(alignedCheckIn.body.assignment.resource_id).toBe(
    alignedAllocation.resource_id,
  );

  const divergentEmergency = await createWorkOrder(
    {
      resource_id: physicalRoom.id,
      category: 'SAFETY',
      severity: 'CRITICAL',
      impact: 'OOO',
      emergency: true,
      description: 'Emergency on the physically occupied room',
      period: { arrival, departure },
    },
    key('emergency-divergent'),
  );
  expect(divergentEmergency.status).toBe(201);
  const divergentDisruptions = await dbRows(
    `select "allocation_id", "resource_id", "state"
       from "inventory_disruption" where "block_id" = $1`,
    [divergentEmergency.body.work_order.block_id],
  );
  expect(divergentDisruptions).toHaveLength(1);
  expect(divergentDisruptions[0].allocation_id).toBe(divergentAllocation.id);
  expect(divergentDisruptions[0].resource_id).toBe(physicalRoom.id);
  expect(divergentDisruptions[0].state).toBe('OPEN');

  const alignedEmergency = await createWorkOrder(
    {
      resource_id: alignedAllocation.resource_id,
      category: 'SAFETY',
      severity: 'CRITICAL',
      impact: 'OOO',
      emergency: true,
      description: 'Emergency on the aligned allocation room',
      period: { arrival, departure },
    },
    key('emergency-aligned'),
  );
  expect(alignedEmergency.status).toBe(201);
  const alignedDisruptions = await dbRows(
    `select "allocation_id", "resource_id", "state"
       from "inventory_disruption" where "block_id" = $1`,
    [alignedEmergency.body.work_order.block_id],
  );
  expect(alignedDisruptions).toHaveLength(1);
  expect(alignedDisruptions[0].allocation_id).toBe(alignedAllocation.id);
  expect(alignedDisruptions[0].resource_id).toBe(alignedAllocation.resource_id);
  expect(alignedDisruptions[0].state).toBe('OPEN');
});
