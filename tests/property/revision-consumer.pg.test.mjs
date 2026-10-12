import { createHash, randomUUID } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  testDatabaseUrl,
  withOwner,
} from './support/harness.mjs';
import { createOrm } from '../../packages/backend/dist/persistence/orm.js';
import { runScopedTransaction } from '../../packages/backend/dist/persistence/tenant-context.js';
import { storeChannelRevision } from '../../packages/backend/dist/modules/distribution/application/inbox-store.js';
import { upsertMapping } from '../../packages/backend/dist/modules/distribution/persistence/mapping-repository.js';

let tenant;
let admin;
let property;
let connectionId;
let productId;
let planId;
let f5ReservationId;
let roomId;

const runId = String(Date.now()).slice(-6);

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function base() {
  return `/tenants/${tenant}/properties/${property.id}`;
}

async function currentInventoryVersion() {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=${addDays(80)}&to=${addDays(95)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function insertRevision({ type, key, items, sequence, payload }) {
  const id = randomUUID();
  const safePayload = payload ?? {
    items: (items ?? []).map((item) => ({ occupancy: 2, ...item })),
  };
  await withOwner(async (client) => {
    await client.query(
      `insert into "distribution_inbox_revision"
         ("id", "tenant_id", "property_id", "connection_id", "channel_key",
          "provider_key", "environment", "provider_revision_id",
          "external_booking_id", "revision_type", "payload_hash",
          "payload_safe", "source_sequence", "received_at")
       values ($1, $2, $3, $4, 'BOOKING_COM', 'CHANNEX', 'STAGING', $5, $6,
               $7, $8, $9::jsonb, $10, now())`,
      [
        id,
        tenant,
        property.id,
        connectionId,
        `REV-${id.slice(0, 8)}`,
        key,
        type,
        'a'.repeat(64),
        JSON.stringify(safePayload),
        sequence,
      ],
    );
  });
  return id;
}

async function revisionState(revisionId) {
  return withOwner(async (client) => {
    const revision = await client.query(
      `select "processing_state", "applied_at", "safe_error_code"
         from "distribution_inbox_revision" where "id" = $1`,
      [revisionId],
    );
    const exceptions = await client.query(
      `select "state", "resolution" from "distribution_exception_case"
        where "inbox_revision_id" = $1
        order by "created_at" desc, "id" desc`,
      [revisionId],
    );
    return { revision: revision.rows[0], exceptions: exceptions.rows };
  });
}

async function reprocess(revisionId) {
  return apiRequest(
    admin.context,
    'POST',
    `${base()}/inbox/${revisionId}/reprocess`,
  );
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
  expect(response.status).toBe(201);
  return response.body.quote.id;
}

async function createOtaDraft(key, arrival, departure) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    {
      body: {
        source: 'OTA',
        channel_connection_id: connectionId,
        external_booking_key: key,
        items: [
          {
            product_id: productId,
            period: {
              arrival: addDays(arrival),
              departure: addDays(departure),
            },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
      },
    },
  );
  expect(response.status).toBe(201);
  return response.body.reservation;
}

async function confirm(reservationId, itemId, priceSnapshotId) {
  return apiRequest(admin.context, 'POST', `${base()}/reservations`, {
    body: {
      reservation_id: reservationId,
      inventory_version: await currentInventoryVersion(),
      items: [{ item_id: itemId, price_snapshot_id: priceSnapshotId }],
    },
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
        code: `P64-${runId}`,
        name: `P06-04 ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  const connection = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections`,
    {
      body: {
        provider_key: 'CHANNEX',
        environment: 'STAGING',
        channel_key: 'BOOKING_COM',
        external_property_id: `p64-${runId}`,
        secret_ref: 'local:hotel/p6-04',
      },
    },
  );
  expect(connection.status).toBe(201);
  connectionId = connection.body.connection.id;
  const resource = await apiRequest(
    admin.context,
    'POST',
    `${base()}/resources`,
    {
      body: { code: `P64-R-${runId}`, type: 'ROOM', capacity: 2 },
    },
  );
  roomId = resource.body.resource.id;
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code: `P64-P-${runId}`,
        name: 'P06-04 room',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  productId = product.body.product.id;
  await apiRequest(
    admin.context,
    'POST',
    `${base()}/products/${productId}/candidates`,
    { body: { resource_id: resource.body.resource.id } },
  );
  await apiRequest(admin.context, 'PATCH', `${base()}/products/${productId}`, {
    body: { version: product.body.product.version, status: 'ACTIVE' },
  });
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: {
      code: `P64-RATE-${runId}`,
      name: 'P06-04 rate',
      product_id: productId,
      currency: 'IDR',
    },
  });
  planId = plan.body.rate_plan.id;
  await apiRequest(admin.context, 'PATCH', `${base()}/rate-plans/${planId}`, {
    body: { version: plan.body.rate_plan.version, status: 'ACTIVE' },
  });
  const cells = [];
  for (let offset = 80; offset <= 95; offset += 1) {
    cells.push({
      rate_plan_id: planId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '325000', currency: 'IDR' },
    });
  }
  await apiRequest(admin.context, 'POST', `${base()}/rates/batch`, {
    body: { cells },
  });
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('P06-04 a new revision links and creates once, then replays as duplicate', async () => {
  const key = `P64-NEW-${runId}`;
  const revisionId = await insertRevision({
    type: 'new',
    key,
    items: [{ arrival: addDays(80), departure: addDays(82) }],
    sequence: '1',
  });
  const first = await reprocess(revisionId);
  expect(first.status).toBe(200);
  expect(first.body.outcome).toBe('CREATED');
  const reservationId = first.body.reservation_id;
  const detailOnce = await detail(reservationId);
  expect(detailOnce.items).toHaveLength(1);
  expect(detailOnce.reservation.state).toBe('INQUIRY');
  const second = await reprocess(revisionId);
  expect(second.status).toBe(200);
  expect(second.body.outcome).toBe('DUPLICATE');
  expect(second.body.replayed).toBe(true);
  const count = await withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "reservation"
            where "channel_connection_id" = $1 and "external_booking_key" = $2`,
          [connectionId, key],
        )
      ).rows[0].count,
    ),
  );
  expect(count).toBe(1);
});

test('P06-04 unknown links, out-of-order and item count changes become permanent exceptions', async () => {
  const missing = await insertRevision({
    type: 'modified',
    key: `P64-MISSING-${runId}`,
    items: [{ arrival: addDays(83), departure: addDays(84) }],
    sequence: '99',
  });
  const missingResult = await reprocess(missing);
  expect(missingResult.body.outcome).toBe('EXCEPTION');
  expect(missingResult.body.error_code).toBe('LINK_MISSING');
  expect(missingResult.body.exception_id).toBeTruthy();
  const key = `P64-ORDER-${runId}`;
  const baseRevision = await insertRevision({
    type: 'new',
    key,
    items: [{ arrival: addDays(84), departure: addDays(86) }],
    sequence: '7',
  });
  const applied = await reprocess(baseRevision);
  expect(applied.body.outcome).toBe('CREATED');
  const outOfOrder = await insertRevision({
    type: 'modified',
    key,
    items: [{ arrival: addDays(84), departure: addDays(87) }],
    sequence: '3',
  });
  const outOfOrderResult = await reprocess(outOfOrder);
  expect(outOfOrderResult.body.outcome).toBe('EXCEPTION');
  expect(outOfOrderResult.body.error_code).toBe('OUT_OF_ORDER');
  const mismatch = await insertRevision({
    type: 'modified',
    key,
    items: [
      { arrival: addDays(84), departure: addDays(87) },
      { arrival: addDays(87), departure: addDays(88) },
    ],
    sequence: '8',
  });
  const mismatchResult = await reprocess(mismatch);
  expect(mismatchResult.body.outcome).toBe('EXCEPTION');
  expect(mismatchResult.body.error_code).toBe('ITEM_COUNT_MISMATCH');
  const unchanged = await detail(applied.body.reservation_id);
  expect(unchanged.items).toHaveLength(1);
  expect(unchanged.items[0].period.arrival).toBe(addDays(84));
});

test('P06-04 modified applies atomically and a conflict preserves the original allocation', async () => {
  const key = `P64-MOD-${runId}`;
  const draft = await createOtaDraft(key, 86, 88);
  const item = (await detail(draft.id)).items[0];
  const confirmed = await confirm(draft.id, item.id, await quote(86, 88));
  expect(confirmed.status).toBe(200);
  const before = await detail(draft.id);
  const revision = await insertRevision({
    type: 'modified',
    key,
    items: [{ arrival: addDays(86), departure: addDays(89) }],
    sequence: '20',
  });
  const applied = await reprocess(revision);
  expect(applied.status).toBe(200);
  expect(applied.body.outcome).toBe('APPLIED');
  const after = await detail(draft.id);
  expect(after.items[0].period.departure).toBe(addDays(89));
  const blockerDraft = await createOtaDraft(`P64-BLOCK-${runId}`, 91, 93);
  const blockerItem = (await detail(blockerDraft.id)).items[0];
  const blocker = await confirm(
    blockerDraft.id,
    blockerItem.id,
    await quote(91, 93),
  );
  expect(blocker.status).toBe(200);
  const conflictRevision = await insertRevision({
    type: 'modified',
    key,
    items: [{ arrival: addDays(91), departure: addDays(93) }],
    sequence: '21',
  });
  const conflict = await reprocess(conflictRevision);
  expect(conflict.status).toBe(200);
  expect(conflict.body.outcome).toBe('EXCEPTION');
  expect(conflict.body.error_code).toBe('EXTERNAL_CONFLICT');
  const preserved = await detail(draft.id);
  expect(preserved.items[0].period.arrival).toBe(
    before.items[0].period.arrival,
  );
  expect(preserved.items[0].period.departure).toBe(addDays(89));
  const allocations = await withOwner(
    async (client) =>
      (
        await client.query(
          `select a."start_date"::text as "start", a."end_date"::text as "end", a."state"
           from "plan_allocation" a
          where a."commitment_id" in (
            select "id" from "commitment" where "source_id" = $1
          ) and a."state" = 'ACTIVE'`,
          [item.id],
        )
      ).rows,
  );
  expect(allocations).toEqual([
    { start: addDays(86), end: addDays(89), state: 'ACTIVE' },
  ]);
});

test('P06-04 cancelled releases future commitments exactly once', async () => {
  const key = `P64-CAN-${runId}`;
  const draft = await createOtaDraft(key, 93, 95);
  const item = (await detail(draft.id)).items[0];
  const confirmed = await confirm(draft.id, item.id, await quote(93, 95));
  expect(confirmed.status).toBe(200);
  const revision = await insertRevision({
    type: 'cancelled',
    key,
    items: [{ arrival: addDays(93), departure: addDays(95) }],
    sequence: '30',
  });
  const result = await reprocess(revision);
  expect(result.status).toBe(200);
  expect(result.body.outcome).toBe('CANCELLED');
  const stored = await withOwner(async (client) => {
    const itemRow = await client.query(
      `select "state" from "reservation_item" where "id" = $1`,
      [item.id],
    );
    const commitment = await client.query(
      `select "state" from "commitment"
        where "source_kind" = 'ITEM' and "source_id" = $1`,
      [item.id],
    );
    return {
      item: itemRow.rows[0]?.state,
      commitment: commitment.rows[0]?.state,
    };
  });
  expect(stored.item).toBe('CANCELLED');
  expect(stored.commitment).toBe('RELEASED');
  const replay = await reprocess(revision);
  expect(replay.body.outcome).toBe('DUPLICATE');
});

test('P06-04 F1 conflict is reprocessed after the blocker is released', async () => {
  const key = `P64-F1C-${runId}`;
  const draft = await createOtaDraft(key, 80, 82);
  const draftItem = (await detail(draft.id)).items[0];
  const confirmed = await confirm(draft.id, draftItem.id, await quote(80, 82));
  expect(confirmed.status).toBe(200);

  const blockerKey = `P64-F1CB-${runId}`;
  const blockerDraft = await createOtaDraft(blockerKey, 84, 85);
  const blockerItem = (await detail(blockerDraft.id)).items[0];
  const blockerConfirmed = await confirm(
    blockerDraft.id,
    blockerItem.id,
    await quote(84, 85),
  );
  expect(blockerConfirmed.status).toBe(200);

  const revisionId = await insertRevision({
    type: 'modified',
    key,
    items: [{ arrival: addDays(84), departure: addDays(85) }],
    sequence: '40',
  });
  const conflict = await reprocess(revisionId);
  expect(conflict.status).toBe(200);
  expect(conflict.body.outcome).toBe('EXCEPTION');
  expect(conflict.body.error_code).toBe('EXTERNAL_CONFLICT');

  const failed = await revisionState(revisionId);
  expect(failed.revision.processing_state).toBe('EXCEPTION');
  expect(failed.revision.applied_at).toBeNull();
  expect(failed.revision.safe_error_code).toBe('EXTERNAL_CONFLICT');
  expect(failed.exceptions[0].state).toBe('OPEN');

  const preserved = await detail(draft.id);
  expect(preserved.items[0].period.arrival).toBe(addDays(80));
  expect(preserved.items[0].period.departure).toBe(addDays(82));

  const blockerRow = (await detail(blockerDraft.id)).items[0];
  const released = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${blockerRow.id}/cancel`,
    { body: { version: blockerRow.version, reason: 'release blocker' } },
  );
  expect(released.status).toBe(200);

  const again = await reprocess(revisionId);
  expect(again.status).toBe(200);
  expect(again.body.outcome).toBe('APPLIED');
  const applied = await detail(draft.id);
  expect(applied.items[0].period.arrival).toBe(addDays(84));
  expect(applied.items[0].period.departure).toBe(addDays(85));

  const resolved = await revisionState(revisionId);
  expect(resolved.revision.processing_state).toBe('APPLIED');
  expect(resolved.revision.applied_at).not.toBeNull();
  expect(resolved.exceptions[0].state).toBe('RESOLVED');
  expect(resolved.exceptions[0].resolution).toBe('REPROCESSED');

  const replay = await reprocess(revisionId);
  expect(replay.body.outcome).toBe('DUPLICATE');
});

test('P06-04 F1 link-missing is reprocessed after the link is created', async () => {
  const key = `P64-F1L-${runId}`;
  const revisionId = await insertRevision({
    type: 'modified',
    key,
    items: [{ arrival: addDays(88), departure: addDays(89) }],
    sequence: '50',
  });
  const missing = await reprocess(revisionId);
  expect(missing.status).toBe(200);
  expect(missing.body.outcome).toBe('EXCEPTION');
  expect(missing.body.error_code).toBe('LINK_MISSING');

  const failed = await revisionState(revisionId);
  expect(failed.revision.processing_state).toBe('EXCEPTION');
  expect(failed.revision.applied_at).toBeNull();
  expect(failed.exceptions[0].state).toBe('OPEN');

  const linked = await createOtaDraft(key, 86, 88);
  const linkedItem = (await detail(linked.id)).items[0];
  expect(linkedItem.period.arrival).toBe(addDays(86));

  const applied = await reprocess(revisionId);
  expect(applied.status).toBe(200);
  expect(applied.body.outcome).toBe('APPLIED');
  expect(applied.body.reservation_id).toBe(linked.id);
  const after = await detail(linked.id);
  expect(after.items[0].period.arrival).toBe(addDays(88));
  expect(after.items[0].period.departure).toBe(addDays(89));

  const resolved = await revisionState(revisionId);
  expect(resolved.revision.processing_state).toBe('APPLIED');
  expect(resolved.revision.applied_at).not.toBeNull();
  expect(resolved.exceptions[0].state).toBe('RESOLVED');
  expect(resolved.exceptions[0].resolution).toBe('REPROCESSED');

  const replay = await reprocess(revisionId);
  expect(replay.body.outcome).toBe('DUPLICATE');
});

test('P06-04 F5 channel occupancy is applied without falling back to one', async () => {
  const key = `P64-F5-${runId}`;
  const revisionId = await insertRevision({
    type: 'new',
    key,
    items: [{ arrival: addDays(81), departure: addDays(82), occupancy: 3 }],
    sequence: '60',
  });
  const created = await reprocess(revisionId);
  expect(created.status).toBe(200);
  expect(created.body.outcome).toBe('CREATED');
  f5ReservationId = created.body.reservation_id;
  const stored = await detail(f5ReservationId);
  expect(stored.items).toHaveLength(1);
  expect(stored.items[0].occupancy.adults).toBe(3);
});

test('P06-04 F5 invalid payloads become permanent exceptions with no partial writes', async () => {
  const invalid = [
    {
      key: `P64-F5-ZERO-${runId}`,
      payload: {
        items: [{ arrival: addDays(80), departure: addDays(82), occupancy: 0 }],
      },
    },
    {
      key: `P64-F5-MANY-${runId}`,
      payload: {
        items: [{ arrival: addDays(80), departure: addDays(82), adults: 50 }],
      },
    },
    {
      key: `P64-F5-MISS-${runId}`,
      payload: { items: [{ arrival: addDays(80), occupancy: 2 }] },
    },
  ];
  let sequence = 61;
  for (const entry of invalid) {
    const revisionId = await insertRevision({
      type: 'new',
      key: entry.key,
      sequence: String(sequence),
      payload: entry.payload,
    });
    sequence += 1;
    const result = await reprocess(revisionId);
    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe('EXCEPTION');
    expect(result.body.error_code).toBe('PAYLOAD_UNSUPPORTED');
    expect(result.body.exception_id).toBeTruthy();
    const stored = await revisionState(revisionId);
    expect(stored.revision.processing_state).toBe('EXCEPTION');
    expect(stored.revision.applied_at).toBeNull();
    expect(stored.exceptions[0].state).toBe('OPEN');
    const count = await withOwner(async (client) =>
      Number(
        (
          await client.query(
            `select count(*)::int as "count" from "reservation"
              where "channel_connection_id" = $1 and "external_booking_key" = $2`,
            [connectionId, entry.key],
          )
        ).rows[0].count,
      ),
    );
    expect(count).toBe(0);
  }

  const modifiedBad = await insertRevision({
    type: 'modified',
    key: `P64-F5-${runId}`,
    sequence: String(sequence),
    payload: {
      items: [{ arrival: addDays(90), departure: addDays(91), occupancy: 50 }],
    },
  });
  const result = await reprocess(modifiedBad);
  expect(result.status).toBe(200);
  expect(result.body.outcome).toBe('EXCEPTION');
  expect(result.body.error_code).toBe('PAYLOAD_UNSUPPORTED');
  const unchanged = await detail(f5ReservationId);
  expect(unchanged.items[0].period.arrival).toBe(addDays(81));
  expect(unchanged.items[0].period.departure).toBe(addDays(82));
});

test('F7 ListChannelExceptions is permission gated, safe and tenant scoped', async () => {
  const revisionId = await insertRevision({
    type: 'modified',
    key: `P64-LIST-${runId}`,
    items: [{ arrival: addDays(89), departure: addDays(90) }],
    sequence: '70',
  });
  const failure = await reprocess(revisionId);
  expect(failure.status).toBe(200);
  expect(failure.body.outcome).toBe('EXCEPTION');
  expect(failure.body.error_code).toBe('LINK_MISSING');
  const exceptionId = failure.body.exception_id;
  expect(exceptionId).toBeTruthy();

  const member = await loginAs('member-a');
  const forbidden = await apiRequest(
    member.context,
    'GET',
    `${base()}/inbox/exceptions`,
  );
  expect(forbidden.status).toBe(403);
  expect(forbidden.body.code).toBe('PERMISSION_DENIED');

  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/inbox/exceptions`,
  );
  expect(response.status).toBe(200);
  expect(Array.isArray(response.body.items)).toBe(true);
  const listed = response.body.items.find((row) => row.id === exceptionId);
  expect(listed).toBeTruthy();
  expect(listed.type).toBe('REVISION_CONFLICT');
  expect(listed.state).toBe('OPEN');
  expect(listed.inbox_revision_id).toBe(revisionId);
  expect(listed.details_safe.error_code).toBe('LINK_MISSING');
  expect(listed.details_safe.provider_revision_id).toBeTruthy();
  for (const row of response.body.items) {
    expect(['OPEN', 'IN_PROGRESS']).toContain(row.state);
    expect(row.tenant_id).toBeUndefined();
    expect(row.payload_safe).toBeUndefined();
    expect(row.payload_hash).toBeUndefined();
  }
  const serialized = JSON.stringify(response.body);
  expect(serialized).not.toContain('payload_hash');
  expect(serialized).not.toContain('a'.repeat(64));

  const other = await loginAs('owner-b');
  const otherTenant = other.session.body.session.active_tenant_id;
  const foreign = await apiRequest(
    other.context,
    'GET',
    `/tenants/${otherTenant}/properties/${property.id}/inbox/exceptions`,
  );
  expect(foreign.status).toBe(404);
  expect(JSON.stringify(foreign.body ?? {})).not.toContain(exceptionId);
});

test('P07 F-RVW7-01 a channel cancellation releases the live room assignment for reuse', async () => {
  const key = `P64-F01-CAN-${runId}`;
  const draft = await createOtaDraft(key, 89, 91);
  const item = (await detail(draft.id)).items[0];
  const confirmed = await confirm(draft.id, item.id, await quote(89, 91));
  expect(confirmed.status).toBe(200);
  const beforeAssign = await detail(draft.id);
  const assign = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${draft.id}/items/${item.id}/assignments`,
    {
      body: {
        resource_id: roomId,
        version: beforeAssign.items[0].version,
      },
      headers: { 'idempotency-key': `p64-f01-assign-${runId}` },
    },
  );
  expect(assign.status).toBe(200);
  expect(assign.body.assignment.state).toBe('PLANNED');

  const revisionId = await insertRevision({
    type: 'cancelled',
    key,
    items: [{ arrival: addDays(89), departure: addDays(91) }],
    sequence: '90',
  });
  const result = await reprocess(revisionId);
  expect(result.status).toBe(200);
  expect(result.body.outcome).toBe('CANCELLED');
  const stored = await withOwner(async (client) => {
    const itemRow = await client.query(
      `select "state" from "reservation_item" where "id" = $1`,
      [item.id],
    );
    const commitment = await client.query(
      `select "state" from "commitment" where "source_id" = $1`,
      [item.id],
    );
    const assignments = await client.query(
      `select "state" from "room_assignment" where "item_id" = $1`,
      [item.id],
    );
    return {
      item: itemRow.rows[0]?.state,
      commitment: commitment.rows[0]?.state,
      assignments: assignments.rows,
    };
  });
  expect(stored.item).toBe('CANCELLED');
  expect(stored.commitment).toBe('RELEASED');
  expect(stored.assignments).toHaveLength(1);
  expect(stored.assignments[0].state).toBe('CANCELLED');
  expect(
    stored.assignments.filter(
      (row) => row.state === 'PLANNED' || row.state === 'ACTIVE',
    ),
  ).toHaveLength(0);

  const secondKey = `P64-F01-REUSE-${runId}`;
  const secondDraft = await createOtaDraft(secondKey, 89, 91);
  const secondItem = (await detail(secondDraft.id)).items[0];
  const secondConfirm = await confirm(
    secondDraft.id,
    secondItem.id,
    await quote(89, 91),
  );
  expect(secondConfirm.status).toBe(200);
  const secondBefore = await detail(secondDraft.id);
  const reassign = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${secondDraft.id}/items/${secondItem.id}/assignments`,
    {
      body: {
        resource_id: roomId,
        version: secondBefore.items[0].version,
      },
      headers: { 'idempotency-key': `p64-f01-reassign-${runId}` },
    },
  );
  expect(reassign.status).toBe(200);
  expect(reassign.body.assignment.resource_id).toBe(roomId);
});

test('transport APPLIED revisions materialize through the scoped PMS API once in new/modify/cancel order', async () => {
  // Dedicated connection keeps this ordering fixture independent of earlier tests.
  const createdConnection = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections`,
    {
      body: {
        provider_key: 'CHANNEX',
        environment: 'STAGING',
        channel_key: 'BOOKING_COM',
        external_property_id: `p64-transport-${runId}`,
        secret_ref: 'local:hotel/p6-04',
      },
    },
  );
  expect(createdConnection.status).toBe(201);
  const transportConnection = createdConnection.body.connection.id;
  const key = `P64-TRANSPORT-${runId}`;
  const orm = await createOrm(testDatabaseUrl, { pool: { min: 0, max: 2 } });
  const scoped = (work) =>
    runScopedTransaction(orm, { tenantId: tenant }, work);
  const envelope = (type, sequence, arrival, departure, externalKey = key) => {
    const payload = {
      schema_version: 1,
      provider_key: 'CHANNEX',
      environment: 'STAGING',
      connection_id: transportConnection,
      channel_key: 'BOOKING_COM',
      external_booking_id: externalKey,
      provider_booking_id: externalKey,
      provider_revision_id: `P64-TRANSPORT-${sequence}-${runId}`,
      revision_type: type,
      source_sequence: sequence,
      source_time: null,
      received_at: new Date().toISOString(),
      items: [
        {
          item_ref: 'room-1',
          item_ref_stable: true,
          external_room_ref: 'EXT-ROOM',
          external_rate_ref: 'EXT-RATE',
          occupancy: 2,
          meal_plan_ref: null,
          arrival: addDays(arrival),
          departure: addDays(departure),
          amount: '650000',
          currency: 'IDR',
        },
      ],
      amount_total: '650000',
      currency: 'IDR',
      commission_amount: null,
      tax_amount: null,
      net_amount: null,
      meal_plan_ref: null,
      occupancy: 2,
      unmapped_fields: [],
      payload_safe_ref: null,
      sanitized: true,
    };
    return {
      ...payload,
      payload_hash: createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex'),
    };
  };
  const store = (payload) =>
    scoped((em) =>
      storeChannelRevision(em, payload, {
        tenantId: tenant,
        propertyId: property.id,
        receivedAt: payload.received_at,
      }),
    );
  const snapshot = () =>
    withOwner(async (client) => {
      const reservations = (
        await client.query(
          'select * from reservation where channel_connection_id=$1 order by id',
          [transportConnection],
        )
      ).rows;
      const items = (
        await client.query(
          'select i.* from reservation_item i join reservation r on r.id=i.reservation_id where r.channel_connection_id=$1 order by i.id',
          [transportConnection],
        )
      ).rows;
      const segments = (
        await client.query(
          'select s.* from stay_segment s join reservation_item i on i.id=s.item_id join reservation r on r.id=i.reservation_id where r.channel_connection_id=$1 order by s.id',
          [transportConnection],
        )
      ).rows;
      const commitments = (
        await client.query(
          'select c.* from commitment c join reservation_item i on i.id=c.source_id join reservation r on r.id=i.reservation_id where r.channel_connection_id=$1 order by c.id',
          [transportConnection],
        )
      ).rows;
      const revisions = (
        await client.query(
          'select id, processing_state, reservation_ref, version, applied_at, safe_error_code from distribution_inbox_revision where connection_id=$1 order by id',
          [transportConnection],
        )
      ).rows;
      const inventory = (
        await client.query(
          'select inventory_version from property where id=$1',
          [property.id],
        )
      ).rows;
      return {
        reservations,
        items,
        segments,
        commitments,
        revisions,
        inventory,
      };
    });
  async function replayUnchanged(id, reservationId) {
    const before = await snapshot();
    const replay = await reprocess(id);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      outcome: 'DUPLICATE',
      reservation_id: reservationId,
      replayed: true,
    });
    expect(await snapshot()).toEqual(before);
  }
  try {
    await scoped((em) =>
      upsertMapping(em, {
        connectionId: transportConnection,
        channelKey: 'BOOKING_COM',
        externalRoomRef: 'EXT-ROOM',
        externalRateRef: 'EXT-RATE',
        occupancy: 2,
        mealPlanRef: null,
        internalProductRef: productId,
        internalRateRef: planId,
        effectiveAt: new Date().toISOString(),
        status: 'ACTIVE',
        mappingVersion: 1,
      }),
    );
    const revisions = [];
    for (const payload of [
      envelope('new', '9', 80, 82),
      envelope('modified', '10', 83, 85),
      envelope('cancelled', '11', 83, 85),
      envelope('new', '999', 90, 92, `${key}-FUTURE`),
    ]) {
      const stored = await store(payload);
      expect(stored.status).toBe('APPLIED');
      expect(stored.externalBookingId).toBeTruthy();
      revisions.push(stored.inboxId);
    }
    const transportOnly = await snapshot();
    expect(transportOnly.reservations).toHaveLength(0);
    expect(transportOnly.revisions).toHaveLength(4);
    for (const revision of transportOnly.revisions) {
      expect(revision.processing_state).toBe('APPLIED');
      expect(revision.reservation_ref).toBeNull();
    }
    const other = await loginAs('owner-b');
    const foreignTenant = other.session.body.session.active_tenant_id;
    const forbidden = await apiRequest(
      other.context,
      'POST',
      `/tenants/${foreignTenant}/properties/${property.id}/inbox/${revisions[0]}/reprocess`,
    );
    expect(forbidden.status).toBe(404);
    expect(await snapshot()).toEqual(transportOnly);

    const materialized = await reprocess(revisions[0]);
    expect(materialized.status).toBe(200);
    expect(materialized.body.outcome).toBe('CREATED');
    expect(materialized.body.replayed).toBe(false);
    const reservationId = materialized.body.reservation_id;
    const initial = await detail(reservationId);
    expect(initial.reservation.state).toBe('INQUIRY');
    expect(initial.reservation.channel_connection_id).toBe(transportConnection);
    expect(initial.reservation.external_booking_key).toBe(key);
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0].product_id).toBeNull();
    expect(initial.items[0].period).toEqual({
      arrival: addDays(80),
      departure: addDays(82),
    });
    const itemId = initial.items[0].id;
    await replayUnchanged(revisions[0], reservationId);

    const modified = await reprocess(revisions[1]);
    expect(modified.status).toBe(200);
    expect(modified.body).toMatchObject({
      outcome: 'APPLIED',
      reservation_id: reservationId,
      state: 'INQUIRY',
      replayed: false,
    });
    const moved = await detail(reservationId);
    expect(moved.items[0].id).toBe(itemId);
    expect(moved.items[0].period).toEqual({
      arrival: addDays(83),
      departure: addDays(85),
    });
    await replayUnchanged(revisions[1], reservationId);

    const cancelled = await reprocess(revisions[2]);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      outcome: 'CANCELLED',
      reservation_id: reservationId,
      state: 'CANCELLED',
      replayed: false,
    });
    const final = await detail(reservationId);
    expect(final.items[0].id).toBe(itemId);
    expect(final.items[0].state).toBe('CANCELLED');
    await replayUnchanged(revisions[2], reservationId);
    await replayUnchanged(revisions[0], reservationId);

    // Numeric ordering crosses 9/10; transport999 cannot mask the materialized11 bound.
    const stale = await store({
      ...envelope('modified', '10', 86, 88),
      provider_revision_id: `P64-TRANSPORT-STALE-${runId}`,
    });
    expect(stale.status).toBe('IGNORED_STALE');
    const rejected = await reprocess(stale.inboxId);
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      outcome: 'EXCEPTION',
      error_code: 'OUT_OF_ORDER',
    });
    expect(await detail(reservationId)).toEqual(final);
    const persisted = await snapshot();
    expect(persisted.reservations).toHaveLength(1);
    expect(persisted.items).toHaveLength(1);
    expect(persisted.segments).toHaveLength(1);
    expect(persisted.commitments).toHaveLength(0);
    for (const id of revisions.slice(0, 3))
      expect(
        persisted.revisions.find((revision) => revision.id === id),
      ).toMatchObject({
        processing_state: 'APPLIED',
        reservation_ref: reservationId,
      });
    expect(
      persisted.revisions.find((revision) => revision.id === revisions[3])
        .reservation_ref,
    ).toBeNull();
  } finally {
    await orm.close(true);
  }
});
