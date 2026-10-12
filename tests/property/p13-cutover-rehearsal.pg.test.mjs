import { randomUUID } from 'node:crypto';
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
let villaResourceA;
let villaResourceB;
let villaProduct;
let villaRatePlan;
let partProduct;
let partRatePlan;
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
    `${base()}/rates?from=${addDays(40)}&to=${addDays(41)}`,
  );
  expect(response.status).toBe(200);
  return response.body.inventory_version;
}

async function createResource(code) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `${base()}/resources`,
    {
      body: { code, type: 'ROOM', capacity: 2 },
    },
  );
  expect(response.status).toBe(201);
  return response.body.resource.id;
}

async function createDraftProduct(code, name, kind) {
  const product = await apiRequest(
    admin.context,
    'POST',
    `${base()}/products`,
    {
      body: { code, name, kind, occupancy_adults_max: 2 },
    },
  );
  expect(product.status).toBe(201);
  return product.body.product;
}

async function activateProduct(product) {
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/products/${product.id}`,
    { body: { version: product.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  return product.id;
}

async function createRatePlan(code, name, productId) {
  const plan = await apiRequest(admin.context, 'POST', `${base()}/rate-plans`, {
    body: { code, name, product_id: productId, currency: 'IDR' },
  });
  expect(plan.status).toBe(201);
  await apiRequest(
    admin.context,
    'PATCH',
    `${base()}/rate-plans/${plan.body.rate_plan.id}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  return plan.body.rate_plan.id;
}

async function setRates(ratePlanId, days) {
  const cells = days.map((date) => ({
    rate_plan_id: ratePlanId,
    date,
    occupancy: 2,
    money: { amount: '450000', currency: 'IDR' },
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
}

async function createConnection(channelKey, externalId, productId, ratePlanId) {
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
        secret_ref: `local:hotel/p13-co-${runId}`,
      },
    },
  );
  expect(response.status).toBe(201);
  const connectionId = response.body.connection.id;
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
  return connectionId;
}

async function preview(
  connectionId,
  productId,
  arrival,
  departure,
  resourceIds,
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

async function search(productIds, arrival, departure) {
  return apiRequest(admin.context, 'POST', `${base()}/availability/search`, {
    body: {
      product_ids: productIds,
      period: { arrival, departure },
      occupancy: { adults: 2, child_ages: [] },
      quantity: 1,
    },
  });
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

async function markEvents(connectionId, status, certainty) {
  await withOwner(async (client) => {
    await client.query(
      `update "distribution_outbox_event"
          set "status" = $1, "certainty" = $2, "provider_request_id" = 'p13co-' || "id"::text,
              "updated_at" = now()
        where "connection_id" = $3 and "aggregate_type" = 'Exposure'`,
      [status, certainty, connectionId],
    );
  });
}

function csv(lines) {
  return [
    'external_key,arrival,departure,adults,quantity,product_code',
    ...lines,
  ].join('\n');
}

async function importFeed(content, mode = 'APPLY') {
  return apiRequest(admin.context, 'POST', `${base()}/imports`, {
    body: {
      mode,
      source: 'FEED',
      file_name: `p13co-${runId}.csv`,
      content_type: 'text/csv',
      content,
    },
  });
}

async function reservationCount(prefix) {
  return withOwner(async (client) =>
    Number(
      (
        await client.query(
          `select count(*)::int as "count" from "reservation"
            where "property_id" = $1 and "external_booking_key" like $2`,
          [property.id, `${prefix}%`],
        )
      ).rows[0].count,
    ),
  );
}

async function insertInboxRevision(externalKey, items) {
  const id = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "distribution_inbox_revision"
         ("id", "tenant_id", "property_id", "connection_id", "channel_key",
          "provider_key", "environment", "provider_revision_id",
          "external_booking_id", "revision_type", "payload_hash",
          "payload_safe", "source_sequence", "received_at")
       values ($1, $2, $3, $4, 'TIKET_COM', 'CHANNEX', 'STAGING', $5, $6,
               'new', $7, $8::jsonb, '1', now())`,
      [
        id,
        tenant,
        property.id,
        connectionA,
        `REV-${id.slice(0, 8)}`,
        externalKey,
        'b'.repeat(64),
        JSON.stringify({ items }),
      ],
    );
  });
  return id;
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
        code: `P13CO-${runId}`,
        name: `P13 cutover rehearsal ${runId}`,
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  villaResourceA = await createResource(`P13CO-A-${runId}`);
  villaResourceB = await createResource(`P13CO-B-${runId}`);
  const villaDraft = await createDraftProduct(
    `P13CO-VILLA-${runId}`,
    'P13 villa whole',
    'VILLA',
  );
  const composition = await apiRequest(
    admin.context,
    'POST',
    `${base()}/compositions`,
    {
      body: {
        product_id: villaDraft.id,
        effective_period: { arrival: addDays(30), departure: addDays(60) },
        resource_ids: [villaResourceA, villaResourceB],
        nested_version_ids: [],
      },
    },
  );
  expect(composition.status).toBe(201);
  const activated = await apiRequest(
    admin.context,
    'POST',
    `${base()}/compositions/${composition.body.composition.id}/activate`,
    { body: { reason: 'P13 cutover rehearsal composition' } },
  );
  expect(activated.status).toBe(200);
  villaProduct = await activateProduct(villaDraft);
  const partDraft = await createDraftProduct(
    `P13CO-PART-${runId}`,
    'P13 villa part B',
    'ROOM',
  );
  await apiRequest(
    admin.context,
    'POST',
    `${base()}/products/${partDraft.id}/candidates`,
    {
      body: { resource_id: villaResourceB },
    },
  );
  partProduct = await activateProduct(partDraft);
  villaRatePlan = await createRatePlan(
    `P13CO-VR-${runId}`,
    'P13 villa rate',
    villaProduct,
  );
  partRatePlan = await createRatePlan(
    `P13CO-PR-${runId}`,
    'P13 part rate',
    partProduct,
  );
  const dates = Array.from({ length: 25 }, (_, index) => addDays(35 + index));
  await setRates(villaRatePlan, dates);
  await setRates(partRatePlan, dates);
  connectionA = await createConnection(
    'TIKET_COM',
    `p13co-tiket-${runId}`,
    villaProduct,
    villaRatePlan,
  );
  connectionB = await createConnection(
    'BOOKING_COM',
    `p13co-booking-${runId}`,
    partProduct,
    partRatePlan,
  );
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('P13-05 cutover rehearsal: import/feed once, villa quota non-overlap, blocked withdrawal handover', async () => {
  const arrival = addDays(40);
  const departure = addDays(42);
  const externalKey = `P13CO-IMP-${runId}`;
  const content = csv([`${externalKey},${arrival},${departure},2,1,`]);

  const dry = await importFeed(content, 'DRY_RUN');
  expect(dry.status).toBe(200);
  expect(dry.body.rows_accepted).toBe(1);
  expect(await reservationCount(externalKey)).toBe(0);

  const applied = await importFeed(content, 'APPLY');
  expect(applied.status).toBe(200);
  expect(applied.body.rows_accepted).toBe(1);
  expect(await reservationCount(externalKey)).toBe(1);

  const replay = await importFeed(content, 'APPLY');
  expect(replay.body.replayed).toBe(true);
  expect(await reservationCount(externalKey)).toBe(1);

  const revisionId = await insertInboxRevision(externalKey, [
    {
      external_room_ref: 'ROOM-1',
      external_rate_ref: 'RATE-1',
      occupancy: 2,
      arrival,
      departure,
      amount: '450000',
      currency: 'IDR',
    },
  ]);
  const reprocess = await apiRequest(
    admin.context,
    'POST',
    `${base()}/inbox/${revisionId}/reprocess`,
  );
  expect(reprocess.status).toBe(200);
  expect(reprocess.body.outcome).toBe('EXCEPTION');
  expect(reprocess.body.error_code).toBe('DUPLICATE_BOOKING');
  expect(await reservationCount(externalKey)).toBe(1);
  const adopted = await withOwner(async (client) => {
    const result = await client.query(
      `select "channel_connection_id" as "connection" from "reservation"
        where "property_id" = $1 and "external_booking_key" = $2`,
      [property.id, externalKey],
    );
    return result.rows[0]?.connection ?? null;
  });
  expect(adopted).toBe(connectionA);

  const whole = await preview(connectionA, villaProduct, arrival, departure, [
    villaResourceA,
    villaResourceB,
  ]);
  expect(whole.body.allowed).toBe(true);
  const published = await publish(whole.body);
  expect(published.status).toBe(202);

  const partsBlocked = await preview(
    connectionB,
    partProduct,
    arrival,
    departure,
    [villaResourceB],
  );
  expect(partsBlocked.body.allowed).toBe(false);
  expect(partsBlocked.body.reason_codes).toContain('EXPOSURE_PROTECTED');
  const villaUnavailable = await search([villaProduct], arrival, departure);
  expect(villaUnavailable.body.offers[0].result).toBe('UNAVAILABLE');

  await markEvents(connectionA, 'SENT', 'ACCEPTED');
  const activatedWhole = await reconcile(
    connectionA,
    'P13 cutover accepted whole quota',
  );
  expect(activatedWhole.activated).toBe(1);

  const withdraw = await apiRequest(
    admin.context,
    'POST',
    `${base()}/exposures/${published.body.operation_id}/withdraw`,
    {
      body: { reason: 'P13 cutover limited release' },
    },
  );
  expect(withdraw.status).toBe(202);
  const withheld = await reconcile(
    connectionA,
    'P13 cutover withdraw before evidence',
  );
  expect(withheld.released).toBe(0);

  await markEvents(connectionA, 'SENT', 'ACCEPTED');
  const released = await reconcile(
    connectionA,
    'P13 cutover accepted withdrawal',
  );
  expect(released.released).toBe(0);
  expect(released.reconciling).toBeGreaterThan(0);

  const limitedParts = await preview(
    connectionB,
    partProduct,
    arrival,
    departure,
    [villaResourceB],
  );
  // G13-R03: limited opening remains BLOCKED_CAPABILITY without cutoff proof.
  expect(limitedParts.body.allowed).toBe(false);
  expect(limitedParts.body.reason_codes).toContain('EXPOSURE_PROTECTED');
  const partOnly = await search([partProduct], arrival, departure);
  expect(partOnly.body.offers[0].result).toBe('UNAVAILABLE');
  const wholeStillClosed = await search([villaProduct], arrival, departure);
  expect(wholeStillClosed.body.offers[0].result).toBe('UNAVAILABLE');

  const partsAwaitingEvidence = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "distribution_outbox_event"
        where "connection_id" = $1 and "status" in ('PENDING', 'RETRY_SCHEDULED', 'LEASED')`,
      [connectionB],
    );
    return result.rows[0].count;
  });
  expect(partsAwaitingEvidence).toBe(0);
});

test('P13-05 ambiguous unlinked external keys fail closed without a second reservation', async () => {
  const key = `P13CO-AMB-${runId}`;
  await withOwner(async (client) => {
    for (const suffix of ['A', 'B']) {
      await client.query(
        `insert into "reservation"
           ("tenant_id", "property_id", "source", "external_booking_key", "state")
         values ($1, $2, 'IMPORT', $3, 'INQUIRY')`,
        [tenant, property.id, `${key}-${suffix}`],
      );
    }
  });
  const sharedKey = `${key}-A`;
  const revisionId = await insertInboxRevision(sharedKey, [
    {
      external_room_ref: 'ROOM-1',
      external_rate_ref: 'RATE-1',
      occupancy: 2,
      arrival: addDays(45),
      departure: addDays(47),
    },
  ]);
  await withOwner(async (client) => {
    await client.query(
      `update "reservation" set "external_booking_key" = $1
        where "property_id" = $2 and "external_booking_key" = $3`,
      [sharedKey, property.id, `${key}-B`],
    );
  });
  const reprocess = await apiRequest(
    admin.context,
    'POST',
    `${base()}/inbox/${revisionId}/reprocess`,
  );
  expect(reprocess.status).toBe(200);
  expect(reprocess.body.outcome).toBe('EXCEPTION');
  expect(reprocess.body.error_code).toBe('EXTERNAL_KEY_AMBIGUOUS');
  expect(await reservationCount(sharedKey)).toBe(2);
  const linked = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count" from "reservation"
        where "property_id" = $1 and "external_booking_key" = $2
          and "channel_connection_id" is not null`,
      [property.id, sharedKey],
    );
    return result.rows[0].count;
  });
  expect(linked).toBe(0);
});

test('P13-05 revision-first then import marks the booking duplicate', async () => {
  const key = `P13CO-REV-${runId}`;
  const arrival = addDays(48);
  const departure = addDays(50);
  const revisionId = await insertInboxRevision(key, [
    {
      external_room_ref: 'ROOM-1',
      external_rate_ref: 'RATE-1',
      occupancy: 2,
      arrival,
      departure,
      amount: '450000',
      currency: 'IDR',
    },
  ]);
  const created = await apiRequest(
    admin.context,
    'POST',
    `${base()}/inbox/${revisionId}/reprocess`,
  );
  expect(created.status).toBe(200);
  expect(created.body.outcome).toBe('CREATED');
  expect(await reservationCount(key)).toBe(1);
  const imported = await importFeed(
    csv([`${key},${arrival},${departure},2,1,`]),
    'APPLY',
  );
  expect(imported.body.rows_duplicate).toBe(1);
  expect(imported.body.rows_accepted).toBe(0);
  expect(await reservationCount(key)).toBe(1);
});
