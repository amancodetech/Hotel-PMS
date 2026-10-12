import { resourceLocationPathSql } from '../../packages/backend/dist/modules/property/persistence/resource-display.js';
import { randomUUID } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { Migration20261001090000_ops_task_components as Migration } from '../../packages/backend/dist/persistence/migrations/Migration20261001090000_ops_task_components.js';
import { createOrm } from '../../packages/backend/dist/persistence/orm.js';
import { runOperationsIntake } from '../../packages/backend/dist/index.js';
import {
  apiDatabaseUrl,
  apiRequest,
  closeBrowser,
  loginAs,
  startApi,
  stopApi,
  withOwner,
} from './support/harness.mjs';
let admin, tenant;
beforeAll(async () => {
  await startApi();
  admin = await loginAs('admin-a');
  tenant = admin.session.body.session.active_tenant_id;
});
afterAll(async () => {
  await stopApi();
  await closeBrowser();
});
const key = () => randomUUID();
async function seeded() {
  const p = await apiRequest(
    admin.context,
    'POST',
    `/tenants/${tenant}/properties`,
    {
      body: {
        code: `P7M-${key().slice(0, 10)}`,
        name: 'PSR07 synthetic migration',
        timezone: 'Asia/Jakarta',
      },
    },
  );
  expect(p.status).toBe(201);
  const property = p.body.property;
  return withOwner(async (c) => {
    const ids = {
      property: property.id,
      resources: [key(), key()],
      reservation: key(),
      item: key(),
      event: key(),
      task: key(),
    };
    for (const [i, id] of ids.resources.entries())
      await c.query(
        "insert into resource(id,tenant_id,property_id,code,resource_type,capacity) values($1,$2,$3,$4,'ROOM',2)",
        [id, tenant, property.id, `M${i}`],
      );
    await c.query(
      "insert into reservation(id,tenant_id,property_id,source,state) values($1,$2,$3,'DIRECT','CHECKED_OUT')",
      [ids.reservation, tenant, property.id],
    );
    await c.query(
      "insert into reservation_item(id,tenant_id,property_id,reservation_id,arrival,departure,adults,child_ages,quantity,state) values($1,$2,$3,$4,current_date,current_date+1,2,'[]',1,'CHECKED_OUT')",
      [ids.item, tenant, property.id, ids.reservation],
    );
    await c.query(
      `insert into stay_event(id,tenant_id,property_id,reservation_id,item_id,type,resource_id,payload,item_version) values($1,$2,$3,$4,$5,'STAY_CHECKED_OUT',$6,$7::jsonb,2)`,
      [
        ids.event,
        tenant,
        property.id,
        ids.reservation,
        ids.item,
        ids.resources[0],
        JSON.stringify({
          resource_id: ids.resources[0],
          resource_ids: ids.resources,
          business_date: '2026-10-01',
        }),
      ],
    );
    await c.query(
      `insert into ops_task(id,tenant_id,property_id,type,status,source_event_id,source_event_type,resource_id,item_id,reservation_id) values($1,$2,$3,'HOUSEKEEPING','PENDING',$4,'STAY_CHECKED_OUT',$5,$6,$7)`,
      [
        ids.task,
        tenant,
        property.id,
        ids.event,
        ids.resources[0],
        ids.item,
        ids.reservation,
      ],
    );
    return ids;
  });
}
test.each(['INSPECTED', 'CANCELLED'])(
  'independent intake preserves %s historical task while filling the missing component',
  async (status) => {
    const ids = await seeded();
    await withOwner((c) =>
      c.query('update ops_task set status=$2 where id=$1', [ids.task, status]),
    );
    const before = await withOwner(
      async (c) =>
        (await c.query('select * from ops_task where id=$1', [ids.task]))
          .rows[0],
    );
    const orm = await createOrm(apiDatabaseUrl());
    try {
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          runOperationsIntake(orm, {
            tenantId: tenant,
            propertyId: ids.property,
          }),
        ),
      );
      expect(results.reduce((n, r) => n + r.created, 0)).toBe(1);
      const tasks = await withOwner(
        async (c) =>
          (
            await c.query('select * from ops_task where source_event_id=$1', [
              ids.event,
            ])
          ).rows,
      );
      expect(tasks).toHaveLength(2);
      expect(tasks.find((t) => t.id === ids.task)).toEqual(before);
      expect(
        await runOperationsIntake(orm, {
          tenantId: tenant,
          propertyId: ids.property,
        }),
      ).toMatchObject({ processed: 0, created: 0 });
    } finally {
      await orm.close(true);
    }
  },
);

test('independent migration preserves null-resource history and enforces null deduplication', async () => {
  await withOwner(async (c) => {
    await c.query('begin');
    try {
      await c.query('create schema psr071_independent');
      await c.query('set local search_path=psr071_independent,public');
      await c.query(
        'create table ops_task (tenant_id uuid, property_id uuid, source_event_id uuid, resource_id uuid, historical_text text)',
      );
      await c.query(
        'create unique index ops_task_source_unique on ops_task(tenant_id,property_id,source_event_id) where source_event_id is not null',
      );
      const values = [key(), key(), key()];
      await c.query(
        "insert into ops_task values($1,$2,$3,null,'keep history')",
        values,
      );
      const before = (await c.query('select * from ops_task')).rows;
      const migration = new Migration();
      await migration.up();
      for (const sql of migration.getQueries()) await c.query(sql);
      expect((await c.query('select * from ops_task')).rows).toEqual(before);
      await c.query('savepoint duplicate_null');
      await expect(
        c.query('insert into ops_task select * from ops_task'),
      ).rejects.toMatchObject({ code: '23505' });
      await c.query('rollback to savepoint duplicate_null');
      await c.query(
        "insert into ops_task values($1,$2,$3,$4,'new component')",
        [...values, key()],
      );
      expect(
        (await c.query('select count(*)::int n from ops_task')).rows[0].n,
      ).toBe(2);
      const down = new Migration();
      await down.down();
      await c.query('savepoint safe_down');
      await expect(c.query(down.getQueries()[0])).rejects.toThrow(
        'data-preserving forward fix',
      );
      await c.query('rollback to savepoint safe_down');
      expect(
        (await c.query('select count(*)::int n from ops_task')).rows[0].n,
      ).toBe(2);
    } finally {
      await c.query('rollback');
    }
  });
});

test('independent location projection chooses nearest own location and stops at foreign scope or cycles', async () => {
  await withOwner(async (c) => {
    await c.query('begin');
    try {
      await c.query('create schema psr071_display');
      await c.query('set local search_path=psr071_display,public');
      await c.query(
        'create table resource(id uuid, tenant_id uuid, property_id uuid, parent_resource_id uuid, location_id uuid)',
      );
      await c.query(
        'create table location(id uuid, tenant_id uuid, property_id uuid, parent_id uuid, name text)',
      );
      const t = key(),
        p = key(),
        other = key(),
        root = key(),
        room = key(),
        bed = key(),
        building = key(),
        floor = key(),
        own = key();
      await c.query(
        "insert into location values($1,$4,$5,null,'Building'),($2,$4,$5,$1,'Floor'),($3,$4,$5,null,'Own')",
        [building, floor, own, t, p],
      );
      await c.query(
        'insert into resource values($1,$4,$5,null,$6),($2,$4,$5,$1,$7),($3,$4,$5,$2,null)',
        [root, room, bed, t, p, building, floor],
      );
      const path = async () =>
        (
          await c.query(
            `select ${resourceLocationPathSql} as path from resource r where r.id=$1`,
            [bed],
          )
        ).rows[0].path;
      expect(await path()).toEqual(['Building', 'Floor']);
      await c.query('update resource set location_id=$2 where id=$1', [
        bed,
        own,
      ]);
      expect(await path()).toEqual(['Own']);
      await c.query('update resource set location_id=null where id=$1', [bed]);
      await c.query('update resource set property_id=$2 where id=$1', [
        room,
        other,
      ]);
      expect(await path()).toEqual([]);
      await c.query(
        'update resource set property_id=$2, tenant_id=$3 where id=$1',
        [room, p, other],
      );
      expect(await path()).toEqual([]);
      await c.query('update resource set tenant_id=$2 where id=$1', [room, t]);
      await c.query('update location set tenant_id=$2 where id=$1', [
        building,
        other,
      ]);
      expect(await path()).toEqual(['Floor']);
      await c.query(
        'update location set tenant_id=$2,parent_id=$3 where id=$1',
        [building, t, floor],
      );
      expect(await path()).toEqual(['Building', 'Floor']);
      await c.query(
        'update resource set location_id=null,parent_resource_id=$2 where id=$1',
        [room, bed],
      );
      expect(await path()).toEqual([]);
    } finally {
      await c.query('rollback');
    }
  });
});
