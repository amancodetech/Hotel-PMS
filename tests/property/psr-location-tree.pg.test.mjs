import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import {
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
  withRuntimeRole,
} from './support/harness.mjs';
import { Migration20260923120000_location_tree as Migration } from '../../packages/backend/dist/persistence/migrations/Migration20260923120000_location_tree.js';
let admin, auditor, other, tenant;
let seq = 0;
const run = Date.now().toString(36);
const key = () => `psr03-${randomUUID()}`;
const base = (p) => `/tenants/${tenant}/properties/${p.id}`;
async function property() {
  const r = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `TREE-${run}-${++seq}`,
        name: 'Synthetic tree',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(r.status).toBe(201);
  return r.body.property;
}
const call = (p, method, path, body, headers = {}) =>
  apiRequest(admin.context, method, `${base(p)}${path}`, { body, headers });
async function location(p, body = {}) {
  const r = await call(
    p,
    'POST',
    '/locations',
    { code: `L${++seq}`, name: 'Location', kind: 'BUILDING', ...body },
    { 'idempotency-key': key() },
  );
  expect(r.status).toBe(201);
  return r.body.location;
}
const patch = (p, l, body) =>
  call(p, 'PATCH', `/locations/${l.id}`, { version: l.version, ...body });
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  auditor = await loginAs('auditor-a');
  other = await loginAs('owner-b');
  tenant = admin.session.body.session.active_tenant_id;
});
afterAll(async () => {
  await stopApi();
  await closeBrowser();
});

test('T20/T21 additive upgrade and safe downgrade preserve legacy identity/state and migration history', async () => {
  const p = await property();
  const l = await call(p, 'POST', '/locations', {
    code: 'LEGACY',
    name: 'Floor 9 is not inferred',
  });
  const r = await call(p, 'POST', '/resources', {
    code: 'OLD',
    type: 'ROOM',
    capacity: 2,
    location_id: l.body.location.id,
  });
  expect(r.status).toBe(201);
  const retired = await call(p, 'PATCH', `/resources/${r.body.resource.id}`, {
    version: 1,
    state: 'RETIRED',
  });
  expect(retired.status).toBe(200);
  await withOwner(async (c) => {
    await c.query('begin');
    try {
      const commitment = randomUUID(),
        product = randomUUID(),
        connection = randomUUID(),
        exposure = randomUUID(),
        journal = randomUUID();
      await c.query(
        `insert into commitment(id,tenant_id,property_id,source_kind,source_id,expires_at,inventory_version)
        values($1,$2,$3,'HOLD',$1,now()+interval '1 hour',1)`,
        [commitment, tenant, p.id],
      );
      await c.query(
        `insert into plan_allocation(id,commitment_id,tenant_id,property_id,resource_id,start_date,end_date)
        values(gen_random_uuid(),$1,$2,$3,$4,'2027-01-01','2027-01-03')`,
        [commitment, tenant, p.id, r.body.resource.id],
      );
      await c.query(
        `insert into product(id,tenant_id,property_id,code,name,kind) values($1,$2,$3,'SNAP','Snapshot','ROOM')`,
        [product, tenant, p.id],
      );
      await c.query(
        `insert into distribution_connection(id,tenant_id,property_id,provider_key,environment,channel_key,external_property_id,secret_ref)
        values($1,$2,$3,'CHANNEX','STAGING','BOOKING_COM','synthetic','local:synthetic')`,
        [connection, tenant, p.id],
      );
      await c.query(
        `insert into exposure(id,tenant_id,property_id,connection_id,product_id,start_date,end_date,mode,state,inventory_version)
        values($1,$2,$3,$4,$5,'2027-02-01','2027-02-03','PARTS','PUBLISHING',1)`,
        [exposure, tenant, p.id, connection, product],
      );
      await c.query(
        `insert into exposure_allocation(id,exposure_id,tenant_id,property_id,resource_id,start_date,end_date)
        values(gen_random_uuid(),$1,$2,$3,$4,'2027-02-01','2027-02-03')`,
        [exposure, tenant, p.id, r.body.resource.id],
      );
      await c.query(
        `insert into reservation(tenant_id,property_id,source,external_booking_key,state) values($1,$2,'IMPORT','synthetic-snapshot','INQUIRY')`,
        [tenant, p.id],
      );
      await c.query(
        `insert into business_day(tenant_id,property_id,business_date,state) values($1,$2,'2026-09-24','OPEN')`,
        [tenant, p.id],
      );
      await c.query(
        `insert into journal(id,tenant_id,property_id,business_date,currency,source_type,source_id,total_debit,total_credit)
        values($1,$2,$3,'2026-09-24','IDR','SNAPSHOT',$1,123456,123456)`,
        [journal, tenant, p.id],
      );
      await c.query(
        `insert into journal_line(tenant_id,property_id,journal_id,line_no,account_code,debit,credit)
        values($1,$2,$3,1,'FOLIO_GUEST',123456,0),($1,$2,$3,2,'REVENUE_ROOM',0,123456)`,
        [tenant, p.id, journal],
      );
      const protectedTables = [
        'commitment',
        'plan_allocation',
        'reservation',
        'exposure',
        'exposure_allocation',
        'journal',
        'journal_line',
        'product',
        'composition_version',
        'composition_leaf',
        'api_idempotency',
      ];
      const snapshots = new Map();
      for (const table of protectedTables)
        snapshots.set(
          table,
          (
            await c.query(
              `select * from "${table}" t order by to_jsonb(t)::text`,
            )
          ).rows,
        );
      const before = await c.query(
        `select id,code,state,capacity,location_id from resource order by id`,
      );
      const history = await c.query(
        'select * from mikro_orm_migrations order by id',
      );
      const down = new Migration();
      await down.down();
      for (const sql of down.getQueries()) await c.query(sql);
      expect(
        (
          await c.query(
            "select count(*)::int n from information_schema.columns where table_name='location' and column_name='parent_id'",
          )
        ).rows[0].n,
      ).toBe(0);
      const up = new Migration();
      await up.up();
      for (const sql of up.getQueries()) await c.query(sql);
      expect(
        (
          await c.query(
            'select id,code,state,capacity,location_id from resource order by id',
          )
        ).rows,
      ).toEqual(before.rows);
      expect(
        (await c.query('select * from mikro_orm_migrations order by id')).rows,
      ).toEqual(history.rows);
      for (const table of protectedTables)
        expect(
          (
            await c.query(
              `select * from "${table}" t order by to_jsonb(t)::text`,
            )
          ).rows,
        ).toEqual(snapshots.get(table));
      const upgraded = await c.query(
        'select parent_id,kind,display_order from location where id=$1',
        [l.body.location.id],
      );
      expect(upgraded.rows[0]).toEqual({
        parent_id: null,
        kind: null,
        display_order: 0,
      });
    } finally {
      await c.query('rollback');
    }
  });
});

test('tree create requires key, replays exactly, conflicts safely and preserves legacy create', async () => {
  const p = await property(),
    k = key(),
    body = { code: 'A', name: 'Building A', kind: 'BUILDING' };
  expect((await call(p, 'POST', '/locations', body)).status).toBe(400);
  const a = await call(p, 'POST', '/locations', body, { 'idempotency-key': k });
  expect(a.status).toBe(201);
  expect(
    (await call(p, 'POST', '/locations', body, { 'idempotency-key': k })).body
      .location,
  ).toEqual(a.body.location);
  expect(
    (
      await call(
        p,
        'POST',
        '/locations',
        { ...body, name: 'changed' },
        { 'idempotency-key': k },
      )
    ).status,
  ).toBe(409);
  expect(
    (await call(p, 'POST', '/locations', body, { 'idempotency-key': key() }))
      .status,
  ).toBe(409);
  expect((await call(p, 'GET', '/locations')).body.items).toHaveLength(1);
});

test('T09 parent omission preserves, null detaches, self/ancestor cycles reject', async () => {
  const p = await property(),
    a = await location(p),
    b = await location(p, { parent_id: a.id, kind: 'FLOOR' });
  expect((await patch(p, a, { parent_id: b.id })).status).toBe(400);
  expect((await patch(p, a, { parent_id: a.id })).status).toBe(400);
  const renamed = await patch(p, b, { name: 'Renamed' });
  expect(renamed.status).toBe(200);
  expect(renamed.body.location.parent_id).toBe(a.id);
  const detached = await patch(p, renamed.body.location, { parent_id: null });
  expect(detached.status).toBe(200);
  expect(detached.body.location.parent_id).toBeNull();
  expect((await patch(p, b, { name: 'old version' })).status).toBe(412);
});

test('T09 inverse concurrent moves produce one winner and no cycle', async () => {
  const p = await property(),
    a = await location(p),
    b = await location(p);
  const results = await Promise.all([
    patch(p, a, { parent_id: b.id }),
    patch(p, b, { parent_id: a.id }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  const roots = await call(p, 'GET', '/locations?tree=true');
  expect(roots.body.items).toHaveLength(1);
});

test('T10 scoped references, permissions, inactive ancestor and RLS reject', async () => {
  const p = await property(),
    q = await property(),
    a = await location(p),
    foreign = await location(q);
  expect((await patch(p, a, { parent_id: foreign.id })).status).toBe(422);
  expect(
    (
      await apiRequest(
        auditor.context,
        'PATCH',
        `${base(p)}/locations/${a.id}`,
        { body: { version: 1, name: 'denied' } },
      )
    ).status,
  ).toBe(403);
  expect([403, 404]).toContain(
    (await apiRequest(other.context, 'GET', `${base(p)}/locations?tree=true`))
      .status,
  );
  const child = await location(p, { parent_id: a.id });
  // T18 now refuses archiving a parent with children through the API.
  // Seed legacy inactive-ancestor data explicitly to keep this isolation test.
  expect((await patch(p, a, { status: 'INACTIVE' })).body.code).toBe(
    'LOCATION_IN_USE',
  );
  await withOwner((c) =>
    c.query(
      "update location set status='INACTIVE' where tenant_id=$1 and property_id=$2 and id=$3",
      [tenant, p.id, a.id],
    ),
  );
  expect(
    (
      await call(p, 'POST', '/resources', {
        code: 'BAD',
        type: 'ROOM',
        capacity: 2,
        location_id: child.id,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(
        p,
        'POST',
        '/locations',
        { code: 'BAD', name: 'bad', parent_id: child.id },
        { 'idempotency-key': key() },
      )
    ).status,
  ).toBe(409);
});

test('T24 display labels repeat across buildings without renumbering internal codes or inventing rooms', async () => {
  const p = await property(),
    a = await location(p),
    b = await location(p);
  for (const [code, loc] of [
    ['A-101', a],
    ['B-101', b],
  ]) {
    const r = await call(p, 'POST', '/resources', {
      code,
      type: 'VILLA',
      capacity: 4,
      location_id: loc.id,
      display_label: '101',
      unit_details: {
        bedrooms_count: 4,
        bathrooms_count: 0,
        notes: 'Synthetic',
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.resource.display_label).toBe('101');
    const changed = await call(p, 'PATCH', `/resources/${r.body.resource.id}`, {
      version: 1,
      display_label: '102',
      location_id: b.id,
      unit_details: { bedrooms_count: 3 },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.resource.code).toBe(code);
    expect(changed.body.resource.location_id).toBe(b.id);
    expect(changed.body.resource.unit_details).toEqual({ bedrooms_count: 3 });
  }
  expect((await call(p, 'GET', '/resources')).body.items).toHaveLength(2);
  expect(
    (
      await call(p, 'POST', '/resources', {
        code: 'A-101',
        type: 'ROOM',
        capacity: 2,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(p, 'POST', '/resources', {
        code: 'X',
        type: 'ROOM',
        capacity: 2,
        unit_details: { bedrooms_count: 2.5 },
      })
    ).status,
  ).toBe(400);
});

test('T17 renaming and relocating an allocated unit preserves identity, future allocation and scoped history', async () => {
  const p = await property();
  const originalLocation = await location(p);
  const destination = await location(p);
  const outsideProperty = await property();
  const outsideLocation = await location(outsideProperty);
  const created = await call(p, 'POST', '/resources', {
    code: 'T17-ROOM-101',
    type: 'ROOM',
    capacity: 2,
    location_id: originalLocation.id,
    display_label: '101',
  });
  expect(created.status).toBe(201);
  const resource = created.body.resource;
  await withOwner(async (c) => {
    await c.query(
      "update property set status='ACTIVE' where tenant_id=$1 and id=$2",
      [tenant, p.id],
    );
    await c.query(
      `insert into commitment(id,tenant_id,property_id,source_kind,source_id,expires_at,inventory_version)
       values($1,$2,$3,'HOLD',$1,now()+interval '1 day',1)`,
      [randomUUID(), tenant, p.id],
    );
    const commitment = await c.query(
      `select id from commitment where tenant_id=$1 and property_id=$2 and source_kind='HOLD' order by created_at desc limit 1`,
      [tenant, p.id],
    );
    await c.query(
      `insert into plan_allocation(id,commitment_id,tenant_id,property_id,resource_id,start_date,end_date)
       values($1,$2,$3,$4,$5,'2031-11-01','2031-11-04')`,
      [randomUUID(), commitment.rows[0].id, tenant, p.id, resource.id],
    );
  });
  const allocationBefore = await withOwner(async (c) =>
    c.query(
      `select id,commitment_id,resource_id,start_date::text,end_date::text,state
         from plan_allocation where tenant_id=$1 and property_id=$2 and resource_id=$3`,
      [tenant, p.id, resource.id],
    ),
  );
  const renamed = await call(p, 'PATCH', `/resources/${resource.id}`, {
    version: resource.version,
    display_label: 'Garden Room 101',
    location_id: destination.id,
  });
  expect(renamed.status).toBe(200);
  expect(renamed.body.resource).toMatchObject({
    id: resource.id,
    code: 'T17-ROOM-101',
    display_label: 'Garden Room 101',
    location_id: destination.id,
    version: resource.version + 1,
  });
  const allocationAfter = await withOwner(async (c) =>
    c.query(
      `select id,commitment_id,resource_id,start_date::text,end_date::text,state
         from plan_allocation where tenant_id=$1 and property_id=$2 and resource_id=$3`,
      [tenant, p.id, resource.id],
    ),
  );
  expect(allocationAfter.rows).toEqual(allocationBefore.rows);
  const foreignMove = await call(p, 'PATCH', `/resources/${resource.id}`, {
    version: renamed.body.resource.version,
    location_id: outsideLocation.id,
  });
  expect(foreignMove.status).toBe(422);
  expect(foreignMove.body.code).toBe('CROSS_SCOPE_REFERENCE');
  const afterRejectedMove = await call(p, 'GET', '/resources');
  expect(
    afterRejectedMove.body.items.find((item) => item.id === resource.id),
  ).toMatchObject({
    id: resource.id,
    code: 'T17-ROOM-101',
    display_label: 'Garden Room 101',
    location_id: destination.id,
  });
  const history = await withOwner((c) =>
    c.query(
      `select action,before_safe,after_safe from audit_event
        where tenant_id=$1 and property_id=$2 and resource_id=$3
        order by created_at,id`,
      [tenant, p.id, resource.id],
    ),
  );
  expect(history.rows.map((entry) => entry.action)).toEqual([
    'resource.created',
    'resource.updated',
  ]);
  expect(history.rows[0].after_safe).toMatchObject({
    code: 'T17-ROOM-101',
    display_label: '101',
    location_id: originalLocation.id,
  });
});

test('P01 paginated children stable at 1000 nodes, scoped signed cursors and ancestors without full resource load', async () => {
  const p = await property(),
    a = await location(p),
    b = await location(p);
  await withOwner((c) =>
    c.query(
      `insert into location(id,tenant_id,property_id,code,name,parent_id,display_order)
 select gen_random_uuid(),$1,$2,'L-'||lpad(n::text,5,'0'),'Synthetic',$3,n%7 from generate_series(1,1000) n`,
      [tenant, p.id, a.id],
    ),
  );
  await withOwner((c) =>
    c.query(
      `insert into resource(id,tenant_id,property_id,code,resource_type,capacity,location_id)
    select gen_random_uuid(),$1,$2,'PERF-'||n,'ROOM',2,$3 from generate_series(1,500) n`,
      [tenant, p.id, a.id],
    ),
  );
  const started = performance.now();
  let cursor = null,
    ids = [],
    pages = 0,
    first;
  do {
    const r = await call(
      p,
      'GET',
      `/locations?tree=true&parent_id=${a.id}&limit=25${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(25);
    expect(r.body.ancestors.map((x) => x.id)).toEqual([a.id]);
    if (!first) first = r.body.next_cursor;
    ids.push(...r.body.items.map((x) => x.id));
    cursor = r.body.next_cursor;
    pages++;
  } while (cursor);
  mkdirSync('.local/verification/PSR-03', { recursive: true });
  writeFileSync(
    '.local/verification/PSR-03/performance.json',
    JSON.stringify({
      probe: 'PSR-P01',
      locations: 1000,
      resources: 500,
      page_size: 25,
      pages,
      elapsed_ms: Math.round(performance.now() - started),
    }),
  );
  expect(pages).toBe(40);
  expect(new Set(ids).size).toBe(1000);
  expect(
    (
      await call(
        p,
        'GET',
        `/locations?tree=true&parent_id=${b.id}&cursor=${first}`,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        p,
        'GET',
        `/locations?tree=true&parent_id=${a.id}&cursor=${first}x`,
      )
    ).status,
  ).toBe(400);
  await patch(p, a, { name: 'Changed' });
  expect(
    (
      await call(
        p,
        'GET',
        `/locations?tree=true&parent_id=${a.id}&cursor=${first}`,
      )
    ).status,
  ).toBe(412);
});

test('T26 old CSV links explicit tree codes, reports invalid/inactive rows and applies accepted subset atomically', async () => {
  const p = await property(),
    a = await location(p, { code: 'BLDG' }),
    b = await location(p, { code: 'FLOOR', parent_id: a.id }),
    off = await location(p, { code: 'OFF' });
  await patch(p, off, { status: 'INACTIVE' });
  const content =
    'code,template,capacity,location\nR1,ROOM,2,FLOOR\nR2,ROOM,2,OFF\nR3,ROOM,2,FOREIGN\nR4,ROOM,0,FLOOR\n=SUM(A1),ROOM,2,FLOOR';
  const imp = (mode, k = key()) =>
    call(
      p,
      'POST',
      '/setup-unit-imports',
      { mode, file_name: 'synthetic.csv', content },
      { 'idempotency-key': k },
    );
  const dry = await imp('DRY_RUN');
  expect(dry.status).toBe(200);
  expect(dry.body.totals.accepted).toBe(1);
  expect(dry.body.rows.map((r) => r.error_code)).toContain('LOCATION_INACTIVE');
  expect((await call(p, 'GET', '/resources')).body.items).toHaveLength(0);
  const k = key(),
    applied = await imp('APPLY', k);
  expect(applied.status).toBe(200);
  expect(applied.body.totals.created).toBe(1);
  expect((await imp('APPLY', k)).body.totals.created).toBe(1);
  expect((await imp('APPLY')).status).toBe(409);
  const resources = (await call(p, 'GET', '/resources')).body.items;
  expect(resources).toHaveLength(1);
  expect(resources[0].location_id).toBe(b.id);
});

test('T21 downgrade after tree use refuses before DDL and leaves values and history intact', async () => {
  const p = await property(),
    a = await location(p);
  await withOwner(async (c) => {
    const before = (
      await c.query('select * from mikro_orm_migrations order by id')
    ).rows;
    await c.query('begin');
    try {
      const down = new Migration();
      await down.down();
      await expect(
        (async () => {
          for (const sql of down.getQueries()) await c.query(sql);
        })(),
      ).rejects.toThrow('PSR03_DOWNGRADE_BLOCKED');
    } finally {
      await c.query('rollback');
    }
    expect(
      (await c.query('select * from mikro_orm_migrations order by id')).rows,
    ).toEqual(before);
    expect(
      (await c.query('select kind from location where id=$1', [a.id])).rows[0]
        .kind,
    ).toBe('BUILDING');
  });
});

test('database independently blocks scoped FK, cycles and excessive depth; RLS hides foreign tree', async () => {
  const p = await property(),
    q = await property(),
    a = await location(p),
    b = await location(p, { parent_id: a.id }),
    foreign = await location(q);
  await withOwner(async (c) => {
    await expect(
      c.query('update location set parent_id=$1 where id=$2', [b.id, a.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      c.query('update location set parent_id=$1 where id=$2', [
        foreign.id,
        b.id,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      c.query(
        `insert into resource(id,tenant_id,property_id,code,resource_type,capacity,unit_details) values(gen_random_uuid(),$1,$2,'BAD','ROOM',2,'{"bedrooms_count":-1}')`,
        [tenant, p.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  await withRuntimeRole('api', async (c) => {
    await c.query('begin');
    try {
      await c.query("select set_config('app.tenant_id',$1,true)", [
        process.env.IDENTITY_TENANT_B,
      ]);
      expect(
        (await c.query('select id from location where property_id=$1', [p.id]))
          .rows,
      ).toHaveLength(0);
    } finally {
      await c.query('rollback');
    }
  });
  let parent = b;
  for (let depth = 3; depth <= 32; depth++)
    parent = await location(p, { parent_id: parent.id });
  expect(
    (
      await call(
        p,
        'POST',
        '/locations',
        { code: 'TOO-DEEP', name: 'Too deep', parent_id: parent.id },
        { 'idempotency-key': key() },
      )
    ).status,
  ).toBe(400);
  const roots = await call(p, 'GET', '/locations?tree=true');
  expect(roots.body.items.map((x) => x.id)).toEqual([a.id]);
});

test('moving a whole subtree under a deep parent rejects atomically', async () => {
  const p = await property(),
    root = await location(p),
    child = await location(p, { parent_id: root.id });
  let chain = await location(p);
  for (let i = 2; i <= 31; i++)
    chain = await location(p, { parent_id: chain.id });
  expect((await patch(p, root, { parent_id: chain.id })).status).toBe(400);
  const page = await call(
    p,
    'GET',
    `/locations?tree=true&parent_id=${root.id}`,
  );
  expect(page.body.items.map((x) => x.id)).toEqual([child.id]);
});

test('tree changes invalidate tree pages without changing inventory version; CSRF still enforced', async () => {
  const p = await property();
  const before = (await call(p, 'GET', '')).body.property.inventory_version;
  const a = await location(p);
  expect((await patch(p, a, { name: 'Updated label' })).status).toBe(200);
  expect((await call(p, 'GET', '')).body.property.inventory_version).toBe(
    before,
  );
  const denied = await call(
    p,
    'POST',
    '/locations',
    { code: 'CSRF', name: 'Denied', parent_id: null },
    { 'idempotency-key': key(), 'x-csrf-token': 'invalid' },
  );
  expect(denied.status).toBe(403);
});

test('T21 actual migration runner refuses unsafe down without removing its history entry', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(
    new URL('../../packages/backend/package.json', import.meta.url),
  );
  const { Migrator } = await import(require.resolve('@mikro-orm/migrations'));
  const { createOrm } = await import('../../packages/backend/dist/index.js');
  const { testOwnerUrl } = await import('./support/harness.mjs');
  const name = 'Migration20260923120000_location_tree';
  const orm = await createOrm(testOwnerUrl, {
    extensions: [Migrator],
    migrations: {
      migrationsList: [{ name, class: Migration }],
      transactional: true,
      allOrNothing: true,
    },
  });
  try {
    const before = await withOwner((c) =>
      c.query('select * from mikro_orm_migrations order by id'),
    );
    await expect(orm.migrator.down({ migrations: [name] })).rejects.toThrow(
      /PSR03_DOWNGRADE_BLOCKED/,
    );
    const after = await withOwner((c) =>
      c.query('select * from mikro_orm_migrations order by id'),
    );
    expect(after.rows).toEqual(before.rows);
  } finally {
    await orm.close(true);
  }
});
