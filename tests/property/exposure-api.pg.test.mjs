import { test, expect, beforeAll, afterAll } from '@jest/globals';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

let tenantA;
let admin;
let owner;
let member;
let auditor;
let property;
let roomId;
let productId;
let connectionId;
let ratePlanId;

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function setRate(amount) {
  const cells = [];
  for (let offset = 1; offset <= 8; offset += 1)
    cells.push({
      rate_plan_id: ratePlanId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount, currency: 'IDR' },
    });
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rates/batch`,
    { body: { cells } },
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function currentInventoryVersion() {
  const response = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/rates?from=${addDays(1)}&to=${addDays(2)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function preview(input) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/exposures/preview`,
    { body: input },
  );
}

async function searchAvailability(arrival, departure, quantity = 1) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/availability/search`,
    {
      body: {
        product_ids: [productId],
        period: { arrival, departure },
        occupancy: { adults: 2, child_ages: [] },
        quantity,
      },
    },
  );
}

async function markExposureEventsAccepted(status = 'SENT') {
  await withOwner(async (client) => {
    await client.query(
      `update "distribution_outbox_event"
          set "status" = $1, "provider_request_id" = 'sim-' || "id"::text,
              "certainty" = 'ACCEPTED', "updated_at" = now()
        where "connection_id" = $2 and "aggregate_type" = 'Exposure'`,
      [status, connectionId],
    );
  });
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  owner = await loginAs('owner-a');
  member = await loginAs('member-a');
  auditor = await loginAs('auditor-a');
  tenantA = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'P5-EXP',
        name: 'Exposure property',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  const resource = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/resources`,
    { body: { code: 'P5-EX1', type: 'ROOM', capacity: 2 } },
  );
  roomId = resource.body.resource.id;
  const product = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products`,
    {
      body: {
        code: 'P5-EXP-P',
        name: 'Exposure product',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  productId = product.body.product.id;
  await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products/${productId}/candidates`,
    { body: { resource_id: roomId } },
  );
  await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${productId}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  const plan = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans`,
    {
      body: {
        code: 'P5-EXP-RATE',
        name: 'Exposure rate',
        product_id: productId,
        currency: 'IDR',
      },
    },
  );
  ratePlanId = plan.body.rate_plan.id;
  await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans/${ratePlanId}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  await setRate('250000');
  const connection = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections`,
    {
      body: {
        provider_key: 'CHANNEX',
        environment: 'STAGING',
        channel_key: 'BOOKING_COM',
        external_property_id: 'ext-p5-exp',
        secret_ref: 'local:hotel/p5-exp',
      },
    },
  );
  expect(connection.status).toBe(201);
  connectionId = connection.body.connection.id;
  const mapping = await apiRequest(
    admin.context,
    'PUT',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/mapping`,
    {
      body: {
        channel_key: 'BOOKING_COM',
        external_room_ref: 'ext-room-exp',
        external_rate_ref: 'ext-rate-exp',
        occupancy: 2,
        internal_product_ref: productId,
        internal_rate_ref: ratePlanId,
      },
    },
  );
  expect(mapping.status).toBe(200);
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('preview and publish protect the resource and require channel sale permission', async () => {
  const mfaDenied = await apiRequest(
    owner.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/exposures/preview`,
    {
      body: {
        connection_id: connectionId,
        product_id: productId,
        period: { arrival: addDays(1), departure: addDays(3) },
        resource_ids: [roomId],
        inventory_version: await currentInventoryVersion(),
      },
    },
  );
  expect(mfaDenied.status).toBe(403);
  expect(mfaDenied.body.code).toBe('MFA_REQUIRED');

  const forbidden = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/exposures/preview`,
    {
      body: {
        connection_id: connectionId,
        product_id: productId,
        period: { arrival: addDays(1), departure: addDays(3) },
        resource_ids: [roomId],
        inventory_version: await currentInventoryVersion(),
      },
    },
  );
  expect(forbidden.status).toBe(403);

  const previewResponse = await preview({
    connection_id: connectionId,
    product_id: productId,
    period: { arrival: addDays(1), departure: addDays(3) },
    resource_ids: [roomId],
    inventory_version: await currentInventoryVersion(),
  });
  expect(previewResponse.status).toBe(200);
  expect(previewResponse.body.allowed).toBe(true);
  expect(previewResponse.body.reason_codes).toEqual([]);

  const publish = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/exposures`,
    {
      body: {
        preview_id: previewResponse.body.preview_id,
        preview_version: previewResponse.body.preview_version,
      },
    },
  );
  expect(publish.status).toBe(202);
  expect(publish.body.state).toBe('PUBLISHING');
  const exposureId = publish.body.operation_id;

  const allocationCount = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "exposure_allocation"
        where "exposure_id" = $1 and "state" = 'RESERVED'`,
      [exposureId],
    );
    return result.rows[0].count;
  });
  expect(allocationCount).toBe(1);

  const blocked = await searchAvailability(addDays(1), addDays(3), 1);
  expect(blocked.body.offers[0].result).toBe('UNAVAILABLE');
  expect(blocked.body.offers[0].reason_codes).toContain('EXPOSURE_PROTECTED');
});

test('stale and expired previews are rejected, and incomplete mapping is reported', async () => {
  const staleVersion = await preview({
    connection_id: connectionId,
    product_id: productId,
    period: { arrival: addDays(4), departure: addDays(5) },
    resource_ids: [roomId],
    inventory_version: 1,
  });
  expect(staleVersion.status).toBe(412);
  expect(staleVersion.body.code).toBe('PREVIEW_STALE');

  const fresh = await preview({
    connection_id: connectionId,
    product_id: productId,
    period: { arrival: addDays(4), departure: addDays(5) },
    resource_ids: [roomId],
    inventory_version: await currentInventoryVersion(),
  });
  expect(fresh.body.allowed).toBe(true);
  await withOwner(async (client) => {
    await client.query(
      `update "exposure_preview" set "expires_at" = now() - interval '1 minute' where "id" = $1`,
      [fresh.body.preview_id],
    );
  });
  const expired = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/exposures`,
    {
      body: {
        preview_id: fresh.body.preview_id,
        preview_version: fresh.body.preview_version,
      },
    },
  );
  expect(expired.status).toBe(412);
  expect(expired.body.code).toBe('PREVIEW_STALE');

  const product = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products`,
    {
      body: {
        code: 'P5-NOMAP',
        name: 'No mapping product',
        kind: 'ROOM',
        occupancy_adults_max: 2,
      },
    },
  );
  await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.body.product.id}/candidates`,
    { body: { resource_id: roomId } },
  );
  const activatedProduct = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.body.product.id}`,
    { body: { version: product.body.product.version, status: 'ACTIVE' } },
  );
  expect(activatedProduct.status).toBe(200);
  const noMapping = await preview({
    connection_id: connectionId,
    product_id: product.body.product.id,
    period: { arrival: addDays(6), departure: addDays(7) },
    resource_ids: [roomId],
    inventory_version: await currentInventoryVersion(),
  });
  expect(noMapping.status).toBe(200);
  expect(noMapping.body.allowed).toBe(false);
  expect(noMapping.body.reason_codes).toContain('MAPPING_INCOMPLETE');
});

test('fractional IDR is rejected without silent rounding', async () => {
  await setRate('250000.555');
  const previewResponse = await preview({
    connection_id: connectionId,
    product_id: productId,
    period: { arrival: addDays(6), departure: addDays(7) },
    resource_ids: [roomId],
    inventory_version: await currentInventoryVersion(),
  });
  expect(previewResponse.status).toBe(200);
  expect(previewResponse.body.allowed).toBe(false);
  expect(previewResponse.body.reason_codes).toContain('FRACTION_NOT_SUPPORTED');
  await setRate('250000');
});

test('withdrawal keeps resources protected after provider acceptance without cutoff proof', async () => {
  const arrivals = addDays(1);
  const departures = addDays(3);
  const exposures = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/exposures`,
  );
  expect(exposures.status).toBe(200);
  const active = exposures.body.items.find(
    (item) =>
      item.state === 'PUBLISHING' &&
      item.start_date === arrivals &&
      item.end_date === departures,
  );
  expect(active).toBeTruthy();
  const exposureId = active.id;

  const sync = await apiRequest(
    auditor.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/sync?attempts=true`,
  );
  expect(sync.status).toBe(200);
  expect(sync.body.state).toBe('QUEUED');
  expect(sync.body.provider_accepted_version).toBeNull();

  const withdraw = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/exposures/${exposureId}/withdraw`,
    { body: { reason: 'Sold privately' } },
  );
  expect(withdraw.status).toBe(202);
  expect(withdraw.body.state).toBe('WITHDRAWING');

  const protectedAfterWithdraw = await searchAvailability(
    arrivals,
    departures,
    1,
  );
  expect(protectedAfterWithdraw.body.offers[0].result).toBe('UNAVAILABLE');

  const reconcileWithoutEvidence = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/reconcile`,
    { body: { reason: 'Check evidence' } },
  );
  expect(reconcileWithoutEvidence.status).toBe(200);
  expect(reconcileWithoutEvidence.body.released).toBe(0);

  const stillWithdrawing = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/exposures`,
  );
  expect(
    stillWithdrawing.body.items.find((item) => item.id === exposureId).state,
  ).toBe('WITHDRAWING');

  const stillProtected = await searchAvailability(arrivals, departures, 1);
  expect(stillProtected.body.offers[0].result).toBe('UNAVAILABLE');

  await markExposureEventsAccepted();
  const reconcile = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/reconcile`,
    { body: { reason: 'Provider accepted zeros' } },
  );
  expect(reconcile.status).toBe(200);
  expect(reconcile.body.released).toBe(0);
  expect(reconcile.body.reconciling).toBeGreaterThan(0);

  const released = await searchAvailability(arrivals, departures, 1);
  expect(released.body.offers[0].result).toBe('UNAVAILABLE');
});

test('sale status opens only one reason and stays closed while a hold exists', async () => {
  const arrival = addDays(4);
  const departure = addDays(5);
  const stopSell = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/sale-status`,
    {
      body: {
        action: 'STOP_SELL',
        product_id: productId,
        period: { arrival, departure },
        reason: 'Maintenance window',
      },
    },
  );
  expect(stopSell.status).toBe(200);
  expect(stopSell.body.effective_open).toBe(false);
  expect(stopSell.body.reason_codes).toContain('STOP_SELL');

  const secondStop = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/sale-status`,
    {
      body: {
        action: 'STOP_SELL',
        product_id: productId,
        period: { arrival, departure },
        reason: 'Second reason',
      },
    },
  );
  expect(secondStop.status).toBe(200);

  const openedFirst = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/sale-status`,
    {
      body: {
        action: 'OPEN',
        restriction_id: stopSell.body.operation_id,
        reason: 'First reason cleared',
      },
    },
  );
  expect(openedFirst.status).toBe(200);
  expect(openedFirst.body.effective_open).toBe(false);
  expect(openedFirst.body.reason_codes).toContain('STOP_SELL');

  const hold = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/holds`,
    {
      body: {
        items: [
          {
            product_id: productId,
            period: { arrival, departure },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
        inventory_version: await currentInventoryVersion(),
        ttl_seconds: 300,
      },
    },
  );
  expect(hold.status).toBe(201);

  const openedSecond = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/sale-status`,
    {
      body: {
        action: 'OPEN',
        restriction_id: secondStop.body.operation_id,
        reason: 'Second reason cleared',
      },
    },
  );
  expect(openedSecond.status).toBe(200);
  expect(openedSecond.body.effective_open).toBe(false);
  expect(openedSecond.body.reason_codes).toContain('COMMITTED');

  await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/holds/${hold.body.hold.id}/release`,
  );
  const reopened = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/connections/${connectionId}/sale-status`,
    {
      body: {
        action: 'OPEN',
        restriction_id: stopSell.body.operation_id,
        reason: 'Already opened probe',
      },
    },
  );
  expect(reopened.status).toBe(409);
});
