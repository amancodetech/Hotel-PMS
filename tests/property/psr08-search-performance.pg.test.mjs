import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createOrm } from '../../packages/backend/dist/persistence/orm.js';
import { readResources } from '../../packages/backend/dist/modules/property/application/resource-service.js';
import { readLocationTree } from '../../packages/backend/dist/modules/property/application/location-tree-service.js';
import {
  apiRequest,
  apiDatabaseUrl,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';
const out = '.local/verification/PSR-08/search-performance-' + Date.now();
mkdirSync(out, { recursive: true });
copyFileSync(
  'tests/property/psr08-search-performance.pg.test.mjs',
  out + '/source.mjs',
);
const report = {
  source_sha256: createHash('sha256')
    .update(readFileSync(out + '/source.mjs'))
    .digest('hex'),
  samples: [],
  failures: [],
  fixtures: [],
  cold_definition:
    'First filtered request on fresh fixture, no process restart or database/OS cache flush',
  query_method:
    'Separate scoped runtime-role service companion with ORM SQL query logger; API latency measured separately',
  target_p95_ms: 1000,
};
const persist = () =>
  writeFileSync(out + '/result.json', JSON.stringify(report, null, 2));
let admin,
  tenant,
  orm,
  queries = 0;
const scope = () => ({
  tenantId: tenant,
  correlationId: randomUUID(),
  actor: {
    kind: 'USER',
    userId: admin.session.body.user.id,
    sessionId: admin.session.body.session.id,
    displayName: 'Synthetic filtered search',
    mfa: admin.session.body.session.mfa,
  },
});
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
  orm = await createOrm(apiDatabaseUrl(), {
    debug: ['query'],
    logger: (m) => {
      if (m.includes('[query]')) queries++;
    },
  });
});
afterAll(async () => {
  persist();
  if (orm) await orm.close(true);
  await stopApi();
  await closeBrowser();
});
async function probe(label, phase, size, api, service) {
  const row = { label, phase, size };
  report.samples.push(row);
  try {
    let time = performance.now();
    const response = await api();
    row.api_ms = performance.now() - time;
    row.status = response.status;
    let count = queries;
    const result = await service();
    row.companion_service_query_count = queries - count;
    row.api_items = response.body.items?.length;
    row.service_items = result.items.length;
    expect(response.status).toBe(200);
    expect(row.companion_service_query_count).toBeGreaterThan(0);
    return { response, result };
  } catch (e) {
    row.failure = e.message;
    report.failures.push(e.message);
    throw e;
  } finally {
    persist();
  }
}
test('PSR-P02 search and sort bounded pages25 under mutations, runtime SQL counts and complete cold/warm samples', async () => {
  for (const requested of [50, 500]) {
    const created = await apiRequest(
      admin.context,
      'POST',
      `/tenants/${tenant}/properties`,
      {
        body: {
          code: 'PSR08-Q-' + requested + '-' + Date.now(),
          name: 'Synthetic filtered search',
          timezone: 'Asia/Makassar',
        },
      },
    );
    expect(created.status).toBe(201);
    const id = created.body.property.id,
      parent = randomUUID(),
      root = `/tenants/${tenant}/properties/${id}`;
    const profile = await withOwner(
      async (c) =>
        (
          await c.query(
            'select l.* from property p join property_limits_profile l on l.id=p.limits_profile_id where p.tenant_id=$1 and p.id=$2',
            [tenant, id],
          )
        ).rows[0],
    );
    const size = Math.min(requested, Number(profile.max_resources));
    report.fixtures.push({ id, parent, size, profile });
    persist();
    await withOwner(async (c) => {
      await c.query(
        "insert into location(id,tenant_id,property_id,code,name,kind) values($1,$2,$3,'ROOT','Root','BUILDING')",
        [parent, tenant, id],
      );
      await c.query(
        "insert into location(id,tenant_id,property_id,code,name,kind,parent_id,display_order) select gen_random_uuid(),$1,$2,'L-'||lpad(n::text,4,'0'),case when n%2=0 then 'needle' else 'other' end,'FLOOR',$3,n%7 from generate_series(1,$4)n",
        [tenant, id, parent, size],
      );
      await c.query(
        "insert into resource(id,tenant_id,property_id,code,display_label,resource_type,capacity,location_id,unit_details) select gen_random_uuid(),$1,$2,'R-'||lpad(n::text,4,'0'),case when n%2=0 then 'needle' else 'other' end,'ROOM',2,$3,jsonb_build_object('bedrooms_count',4,'bathrooms_count',2,'notes','synthetic') from generate_series(1,$4)n",
        [tenant, id, parent, size],
      );
    });
    for (const label of ['resources', 'tree']) {
      const options =
        label === 'resources'
          ? {
              limit: 25,
              q: 'needle',
              sort: 'code',
              type: 'ROOM',
              min_capacity: 2,
              bedrooms_count: 4,
              bathrooms_count: 2,
            }
          : {
              limit: 25,
              parent_id: parent,
              q: 'needle',
              sort: 'code',
              kind: 'FLOOR',
            };
      const path =
        label === 'resources'
          ? '/resources?limit=25&q=needle&sort=code&type=ROOM&min_capacity=2&bedrooms_count=4&bathrooms_count=2'
          : `/locations?tree=true&parent_id=${parent}&limit=25&q=needle&sort=code&kind=FLOOR`;
      const read = (opts) =>
        label === 'resources'
          ? readResources(orm, scope(), id, opts)
          : readLocationTree(orm, scope(), id, opts);
      const get = (cursor) =>
        apiRequest(
          admin.context,
          'GET',
          root + path + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        );
      let cursor = null,
        serviceCursor = null,
        ids = [],
        codes = [],
        firstCursor,
        firstIds;
      do {
        const { response, result } = await probe(
          label,
          ids.length === 0 ? 'cold' : 'pagination',
          size,
          () => get(cursor),
          () =>
            read({
              ...options,
              ...(serviceCursor ? { cursor: serviceCursor } : {}),
            }),
        );
        expect(response.body.items.length).toBeLessThanOrEqual(25);
        ids.push(...response.body.items.map((x) => x.id));
        codes.push(...response.body.items.map((x) => x.code));
        if (!firstIds) {
          firstIds = response.body.items.map((x) => x.id);
          firstCursor = response.body.next_cursor;
        }
        cursor = response.body.next_cursor;
        serviceCursor = result.next_cursor;
        expect(ids.length).toBeLessThanOrEqual(size);
      } while (cursor);
      expect(ids.length).toBe(Math.floor(size / 2));
      expect(new Set(ids).size).toBe(ids.length);
      expect(codes).toEqual([...codes].sort());
      for (let n = 0; n < 5; n++) {
        const { response } = await probe(
          label,
          'warm',
          size,
          () => get(null),
          () => read(options),
        );
        expect(response.body.items.map((x) => x.id)).toEqual(firstIds);
      }
      if (firstCursor) {
        const rejected = await apiRequest(
          admin.context,
          'GET',
          root +
            path.replace('q=needle', 'q=other') +
            '&cursor=' +
            encodeURIComponent(firstCursor),
        );
        expect(rejected.status).toBe(400);
      }
      const mutation = await withOwner(async (c) => {
        if (label === 'resources') {
          const old = (
            await c.query(
              'select * from resource where tenant_id=$1 and property_id=$2 and id=$3',
              [tenant, id, firstIds[0]],
            )
          ).rows[0];
          return { id: old.id, version: old.version };
        }
        return (
          await c.query(
            'select id,version from location where tenant_id=$1 and property_id=$2 and id=$3',
            [tenant, id, firstIds[0]],
          )
        ).rows[0];
      });
      const changed = await apiRequest(
        admin.context,
        'PATCH',
        root +
          (label === 'resources' ? '/resources/' : '/locations/') +
          mutation.id,
        {
          body: {
            version: mutation.version,
            ...(label === 'resources'
              ? { display_label: 'no match' }
              : { name: 'no match' }),
          },
        },
      );
      expect(changed.status).toBe(200);
      if (firstCursor) {
        const stale = await get(firstCursor);
        expect(stale.status).toBe(412);
      }
      const fresh = await get(null);
      expect(fresh.status).toBe(200);
      expect(fresh.body.items.some((x) => x.id === mutation.id)).toBe(false);
      report.fixtures.at(-1)[label + '_mutation'] = {
        removed_id: mutation.id,
        fresh_items: fresh.body.items.length,
      };
      persist();
    }
  }
  report.summary = [];
  for (const label of ['resources', 'tree'])
    for (const phase of ['cold', 'warm', 'pagination'])
      for (const size of [...new Set(report.samples.map((x) => x.size))]) {
        const samples = report.samples.filter(
          (x) => x.label === label && x.phase === phase && x.size === size,
        );
        if (!samples.length) continue;
        const times = samples.map((x) => x.api_ms).sort((a, b) => a - b);
        report.summary.push({
          label,
          phase,
          size,
          p50_ms: times[Math.ceil(times.length * 0.5) - 1],
          p95_ms: times[Math.ceil(times.length * 0.95) - 1],
          samples: samples.length,
          all_outcomes_included: true,
        });
      }
  persist();
  for (const row of report.summary) expect(row.p95_ms).toBeLessThan(1000);
}, 180000);
