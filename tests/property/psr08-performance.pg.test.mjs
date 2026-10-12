import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createOrm } from '../../packages/backend/dist/persistence/orm.js';
import { readResources } from '../../packages/backend/dist/modules/property/application/resource-service.js';
import { readLocationTree } from '../../packages/backend/dist/modules/property/application/location-tree-service.js';
import { searchAvailability } from '../../packages/backend/dist/modules/inventory/application/availability-service.js';
import {
  apiRequest,
  apiDatabaseUrl,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';
const out =
  process.env.PSR08_PERF_OUT ??
  '.local/verification/PSR-08/performance-' + Date.now();
mkdirSync(out, { recursive: true });
copyFileSync(
  'tests/property/psr08-performance.pg.test.mjs',
  out + '/source.mjs',
);
const report = {
  generated_at: new Date().toISOString(),
  node: process.version,
  published_sla: false,
  target_p95_ms: 1000,
  cold_definition:
    'First request per new fixture; PostgreSQL OS cache is not flushed.',
  query_count_method:
    'Separate service invocation using runtime-role ORM debug query logger; includes transaction and authorization SQL. API latency is measured separately without SQL logging.',
  samples: [],
  fixtures: [],
  failures: [],
};
let admin,
  tenant,
  orm,
  queries = 0;
const persist = () =>
  writeFileSync(out + '/performance.json', JSON.stringify(report, null, 2));
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(q * values.length) - 1)
  ];
const scope = () => ({
  tenantId: tenant,
  correlationId: randomUUID(),
  actor: {
    kind: 'USER',
    userId: admin.session.body.user.id,
    sessionId: admin.session.body.session.id,
    displayName: 'Synthetic performance probe',
    mfa: admin.session.body.session.mfa,
  },
});
const shift = (n) =>
  new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
  orm = await createOrm(apiDatabaseUrl(), {
    debug: ['query'],
    logger: (message) => {
      if (message.includes('[query]')) queries++;
    },
  });
  report.database = await withOwner(
    async (c) => (await c.query('select version() version')).rows[0].version,
  );
  persist();
});
afterAll(async () => {
  persist();
  if (orm) await orm.close(true);
  await stopApi();
  await closeBrowser();
});
async function measured(label, phase, size, api, service) {
  const row = {
    label,
    phase,
    size,
    api_ms: null,
    status: null,
    result: null,
    service_query_count: null,
  };
  report.samples.push(row);
  persist();
  try {
    let t = performance.now();
    const response = await api();
    row.api_ms = performance.now() - t;
    row.status = response.status;
    row.result = response.body.offers?.[0]?.result ?? 'PAGE';
    const before = queries;
    t = performance.now();
    const value = await service();
    row.service_ms = performance.now() - t;
    row.service_query_count = queries - before;
    row.service_result = value.offers?.[0]?.result ?? 'PAGE';
    expect(row.service_query_count).toBeGreaterThan(0);
    expect(response.status).toBe(200);
    if (label === 'search')
      expect(['AVAILABLE', 'UNDETERMINED']).toContain(row.result);
    return response;
  } catch (e) {
    row.failure = e.message;
    report.failures.push({ label, phase, size, message: e.message });
    throw e;
  } finally {
    persist();
  }
}
(process.env.PSR08_MUTATION_ONLY === '1' ? test.skip : test)(
  'PSR-P01/P02 within unchanged limits: stable pages25, mutation invalidation, cold/warm all outcomes and SQL counts',
  async () => {
    const created = await apiRequest(
      admin.context,
      'POST',
      `/tenants/${tenant}/properties`,
      {
        body: {
          code: 'PSR08-P-' + Date.now(),
          name: 'Synthetic performance',
          timezone: 'Asia/Makassar',
        },
      },
    );
    expect(created.status).toBe(201);
    const profile = await withOwner(
      async (c) =>
        (
          await c.query(
            'select l.* from property p join property_limits_profile l on l.id=p.limits_profile_id where p.id=$1 and p.tenant_id=$2',
            [created.body.property.id, tenant],
          )
        ).rows[0],
    );
    report.profile = profile;
    persist();
    for (const size of [
      ...new Set([
        Math.min(50, profile.max_resources),
        Math.min(250, profile.max_resources),
        Number(profile.max_resources),
      ]),
    ]) {
      const r = await apiRequest(
        admin.context,
        'POST',
        `/tenants/${tenant}/properties`,
        {
          body: {
            code: 'PSR08-P-' + size + '-' + Date.now(),
            name: 'Synthetic performance ' + size,
            timezone: 'Asia/Makassar',
          },
        },
      );
      expect(r.status).toBe(201);
      const id = r.body.property.id,
        parent = randomUUID(),
        product = randomUUID(),
        root = `/tenants/${tenant}/properties/${id}`;
      await withOwner(async (c) => {
        await c.query(
          "insert into location(id,tenant_id,property_id,code,name,kind) values($1,$2,$3,'ROOT','Root','BUILDING')",
          [parent, tenant, id],
        );
        await c.query(
          "insert into location(id,tenant_id,property_id,code,name,parent_id,display_order) select gen_random_uuid(),$1,$2,'L-'||lpad(n::text,5,'0'),'Synthetic',$3,n%7 from generate_series(1,$4) n",
          [tenant, id, parent, size],
        );
        await c.query(
          "insert into resource(id,tenant_id,property_id,code,resource_type,capacity,location_id) select gen_random_uuid(),$1,$2,'R-'||lpad(n::text,5,'0'),'ROOM',2,$3 from generate_series(1,$4) n",
          [tenant, id, parent, size],
        );
        await c.query(
          "insert into product(id,tenant_id,property_id,code,name,kind,status) values($1,$2,$3,'POOL','Synthetic pool','ROOM','ACTIVE')",
          [product, tenant, id],
        );
        await c.query(
          "insert into product_resource_candidate(product_id,tenant_id,property_id,resource_type,resource_id) select $1,$2,$3,'ROOM',id from resource where tenant_id=$2 and property_id=$3",
          [product, tenant, id],
        );
      });
      report.fixtures.push({ id, parent, product, size });
      persist();
      const snapshot = await withOwner(async (c) => ({
        resources: (
          await c.query(
            'select id from resource where tenant_id=$1 and property_id=$2 order by created_at,id',
            [tenant, id],
          )
        ).rows.map((x) => x.id),
        locations: (
          await c.query(
            'select id from location where tenant_id=$1 and property_id=$2 and parent_id=$3 order by display_order,code,id',
            [tenant, id, parent],
          )
        ).rows.map((x) => x.id),
      }));
      const get = (path) => apiRequest(admin.context, 'GET', root + path);
      for (const [label, path, service] of [
        [
          'resources',
          '/resources',
          (cursor) => readResources(orm, scope(), id, { limit: 25, cursor }),
        ],
        [
          'tree',
          `/locations?tree=true&parent_id=${parent}`,
          (cursor) =>
            readLocationTree(orm, scope(), id, {
              limit: 25,
              parent_id: parent,
              ...(cursor ? { cursor } : {}),
            }),
        ],
      ]) {
        let cursor = null,
          serviceCursor = null,
          ids = [],
          page = 0,
          first;
        do {
          const join = path.includes('?') ? '&' : '?';
          const response = await measured(
            label,
            page === 0 ? 'cold' : 'pagination',
            size,
            () =>
              get(
                path +
                  join +
                  'limit=25' +
                  (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
              ),
            async () => {
              const value = await service(serviceCursor);
              serviceCursor = value.next_cursor;
              return value;
            },
          );
          expect(response.body.items.length).toBeLessThanOrEqual(25);
          if (!first) first = response;
          ids.push(...response.body.items.map((x) => x.id));
          cursor = response.body.next_cursor;
          page++;
          expect(page).toBeLessThanOrEqual(Math.ceil(size / 25) + 1);
        } while (cursor);
        expect(ids).toEqual(
          snapshot[label === 'tree' ? 'locations' : 'resources'],
        );
        expect(new Set(ids).size).toBe(size);
        report.fixtures.at(-1)[label + '_pages'] = page;
        persist();
        for (let n = 0; n < 5; n++) {
          const response = await measured(
            label,
            'warm',
            size,
            () => get(path + (path.includes('?') ? '&' : '?') + 'limit=25'),
            () => service(null),
          );
          expect(response.body.items.map((x) => x.id)).toEqual(
            first.body.items.map((x) => x.id),
          );
        }
        if (label === 'tree' && first.body.next_cursor) {
          const changed = await apiRequest(
            admin.context,
            'PATCH',
            root + '/locations/' + parent,
            { body: { version: 1, name: 'Renamed' } },
          );
          expect(changed.status).toBe(200);
          const stale = await get(
            path +
              '&limit=25&cursor=' +
              encodeURIComponent(first.body.next_cursor),
          );
          expect(stale.status).toBe(412);
          report.fixtures.at(-1).mutation_cursor_status = stale.status;
          persist();
        }
      }
      const input = {
        product_ids: [product],
        period: { arrival: shift(10), departure: shift(12) },
        occupancy: { adults: 2, child_ages: [] },
        quantity: 1,
      };
      for (let n = 0; n < 6; n++)
        await measured(
          'search',
          n === 0 ? 'cold' : 'warm',
          size,
          () =>
            apiRequest(admin.context, 'POST', root + '/availability/search', {
              body: input,
            }),
          () =>
            searchAvailability(orm, scope(), id, {
              productIds: [product],
              period: input.period,
              occupancy: { adults: 2, childAges: [] },
              quantity: 1,
            }),
        );
    }
    report.summary = [];
    for (const fixture of report.fixtures)
      for (const label of ['tree', 'resources', 'search'])
        for (const phase of ['cold', 'warm', 'pagination']) {
          const rows = report.samples.filter(
            (x) =>
              x.size === fixture.size && x.label === label && x.phase === phase,
          );
          if (!rows.length) continue;
          const times = rows.map((x) => x.api_ms).filter((x) => x !== null);
          report.summary.push({
            size: fixture.size,
            label,
            phase,
            p50_ms: percentile(times, 0.5),
            p95_ms: percentile(times, 0.95),
            all_outcomes_included: true,
            undetermined: rows.filter((x) => x.result === 'UNDETERMINED')
              .length,
            failed: rows.filter((x) => x.failure).length,
            queries: rows.map((x) => x.service_query_count),
          });
        }
    persist();
    for (const item of report.summary) expect(item.p95_ms).toBeLessThan(1000);
  },
  300000,
);

test('PSR-P02 search responds to changed inventory without cached stale availability', async () => {
  const response = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: 'PSR08-MUT-' + Date.now(),
        name: 'Synthetic mutation',
        timezone: 'Asia/Makassar',
      },
    },
  );
  expect(response.status).toBe(201);
  const id = response.body.property.id,
    resource = randomUUID(),
    product = randomUUID(),
    block = randomUUID(),
    root = `/tenants/${tenant}/properties/${id}`;
  await withOwner(async (c) => {
    await c.query(
      "insert into resource(id,tenant_id,property_id,code,resource_type,capacity) values($1,$2,$3,'R1','ROOM',2)",
      [resource, tenant, id],
    );
    await c.query(
      "insert into product(id,tenant_id,property_id,code,name,kind,status) values($1,$2,$3,'P1','Synthetic','ROOM','ACTIVE')",
      [product, tenant, id],
    );
    await c.query(
      "insert into product_resource_candidate(product_id,tenant_id,property_id,resource_type,resource_id) values($1,$2,$3,'ROOM',$4)",
      [product, tenant, id, resource],
    );
  });
  const period = { arrival: shift(10), departure: shift(12) },
    input = {
      product_ids: [product],
      period,
      occupancy: { adults: 2, child_ages: [] },
      quantity: 1,
    };
  const probe = (phase) =>
    measured(
      'search-mutation',
      phase,
      1,
      () =>
        apiRequest(admin.context, 'POST', root + '/availability/search', {
          body: input,
        }),
      () =>
        searchAvailability(orm, scope(), id, {
          productIds: [product],
          period,
          occupancy: { adults: 2, childAges: [] },
          quantity: 1,
        }),
    );
  const before = await probe('before-change');
  expect(before.body.offers[0].result).toBe('AVAILABLE');
  await withOwner(async (c) => {
    await c.query(
      "insert into inventory_block(id,tenant_id,property_id,mode,reason,start_date,end_date) values($1,$2,$3,'PLANNED','Synthetic mutation',$4,$5)",
      [block, tenant, id, period.arrival, period.departure],
    );
    await c.query(
      'insert into inventory_block_resource(block_id,tenant_id,property_id,resource_id) values($1,$2,$3,$4)',
      [block, tenant, id, resource],
    );
    await c.query(
      'update property set inventory_version=inventory_version+1 where tenant_id=$1 and id=$2',
      [tenant, id],
    );
  });
  const after = await probe('after-change');
  expect(after.body.offers[0].result).toBe('UNAVAILABLE');
  report.mutation = {
    property: id,
    resource,
    block,
    before: before.body.offers[0].result,
    after: after.body.offers[0].result,
  };
  persist();
});
