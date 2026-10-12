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
let productId;
let planId;

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
    `${base()}/rates?from=${addDays(60)}&to=${addDays(75)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
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
            arrival: addDays(item.arrival),
            departure: addDays(item.departure),
          },
          occupancy: { adults: 2, child_ages: [] },
          quantity: item.quantity ?? 1,
          owner_stay: item.owner_stay,
        })),
        ...extra,
      },
    },
  );
  expect(response.status).toBe(201);
  return response.body.reservation;
}

async function confirm(reservationId, items) {
  return apiRequest(admin.context, 'POST', `${base()}/reservations`, {
    body: {
      reservation_id: reservationId,
      inventory_version: await currentInventoryVersion(),
      items,
    },
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
  tenant = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P63-${runId}`,
        name: `P06-03 ${runId}`,
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
      body: { code: `P63-R-${runId}`, type: 'ROOM', capacity: 2 },
    },
  );
  expect(resource.status).toBe(201);
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code: `P63-P-${runId}`,
        name: 'P06-03 room',
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
  const resourceTwo = await apiRequest(
    admin.context,
    'POST',
    `${base()}/resources`,
    { body: { code: `P63-R2-${runId}`, type: 'ROOM', capacity: 2 } },
  );
  expect(resourceTwo.status).toBe(201);
  const candidateTwo = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products/${productId}/candidates`,
    { body: { resource_id: resourceTwo.body.resource.id } },
  );
  expect(candidateTwo.status).toBe(201);
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/products/${productId}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: {
      code: `P63-RATE-${runId}`,
      name: 'P06-03 rate',
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
  for (let offset = 60; offset <= 75; offset += 1) {
    cells.push({
      rate_plan_id: planId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '315000', currency: 'IDR' },
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
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('P06-03 pickup moves a group allotment without duplicating inventory', async () => {
  const draft = await createDraft([
    { arrival: 60, departure: 62 },
    { arrival: 60, departure: 62 },
  ]);
  const quoteId = await quote(60, 62);
  const allotment = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${draft.id}/group-allotment`,
    {
      body: {
        product_id: productId,
        period: { arrival: addDays(60), departure: addDays(62) },
        quantity: 1,
        inventory_version: await currentInventoryVersion(),
      },
    },
  );
  expect(allotment.status).toBe(200);
  expect(allotment.body.allocation_count).toBe(1);
  const items = (await detail(draft.id)).items;
  const mismatch = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${draft.id}/group-allotment/pickup`,
    {
      body: {
        item_id: items[0].id,
        price_snapshot_id: await quote(73, 75),
      },
    },
  );
  expect(mismatch.status).toBe(400);
  expect(mismatch.body.code).toBe('INVALID_REQUEST');
  const pickup = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${draft.id}/group-allotment/pickup`,
    { body: { item_id: items[0].id, price_snapshot_id: quoteId } },
  );
  expect(pickup.status).toBe(200);
  expect(pickup.body.moved_allocations).toBe(1);
  const stored = await withOwner(async (client) => {
    const commitments = await client.query(
      `select "source_kind", "state" from "commitment"
        where "source_id" in ($1, $2) order by "source_kind"`,
      [draft.id, items[0].id],
    );
    const allocations = await client.query(
      `select count(*)::int as "count" from "plan_allocation"
        where "property_id" = $1 and "state" = 'ACTIVE'`,
      [property.id],
    );
    const allotmentRow = await client.query(
      `select "state" from "reservation_group_allotment" where "reservation_id" = $1`,
      [draft.id],
    );
    const item = await client.query(
      `select "state" from "reservation_item" where "id" = $1`,
      [items[0].id],
    );
    return {
      commitments,
      active: allocations.rows[0].count,
      allotment: allotmentRow.rows[0]?.state,
      item: item.rows[0]?.state,
    };
  });
  expect(stored.allotment).toBe('PICKED_UP');
  expect(stored.item).toBe('CONFIRMED');
  expect(stored.active).toBe(1);
  expect(
    stored.commitments.rows.find((row) => row.source_kind === 'GROUP').state,
  ).toBe('RELEASED');
  const again = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservations/${draft.id}/group-allotment/pickup`,
    {
      body: {
        item_id: items[1].id,
        price_snapshot_id: quoteId,
      },
    },
  );
  expect(again.status).toBe(404);
});

test('P06-03 split secures both segments atomically with no overlap', async () => {
  const draft = await createDraft([{ arrival: 63, departure: 66 }]);
  const item = (await detail(draft.id)).items[0];
  const firstQuote = await quote(63, 64);
  const secondQuote = await quote(64, 66);
  const confirmed = await confirm(draft.id, [
    { item_id: item.id, price_snapshot_id: await quote(63, 66) },
  ]);
  expect(confirmed.status).toBe(200);
  const stale = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${item.id}/split`,
    {
      body: {
        version: 1,
        split_date: addDays(64),
        first_price_snapshot_id: firstQuote,
        second_price_snapshot_id: secondQuote,
      },
    },
  );
  expect(stale.status).toBe(412);
  const split = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${item.id}/split`,
    {
      body: {
        version: (await detail(draft.id)).items[0].version,
        split_date: addDays(64),
        first_price_snapshot_id: firstQuote,
        second_price_snapshot_id: secondQuote,
      },
    },
  );
  expect(split.status).toBe(200);
  const after = await detail(draft.id);
  expect(after.items).toHaveLength(2);
  expect(after.items[0].period).toEqual({
    arrival: addDays(63),
    departure: addDays(64),
  });
  expect(after.items[1].period).toEqual({
    arrival: addDays(64),
    departure: addDays(66),
  });
  expect(after.items.every((row) => row.state === 'CONFIRMED')).toBe(true);
  expect(after.items[0].segments).toHaveLength(1);
  expect(after.items[1].segments).toHaveLength(1);
  const overlaps = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count"
         from "plan_allocation" a
         join "plan_allocation" b
           on a."resource_id" = b."resource_id" and a."id" < b."id"
        where a."state" = 'ACTIVE' and b."state" = 'ACTIVE'
          and a."property_id" = $1
          and daterange(a."start_date", a."end_date", '[)')
              && daterange(b."start_date", b."end_date", '[)')`,
      [property.id],
    );
    const allocations = await client.query(
      `select "start_date"::text as "start", "end_date"::text as "end"
         from "plan_allocation"
        where "property_id" = $1 and "state" = 'ACTIVE'
        order by "start_date"`,
      [property.id],
    );
    return { overlaps: result.rows[0].count, allocations: allocations.rows };
  });
  expect(overlaps.overlaps).toBe(0);
  expect(overlaps.allocations).toEqual([
    { start: addDays(60), end: addDays(62) },
    { start: addDays(63), end: addDays(64) },
    { start: addDays(64), end: addDays(66) },
  ]);
});

test('P06-03 no-show releases the commitment and rejects residents', async () => {
  const draft = await createDraft([{ arrival: 67, departure: 69 }]);
  const item = (await detail(draft.id)).items[0];
  const confirmed = await confirm(draft.id, [
    { item_id: item.id, price_snapshot_id: await quote(67, 69) },
  ]);
  expect(confirmed.status).toBe(200);
  const fresh = await detail(draft.id);
  const noShow = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${item.id}/no-show`,
    {
      body: {
        version: fresh.items[0].version,
        reason: 'P06-03 no show test',
      },
    },
  );
  expect(noShow.status).toBe(200);
  const stored = await withOwner(async (client) => {
    const itemRow = await client.query(
      `select "state" from "reservation_item" where "id" = $1`,
      [item.id],
    );
    const commitment = await client.query(
      `select "state" from "commitment" where "source_kind" = 'ITEM' and "source_id" = $1`,
      [item.id],
    );
    return {
      item: itemRow.rows[0]?.state,
      commitment: commitment.rows[0]?.state,
    };
  });
  expect(stored.item).toBe('NO_SHOW');
  expect(stored.commitment).toBe('RELEASED');
  const residentDraft = await createDraft([{ arrival: 71, departure: 73 }]);
  const residentItem = (await detail(residentDraft.id)).items[0];
  const residentConfirm = await confirm(residentDraft.id, [
    { item_id: residentItem.id, price_snapshot_id: await quote(71, 73) },
  ]);
  expect(residentConfirm.status).toBe(200);
  await withOwner(async (client) => {
    await client.query(
      `update "reservation_item" set "state" = 'IN_HOUSE' where "id" = $1`,
      [residentItem.id],
    );
  });
  const residentAttempt = await apiRequest(
    admin.context,
    'POST',
    `${base()}/reservation-items/${residentItem.id}/no-show`,
    {
      body: {
        version: 2,
        reason: 'resident must be rejected',
      },
    },
  );
  expect(residentAttempt.status).toBe(409);
  expect(residentAttempt.body.code).toBe('INVALID_STATE_TRANSITION');
});

test('P06-03 owner stay and quantity packages confirm without special casing', async () => {
  const draft = await createDraft([
    { arrival: 73, departure: 75, quantity: 2, owner_stay: true },
  ]);
  const item = (await detail(draft.id)).items[0];
  expect(
    await withOwner(async (client) => {
      const row = await client.query(
        `select "owner_stay" from "reservation_item" where "id" = $1`,
        [item.id],
      );
      return row.rows[0]?.owner_stay;
    }),
  ).toBe(true);
  const confirmed = await confirm(draft.id, [
    { item_id: item.id, price_snapshot_id: await quote(73, 75, 2, 2) },
  ]);
  expect(confirmed.status).toBe(200);
  const allocations = await withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "plan_allocation"
            where "commitment_id" in (
              select "id" from "commitment" where "source_id" = $1
            ) and "state" = 'ACTIVE'`,
          [item.id],
        )
      ).rows[0].count,
    ),
  );
  expect(allocations).toBe(2);
  const after = await detail(draft.id);
  expect(after.items[0].quantity).toBe(2);
});
