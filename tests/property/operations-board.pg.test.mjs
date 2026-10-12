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
} from './support/harness.mjs';

let tenant;
let admin;
let member;
let owner;
let adminMembershipId;
let memberMembershipId;
let ownerMembershipId;
let property;
let productId;
let planId;
let rooms;

const seed = 20260916;
const runId = `P09B${seed}`;
const key = (name) => `p09-03-${name}-${runId}`;
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

async function checkIn(item, resourceId, suffix) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-in`,
    {
      body: { version: item.itemVersion, resource_id: resourceId },
      headers: { 'idempotency-key': key(`ci-${suffix}`) },
    },
  );
  expect(response.status).toBe(200);
}

async function itemVersion(itemId) {
  const [row] = await dbRows(
    `select "version" from "reservation_item" where "id" = $1`,
    [itemId],
  );
  return row.version;
}

async function checkOut(item, suffix) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-out`,
    {
      body: { version: await itemVersion(item.itemId) },
      headers: { 'idempotency-key': key(`co-${suffix}`) },
    },
  );
}

async function board() {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/operations/board`,
  );
  expect(response.status).toBe(200);
  return response.body;
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  member = await loginAs('member-a');
  owner = await loginAs('owner-a');
  tenant = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P09-B-${runId}`,
        name: `P09-03 ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  rooms = {};
  for (const suffix of ['R1', 'R2', 'R3']) {
    const resource = await apiRequest(
      admin.context,
      'POST',
      `${base()}/resources`,
      {
        body: { code: `P09-03-${suffix}-${runId}`, type: 'ROOM', capacity: 2 },
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
        code: `P09-03-P-${runId}`,
        name: `P09-03 ${runId}`,
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
      code: `P09-03-R-${runId}`,
      name: `P09-03 ${runId}`,
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
  const subjectToRole = new Map([
    [identityUsers.users['admin-a'].id, 'admin'],
    [identityUsers.users['member-a'].id, 'member'],
    [identityUsers.users['owner-a'].id, 'owner'],
  ]);
  const rows = await dbRows(
    `select m."id", u."identity_subject"
       from "membership" m join "app_user" u on u."id" = m."user_id"
      where m."tenant_id" = $1`,
    [tenant],
  );
  for (const row of rows) {
    const role = subjectToRole.get(row.identity_subject);
    if (role === 'admin') adminMembershipId = row.id;
    if (role === 'member') memberMembershipId = row.id;
    if (role === 'owner') ownerMembershipId = row.id;
  }
  expect(adminMembershipId).toBeTruthy();
  expect(memberMembershipId).toBeTruthy();
  expect(ownerMembershipId).toBeTruthy();
  await withOwner(async (client) => {
    await client.query(
      `insert into "role_permission" ("role_id", "permission_code")
       select r."id", p."code"
         from "role" r
         join "permission" p on p."code" in ('task.read', 'task.complete')
        where r."tenant_id" = $1 and r."code" = 'MEMBER'
       on conflict do nothing`,
      [tenant],
    );
  });
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
});

test('operations board reflects task buckets and internal notifications (AT-O02 companion)', async () => {
  const item = await createConfirmedItem(today, addDays(3));
  await checkIn(item, rooms.R1.id, 'board');
  const checkout = await checkOut(item, 'board');
  expect(checkout.status).toBe(200);

  const policy = await apiRequest(
    admin.context,
    'PUT',
    `${base()}/operations-policy`,
    {
      body: { inspection_required: true, long_stay_clean_interval_days: 3 },
      headers: { 'idempotency-key': key('policy') },
    },
  );
  expect(policy.status).toBe(200);

  const afterCheckout = await board();
  expect(afterCheckout.buckets.pending).toBe(1);
  expect(afterCheckout.inspection_required).toBe(true);
  expect(afterCheckout.date).toBe(today);

  const tasks = await apiRequest(
    admin.context,
    'GET',
    `${base()}/tasks?resource_id=${rooms.R1.id}`,
  );
  const task = tasks.body.tasks[0];
  const assign = await apiRequest(
    admin.context,
    'POST',
    `${base()}/tasks/${task.id}/assign`,
    {
      body: { membership_id: memberMembershipId, version: task.version },
      headers: { 'idempotency-key': key('assign-board') },
    },
  );
  expect(assign.status).toBe(200);
  expect((await board()).buckets.pending).toBe(0);
  expect((await board()).buckets.assigned).toBe(1);

  const start = await apiRequest(
    member.context,
    'POST',
    `${base()}/tasks/${task.id}/start`,
    {
      body: { version: assign.body.task.version },
      headers: { 'idempotency-key': key('start-board') },
    },
  );
  expect(start.status).toBe(200);
  expect((await board()).buckets.in_progress).toBe(1);

  const complete = await apiRequest(
    member.context,
    'POST',
    `${base()}/tasks/${task.id}/complete`,
    {
      body: { version: start.body.task.version },
      headers: { 'idempotency-key': key('complete-board') },
    },
  );
  expect(complete.status).toBe(200);
  const awaiting = await board();
  expect(awaiting.buckets.awaiting_inspection).toBe(1);
  // Completing a task under the inspection policy raises a warning
  // notification that never leaves the system.
  const inspectionNotification = awaiting.notifications.find(
    (row) => row.type === 'TASK_READY_FOR_INSPECTION',
  );
  expect(inspectionNotification).toBeTruthy();
  expect(inspectionNotification.severity).toBe('WARNING');
  expect(inspectionNotification.read_at).toBeNull();

  const inspect = await apiRequest(
    owner.context,
    'POST',
    `${base()}/tasks/${task.id}/inspect`,
    {
      body: { version: complete.body.task.version },
      headers: { 'idempotency-key': key('inspect-board') },
    },
  );
  expect(inspect.status).toBe(200);
  expect((await board()).buckets.ready).toBe(1);
});

test('shift handover records counts and references without replacing the cashier ledger', async () => {
  const before = await board();
  const handover = await apiRequest(
    admin.context,
    'POST',
    `${base()}/shift-handovers`,
    {
      body: {
        to_membership_id: memberMembershipId,
        follow_up_membership_id: adminMembershipId,
        exceptions_text: 'One room awaiting inspection booking',
        note: 'Night shift',
      },
      headers: { 'idempotency-key': key('handover') },
    },
  );
  expect(handover.status).toBe(201);
  const record = handover.body.handover;
  expect(record.shift_date).toBe(today);
  expect(record.open_tasks).toBe(
    before.buckets.pending +
      before.buckets.assigned +
      before.buckets.in_progress +
      before.buckets.awaiting_inspection,
  );
  expect(record.cashier_session_id).toBeNull();
  expect(record.exceptions_text).toBe('One room awaiting inspection booking');

  const list = await apiRequest(
    admin.context,
    'GET',
    `${base()}/shift-handovers`,
  );
  expect(list.status).toBe(200);
  expect(list.body.handovers[0].id).toBe(record.id);

  const notifications = await apiRequest(
    member.context,
    'GET',
    `${base()}/notifications`,
  );
  expect(notifications.status).toBe(200);
  const handoverNotification = notifications.body.notifications.find(
    (row) => row.type === 'SHIFT_HANDOVER',
  );
  expect(handoverNotification).toBeTruthy();
  expect(handoverNotification.recipient_membership_id).toBe(memberMembershipId);

  const receipt = await apiRequest(
    member.context,
    'POST',
    `${base()}/notifications/${handoverNotification.id}/read`,
  );
  expect(receipt.status).toBe(200);
  expect(receipt.body.newly_read).toBe(true);
  const again = await apiRequest(
    member.context,
    'POST',
    `${base()}/notifications/${handoverNotification.id}/read`,
  );
  expect(again.status).toBe(200);
  expect(again.body.newly_read).toBe(false);
});

test('emergency notification is internal and addressed notifications stay scoped', async () => {
  const emergency = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders`,
    {
      body: {
        resource_id: rooms.R2.id,
        category: 'SAFETY',
        severity: 'CRITICAL',
        impact: 'OOO',
        emergency: true,
        description: 'Broken window in room',
        period: { arrival: today, departure: addDays(2) },
      },
      headers: { 'idempotency-key': key('emergency') },
    },
  );
  expect(emergency.status).toBe(201);
  expect(emergency.body.work_order.emergency).toBe(true);

  const notifications = await apiRequest(
    member.context,
    'GET',
    `${base()}/notifications`,
  );
  expect(notifications.status).toBe(200);
  const alert = notifications.body.notifications.find(
    (row) => row.type === 'WORK_ORDER_EMERGENCY',
  );
  expect(alert).toBeTruthy();
  expect(alert.severity).toBe('CRITICAL');
  expect(alert.recipient_membership_id).toBeNull();

  const row = await dbRows(
    `select "body" from "ops_notification" where "id" = $1`,
    [alert.id],
  );
  expect(row[0].body).toBe('Broken window in room');

  const addressed = await dbRows(
    `insert into "ops_notification"
       ("tenant_id", "property_id", "type", "severity", "title",
        "recipient_membership_id")
     values ($1, $2, 'SHIFT_HANDOVER', 'INFO', 'Private handover note', $3)
     returning "id"`,
    [tenant, property.id, ownerMembershipId],
  );
  expect(addressed).toHaveLength(1);
  const blocked = await apiRequest(
    member.context,
    'POST',
    `${base()}/notifications/${addressed[0].id}/read`,
  );
  expect(blocked.status).toBe(422);
  expect(blocked.body.code).toBe('CROSS_SCOPE_REFERENCE');
});

test('a repair whose time ended without verification still blocks delivery (AT-29)', async () => {
  const yesterday = addDays(-1);
  // The arrival is quoted while both rooms are still sellable; the work order
  // opens afterwards so availability is not the subject under test.
  const arrival = await createConfirmedItem(today, addDays(2));
  const order = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders`,
    {
      body: {
        resource_id: rooms.R3.id,
        category: 'PLUMBING',
        severity: 'HIGH',
        impact: 'OOO',
        description: 'Pipe repair window closed yesterday',
        period: { arrival: yesterday, departure: today },
      },
      headers: { 'idempotency-key': key('at29') },
    },
  );
  expect(order.status).toBe(201);

  const blocked = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${arrival.reservationId}/items/${arrival.itemId}/assignments`,
    {
      body: {
        resource_id: rooms.R3.id,
        version: await itemVersion(arrival.itemId),
      },
      headers: { 'idempotency-key': key('at29-assign') },
    },
  );
  expect(blocked.status).toBe(400);
  expect(blocked.body.details.reason).toBe('OOO');

  // Time ending is not verification: the room stays blocked until the work
  // order reaches CLOSED through the lifecycle.
  let current = order.body.work_order;
  for (const status of ['TRIAGED', 'IN_PROGRESS']) {
    const response = await apiRequest(
      admin.context,
      'POST',
      `${base()}/work-orders/${current.id}/transitions`,
      {
        body: { status, version: current.version },
        headers: { 'idempotency-key': key(`at29-${status}`) },
      },
    );
    expect(response.status).toBe(200);
    current = response.body.work_order;
  }
  const resolved = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${current.id}/transitions`,
    {
      body: {
        status: 'RESOLVED',
        version: current.version,
        note: 'Pipe replaced',
      },
      headers: { 'idempotency-key': key('at29-resolved') },
    },
  );
  current = resolved.body.work_order;
  const verified = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${current.id}/transitions`,
    {
      body: { status: 'VERIFIED', version: current.version },
      headers: { 'idempotency-key': key('at29-verified') },
    },
  );
  current = verified.body.work_order;
  const closed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/work-orders/${current.id}/close`,
    {
      body: { version: current.version },
      headers: { 'idempotency-key': key('at29-close') },
    },
  );
  expect(closed.status).toBe(200);
  // Verified and closed clears OOO; R3 was never inspected under the
  // property-wide inspection policy, so the only remaining gate is the
  // inspection requirement — time ending alone never granted readiness.
  const delivered = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${arrival.reservationId}/items/${arrival.itemId}/assignments`,
    {
      body: {
        resource_id: rooms.R3.id,
        version: await itemVersion(arrival.itemId),
      },
      headers: { 'idempotency-key': key('at29-assign-after') },
    },
  );
  expect(delivered.status).toBe(400);
  expect(delivered.body.details.reason).toBe('INSPECTION_REQUIRED');
});
