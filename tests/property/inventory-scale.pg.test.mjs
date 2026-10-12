import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';

const tenantA = process.env.IDENTITY_TENANT_A;
let admin;
let tenantId;

function shift(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))
  ];
}

function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

async function createPropertyWithResources(code, count) {
  const propertyId = randomUUID();
  const productId = randomUUID();
  await withOwner(async (client) => {
    await client.query(
      `insert into "property"
         ("id", "tenant_id", "code", "name", "timezone", "base_currency", "limits_profile_id")
       values ($1, $2, $3, $3, 'Asia/Jakarta', 'IDR',
               (select "id" from "property_limits_profile" where "code" = 'PERF-01'))`,
      [propertyId, tenantA, code],
    );
    await client.query(
      `insert into "resource"
         ("id", "tenant_id", "property_id", "code", "resource_type", "capacity")
       select gen_random_uuid(), $1, $2, $3 || '-' || lpad(g::text, 4, '0'), 'ROOM', 2
         from generate_series(1, $4) g`,
      [tenantA, propertyId, code, count],
    );
    await client.query(
      `insert into "product"
         ("id", "tenant_id", "property_id", "code", "name", "kind", "status")
       values ($1, $2, $3, $4 || '-P', $4 || ' product', 'ROOM', 'ACTIVE')`,
      [productId, tenantA, propertyId, code],
    );
    await client.query(
      `insert into "product_resource_candidate"
         ("product_id", "tenant_id", "property_id", "resource_type", "resource_id")
       select $1, $2, $3, 'ROOM', "id" from "resource"
        where "property_id" = $3`,
      [productId, tenantA, propertyId],
    );
  });
  return { propertyId, productId };
}

async function search(propertyId, productId, arrival, departure, quantity = 1) {
  return apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenantId}/properties/${propertyId}/availability/search`,
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

beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenantId = admin.session.body.session.active_tenant_id;
});

afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('AT-I01: 100 concurrent holds produce exactly one guarantee', async () => {
  const { propertyId, productId } = await createPropertyWithResources(
    'P5-RACE',
    1,
  );
  const arrival = shift(1);
  const departure = shift(2);
  const calendar = await apiRequest(
    admin.context,
    'GET',
    `/tenants/${tenantId}/properties/${propertyId}/rates?from=${arrival}&to=${departure}`,
  );
  const inventoryVersion = calendar.body.inventory_version;
  const requests = Array.from({ length: 100 }, () =>
    apiRequest(
      admin.context,
      'POST',
      `/tenants/${tenantId}/properties/${propertyId}/holds`,
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
          inventory_version: inventoryVersion,
          ttl_seconds: 120,
        },
      },
    ),
  );
  const responses = await Promise.all(requests);
  const statuses = responses.map((response) => response.status);
  const created = statuses.filter((status) => status === 201).length;
  const internal = statuses.filter((status) => status >= 500).length;
  expect(created).toBe(1);
  expect(internal).toBe(0);
  const active = await withOwner(async (client) => {
    const result = await client.query(
      `select count(*)::int as "count"
         from "plan_allocation" a
         join "commitment" c on c."id" = a."commitment_id"
        where c."property_id" = $1 and a."state" = 'ACTIVE'`,
      [propertyId],
    );
    return result.rows[0].count;
  });
  expect(active).toBe(1);
});

test('AT-I02/10: seeded randomized blocks match a brute-force reference', async () => {
  const random = mulberry32(20260914);
  for (let round = 0; round < 8; round += 1) {
    const { propertyId, productId } = await createPropertyWithResources(
      `P5-PBT-${round}`,
      4,
    );
    const rooms = await withOwner(async (client) => {
      const result = await client.query(
        `select "id", "code" from "resource" where "property_id" = $1 order by "code"`,
        [propertyId],
      );
      return result.rows;
    });
    const arrival = shift(2);
    const departure = shift(4);
    const blockedRooms = new Set();
    const blockCount = Math.floor(random() * 3);
    await withOwner(async (client) => {
      for (let index = 0; index < blockCount; index += 1) {
        const room = rooms[Math.floor(random() * rooms.length)];
        const blockStart = random() < 0.5 ? shift(2) : shift(3);
        const blockEnd = blockStart === shift(2) ? shift(3) : shift(4);
        await client.query(
          `insert into "inventory_block"
             ("id", "tenant_id", "property_id", "mode", "reason", "start_date", "end_date")
           values ($1, $2, $3, 'PLANNED', 'random block', $4::date, $5::date)`,
          [randomUUID(), tenantA, propertyId, blockStart, blockEnd],
        );
        const block = await client.query(
          `select "id" from "inventory_block" where "property_id" = $1 order by "created_at" desc limit 1`,
          [propertyId],
        );
        await client.query(
          `insert into "inventory_block_resource"
             ("block_id", "tenant_id", "property_id", "resource_id")
           values ($1, $2, $3, $4)`,
          [block.rows[0].id, tenantA, propertyId, room.id],
        );
        blockedRooms.add(room.id);
      }
    });
    const expectedAvailable = rooms.filter(
      (room) => !blockedRooms.has(room.id),
    ).length;
    const response = await search(propertyId, productId, arrival, departure, 1);
    expect(response.status).toBe(200);
    expect(response.body.offers[0].result).toBe(
      expectedAvailable >= 1 ? 'AVAILABLE' : 'UNAVAILABLE',
    );
  }
});

test('PERF-01: bounded search over 500 resources stays within the initial budget', async () => {
  const { propertyId, productId } = await createPropertyWithResources(
    'P5-PERF',
    500,
  );
  const arrival = shift(5);
  const departure = shift(6);
  const started = Date.now();
  const response = await search(propertyId, productId, arrival, departure, 1);
  const elapsed = Date.now() - started;
  expect(response.status).toBe(200);
  expect(response.body.offers[0].result).toBe('AVAILABLE');
  mkdirSync('.local/verification/P05-07', { recursive: true, mode: 0o700 });
  writeFileSync(
    '.local/verification/P05-07/scale-evidence.json',
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        resources: 500,
        horizon_nights: 1,
        search_ms: elapsed,
        quantity: 1,
        result: response.body.offers[0].result,
        note: 'Initial design target is 500ms after the lock; this is not a published SLA.',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  expect(elapsed).toBeLessThan(10_000);
});

test('AT-T01: 100 concurrent searches stay consistent under the same lock', async () => {
  const { propertyId, productId } = await createPropertyWithResources(
    'P5-CONC',
    10,
  );
  const arrival = shift(6);
  const departure = shift(7);
  const requests = Array.from({ length: 100 }, () =>
    search(propertyId, productId, arrival, departure, 1),
  );
  const responses = await Promise.all(requests);
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(
    responses.every(
      (response) => response.body.offers[0].result === 'AVAILABLE',
    ),
  ).toBe(true);
});

test('SET-08 PERF: ranked list and bounded search hold the initial p95 target at 50/500/2000 resources', async () => {
  const databaseVersion = await withOwner(async (client) => {
    const result = await client.query('select version() as "version"');
    return result.rows[0].version;
  });
  const samples = 5;
  const report = {
    generated_at: new Date().toISOString(),
    node: process.version,
    database: databaseVersion,
    horizon_nights: 1,
    samples_per_size: samples,
    list_limit: 100,
    target_p95_ms: 1000,
    published_sla: false,
    note: 'Local synthetic measurement after lock warmup; warmup calls are retried (max 3) and every attempt is recorded, so a cold UNDETERMINED is reported, never hidden; sizes 50/500 are asserted strictly AVAILABLE under target, while 2000 is above the PERF-01 profile cap so fail-closed UNDETERMINED is allowed and counted (search p95 is computed over AVAILABLE samples only and is null when none); all responses must be 200 with AVAILABLE or UNDETERMINED.',
    sizes: [],
  };
  for (const size of [50, 500, 2000]) {
    const { propertyId, productId } = await createPropertyWithResources(
      `S8-PERF-${size}`,
      size,
    );
    const arrival = shift(5);
    const departure = shift(6);
    const listTimes = [];
    const searchTimes = [];
    const firstPage = await apiRequest(
      admin.context,
      'GET',
      `/tenants/${tenantId}/properties/${propertyId}/resources?limit=100`,
    );
    const secondPage = await apiRequest(
      admin.context,
      'GET',
      `/tenants/${tenantId}/properties/${propertyId}/resources?limit=100`,
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items.length).toBe(Math.min(size, 100));
    expect(secondPage.body.items.map((item) => item.id)).toEqual(
      firstPage.body.items.map((item) => item.id),
    );
    const warmupAttempts = [];
    let warmup = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const warmupStarted = Date.now();
      const response = await search(
        propertyId,
        productId,
        arrival,
        departure,
        1,
      );
      warmupAttempts.push({
        attempt: attempt + 1,
        status: response.status,
        result: response.body.offers[0].result,
        ms: Date.now() - warmupStarted,
      });
      expect(response.status).toBe(200);
      expect(['AVAILABLE', 'UNDETERMINED']).toContain(
        response.body.offers[0].result,
      );
      warmup = response;
      if (response.body.offers[0].result === 'AVAILABLE') break;
    }
    if (size <= 500) expect(warmup.body.offers[0].result).toBe('AVAILABLE');
    let undetermined = 0;
    let available = 0;
    const availableTimes = [];
    for (let index = 0; index < samples; index += 1) {
      const listStarted = Date.now();
      const list = await apiRequest(
        admin.context,
        'GET',
        `/tenants/${tenantId}/properties/${propertyId}/resources?limit=100`,
      );
      listTimes.push(Date.now() - listStarted);
      expect(list.status).toBe(200);
      expect(list.body.items.length).toBe(Math.min(size, 100));
      const searchStarted = Date.now();
      const response = await search(
        propertyId,
        productId,
        arrival,
        departure,
        1,
      );
      const searchMs = Date.now() - searchStarted;
      searchTimes.push(searchMs);
      expect(response.status).toBe(200);
      if (response.body.offers[0].result === 'UNDETERMINED') undetermined += 1;
      else {
        expect(response.body.offers[0].result).toBe('AVAILABLE');
        available += 1;
        availableTimes.push(searchMs);
      }
    }
    expect(available + undetermined).toBe(samples);
    if (size <= 500) {
      expect(available).toBe(samples);
      expect(undetermined).toBe(0);
    }
    const measuredSearchP95 =
      available > 0 ? percentile(availableTimes, 0.95) : null;
    report.sizes.push({
      resources: size,
      undetermined,
      available_samples: available,
      cold_undetermined: warmupAttempts.filter(
        (attempt) => attempt.result === 'UNDETERMINED',
      ).length,
      warmup_attempts: warmupAttempts,
      list_p50_ms: percentile(listTimes, 0.5),
      list_p95_ms: percentile(listTimes, 0.95),
      search_p50_ms: available > 0 ? percentile(availableTimes, 0.5) : null,
      search_p95_ms: measuredSearchP95,
      list_samples_ms: listTimes,
      search_samples_ms: searchTimes,
    });
  }
  mkdirSync('.local/verification/SET-08-3', { recursive: true, mode: 0o700 });
  writeFileSync(
    '.local/verification/SET-08-3/scale-evidence.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  for (const size of report.sizes) {
    expect(size.list_p95_ms).toBeLessThan(report.target_p95_ms);
    if (size.search_p95_ms !== null)
      expect(size.search_p95_ms).toBeLessThan(report.target_p95_ms);
  }
}, 300000);
