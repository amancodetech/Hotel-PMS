import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
} from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
let admin;

function shift(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('SET-08 journey: setup draft -> activation gate -> apply -> activate -> first confirmed sale', async () => {
  const runId = Date.now().toString(36).slice(-6).toUpperCase();
  const code = `S8-JOURNEY-${runId}`;
  const steps = [];
  const base = `/tenants/${tenantA}/properties`;

  const created = await apiRequest(admin.context, 'POST', base, {
    body: { code, name: 'Journey Inn', timezone: 'Asia/Jakarta' },
  });
  expect(created.status).toBe(201);
  expect(created.body.property.status).toBe('SETUP');
  const propertyId = created.body.property.id;
  const version = created.body.property.version;
  steps.push({ step: 'property_created', property_id: propertyId });

  const incomplete = await apiRequest(
    admin.context,
    'PUT',
    `${base}/${propertyId}/setup-draft`,
    {
      body: {
        property: {
          name: 'Journey Inn',
          code,
          country: 'Indonesia',
          timezone: 'Asia/Jakarta',
          base_currency: 'IDR',
          types: ['ROOM'],
        },
        unit_groups: [],
        operations: {
          check_in: '14:00',
          check_out: '12:00',
          inspection_required: false,
          explicit_states: true,
        },
        pricing: { postponed: true },
      },
      headers: { 'idempotency-key': `journey-incomplete-${runId}` },
    },
  );
  expect(incomplete.status).toBe(200);
  expect(incomplete.body.draft.completed).toBe(false);

  const blocked = await apiRequest(
    admin.context,
    'PATCH',
    `${base}/${propertyId}`,
    { body: { version, status: 'ACTIVE' } },
  );
  expect(blocked.status).toBe(422);
  expect(blocked.body.code).toBe('SETUP_READINESS_BLOCKED');
  expect(
    blocked.body.details.issues.some(
      (issue) => issue.code === 'units_required',
    ),
  ).toBe(true);
  steps.push({ step: 'activation_blocked', code: blocked.body.code });

  const sellFrom = shift(0);
  const sellTo = shift(7);
  const currentDraft = await apiRequest(
    admin.context,
    'GET',
    `${base}/${propertyId}/setup-draft`,
  );
  expect(currentDraft.status).toBe(200);
  const complete = await apiRequest(
    admin.context,
    'PUT',
    `${base}/${propertyId}/setup-draft`,
    {
      body: {
        property: {
          name: 'Journey Inn',
          code,
          country: 'Indonesia',
          timezone: 'Asia/Jakarta',
          base_currency: 'IDR',
          types: ['ROOM'],
        },
        unit_groups: [
          {
            id: 'g1',
            template_code: 'ROOM',
            pattern: '101-104',
            exclusions: [],
            capacity: 2,
            rental_mode: 'EXCLUSIVE',
            guaranteed_specs: [],
            parts: [],
            connected_codes: [],
          },
        ],
        operations: {
          check_in: '14:00',
          check_out: '12:00',
          inspection_required: false,
          explicit_states: true,
        },
        pricing: {
          postponed: false,
          plan_name: 'Journey flexible',
          sell_from: sellFrom,
          sell_to: sellTo,
          base_price: '1500000',
        },
      },
      headers: {
        'idempotency-key': `journey-complete-${runId}`,
        'if-match': `"${currentDraft.body.draft.draft_id}:${currentDraft.body.draft.revision}"`,
      },
    },
  );
  expect(complete.status).toBe(200);
  expect(complete.body.draft.completed).toBe(false);

  const preview = await apiRequest(
    admin.context,
    'POST',
    `${base}/${propertyId}/setup-draft/preview`,
  );
  expect(preview.status).toBe(200);
  expect(preview.body.blockers).toEqual([]);

  const etag = `"${complete.body.draft.draft_id}:${complete.body.draft.revision}"`;
  const apply = await apiRequest(
    admin.context,
    'POST',
    `${base}/${propertyId}/setup-draft/apply`,
    {
      body: { preview_version: preview.body.preview_version },
      headers: {
        'idempotency-key': `journey-apply-${runId}`,
        'if-match': etag,
      },
    },
  );
  expect(apply.status).toBe(200);
  expect(apply.body.result.created_units).toBe(4);
  steps.push({
    step: 'setup_applied',
    units: apply.body.result.created_units,
    rate_plan: apply.body.result.created_rate_plan !== null,
  });

  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `${base}/${propertyId}`,
    {
      body: {
        version: (
          await apiRequest(admin.context, 'GET', `${base}/${propertyId}`)
        ).body.property.version,
        status: 'ACTIVE',
      },
    },
  );
  expect(activated.status).toBe(200);
  expect(activated.body.property.status).toBe('ACTIVE');
  steps.push({ step: 'property_activated' });

  const products = await apiRequest(
    admin.context,
    'GET',
    `${base}/${propertyId}/products`,
  );
  expect(products.status).toBe(200);
  const product = products.body.items.find((item) => item.status === 'ACTIVE');
  expect(product).toBeTruthy();
  const ratePlanId = apply.body.result.created_rate_plan;
  expect(ratePlanId).toBeTruthy();
  const plans = await apiRequest(
    admin.context,
    'GET',
    `${base}/${propertyId}/rate-plans`,
  );
  expect(plans.status).toBe(200);
  const plan = plans.body.items.find((item) => item.id === ratePlanId);
  expect(plan).toBeTruthy();
  expect(plan.status).toBe('DRAFT');
  const planActivated = await apiRequest(
    admin.context,
    'PATCH',
    `${base}/${propertyId}/rate-plans/${ratePlanId}`,
    { body: { version: plan.version, status: 'ACTIVE' } },
  );
  expect(planActivated.status).toBe(200);
  steps.push({ step: 'rate_plan_activated_after_setup' });

  const arrival = shift(0);
  const departure = shift(2);
  const inventory = await apiRequest(
    admin.context,
    'GET',
    `${base}/${propertyId}/rates?from=${shift(0)}&to=${shift(8)}`,
  );
  expect(inventory.status).toBe(200);

  const quote = await apiRequest(
    admin.context,
    'POST',
    `${base}/${propertyId}/quotes`,
    {
      body: {
        product_id: product.id,
        rate_plan_id: ratePlanId,
        period: { arrival, departure },
        occupancy: { adults: 1, child_ages: [] },
        quantity: 1,
      },
    },
  );
  expect(quote.status).toBe(201);
  steps.push({ step: 'quote_created' });

  const draft = await apiRequest(
    admin.context,
    'POST',
    `${base}/${propertyId}/reservations/drafts`,
    {
      body: {
        source: 'DIRECT',
        items: [
          {
            product_id: product.id,
            period: { arrival, departure },
            occupancy: { adults: 1, child_ages: [] },
            quantity: 1,
          },
        ],
      },
    },
  );
  expect(draft.status).toBe(201);
  const detail = await apiRequest(
    admin.context,
    'GET',
    `${base}/${propertyId}/reservations/${draft.body.reservation.id}`,
  );
  expect(detail.status).toBe(200);
  const itemId = detail.body.items[0].id;

  const confirmed = await apiRequest(
    admin.context,
    'POST',
    `${base}/${propertyId}/reservations`,
    {
      body: {
        reservation_id: draft.body.reservation.id,
        inventory_version: inventory.body.inventory_version,
        items: [{ item_id: itemId, price_snapshot_id: quote.body.quote.id }],
      },
    },
  );
  expect(confirmed.status).toBe(200);
  steps.push({ step: 'reservation_confirmed' });

  const resources = await apiRequest(
    admin.context,
    'GET',
    `${base}/${propertyId}/resources?limit=100`,
  );
  expect(resources.status).toBe(200);
  const room = resources.body.items.find((entry) => entry.code === '101');
  expect(room).toBeTruthy();
  const after = await apiRequest(
    admin.context,
    'GET',
    `${base}/${propertyId}/reservations/${draft.body.reservation.id}`,
  );
  const itemVersion = after.body.items[0].version;
  const checkedIn = await apiRequest(
    admin.context,
    'POST',
    `${base}/${propertyId}/reservations/${draft.body.reservation.id}/items/${itemId}/check-in`,
    {
      body: { version: itemVersion, resource_id: room.id },
      headers: { 'idempotency-key': `journey-checkin-${runId}` },
    },
  );
  expect(checkedIn.status).toBe(200);
  steps.push({ step: 'checked_in', resource: room.code });

  const evidence = {
    generated_at: new Date().toISOString(),
    property: { id: propertyId, code },
    sell_window: { from: sellFrom, to: sellTo },
    occupancy_basis: 1,
    observation:
      'setup apply prices occupancy 1 only; a 2-adult quote returns RATE_MISSING until extra rates exist',
    reservation_id: draft.body.reservation.id,
    steps,
  };
  mkdirSync('.local/verification/SET-08-4', { recursive: true, mode: 0o700 });
  writeFileSync(
    '.local/verification/SET-08-4/journey-evidence.json',
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
}, 120000);
