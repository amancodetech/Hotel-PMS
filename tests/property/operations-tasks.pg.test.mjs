import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { phase9Operations } from '../../apps/api/dist/operations/operations.js';
import { runOperationsIntake } from '../../packages/backend/dist/index.js';
import { createOrm } from '../../packages/backend/dist/persistence/orm.js';
import {
  apiDatabaseUrl,
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

let orm;
let tenant;
let tenantB;
let admin;
let member;
let memberMembershipId;
let adminMembershipId;
let owner;
let auditor;
let property;
let productId;
let planId;
let rooms;
let itemCheckout;
let itemDnd;
let itemPolicy;
let itemReassign;
let itemMove;
let itemArrival1;
let itemArrival2;
let itemLong;
let longTaskTwoId;

// Fixed synthetic seed: no user data, deterministic codes and fixtures.
const seed = 20260916;
const runId = `P09A${seed}`;
const key = (name) => `p09-01-${name}-${runId}`;

const phase9Contract = JSON.parse(
  readFileSync('docs/contracts/phase9.openapi.json', 'utf8'),
);

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The synthetic property runs Asia/Jakarta (UTC+7); the operational date must
// match businessToday as the API computes it.
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

async function createDraft(items) {
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
    `${base()}/rates?from=${addDays(0)}&to=${addDays(40)}`,
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

async function checkIn(item, resourceId) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-in`,
    {
      body: { version: item.itemVersion, resource_id: resourceId },
      headers: { 'idempotency-key': key(`ci-${item.itemId}`) },
    },
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function checkOut(item, suffix, version) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/check-out`,
    {
      body: { version: version ?? (await itemVersion(item.itemId)) },
      headers: { 'idempotency-key': key(suffix) },
    },
  );
  return response;
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
      headers: { 'idempotency-key': key(`as-${item.itemId}-${resourceId}`) },
    },
  );
}

async function moveStay(
  item,
  resourceId,
  effectiveDate,
  idempotencyKey,
  version,
) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${item.reservationId}/items/${item.itemId}/move`,
    {
      body: {
        to_resource_id: resourceId,
        effective_date: effectiveDate,
        version: version ?? (await itemVersion(item.itemId)),
      },
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
}

async function listTasks(query = '') {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/tasks${query}`,
  );
  expect(response.status).toBe(200);
  return response.body.tasks;
}

async function tasksForResource(resourceId) {
  return listTasks(`?resource_id=${resourceId}`);
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

async function itemVersion(itemId) {
  const [row] = await dbRows(
    `select "version" from "reservation_item" where "id" = $1`,
    [itemId],
  );
  return row.version;
}

async function dbAudit(action, resourceId) {
  const [row] = await dbRows(
    `select count(*)::int as "count",
            count("correlation_id")::int as "with_correlation"
       from "audit_event"
      where "action" = $1 and "resource_id" = $2`,
    [action, resourceId],
  );
  return row;
}

function contractOperations() {
  const operations = [];
  for (const [path, item] of Object.entries(phase9Contract.paths)) {
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

async function setPolicy(body) {
  const response = await apiRequest(
    admin.context,
    'PUT',
    `${base()}/operations-policy`,
    { body, headers: { 'idempotency-key': key(`policy-${Date.now()}`) } },
  );
  return response;
}

beforeAll(async () => {
  await startApi();
  orm = await createOrm(apiDatabaseUrl());
  admin = await loginAs('admin-a');
  member = await loginAs('member-a');
  owner = await loginAs('owner-a');
  auditor = await loginAs('auditor-a');
  tenant = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P09-A-${runId}`,
        name: `P09-01 ${runId}`,
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
        body: { code: `P09-01-${suffix}-${runId}`, type: 'ROOM', capacity: 2 },
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
        code: `P09-01-P-${runId}`,
        name: `P09-01 ${runId}`,
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
      code: `P09-01-R-${runId}`,
      name: `P09-01 ${runId}`,
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
  for (let offset = 0; offset <= 40; offset += 1) {
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

  itemCheckout = await createConfirmed(0, 4);
  await checkIn(itemCheckout, rooms.R1.id);
  itemDnd = await createConfirmed(0, 3);
  await checkIn(itemDnd, rooms.R4.id);
  itemPolicy = await createConfirmed(0, 4);
  await checkIn(itemPolicy, rooms.R2.id);
  itemReassign = await createConfirmed(0, 4);
  await checkIn(itemReassign, rooms.R3.id);
  itemMove = await createConfirmed(0, 4);
  await checkIn(itemMove, rooms.R5.id);
  itemArrival1 = await createConfirmed(0, 2);
  itemArrival2 = await createConfirmed(0, 2);
  // Long stay starts after the overlapping fixtures depart; it is never
  // checked in, it only carries a confirmed item for scheduled cleaning.
  itemLong = await createConfirmed(5, 35);

  // Synthetic housekeeping grant: MEMBER can read and complete tasks but not
  // manage them; member-a must not reach guest identity through task views.
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
    const identityUsers = readIdentityUsers();
    const subject = identityUsers.users['member-a'].id;
    const adminSubject = identityUsers.users['admin-a'].id;
    const membership = await client.query(
      `select m."id" from "membership" m
        join "app_user" u on u."id" = m."user_id"
       where m."tenant_id" = $1 and u."identity_subject" = $2`,
      [tenant, subject],
    );
    memberMembershipId = membership.rows[0].id;
    const adminMembership = await client.query(
      `select m."id" from "membership" m
        join "app_user" u on u."id" = m."user_id"
       where m."tenant_id" = $1 and u."identity_subject" = $2`,
      [tenant, adminSubject],
    );
    adminMembershipId = adminMembership.rows[0].id;
  });
});

afterAll(async () => {
  await stopApi();
  await closeSessions();
  await closeBrowser();
  await orm.close(true);
});

test('Phase 9 contract matches the implemented operations manifest', () => {
  expect(contractOperations()).toEqual(
    [...phase9Operations].sort((a, b) =>
      a.operationId.localeCompare(b.operationId),
    ),
  );
  for (const operation of phase9Operations) {
    expect(operation.permission).toMatch(
      /^(task\.(read|manage|complete|inspect)|maintenance\.(read|manage))$/,
    );
  }
});

test('checkout materializes one prep task per stay event and intake is replay-safe (AT-O01)', async () => {
  const checkoutVersion = await itemVersion(itemCheckout.itemId);
  const checked = await checkOut(itemCheckout, 'checkout-1', checkoutVersion);
  expect(checked.status).toBe(200);
  expect(checked.body.financial_clearance_state).toBe('PENDING');

  const tasks = await tasksForResource(rooms.R1.id);
  expect(tasks).toHaveLength(1);
  const task = tasks[0];
  expect(task.type).toBe('HOUSEKEEPING');
  expect(task.status).toBe('PENDING');
  expect(task.item_id).toBe(itemCheckout.itemId);
  expect(task.reservation_id).toBe(itemCheckout.reservationId);
  expect(task.source_event_type).toBe('STAY_CHECKED_OUT');
  expect(task.source_event_id).toBeTruthy();
  expect(task.policy_version).toBeNull();
  expect(task.assignee_membership_id).toBeNull();

  const room = await dbRoom(rooms.R1.id);
  expect(room.housekeeping_state).toBe('DIRTY');

  const events = await dbRows(
    `select "id", "payload" from "stay_event"
      where "item_id" = $1 and "type" = 'STAY_CHECKED_OUT'`,
    [itemCheckout.itemId],
  );
  expect(events).toHaveLength(1);
  expect(events[0].id).toBe(task.source_event_id);
  expect(task.due_date).toBe(events[0].payload.business_date);

  const audit = await dbAudit('ops.task_created', task.id);
  expect(audit.count).toBe(1);
  expect(audit.with_correlation).toBe(1);

  const replay = await checkOut(itemCheckout, 'checkout-1', checkoutVersion);
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(await tasksForResource(rooms.R1.id)).toHaveLength(1);

  // Synthetic backfill event (no task): intake materializes it once and a
  // second run is a no-op, proving the event-identity consumption contract.
  const backfillEventId = await withOwner(async (client) => {
    const inserted = await client.query(
      `insert into "stay_event"
         ("tenant_id", "property_id", "reservation_id", "item_id", "type",
          "resource_id", "payload", "item_version")
       values ($1, $2, $3, $4, 'STAY_CHECKED_OUT', $5, $6::jsonb, $7)
       returning "id"`,
      [
        tenant,
        property.id,
        itemCheckout.reservationId,
        itemCheckout.itemId,
        rooms.R1.id,
        JSON.stringify({
          resource_id: rooms.R1.id,
          business_date: today,
        }),
        itemCheckout.itemVersion + 100,
      ],
    );
    return inserted.rows[0].id;
  });
  const firstIntake = await runOperationsIntake(orm, {
    tenantId: tenant,
    propertyId: property.id,
  });
  expect(firstIntake.processed).toBe(1);
  expect(firstIntake.created).toBe(1);
  const afterIntake = await tasksForResource(rooms.R1.id);
  expect(afterIntake).toHaveLength(2);
  const backfillTask = afterIntake.find(
    (row) => row.source_event_id === backfillEventId,
  );
  expect(backfillTask).toBeTruthy();
  const secondIntake = await runOperationsIntake(orm, {
    tenantId: tenant,
    propertyId: property.id,
  });
  expect(secondIntake.processed).toBe(0);
  expect(secondIntake.created).toBe(0);
  expect(await tasksForResource(rooms.R1.id)).toHaveLength(2);
});

test('long-stay cleaning needs a facility schedule and respects its interval', async () => {
  const missing = await apiRequest(admin.context, 'POST', `${base()}/tasks`, {
    body: {
      type: 'HOUSEKEEPING',
      description: 'Long-stay clean',
      item_id: itemLong.itemId,
    },
    headers: { 'idempotency-key': key('long-missing') },
  });
  expect(missing.status).toBe(422);
  expect(missing.body.code).toBe('LONG_STAY_POLICY_MISSING');

  const configured = await setPolicy({
    inspection_required: false,
    long_stay_clean_interval_days: 3,
  });
  expect(configured.status).toBe(200);
  expect(configured.body.policy.version).toBe(1);
  expect(configured.body.policy.configured).toBe(true);

  const created = await apiRequest(admin.context, 'POST', `${base()}/tasks`, {
    body: {
      type: 'HOUSEKEEPING',
      description: 'Long-stay clean',
      item_id: itemLong.itemId,
      due_date: today,
    },
    headers: { 'idempotency-key': key('long-1') },
  });
  expect(created.status).toBe(201);
  expect(created.body.task.policy_version).toBe(1);

  const tooSoon = await apiRequest(admin.context, 'POST', `${base()}/tasks`, {
    body: {
      type: 'HOUSEKEEPING',
      description: 'Long-stay clean again',
      item_id: itemLong.itemId,
    },
    headers: { 'idempotency-key': key('long-2') },
  });
  expect(tooSoon.status).toBe(409);
  expect(tooSoon.body.code).toBe('INTERVAL_NOT_ELAPSED');
  expect(tooSoon.body.details.interval_days).toBe(3);

  await withOwner(async (client) => {
    await client.query(
      `update "ops_task" set "created_at" = now() - interval '4 days'
        where "id" = $1`,
      [created.body.task.id],
    );
  });
  const allowed = await apiRequest(admin.context, 'POST', `${base()}/tasks`, {
    body: {
      type: 'HOUSEKEEPING',
      description: 'Long-stay clean after interval',
      item_id: itemLong.itemId,
    },
    headers: { 'idempotency-key': key('long-3') },
  });
  expect(allowed.status).toBe(201);
  longTaskTwoId = allowed.body.task.id;

  const maintenance = await apiRequest(
    admin.context,
    'POST',
    `${base()}/tasks`,
    {
      body: {
        type: 'MAINTENANCE',
        description: 'Fix the tap',
        resource_id: rooms.R7.id,
      },
      headers: { 'idempotency-key': key('maintenance-rejected') },
    },
  );
  expect(maintenance.status).toBe(400);
  expect(maintenance.body.details.reason).toBe(
    'maintenance_work_order_required',
  );
});

test('inspection policy gates delivery and self-inspection is denied (AT-O02)', async () => {
  const policy = await apiRequest(
    admin.context,
    'GET',
    `${base()}/operations-policy`,
  );
  expect(policy.status).toBe(200);
  const updated = await setPolicy({
    inspection_required: true,
    long_stay_clean_interval_days: 3,
    version: policy.body.policy.version,
  });
  expect(updated.status).toBe(200);
  expect(updated.body.policy.version).toBe(policy.body.policy.version + 1);

  const checked = await checkOut(itemPolicy, 'checkout-policy');
  expect(checked.status).toBe(200);
  const [task] = await tasksForResource(rooms.R2.id);
  expect(task).toBeTruthy();

  const assigned = await apiRequest(
    admin.context,
    'POST',
    `${base()}/tasks/${task.id}/assign`,
    {
      body: { membership_id: adminMembershipId, version: task.version },
      headers: { 'idempotency-key': key('assign-policy') },
    },
  );
  // The inspector takes the task so the self-inspection rule can be proven.
  expect(assigned.status).toBe(200);
  const assignedTask = assigned.body.task;
  expect(assignedTask.status).toBe('ASSIGNED');
  expect(assignedTask.assignee_membership_id).toBe(adminMembershipId);

  const started = await apiRequest(
    admin.context,
    'POST',
    `${base()}/tasks/${task.id}/start`,
    {
      body: { version: assignedTask.version },
      headers: { 'idempotency-key': key('start-policy') },
    },
  );
  expect(started.status).toBe(200);
  expect(started.body.task.status).toBe('IN_PROGRESS');
  expect((await dbRoom(rooms.R2.id)).housekeeping_state).toBe('CLEANING');

  const completed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/tasks/${task.id}/complete`,
    {
      body: { version: started.body.task.version },
      headers: { 'idempotency-key': key('complete-policy') },
    },
  );
  expect(completed.status).toBe(200);
  expect(completed.body.task.status).toBe('CLEAN');
  expect((await dbRoom(rooms.R2.id)).housekeeping_state).toBe('CLEAN');

  const blocked = await assignRoom(itemArrival1, rooms.R2.id);
  expect(blocked.status).toBe(400);
  expect(blocked.body.details.reason).toBe('INSPECTION_REQUIRED');

  // The cleaner cannot inspect the same task while inspection is required.
  const selfInspect = await apiRequest(
    admin.context,
    'POST',
    `${base()}/tasks/${task.id}/inspect`,
    {
      body: { version: completed.body.task.version },
      headers: { 'idempotency-key': key('self-inspect') },
    },
  );
  expect(selfInspect.status).toBe(403);
  expect(selfInspect.body.code).toBe('SELF_INSPECTION_DENIED');
  expect((await dbRoom(rooms.R2.id)).housekeeping_state).toBe('CLEAN');

  const inspection = await apiRequest(
    owner.context,
    'POST',
    `${base()}/tasks/${task.id}/inspect`,
    {
      body: { version: completed.body.task.version },
      headers: { 'idempotency-key': key('inspect-policy') },
    },
  );
  expect(inspection.status).toBe(200);
  expect(inspection.body.task.status).toBe('INSPECTED');
  expect(inspection.body.task.inspected_by_membership_id).toBeTruthy();
  expect((await dbRoom(rooms.R2.id)).housekeeping_state).toBe('INSPECTED');

  const delivered = await assignRoom(itemArrival1, rooms.R2.id);
  expect(delivered.status).toBe(200);
});

test('reassignment during cleaning keeps the task visible and blocks delivery', async () => {
  const checked = await checkOut(itemReassign, 'checkout-reassign');
  expect(checked.status).toBe(200);
  const [task] = await tasksForResource(rooms.R3.id);
  expect(task).toBeTruthy();

  const assigned = await apiRequest(
    admin.context,
    'POST',
    `${base()}/tasks/${task.id}/assign`,
    {
      body: { membership_id: memberMembershipId, version: task.version },
      headers: { 'idempotency-key': key('assign-reassign') },
    },
  );
  expect(assigned.status).toBe(200);
  const started = await apiRequest(
    member.context,
    'POST',
    `${base()}/tasks/${task.id}/start`,
    {
      body: { version: assigned.body.task.version },
      headers: { 'idempotency-key': key('start-reassign') },
    },
  );
  expect(started.status).toBe(200);
  expect((await dbRoom(rooms.R3.id)).housekeeping_state).toBe('CLEANING');

  const interrupted = await assignRoom(itemArrival2, rooms.R3.id);
  expect(interrupted.status).toBe(400);
  expect(interrupted.body.details.reason).toBe('CLEANING');

  // Supervisor reassigns while the worker is interrupted; nothing becomes
  // ready just because the assignee changed.
  const reassigned = await apiRequest(
    admin.context,
    'POST',
    `${base()}/tasks/${task.id}/assign`,
    {
      body: {
        membership_id: adminMembershipId,
        version: started.body.task.version,
      },
      headers: { 'idempotency-key': key('reassign-reassign') },
    },
  );
  expect(reassigned.status).toBe(200);
  expect(reassigned.body.task.status).toBe('IN_PROGRESS');
  expect(reassigned.body.task.assignee_membership_id).toBe(adminMembershipId);
  expect((await dbRoom(rooms.R3.id)).housekeeping_state).toBe('CLEANING');

  const completed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/tasks/${task.id}/complete`,
    {
      body: { version: reassigned.body.task.version },
      headers: { 'idempotency-key': key('complete-reassign') },
    },
  );
  expect(completed.status).toBe(200);
  expect(completed.body.task.status).toBe('CLEAN');
  expect((await dbRoom(rooms.R3.id)).housekeeping_state).toBe('CLEAN');
});

test('move materializes one prep task for the vacated room (STAY_MOVED)', async () => {
  // Freeze the delivery policy for the move fixture; the inspection test
  // re-enables the requirement with the current version afterwards.
  const policyBefore = await apiRequest(
    admin.context,
    'GET',
    `${base()}/operations-policy`,
  );
  expect(policyBefore.status).toBe(200);
  const relaxed = await setPolicy({
    inspection_required: false,
    long_stay_clean_interval_days:
      policyBefore.body.policy.long_stay_clean_interval_days,
    version: policyBefore.body.policy.version,
  });
  expect(relaxed.status).toBe(200);

  const moveVersion = await itemVersion(itemMove.itemId);
  const moved = await moveStay(
    itemMove,
    rooms.R6.id,
    today,
    key('move'),
    moveVersion,
  );
  expect(moved.status).toBe(200);

  const tasks = await tasksForResource(rooms.R5.id);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].type).toBe('HOUSEKEEPING');
  expect(tasks[0].source_event_type).toBe('STAY_MOVED');
  expect((await dbRoom(rooms.R5.id)).housekeeping_state).toBe('DIRTY');
  expect(await tasksForResource(rooms.R6.id)).toHaveLength(0);

  const replay = await moveStay(
    itemMove,
    rooms.R6.id,
    today,
    key('move'),
    moveVersion,
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(await tasksForResource(rooms.R5.id)).toHaveLength(1);
});

test('DND logging records time and follow-up without flipping housekeeping (AT-O04)', async () => {
  const cleanBefore = await dbRoom(rooms.R7.id);
  const loggedClean = await apiRequest(
    admin.context,
    'POST',
    `${base()}/dnd-logs`,
    {
      body: {
        resource_id: rooms.R7.id,
        note: 'Guest declined service',
        follow_up_at: new Date(Date.now() + 3600_000).toISOString(),
      },
      headers: { 'idempotency-key': key('dnd-clean') },
    },
  );
  expect(loggedClean.status).toBe(201);
  expect(loggedClean.body.dnd.state).toBe('ACTIVE');
  expect((await dbRoom(rooms.R7.id)).housekeeping_state).toBe(
    cleanBefore.housekeeping_state,
  );

  const followed = await apiRequest(
    admin.context,
    'POST',
    `${base()}/dnd-logs/${loggedClean.body.dnd.id}/follow-up`,
    {
      body: { note: 'Called the room; guest asked for later' },
      headers: { 'idempotency-key': key('dnd-follow') },
    },
  );
  expect(followed.status).toBe(200);
  expect(followed.body.dnd.state).toBe('FOLLOWED_UP');
  expect(followed.body.dnd.follow_up_attempt_at).toBeTruthy();

  const twice = await apiRequest(
    admin.context,
    'POST',
    `${base()}/dnd-logs/${loggedClean.body.dnd.id}/follow-up`,
    {
      body: { note: 'Again' },
      headers: { 'idempotency-key': key('dnd-follow-2') },
    },
  );
  expect(twice.status).toBe(409);
  expect(twice.body.code).toBe('INVALID_STATE_TRANSITION');

  const checked = await checkOut(itemDnd, 'checkout-dnd');
  expect(checked.status).toBe(200);
  const dirtyBefore = await dbRoom(rooms.R4.id);
  expect(dirtyBefore.housekeeping_state).toBe('DIRTY');
  const loggedDirty = await apiRequest(
    admin.context,
    'POST',
    `${base()}/dnd-logs`,
    {
      body: { resource_id: rooms.R4.id, note: 'Do not disturb now' },
      headers: { 'idempotency-key': key('dnd-dirty') },
    },
  );
  expect(loggedDirty.status).toBe(201);
  expect((await dbRoom(rooms.R4.id)).housekeeping_state).toBe('DIRTY');
  const logs = await apiRequest(
    admin.context,
    'GET',
    `${base()}/dnd-logs?resource_id=${rooms.R4.id}`,
  );
  expect(logs.status).toBe(200);
  expect(logs.body.dnd_logs).toHaveLength(1);
});

test('task reads are scoped and never expose guest identity (AT-O06 partial)', async () => {
  const auditorRead = await apiRequest(
    auditor.context,
    'GET',
    `${base()}/tasks`,
  );
  expect(auditorRead.status).toBe(403);
  expect(auditorRead.body.code).toBe('PERMISSION_DENIED');

  const memberRead = await apiRequest(member.context, 'GET', `${base()}/tasks`);
  expect(memberRead.status).toBe(200);
  expect(memberRead.body.tasks.length).toBeGreaterThan(0);
  for (const task of memberRead.body.tasks) {
    for (const forbidden of [
      'guest',
      'guest_id',
      'guest_name',
      'guest_email',
      'document',
      'passport',
      'balance_due',
      'money',
    ])
      expect(Object.hasOwn(task, forbidden)).toBe(false);
  }
  const memberCreate = await apiRequest(
    member.context,
    'POST',
    `${base()}/tasks`,
    {
      body: { type: 'GUEST_REQUEST', description: 'Extra towels' },
      headers: { 'idempotency-key': key('member-create') },
    },
  );
  expect(memberCreate.status).toBe(403);

  const identityUsers = readIdentityUsers();
  const ownerB = await loginAs('owner-b');
  tenantB = ownerB.session.body.session.active_tenant_id;
  const crossTenant = await apiRequest(
    ownerB.context,
    'GET',
    `${base()}/tasks`,
  );
  expect([403, 404]).toContain(crossTenant.status);
  const crossTenantWrite = await apiRequest(
    ownerB.context,
    'POST',
    `${base()}/tasks`,
    {
      body: {
        type: 'GUEST_REQUEST',
        description: 'Should not cross tenants',
        item_id: itemArrival2.itemId,
      },
      headers: { 'idempotency-key': key('cross-tenant') },
    },
  );
  expect([403, 404]).toContain(crossTenantWrite.status);

  const tenantBRows = await withRuntimeRole('api', async (client) => {
    await client.query(`select set_config('app.tenant_id', $1, false)`, [
      tenantB,
    ]);
    const result = await client.query(
      `select count(*)::int as "count" from "ops_task"`,
    );
    return result.rows[0].count;
  });
  expect(tenantBRows).toBe(0);
  expect(identityUsers.users['member-a']).toBeTruthy();
});

test('operations policy snapshot stays with the task and future tasks use the new version', async () => {
  const policy = await apiRequest(
    admin.context,
    'GET',
    `${base()}/operations-policy`,
  );
  expect(policy.status).toBe(200);
  const updated = await setPolicy({
    inspection_required: false,
    long_stay_clean_interval_days: null,
    version: policy.body.policy.version,
  });
  expect(updated.status).toBe(200);
  expect(updated.body.policy.long_stay_clean_interval_days).toBeNull();

  const created = await apiRequest(admin.context, 'POST', `${base()}/tasks`, {
    body: {
      type: 'GUEST_REQUEST',
      description: 'Extra towels',
      resource_id: rooms.R7.id,
    },
    headers: { 'idempotency-key': key('guest-request') },
  });
  expect(created.status).toBe(201);
  expect(created.body.task.policy_version).toBeNull();

  const stale = await setPolicy({
    inspection_required: true,
    long_stay_clean_interval_days: null,
    version: policy.body.policy.version,
  });
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');

  const longTask = await withOwner(async (client) => {
    const result = await client.query(
      `select "policy_version" from "ops_task" where "id" = $1`,
      [longTaskTwoId],
    );
    return result.rows[0];
  });
  expect(longTask.policy_version).toBe(1);
});
