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
let propertyA;
let propertyB;
let productA;
let productB;

const runId = String(Date.now()).slice(-6);

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createProperty(code) {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: { code, name: `F-RVW7-04 ${code}`, timezone: 'Asia/Jakarta' },
    },
  );
  expect(created.status).toBe(201);
  const property = created.body.property;
  const product = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties/${property.id}/products`,
    {
      body: {
        code: `${code}-P`,
        name: `F-RVW7-04 ${code} product`,
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  expect(product.status).toBe(201);
  return { property, productId: product.body.product.id };
}

async function createDraft(property, productId, arrival, departure, key) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties/${property.id}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
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
      headers: key ? { 'idempotency-key': key } : {},
    },
  );
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
  const a = await createProperty(`P07-I04-A-${runId}`);
  propertyA = a.property;
  productA = a.productId;
  const b = await createProperty(`P07-I04-B-${runId}`);
  propertyB = b.property;
  productB = b.productId;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('F-RVW7-04 the same idempotency key is scoped per property and never leaks a response', async () => {
  const key = `p07-f04-${runId}-shared`;
  const first = await createDraft(propertyA, productA, 1, 3, key);
  expect(first.status).toBe(201);
  const second = await createDraft(propertyB, productB, 1, 3, key);
  expect(second.status).toBe(201);
  expect(second.body.reservation.id).not.toBe(first.body.reservation.id);

  const replayA = await createDraft(propertyA, productA, 1, 3, key);
  expect(replayA.status).toBe(201);
  expect(replayA.body.replayed).toBe(true);
  expect(replayA.body.reservation.id).toBe(first.body.reservation.id);
  const replayB = await createDraft(propertyB, productB, 1, 3, key);
  expect(replayB.status).toBe(201);
  expect(replayB.body.replayed).toBe(true);
  expect(replayB.body.reservation.id).toBe(second.body.reservation.id);

  const stored = await withOwner(async (client) => {
    const result = await client.query(
      `select "property_id",
              "response_safe"->'reservation'->>'id' as "reservation_id"
         from "api_idempotency"
        where "tenant_id" = $1 and "operation" = 'CreateReservationDraft'
          and "key" = $2
        order by "property_id"`,
      [tenant, key],
    );
    return result.rows;
  });
  expect(stored).toHaveLength(2);
  const byProperty = new Map(
    stored.map((row) => [row.property_id, row.reservation_id]),
  );
  expect(byProperty.get(propertyA.id)).toBe(first.body.reservation.id);
  expect(byProperty.get(propertyB.id)).toBe(second.body.reservation.id);

  const conflicting = await createDraft(propertyA, productA, 4, 6, key);
  expect(conflicting.status).toBe(409);
  expect(conflicting.body.code).toBe('CONFLICT');
  expect(conflicting.body.details.reason).toBe('idempotency_key_reused');

  const otherTenantRows = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "reservation"
        where "id" = any($1::uuid[]) and "property_id" = $2`,
      [[first.body.reservation.id, second.body.reservation.id], propertyB.id],
    );
    return result.rows[0].count;
  });
  expect(otherTenantRows).toBe(1);
});
