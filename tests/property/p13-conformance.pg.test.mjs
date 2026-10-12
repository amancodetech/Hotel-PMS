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
let roomId;
let productId;
let ratePlanId;
let connectionA;
let connectionB;

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
    `${base()}/rates?from=${addDays(1)}&to=${addDays(2)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function setRates(days) {
  const cells = days.map((date) => ({
    rate_plan_id: ratePlanId,
    date,
    occupancy: 2,
    money: { amount: '275000', currency: 'IDR' },
  }));
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/rates/batch`,
    {
      body: { cells },
    },
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function preview(
  connectionId,
  arrival,
  departure,
  resourceIds = [roomId],
) {
  return apiRequest(admin.context, 'POST', `${base()}/exposures/preview`, {
    body: {
      connection_id: connectionId,
      product_id: productId,
      period: { arrival, departure },
      resource_ids: resourceIds,
      inventory_version: await currentInventoryVersion(),
    },
  });
}

async function publish(previewBody) {
  return apiRequest(admin.context, 'POST', `${base()}/exposures`, {
    body: {
      preview_id: previewBody.preview_id,
      preview_version: previewBody.preview_version,
    },
  });
}

async function sync(connectionId) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/connections/${connectionId}/sync?attempts=true`,
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function reconcile(connectionId, reason) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections/${connectionId}/reconcile`,
    { body: { reason } },
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function markExposureEvents(connectionId, status, certainty) {
  await withOwner(async (client) => {
    await client.query(
      `update "distribution_outbox_event"
          set "status" = $1, "certainty" = $2, "provider_request_id" = 'p13-' || "id"::text,
              "updated_at" = now()
        where "connection_id" = $3 and "aggregate_type" = 'Exposure'`,
      [status, certainty, connectionId],
    );
  });
}

async function exposureEvents(connectionId) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select "id", "aggregate_type", "aggregate_id", "event_type",
              "event_version", "status", "certainty", "inventory_version",
              "payload_safe", "created_at", "updated_at"
         from "distribution_outbox_event"
        where "connection_id" = $1
        order by "created_at", "id"`,
      [connectionId],
    );
    return result.rows;
  });
}

async function availableEventsWithin(connectionId, fromIso) {
  return withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count"
         from "distribution_outbox_event"
        where "connection_id" = $1
          and "event_type" = 'AvailabilitySnapshot'
          and "created_at" > $2`,
      [connectionId, fromIso],
    );
    return result.rows[0].count;
  });
}

async function registeredExposure(state, arrival, departure, connectionId) {
  const response = await apiRequest(
    admin.context,
    'GET',
    `${base()}/exposures`,
  );
  expect(response.status).toBe(200);
  return response.body.items.find(
    (item) =>
      item.state === state &&
      item.start_date === arrival &&
      item.end_date === departure &&
      (!connectionId || item.connection_id === connectionId),
  );
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
        code: `P13C-${runId}`,
        name: `P13 conformance ${runId}`,
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
      body: { code: `P13C-R-${runId}`, type: 'ROOM', capacity: 2 },
    },
  );
  roomId = resource.body.resource.id;
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: {
        code: `P13C-P-${runId}`,
        name: 'P13 conformance room',
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
    {
      body: { resource_id: roomId },
    },
  );
  await apiRequest(admin.context, 'PATCH', `${base()}/products/${productId}`, {
    body: { version: product.body.product.version, status: 'ACTIVE' },
  });
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: {
      code: `P13C-RATE-${runId}`,
      name: 'P13 conformance rate',
      product_id: productId,
      currency: 'IDR',
    },
  });
  ratePlanId = plan.body.rate_plan.id;
  await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/rate-plans/${ratePlanId}`,
    {
      body: { version: plan.body.rate_plan.version, status: 'ACTIVE' },
    },
  );
  await setRates(Array.from({ length: 9 }, (_, index) => addDays(index + 1)));

  const createConnection = async (channelKey, externalId) => {
    const response = await apiRequest(
      admin.context,
      'POST',
      `${base()}/connections`,
      {
        body: {
          provider_key: 'CHANNEX',
          environment: 'STAGING',
          channel_key: channelKey,
          external_property_id: externalId,
          secret_ref: `local:hotel/p13-${runId}`,
        },
      },
    );
    expect(response.status).toBe(201);
    return response.body.connection.id;
  };
  connectionA = await createConnection('TIKET_COM', `p13-tiket-${runId}`);
  connectionB = await createConnection('BOOKING_COM', `p13-booking-${runId}`);
  for (const [connectionId, channelKey] of [
    [connectionA, 'TIKET_COM'],
    [connectionB, 'BOOKING_COM'],
  ]) {
    const mapping = await apiRequest(
      admin.context,
      'PUT',
      `${base()}/connections/${connectionId}/mapping`,
      {
        body: {
          channel_key: channelKey,
          external_room_ref: `ext-room-${connectionId.slice(0, 8)}`,
          external_rate_ref: `ext-rate-${connectionId.slice(0, 8)}`,
          occupancy: 2,
          internal_product_ref: productId,
          internal_rate_ref: ratePlanId,
        },
      },
    );
    expect(mapping.status).toBe(200);
  }
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('P13 AT-C07 D-20 quota stays exclusive after accepted withdrawal without cutoff proof', async () => {
  const arrival = addDays(1);
  const departure = addDays(3);
  const first = await preview(connectionA, arrival, departure);
  expect(first.body.allowed).toBe(true);
  const published = await publish(first.body);
  expect(published.status).toBe(202);

  const secondChannel = await preview(connectionB, arrival, departure);
  expect(secondChannel.body.allowed).toBe(false);
  expect(secondChannel.body.reason_codes).toContain('EXPOSURE_PROTECTED');

  await markExposureEvents(connectionA, 'SENT', 'ACCEPTED');
  const activated = await reconcile(
    connectionA,
    'P13 accepted provider evidence',
  );
  expect(activated.activated).toBe(1);
  const providerAccepted = await sync(connectionA);
  expect(providerAccepted.state).not.toBe('CHANNEL_VERIFIED');
  expect(providerAccepted.state).not.toBe('UNKNOWN');
  expect(providerAccepted.provider_accepted_version).not.toBeNull();
  expect(providerAccepted.channel_verified_version).toBeNull();

  const stillBlocked = await preview(connectionB, arrival, departure);
  expect(stillBlocked.body.allowed).toBe(false);
  expect(stillBlocked.body.reason_codes).toContain('EXPOSURE_PROTECTED');

  const exposure = await registeredExposure(
    'ACTIVE',
    arrival,
    departure,
    connectionA,
  );
  expect(exposure).toBeTruthy();
  const withdraw = await apiRequest(
    admin.context,
    'POST',
    `${base()}/exposures/${exposure.id}/withdraw`,
    { body: { reason: 'P13 conformance release' } },
  );
  expect(withdraw.status).toBe(202);

  const withdrawalEvents = await exposureEvents(connectionA);
  const publishRestriction = withdrawalEvents.find(
    (event) =>
      event.event_type === 'RestrictionSnapshot' &&
      event.payload_safe.cells?.some((cell) => cell.date === arrival) &&
      event.payload_safe.cells.some((cell) => cell.stop_sell === false),
  );
  const withdrawalStop = withdrawalEvents.find(
    (event) =>
      event.event_type === 'RestrictionSnapshot' &&
      event.status === 'PENDING' &&
      event.payload_safe.cells?.some(
        (cell) => cell.date === arrival && cell.stop_sell === true,
      ),
  );
  expect(withdrawalStop).toBeTruthy();
  expect(withdrawalStop.event_version).toBeGreaterThan(
    publishRestriction.event_version,
  );

  const withheld = await reconcile(
    connectionA,
    'P13 withdraw without accepted evidence',
  );
  expect(withheld.released).toBe(0);
  const afterWithheld = await preview(connectionB, arrival, departure);
  expect(afterWithheld.body.allowed).toBe(false);
  expect(afterWithheld.body.reason_codes).toContain('EXPOSURE_PROTECTED');

  await markExposureEvents(connectionA, 'SENT', 'ACCEPTED');
  const released = await reconcile(
    connectionA,
    'P13 reconcile accepted withdrawal',
  );
  expect(released.released).toBe(0);
  expect(released.reconciling).toBeGreaterThan(0);
  const afterRelease = (await exposureEvents(connectionA)).find(
    (event) => event.id === withdrawalStop.id,
  );
  expect(afterRelease.status).toBe('SENT');

  const handedOver = await preview(connectionB, arrival, departure);
  // G13-R03 supersedes the historical acceptance-only handover expectation.
  expect(handedOver.body.allowed).toBe(false);
  expect(handedOver.body.reason_codes).toContain('EXPOSURE_PROTECTED');
  const allocation = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "exposure_allocation"
        where "exposure_id" = $1 and "state" = 'RESERVED'`,
      [published.body.operation_id],
    );
    return result.rows[0].count;
  });
  expect(allocation).toBe(1);
});

test('P13 readback and proof separate provider acceptance from channel verification', async () => {
  const arrival = addDays(3);
  const departure = addDays(5);
  const previewResponse = await preview(connectionA, arrival, departure);
  expect(previewResponse.body.allowed).toBe(true);
  const published = await publish(previewResponse.body);
  expect(published.status).toBe(202);

  const queued = await sync(connectionA);
  expect(queued.state).toBe('QUEUED');
  expect(queued.pending).toBeGreaterThan(0);
  expect(queued.channel_verified_version).toBeNull();

  await markExposureEvents(connectionA, 'UNKNOWN', 'UNKNOWN');
  const unknownReconcile = await reconcile(
    connectionA,
    'P13 unknown transport',
  );
  expect(unknownReconcile.activated).toBe(0);
  const unknownState = await sync(connectionA);
  expect(unknownState.state).toBe('UNKNOWN');
  expect(unknownState.state).not.toBe('CHANNEL_VERIFIED');

  const pending = await registeredExposure(
    'UNKNOWN',
    arrival,
    departure,
    connectionA,
  );
  expect(pending).toBeTruthy();

  await markExposureEvents(connectionA, 'SENT', 'ACCEPTED');
  const acceptedState = await sync(connectionA);
  expect(acceptedState.state).not.toBe('CHANNEL_VERIFIED');
  expect(acceptedState.provider_accepted_version).not.toBeNull();
  expect(acceptedState.channel_verified_version).toBeNull();
  expect(
    acceptedState.attempts.every(
      (attempt) => attempt.certainty !== 'CHANNEL_VERIFIED',
    ),
  ).toBe(true);

  await markExposureEvents(connectionA, 'CHANNEL_VERIFIED', 'CHANNEL_VERIFIED');
  const verifiedState = await sync(connectionA);
  expect(verifiedState.state).toBe('CHANNEL_VERIFIED');
  expect(verifiedState.channel_verified_version).toBe(
    verifiedState.desired_version,
  );

  const accepted = await reconcile(connectionA, 'P13 provider accepted');
  expect(accepted.activated).toBe(1);
  const activeExposure = await registeredExposure(
    'ACTIVE',
    arrival,
    departure,
    connectionA,
  );
  expect(activeExposure).toBeTruthy();
});

test('P13 AT-C09 restore/recovery keeps increases frozen until accepted reconciliation', async () => {
  const arrival = addDays(5);
  const departure = addDays(7);
  const previewResponse = await preview(connectionA, arrival, departure);
  expect(previewResponse.body.allowed).toBe(true);
  const published = await publish(previewResponse.body);
  expect(published.status).toBe(202);

  const events = await exposureEvents(connectionA);
  const availability = events
    .filter(
      (event) =>
        event.event_type === 'AvailabilitySnapshot' &&
        event.status === 'PENDING' &&
        event.payload_safe.cells?.some((cell) => cell.date === arrival),
    )
    .at(-1);
  expect(availability).toBeTruthy();
  expect(availability.payload_safe.cells[0].available).toBe(1);

  const stop = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections/${connectionA}/sale-status`,
    {
      body: {
        action: 'STOP_SELL',
        product_id: productId,
        period: { arrival, departure },
        reason: 'P13 recovery freeze',
      },
    },
  );
  expect(stop.status).toBe(200);
  expect(stop.body.effective_open).toBe(false);
  expect(stop.body.reason_codes).toContain('STOP_SELL');
  const freezeAt = new Date().toISOString();

  const stopEvents = await exposureEvents(connectionA);
  const stopSnapshot = stopEvents.find(
    (event) =>
      event.event_type === 'RestrictionSnapshot' &&
      event.status === 'PENDING' &&
      event.payload_safe.cells?.some(
        (cell) => cell.date === arrival && cell.stop_sell === true,
      ),
  );
  expect(stopSnapshot).toBeTruthy();

  const increasesAfterFreeze = await availableEventsWithin(
    connectionA,
    freezeAt,
  );
  expect(increasesAfterFreeze).toBe(0);

  await markExposureEvents(connectionA, 'UNKNOWN', 'UNKNOWN');
  const withheld = await reconcile(
    connectionA,
    'P13 restore without accepted evidence',
  );
  expect(withheld.activated).toBe(0);
  const frozenState = await sync(connectionA);
  expect(frozenState.state).not.toBe('CHANNEL_VERIFIED');
  expect(frozenState.unknown).toBeGreaterThan(0);
  const stillPublishing = await registeredExposure(
    'UNKNOWN',
    arrival,
    departure,
    connectionA,
  );
  expect(stillPublishing).toBeTruthy();

  await markExposureEvents(connectionA, 'SENT', 'ACCEPTED');
  const activated = await reconcile(
    connectionA,
    'P13 reconcile accepted after recovery',
  );
  expect(activated.activated).toBe(1);
  const recoveredState = await sync(connectionA);
  expect(recoveredState.state).not.toBe('CHANNEL_VERIFIED');
  expect(recoveredState.provider_accepted_version).not.toBeNull();
  const activeExposure = await registeredExposure(
    'ACTIVE',
    arrival,
    departure,
    connectionA,
  );
  expect(activeExposure).toBeTruthy();

  const openAttempt = await apiRequest(
    admin.context,
    'POST',
    `${base()}/connections/${connectionA}/sale-status`,
    {
      body: {
        action: 'OPEN',
        restriction_id: stop.body.operation_id,
        reason: 'P13 explicit open attempt',
      },
    },
  );
  expect(openAttempt.status).toBe(200);
  expect(openAttempt.body.effective_open).toBe(false);
  expect(openAttempt.body.reason_codes.length).toBeGreaterThan(0);
  const openEvents = await exposureEvents(connectionA);
  const openSnapshot = openEvents.find(
    (event) =>
      event.event_type === 'RestrictionSnapshot' &&
      event.status === 'PENDING' &&
      event.payload_safe.cells?.some(
        (cell) => cell.date === arrival && cell.stop_sell === false,
      ),
  );
  expect(openSnapshot).toBeTruthy();
  const increasesAfterOpenAttempt = await availableEventsWithin(
    connectionA,
    freezeAt,
  );
  expect(increasesAfterOpenAttempt).toBe(0);
});
