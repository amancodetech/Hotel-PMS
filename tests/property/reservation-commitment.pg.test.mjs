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
let auditor;
let member;
let property;
let productId;
let planId;
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
  expect(response.status).toBe(201);
  return response.body.quote.id;
}

async function createDraft(items, extra = {}) {
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
        ...extra,
      },
    },
  );
  expect(response.status).toBe(201);
  return response.body.reservation;
}

async function currentInventoryVersion() {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=${addDays(40)}&to=${addDays(52)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function confirmReservation(reservationId, items, key, version) {
  return apiRequest(admin.context, 'POST', `${base()}/reservations`, {
    body: {
      reservation_id: reservationId,
      inventory_version: version ?? (await currentInventoryVersion()),
      items,
    },
    headers: key ? { 'idempotency-key': key } : {},
  });
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

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  auditor = await loginAs('auditor-a');
  member = await loginAs('member-a');
  tenant = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P62-${runId}`,
        name: `P06-02 ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  const resource = await apiRequest(
    admin.context,
    'POST',
    `${base()}/resources`,
    {
      body: { code: `P62-R-${runId}`, type: 'ROOM', capacity: 2 },
    },
  );
  expect(resource.status).toBe(201);
  roomId = resource.body.resource.id;
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code: `P62-P-${runId}`,
        name: 'P06-02 room',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  productId = product.body.product.id;
  const candidate = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products/${productId}/candidates`,
    { body: { resource_id: resource.body.resource.id } },
  );
  expect(candidate.status).toBe(201);
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/products/${productId}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: {
      code: `P62-RATE-${runId}`,
      name: 'P06-02 rate',
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
  for (let offset = 40; offset <= 56; offset += 1) {
    cells.push({
      rate_plan_id: planId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '300000', currency: 'IDR' },
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
  const calendar = await apiRequest(
    admin.context,
    'GET',
    `${base()}/rates?from=${addDays(40)}&to=${addDays(52)}`,
  );
  expect(calendar.status).toBe(200);
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('P06-02 confirm commits inventory, price snapshot and replays idempotently', async () => {
  const draft = await createDraft([[40, 42]]);
  const quoteId = await quote(40, 42);
  const versionAtConfirm = await currentInventoryVersion();
  const first = await confirmReservation(
    draft.id,
    [
      {
        item_id: (await detail(draft.id)).items[0].id,
        price_snapshot_id: quoteId,
      },
    ],
    `p62-confirm-${runId}`,
    versionAtConfirm,
  );
  expect(first.status).toBe(200);
  expect(first.body.state).toBe('CONFIRMED');
  expect(first.body.replayed).toBe(false);
  const itemId = first.body.item_ids[0];
  const stored = await withOwner(async (client) => {
    const commitments = await client.query(
      `select "state" from "commitment"
        where "source_kind" = 'ITEM' and "source_id" = $1`,
      [itemId],
    );
    const allocations = await client.query(
      `select "state" from "plan_allocation"
        where "commitment_id" = (select "id" from "commitment" where "source_id" = $1)`,
      [itemId],
    );
    const item = await client.query(
      `select "state", "price_snapshot_id", "version" from "reservation_item" where "id" = $1`,
      [itemId],
    );
    const audit = await client.query(
      `select count(*)::int as "count" from "audit_event"
        where "resource_id" = $1 and "action" = 'reservation.confirmed'`,
      [draft.id],
    );
    return {
      commitment: commitments.rows[0]?.state,
      allocations: allocations.rows.map((row) => row.state),
      item: item.rows[0],
      audit: audit.rows[0].count,
    };
  });
  expect(stored.commitment).toBe('ACTIVE');
  expect(stored.allocations).toEqual(['ACTIVE']);
  expect(stored.item.state).toBe('CONFIRMED');
  expect(stored.item.price_snapshot_id).toBe(quoteId);
  expect(stored.audit).toBeGreaterThanOrEqual(1);
  const replay = await confirmReservation(
    draft.id,
    [{ item_id: itemId, price_snapshot_id: quoteId }],
    `p62-confirm-${runId}`,
    versionAtConfirm,
  );
  expect(replay.status).toBe(200);
  expect(replay.body.replayed).toBe(true);
  const countAfter = await withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "commitment" where "source_id" = $1`,
          [itemId],
        )
      ).rows[0].count,
    ),
  );
  expect(countAfter).toBe(1);
  const otherDraft = await createDraft([[43, 45]]);
  const otherQuote = await quote(43, 45);
  const otherItem = (await detail(otherDraft.id)).items[0].id;
  const mismatch = await confirmReservation(
    otherDraft.id,
    [{ item_id: otherItem, price_snapshot_id: otherQuote }],
    `p62-confirm-${runId}`,
  );
  expect(mismatch.status).toBe(409);
  expect(mismatch.body.code).toBe('CONFLICT');
  const doubleConfirm = await confirmReservation(
    draft.id,
    [{ item_id: itemId, price_snapshot_id: quoteId }],
    `p62-confirm-2-${runId}`,
  );
  expect(doubleConfirm.status).toBe(409);
  expect(doubleConfirm.body.code).toBe('INVALID_STATE_TRANSITION');
});

test('P06-02 modify replaces commitment atomically and keeps the old one on failure', async () => {
  const draft = await createDraft([[43, 45]]);
  const quoteId = await quote(43, 45);
  const itemId = (await detail(draft.id)).items[0].id;
  const confirmed = await confirmReservation(draft.id, [
    { item_id: itemId, price_snapshot_id: quoteId },
  ]);
  expect(confirmed.status).toBe(200);
  const newQuote = await quote(46, 48);
  const modified = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/reservations/${draft.id}`,
    {
      body: {
        version: confirmed.body.version,
        items: [
          {
            item_id: itemId,
            period: { arrival: addDays(46), departure: addDays(48) },
            price_snapshot_id: newQuote,
          },
        ],
      },
    },
  );
  expect(modified.status).toBe(200);
  const history = await withOwner(async (client) => {
    const rows = await client.query(
      `select a."state", a."start_date"::text as "start" from "commitment" c
        join "plan_allocation" a on a."commitment_id" = c."id"
       where c."source_id" = $1`,
      [itemId],
    );
    return rows.rows.map((row) => ({
      state: row.state,
      start: row.start,
    }));
  });
  expect(history).toHaveLength(2);
  expect(history.filter((row) => row.state === 'RELEASED')).toEqual([
    { state: 'RELEASED', start: addDays(43) },
  ]);
  expect(history.filter((row) => row.state === 'ACTIVE')).toEqual([
    { state: 'ACTIVE', start: addDays(46) },
  ]);
  const blocker = await createDraft([[50, 52]]);
  const blockerQuote = await quote(50, 52);
  const conflictingQuote = await quote(50, 52);
  const blockerItem = (await detail(blocker.id)).items[0].id;
  const blockerConfirm = await confirmReservation(blocker.id, [
    { item_id: blockerItem, price_snapshot_id: blockerQuote },
  ]);
  expect(blockerConfirm.status).toBe(200);
  const failed = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/reservations/${draft.id}`,
    {
      body: {
        version: modified.body.version,
        items: [
          {
            item_id: itemId,
            period: { arrival: addDays(50), departure: addDays(52) },
            price_snapshot_id: conflictingQuote,
          },
        ],
      },
    },
  );
  expect([409, 422]).toContain(failed.status);
  expect(failed.body.code).toBe('RESOURCE_UNAVAILABLE');
  const afterFailure = await withOwner(async (client) => {
    const commitment = await client.query(
      `select "state" from "commitment" where "source_id" = $1 order by "created_at" desc limit 1`,
      [itemId],
    );
    const allocation = await client.query(
      `select a."start_date"::text as "start" from "plan_allocation" a
        where a."state" = 'ACTIVE' and a."commitment_id" in (
          select "id" from "commitment" where "source_id" = $1 and "state" = 'ACTIVE'
        )`,
      [itemId],
    );
    return {
      state: commitment.rows[0]?.state,
      start: allocation.rows[0]?.start,
    };
  });
  expect(afterFailure.state).toBe('ACTIVE');
  expect(afterFailure.start).toBe(addDays(46));
  const unchanged = await detail(draft.id);
  expect(unchanged.items[0].period.arrival).toBe(addDays(46));
});

test('P06-02 modify keeps unconfirmed items uncommitted (F4)', async () => {
  const draft = await createDraft([[42, 44]]);
  const itemId = (await detail(draft.id)).items[0].id;
  const periodQuote = await quote(43, 45);
  const first = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/reservations/${draft.id}`,
    {
      body: {
        version: draft.version,
        items: [
          {
            item_id: itemId,
            period: { arrival: addDays(43), departure: addDays(45) },
            price_snapshot_id: periodQuote,
          },
        ],
      },
    },
  );
  expect(first.status).toBe(200);
  const afterFirst = await withOwner(async (client) => {
    const commitments = await client.query(
      `select "state" from "commitment" where "source_id" = $1`,
      [itemId],
    );
    const item = await client.query(
      `select "state", "arrival"::text as "arrival" from "reservation_item" where "id" = $1`,
      [itemId],
    );
    return { commitments: commitments.rows, item: item.rows[0] };
  });
  expect(afterFirst.commitments).toEqual([]);
  expect(afterFirst.item.state).toBe('INQUIRY');
  expect(afterFirst.item.arrival).toBe(addDays(43));
  const quantityQuote = await withOwner(async (client) => {
    const cloned = await client.query(
      `insert into "price_quote"
         ("id", "tenant_id", "property_id", "rate_plan_id", "policy_version_id",
          "product_id", "currency", "start_date", "end_date", "quantity",
          "adults", "child_ages", "total_amount", "cells", "inventory_version",
          "expires_at")
       select gen_random_uuid(), "tenant_id", "property_id", "rate_plan_id",
              "policy_version_id", "product_id", "currency", "start_date",
              "end_date", 2, "adults", "child_ages", "total_amount", "cells",
              "inventory_version", "expires_at"
         from "price_quote" where "id" = $1
       returning "id"`,
      [periodQuote],
    );
    return cloned.rows[0].id;
  });
  const second = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/reservations/${draft.id}`,
    {
      body: {
        version: first.body.version,
        items: [
          { item_id: itemId, quantity: 2, price_snapshot_id: quantityQuote },
        ],
      },
    },
  );
  expect(second.status).toBe(200);
  const afterSecond = await withOwner(async (client) => {
    const commitments = await client.query(
      `select "state" from "commitment" where "source_id" = $1`,
      [itemId],
    );
    const item = await client.query(
      `select "state", "quantity" from "reservation_item" where "id" = $1`,
      [itemId],
    );
    return { commitments: commitments.rows, item: item.rows[0] };
  });
  expect(afterSecond.commitments).toEqual([]);
  expect(afterSecond.item.state).toBe('INQUIRY');
  expect(afterSecond.item.quantity).toBe(2);
  const detailAfter = await detail(draft.id);
  expect(detailAfter.items[0].state).toBe('INQUIRY');
  const audit = await withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "audit_event"
            where "resource_id" = $1 and "action" = 'reservation.modified'`,
          [draft.id],
        )
      ).rows[0].count,
    ),
  );
  expect(audit).toBeGreaterThanOrEqual(2);
});

test('P06-02 modify releases a stray commitment on an unconfirmed item', async () => {
  const draft = await createDraft([[46, 48]]);
  const itemId = (await detail(draft.id)).items[0].id;
  await withOwner(async (client) => {
    await client.query(
      `insert into "commitment"
         ("id", "tenant_id", "property_id", "source_kind", "source_id",
          "state", "expires_at", "inventory_version")
       values (gen_random_uuid(), $1, $2, 'ITEM', $3, 'ACTIVE', null, 1)`,
      [tenant, property.id, itemId],
    );
  });
  const modified = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/reservations/${draft.id}`,
    {
      body: { version: draft.version, items: [{ item_id: itemId }] },
    },
  );
  expect(modified.status).toBe(200);
  const stored = await withOwner(async (client) => {
    const commitment = await client.query(
      `select "state" from "commitment" where "source_id" = $1`,
      [itemId],
    );
    const item = await client.query(
      `select "state" from "reservation_item" where "id" = $1`,
      [itemId],
    );
    return { commitment: commitment.rows[0]?.state, item: item.rows[0]?.state };
  });
  expect(stored.commitment).toBe('RELEASED');
  expect(stored.item).toBe('INQUIRY');
});

test('P06-02 cancel releases the future commitment and is version-guarded', async () => {
  const draft = await createDraft([[44, 46]]);
  const quoteId = await quote(44, 46);
  const itemId = (await detail(draft.id)).items[0].id;
  const confirmed = await confirmReservation(draft.id, [
    { item_id: itemId, price_snapshot_id: quoteId },
  ]);
  const versionAfterConfirm = confirmed.body.version;
  const before = await detail(draft.id);
  const cancel = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${itemId}/cancel`,
    {
      body: { version: before.items[0].version, reason: 'P06-02 test cancel' },
    },
  );
  expect(cancel.status).toBe(200);
  expect(cancel.body.state).toBe('CANCELLED');
  const stored = await withOwner(async (client) => {
    const commitment = await client.query(
      `select "state" from "commitment" where "source_id" = $1`,
      [itemId],
    );
    const allocations = await client.query(
      `select "state" from "plan_allocation" where "commitment_id" = (
        select "id" from "commitment" where "source_id" = $1
      )`,
      [itemId],
    );
    return {
      commitment: commitment.rows[0]?.state,
      allocations: allocations.rows.map((row) => row.state),
    };
  });
  expect(stored.commitment).toBe('RELEASED');
  expect(stored.allocations).toEqual(['RELEASED']);
  const stale = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${itemId}/cancel`,
    { body: { version: 1, reason: 'stale cancel attempt' } },
  );
  expect(stale.status).toBe(412);
  expect(stale.body.code).toBe('STALE_VERSION');
  const again = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${itemId}/cancel`,
    {
      body: {
        version: cancel.body.item_version,
        reason: 'second cancel attempt',
      },
    },
  );
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
  const reservation = await detail(draft.id);
  expect(reservation.reservation.version).toBeGreaterThan(versionAfterConfirm);
});

test('P06-02 concurrent confirms on one resource end with a single winner', async () => {
  const firstDraft = await createDraft([[42, 44]]);
  const secondDraft = await createDraft([[42, 44]]);
  const firstQuote = await quote(42, 44);
  const secondQuote = await quote(42, 44);
  const firstItem = (await detail(firstDraft.id)).items[0].id;
  const secondItem = (await detail(secondDraft.id)).items[0].id;
  const raceVersion = await currentInventoryVersion();
  const [firstResult, secondResult] = await Promise.all([
    confirmReservation(
      firstDraft.id,
      [{ item_id: firstItem, price_snapshot_id: firstQuote }],
      undefined,
      raceVersion,
    ),
    confirmReservation(
      secondDraft.id,
      [{ item_id: secondItem, price_snapshot_id: secondQuote }],
      undefined,
      raceVersion,
    ),
  ]);
  const statuses = [firstResult.status, secondResult.status].sort();
  expect(statuses[0]).toBe(200);
  expect([409, 412, 422]).toContain(statuses[1]);
  const active = await withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "commitment"
            where "source_id" in ($1, $2) and "state" = 'ACTIVE'`,
          [firstItem, secondItem],
        )
      ).rows[0].count,
    ),
  );
  expect(active).toBe(1);
});

test('P06-02 channel-linked confirmation enqueues a ReservationConfirmed outbox event', async () => {
  const connection = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections`,
    {
      body: {
        provider_key: 'CHANNEX',
        environment: 'STAGING',
        channel_key: 'BOOKING_COM',
        external_property_id: `p62-${runId}`,
        secret_ref: 'local:hotel/p6-02',
      },
    },
  );
  expect(connection.status).toBe(201);
  const connectionId = connection.body.connection.id;
  const externalKey = `P62-EXT-${runId}`;
  const draft = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/drafts`,
    {
      body: {
        source: 'OTA',
        channel_connection_id: connectionId,
        external_booking_key: externalKey,
        items: [
          {
            product_id: productId,
            period: { arrival: addDays(44), departure: addDays(46) },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
      },
    },
  );
  expect(draft.status).toBe(201);
  const quoteId = await quote(44, 46);
  const itemId = (await detail(draft.body.reservation.id)).items[0].id;
  const confirmed = await confirmReservation(draft.body.reservation.id, [
    { item_id: itemId, price_snapshot_id: quoteId },
  ]);
  expect(confirmed.status).toBe(200);
  const outbox = await withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "distribution_outbox_event"
            where "aggregate_id" = $1 and "event_type" = 'ReservationConfirmed'`,
          [draft.body.reservation.id],
        )
      ).rows[0].count,
    ),
  );
  expect(outbox).toBe(1);
});

test('P06-02 permissions separate read, create, modify and cancel', async () => {
  const draft = await createDraft([[48, 50]]);
  const quoteId = await quote(48, 50);
  const itemId = (await detail(draft.id)).items[0].id;
  const auditorConfirm = await confirmReservationWith(auditor, draft.id, [
    { item_id: itemId, price_snapshot_id: quoteId },
  ]);
  expect(auditorConfirm.status).toBe(403);
  const memberModify = await apiRequest(
    member.context,
    'PATCH',
    `${base()}/reservations/${draft.id}`,
    {
      body: {
        version: 1,
        items: [{ item_id: itemId, quantity: 2 }],
      },
    },
  );
  expect(memberModify.status).toBe(403);
  const memberCancel = await apiRequest(
    member.context,
    'POST',
    `${base()}/reservation-items/${itemId}/cancel`,
    { body: { version: 1, reason: 'member attempt' } },
  );
  expect(memberCancel.status).toBe(403);
});

async function confirmReservationWith(session, reservationId, items) {
  return apiRequest(session.context, 'POST', `${base()}/reservations`, {
    body: {
      reservation_id: reservationId,
      inventory_version: await currentInventoryVersion(),
      items,
    },
  });
}

test('P07 F-RVW7-01 cancelling an item releases its live room assignment for reuse', async () => {
  const draft = await createDraft([[48, 50]]);
  const quoteId = await quote(48, 50);
  const itemId = (await detail(draft.id)).items[0].id;
  const confirmed = await confirmReservation(draft.id, [
    { item_id: itemId, price_snapshot_id: quoteId },
  ]);
  expect(confirmed.status).toBe(200);
  const beforeAssign = await detail(draft.id);
  const assign = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${draft.id}/items/${itemId}/assignments`,
    {
      body: {
        resource_id: roomId,
        version: beforeAssign.items[0].version,
      },
      headers: { 'idempotency-key': `p07-f01-assign-${runId}` },
    },
  );
  expect(assign.status).toBe(200);
  expect(assign.body.assignment.state).toBe('PLANNED');

  const beforeCancel = await detail(draft.id);
  const cancel = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${itemId}/cancel`,
    {
      body: {
        version: beforeCancel.items[0].version,
        reason: 'F-RVW7-01 cancel after assignment',
      },
    },
  );
  expect(cancel.status).toBe(200);
  const stored = await withOwner(async (client) => {
    const assignments = await client.query(
      `select "state", "version" from "room_assignment" where "item_id" = $1`,
      [itemId],
    );
    const commitment = await client.query(
      `select "state" from "commitment" where "source_id" = $1`,
      [itemId],
    );
    const allocations = await client.query(
      `select "state" from "plan_allocation" where "commitment_id" = (
        select "id" from "commitment" where "source_id" = $1
      )`,
      [itemId],
    );
    return {
      assignments: assignments.rows,
      commitment: commitment.rows[0]?.state,
      allocations: allocations.rows.map((row) => row.state),
    };
  });
  expect(stored.assignments).toHaveLength(1);
  expect(stored.assignments[0].state).toBe('CANCELLED');
  expect(stored.assignments[0].version).toBe(
    assign.body.assignment.version + 1,
  );
  expect(stored.commitment).toBe('RELEASED');
  expect(stored.allocations).toEqual(['RELEASED']);
  expect(
    stored.assignments.filter(
      (row) => row.state === 'PLANNED' || row.state === 'ACTIVE',
    ),
  ).toHaveLength(0);

  const secondDraft = await createDraft([[48, 50]]);
  const secondQuote = await quote(48, 50);
  const secondItem = (await detail(secondDraft.id)).items[0].id;
  const secondConfirm = await confirmReservation(secondDraft.id, [
    { item_id: secondItem, price_snapshot_id: secondQuote },
  ]);
  expect(secondConfirm.status).toBe(200);
  const secondBefore = await detail(secondDraft.id);
  const reassign = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${secondDraft.id}/items/${secondItem}/assignments`,
    {
      body: {
        resource_id: roomId,
        version: secondBefore.items[0].version,
      },
      headers: { 'idempotency-key': `p07-f01-reassign-${runId}` },
    },
  );
  expect(reassign.status).toBe(200);
  expect(reassign.body.assignment.resource_id).toBe(roomId);
  const board = await apiRequest(
    admin.context,
    'GET',
    `${base()}/front-desk/board?date=${addDays(48)}`,
  );
  expect(board.status).toBe(200);
  const candidate = board.body.arrivals
    .find((row) => row.item_id === secondItem)
    .candidates.find((row) => row.resource_id === roomId);
  expect(candidate.eligible).toBe(true);
  expect(candidate.reason).toBeNull();
});

test('P07 F-RVW7-01 no-show also releases the live room assignment', async () => {
  const draft = await createDraft([[53, 55]]);
  const quoteId = await quote(53, 55);
  const itemId = (await detail(draft.id)).items[0].id;
  const confirmed = await confirmReservation(draft.id, [
    { item_id: itemId, price_snapshot_id: quoteId },
  ]);
  expect(confirmed.status).toBe(200);
  const beforeAssign = await detail(draft.id);
  const assign = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${draft.id}/items/${itemId}/assignments`,
    {
      body: {
        resource_id: roomId,
        version: beforeAssign.items[0].version,
      },
      headers: { 'idempotency-key': `p07-f01-noshow-assign-${runId}` },
    },
  );
  expect(assign.status).toBe(200);
  const beforeNoShow = await detail(draft.id);
  const noShow = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${itemId}/no-show`,
    {
      body: {
        version: beforeNoShow.items[0].version,
        reason: 'F-RVW7-01 synthetic no-show after assignment',
      },
    },
  );
  expect(noShow.status).toBe(200);
  expect(noShow.body.state).toBe('NO_SHOW');
  const stored = await withOwner(async (client) => {
    const item = await client.query(
      `select "state" from "reservation_item" where "id" = $1`,
      [itemId],
    );
    const commitment = await client.query(
      `select "state" from "commitment" where "source_id" = $1`,
      [itemId],
    );
    const assignments = await client.query(
      `select "state" from "room_assignment" where "item_id" = $1`,
      [itemId],
    );
    return {
      item: item.rows[0]?.state,
      commitment: commitment.rows[0]?.state,
      assignments: assignments.rows,
    };
  });
  expect(stored.item).toBe('NO_SHOW');
  expect(stored.commitment).toBe('RELEASED');
  expect(stored.assignments).toHaveLength(1);
  expect(stored.assignments[0].state).toBe('CANCELLED');
});
