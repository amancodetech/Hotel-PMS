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
let member;
let auditor;
let property;
let roomOne;
let roomTwo;
let roomThree;
let productOne;
let productTwo;
let ratePlanId;

function addDays(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function search(productIds, arrival, departure, quantity = 1) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/availability/search`,
    {
      body: {
        product_ids: productIds,
        period: { arrival, departure },
        occupancy: { adults: 2, child_ages: [] },
        quantity,
      },
    },
  );
}

async function createProduct(code, kind = 'ROOM') {
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products`,
    {
      body: {
        code,
        name: `Product ${code}`,
        kind,
        occupancy_adults_max: 2,
      },
    },
  );
  expect(created.status).toBe(201);
  return created.body.product;
}

async function addCandidate(productId, resourceId) {
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/products/${productId}/candidates`,
    { body: { resource_id: resourceId } },
  );
  expect(response.status).toBe(201);
}

async function activateProduct(product) {
  const response = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/products/${product.id}`,
    { body: { version: product.version, status: 'ACTIVE' } },
  );
  expect(response.status).toBe(200);
  return response.body.product;
}

async function createHold(itemProductId, arrival, departure, ttl = 300) {
  const inventory = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/rates?from=${arrival}&to=${departure}`,
  );
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/holds`,
    {
      body: {
        items: [
          {
            product_id: itemProductId,
            period: { arrival, departure },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
        inventory_version: inventory.body.inventory_version,
        ttl_seconds: ttl,
      },
    },
  );
  return response;
}

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  member = await loginAs('member-a');
  auditor = await loginAs('auditor-a');
  tenantA = admin.session.body.session.active_tenant_id;
  const created = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties`,
    {
      body: {
        code: 'P5-INV',
        name: 'Inventory property',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(created.status).toBe(201);
  property = created.body.property;
  const resources = [];
  for (const code of ['P5-R1', 'P5-R2', 'P5-R3']) {
    const resource = await apiRequest(
      admin.context,
      'POST',
      `/tenants/${tenantA}/properties/${property.id}/resources`,
      { body: { code, type: 'ROOM', capacity: 2 } },
    );
    expect(resource.status).toBe(201);
    resources.push(resource.body.resource.id);
  }
  [roomOne, roomTwo, roomThree] = resources;
  let product = await createProduct('P5-P1');
  await addCandidate(product.id, roomOne);
  await addCandidate(product.id, roomTwo);
  product = await activateProduct(product);
  productOne = product;
  product = await createProduct('P5-P2');
  await addCandidate(product.id, roomThree);
  product = await activateProduct(product);
  productTwo = product;
  const plan = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans`,
    {
      body: {
        code: 'P5-RATE1',
        name: 'Inventory rate',
        product_id: productOne.id,
        currency: 'IDR',
      },
    },
  );
  expect(plan.status).toBe(201);
  ratePlanId = plan.body.rate_plan.id;
  const activated = await apiRequest(
    admin.context,
    'PATCH',
    `/tenants/${tenantA}/properties/${property.id}/rate-plans/${ratePlanId}`,
    { body: { version: plan.body.rate_plan.version, status: 'ACTIVE' } },
  );
  expect(activated.status).toBe(200);
  const cells = [];
  for (let offset = 1; offset <= 6; offset += 1)
    cells.push({
      rate_plan_id: ratePlanId,
      date: addDays(offset),
      occupancy: 2,
      money: { amount: '250000', currency: 'IDR' },
    });
  const rates = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/rates/batch`,
    { body: { cells } },
  );
  expect(rates.status).toBe(200);
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('quote freezes nightly prices and requires an active rate plan', async () => {
  const quote = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/quotes`,
    {
      body: {
        product_id: productOne.id,
        period: { arrival: addDays(1), departure: addDays(3) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 2,
      },
    },
  );
  expect(quote.status).toBe(201);
  expect(quote.body.quote.total_money.amount).toBe('1000000');
  expect(quote.body.quote.total_money.currency).toBe('IDR');
  expect(quote.body.quote.cells).toHaveLength(2);
  expect(quote.body.quote.cells[0].line_total).toBe('500000');

  const missing = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/quotes`,
    {
      body: {
        product_id: productTwo.id,
        period: { arrival: addDays(1), departure: addDays(2) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    },
  );
  expect(missing.status).toBe(422);
  expect(missing.body.code).toBe('RATE_INCOMPLETE');
});

test('search respects quantity, scope and read permission', async () => {
  const available = await search([productOne.id], addDays(1), addDays(2), 2);
  expect(available.status).toBe(200);
  expect(available.body.guaranteed).toBe(false);
  expect(available.body.offers[0].result).toBe('AVAILABLE');

  const tooMany = await search([productOne.id], addDays(1), addDays(2), 3);
  expect(tooMany.body.offers[0].result).toBe('UNAVAILABLE');
  expect(tooMany.body.offers[0].reason_codes).toContain('INSUFFICIENT');

  const forbidden = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/availability/search`,
    {
      body: {
        product_ids: [productOne.id],
        period: { arrival: addDays(1), departure: addDays(2) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    },
  );
  expect(forbidden.status).toBe(403);

  const readOnly = await search([productOne.id], addDays(1), addDays(2), 1);
  expect(readOnly.status).toBe(200);
  const auditSearch = await apiRequest(
    auditor.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/availability/search`,
    {
      body: {
        product_ids: [productOne.id],
        period: { arrival: addDays(1), departure: addDays(2) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      },
    },
  );
  expect(auditSearch.status).toBe(200);
});

test('hold fixes all items or none and blocks double allocation', async () => {
  const arrival = addDays(1);
  const departure = addDays(2);
  const hold = await createHold(productOne.id, arrival, departure);
  expect(hold.status).toBe(201);
  expect(hold.body.hold.state).toBe('ACTIVE');
  const holdId = hold.body.hold.id;
  expect(hold.body.hold.allocations).toHaveLength(1);

  const second = await createHold(productOne.id, arrival, departure);
  expect(second.status).toBe(201);

  const exhausted = await search([productOne.id], arrival, departure, 1);
  expect(exhausted.body.offers[0].result).toBe('UNAVAILABLE');
  expect(exhausted.body.offers[0].reason_codes).toContain('COMMITTED');

  const release = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/holds/${holdId}/release`,
  );
  expect(release.status).toBe(200);
  expect(release.body.hold.state).toBe('RELEASED');

  const releaseSecond = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/holds/${second.body.hold.id}/release`,
  );
  expect(releaseSecond.status).toBe(200);

  const draft = await createProduct('P5-P3');
  const calendar = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/rates?from=${addDays(1)}&to=${addDays(2)}`,
  );
  const partial = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/holds`,
    {
      body: {
        items: [
          {
            product_id: productOne.id,
            period: { arrival, departure },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
          {
            product_id: draft.id,
            period: { arrival, departure },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
        inventory_version: calendar.body.inventory_version,
        ttl_seconds: 120,
      },
    },
  );
  expect([409, 422]).toContain(partial.status);
  const counts = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count"
         from "plan_allocation" a
         join "commitment" c on c."id" = a."commitment_id"
        where c."property_id" = $1 and c."source_kind" = 'HOLD' and a."state" = 'ACTIVE'`,
      [property.id],
    );
    return result.rows[0].count;
  });
  expect(counts).toBe(0);
});

test('expired hold frees resources without a worker and cannot be released', async () => {
  const arrival = addDays(2);
  const departure = addDays(3);
  const hold = await createHold(productTwo.id, arrival, departure, 60);
  expect(hold.status).toBe(201);
  const holdId = hold.body.hold.id;

  await withOwner(async (client) => {
    await client.query(
      `update "commitment" set "expires_at" = now() - interval '5 seconds' where "id" = $1`,
      [holdId],
    );
  });

  const afterExpiry = await search([productTwo.id], arrival, departure, 1);
  expect(afterExpiry.body.offers[0].result).toBe('AVAILABLE');

  const release = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/holds/${holdId}/release`,
  );
  expect(release.status).toBe(409);
  expect(release.body.code).toBe('HOLD_EXPIRED');

  const state = await withOwner(async (client) => {
    const result = await client.query(
      `select "state" from "commitment" where "id" = $1`,
      [holdId],
    );
    return result.rows[0].state;
  });
  expect(state).toBe('EXPIRED');
});

test('stale inventory version is rejected before writing', async () => {
  const arrival = addDays(3);
  const departure = addDays(4);
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/holds`,
    {
      body: {
        items: [
          {
            product_id: productOne.id,
            period: { arrival, departure },
            occupancy: { adults: 2, child_ages: [] },
            quantity: 1,
          },
        ],
        inventory_version: 1,
        ttl_seconds: 120,
      },
    },
  );
  expect(response.status).toBe(412);
  expect(response.body.code).toBe('STALE_VERSION');
});

test('blocks prevent planned conflicts, emergency keeps commitment and opens a disruption', async () => {
  const arrival = addDays(3);
  const departure = addDays(4);
  const hold = await createHold(productOne.id, arrival, departure);
  expect(hold.status).toBe(201);
  const holdId = hold.body.hold.id;
  const allocation = hold.body.hold.allocations[0];

  const planned = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/blocks`,
    {
      body: {
        resource_ids: [allocation.resource_id],
        period: { arrival, departure },
        reason: 'Planned maintenance',
        mode: 'PLANNED',
      },
    },
  );
  expect(planned.status).toBe(409);
  expect(planned.body.code).toBe('BLOCK_CONFLICT');

  const emergency = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/blocks`,
    {
      body: {
        resource_ids: [allocation.resource_id],
        period: { arrival, departure },
        reason: 'Emergency repair',
        mode: 'EMERGENCY',
      },
    },
  );
  expect(emergency.status).toBe(201);
  expect(emergency.body.disruptions).toHaveLength(1);
  const blockId = emergency.body.block.id;

  const stillHeld = await withOwner(async (client) => {
    const result = await client.query(
      `select "state" from "commitment" where "id" = $1`,
      [holdId],
    );
    return result.rows[0].state;
  });
  expect(stillHeld).toBe('ACTIVE');

  const blocked = await search([productOne.id], arrival, departure, 2);
  expect(blocked.body.offers[0].result).toBe('UNAVAILABLE');

  const releaseBlockResponse = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/blocks/${blockId}/release`,
    { body: { reason: 'Repair done' } },
  );
  expect(releaseBlockResponse.status).toBe(200);
  expect(releaseBlockResponse.body.block.state).toBe('RELEASED');

  const releaseHoldResponse = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/holds/${holdId}/release`,
  );
  expect(releaseHoldResponse.status).toBe(200);
});

test('partial-night blocks keep a resource unavailable for the whole stay', async () => {
  const arrival = addDays(4);
  const departure = addDays(6);
  const block = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/blocks`,
    {
      body: {
        resource_ids: [roomThree],
        period: { arrival: addDays(5), departure: addDays(6) },
        reason: 'Second night only',
        mode: 'PLANNED',
      },
    },
  );
  expect(block.status).toBe(201);

  const unavailable = await search([productTwo.id], arrival, departure, 1);
  expect(unavailable.body.offers[0].result).toBe('UNAVAILABLE');
  expect(unavailable.body.offers[0].reason_codes).toContain('BLOCKED');

  const shorter = await search([productTwo.id], arrival, addDays(5), 1);
  expect(shorter.body.offers[0].result).toBe('AVAILABLE');

  const release = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/blocks/${block.body.block.id}/release`,
    { body: { reason: 'Clear' } },
  );
  expect(release.status).toBe(200);
  const availableAgain = await search([productTwo.id], arrival, departure, 1);
  expect(availableAgain.body.offers[0].result).toBe('AVAILABLE');
});

test('resource maintenance OOO needs emergency permission and blocks availability', async () => {
  const forbidden = await apiRequest(
    member.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/resources/${roomThree}/maintenance`,
    { body: { version: 1, state: 'OOO', reason: 'Broken lock' } },
  );
  expect(forbidden.status).toBe(403);

  const current = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantA}/properties/${property.id}/resources?limit=10`,
  );
  const resource = current.body.items.find((item) => item.id === roomThree);
  const mfaDenied = await (async () => {
    const owner = await loginAs('owner-a');
    return apiRequest(
      owner.context,
      'POST',
      `/tenants/${tenantA}/properties/${property.id}/resources/${roomThree}/maintenance`,
      {
        body: {
          version: resource.version,
          state: 'OOO',
          reason: 'Owner without MFA',
        },
      },
    );
  })();
  expect(mfaDenied.status).toBe(403);
  expect(mfaDenied.body.code).toBe('MFA_REQUIRED');

  const ooo = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/resources/${roomThree}/maintenance`,
    {
      body: { version: resource.version, state: 'OOO', reason: 'Broken lock' },
    },
  );
  expect(ooo.status).toBe(200);
  expect(ooo.body.resource.maintenance_state).toBe('OOO');

  const unavailable = await search([productTwo.id], addDays(5), addDays(6), 1);
  expect(unavailable.body.offers[0].result).toBe('UNAVAILABLE');
  expect(unavailable.body.offers[0].reason_codes).toContain('MAINTENANCE');

  const cleared = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/resources/${roomThree}/maintenance`,
    {
      body: {
        version: ooo.body.resource.version,
        state: 'NONE',
        reason: 'Repair done',
      },
    },
  );
  expect(cleared.status).toBe(200);
  const available = await search([productTwo.id], addDays(5), addDays(6), 1);
  expect(available.body.offers[0].result).toBe('AVAILABLE');
});

test('expired holds are swept before block conflict detection (F-RVW9F-01)', async () => {
  const arrival = addDays(20);
  const departure = addDays(22);
  const hold = await createHold(productOne.id, arrival, departure, 300);
  expect(hold.status).toBe(201);
  const holdId = hold.body.hold.id;
  const allocation = hold.body.hold.allocations[0];
  await withOwner(async (client) => {
    await client.query(
      `update "commitment" set "expires_at" = now() - interval '1 minute'
        where "id" = $1`,
      [holdId],
    );
  });

  const planned = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/blocks`,
    {
      body: {
        resource_ids: [allocation.resource_id],
        period: { arrival, departure },
        reason: 'Planned window after hold expiry',
        mode: 'PLANNED',
      },
    },
  );
  expect(planned.status).toBe(201);

  const emergency = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantA}/properties/${property.id}/blocks`,
    {
      body: {
        resource_ids: [allocation.resource_id],
        period: { arrival, departure },
        reason: 'Emergency after hold expiry',
        mode: 'EMERGENCY',
      },
    },
  );
  expect(emergency.status).toBe(201);
  expect(emergency.body.disruptions).toHaveLength(0);

  const states = await withOwner(async (client) => {
    const commitment = await client.query(
      `select "state" from "commitment" where "id" = $1`,
      [holdId],
    );
    const plan = await client.query(
      `select "state" from "plan_allocation" where "id" = $1`,
      [allocation.id],
    );
    return {
      commitment: commitment.rows[0].state,
      allocation: plan.rows[0].state,
    };
  });
  expect(states.commitment).toBe('EXPIRED');
  expect(states.allocation).toBe('RELEASED');
});
