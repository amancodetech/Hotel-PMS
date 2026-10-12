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
test('PSR07 forward component migration preserves a legacy task and rejects destructive down after component use', async () => {
  const ids = await seeded();
  await withOwner(async (c) => {
    await c.query('begin');
    try {
      // A private schema inside the disposable harness database isolates DDL from
      // every other suite and tests the actual migration SQL against real PG.
      await c.query('create schema psr07_migration_fixture');
      await c.query(
        'create table psr07_migration_fixture.ops_task (like public.ops_task including defaults including constraints)',
      );
      await c.query('set local search_path=psr07_migration_fixture,public');
      await c.query(
        'create unique index ops_task_source_unique on ops_task(tenant_id,property_id,source_event_id) where source_event_id is not null',
      );
      await c.query(
        'insert into ops_task select * from public.ops_task where id=$1',
        [ids.task],
      );
      const before = (await c.query('select * from ops_task')).rows;
      const up = new Migration();
      await up.up();
      for (const sql of up.getQueries()) await c.query(sql);
      expect((await c.query('select * from ops_task')).rows).toEqual(before);
      // Untouched single-component history can downgrade and upgrade safely.
      const safeDown = new Migration();
      await safeDown.down();
      for (const sql of safeDown.getQueries()) await c.query(sql);
      for (const sql of up.getQueries()) await c.query(sql);
      await c.query(
        "insert into ops_task select (jsonb_populate_record(null::ops_task,to_jsonb(t)||jsonb_build_object('id',$2::uuid,'resource_id',$3::uuid))).* from ops_task t where id=$1",
        [ids.task, key(), ids.resources[1]],
      );
      expect(
        (await c.query('select count(*)::int n from ops_task')).rows[0].n,
      ).toBe(2);
      await c.query('savepoint duplicate');
      await expect(
        c.query(
          "insert into ops_task select (jsonb_populate_record(null::ops_task,to_jsonb(t)||jsonb_build_object('id',$2::uuid))).* from ops_task t where id=$1",
          [ids.task, key()],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await c.query('rollback to savepoint duplicate');
      const protectedRows = (
        await c.query('select * from ops_task order by id')
      ).rows;
      const down = new Migration();
      await down.down();
      await c.query('savepoint downgrade');
      await expect(c.query(down.getQueries()[0])).rejects.toThrow(
        'data-preserving forward fix',
      );
      await c.query('rollback to savepoint downgrade');
      expect(
        (await c.query('select * from ops_task order by id')).rows,
      ).toEqual(protectedRows);
    } finally {
      await c.query('rollback');
    }
  });
});

test('PSR07 concurrent intake fills a missing legacy component once, preserves the first task and does not duplicate stay events', async () => {
  const ids = await seeded();
  const before = await withOwner(
    async (c) =>
      (await c.query('select * from ops_task where id=$1', [ids.task])).rows[0],
  );
  const orm = await createOrm(apiDatabaseUrl());
  try {
    const results = await Promise.all([
      runOperationsIntake(orm, { tenantId: tenant, propertyId: ids.property }),
      runOperationsIntake(orm, { tenantId: tenant, propertyId: ids.property }),
    ]);
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(1);
    const after = await withOwner(
      async (c) =>
        (
          await c.query(
            'select * from ops_task where source_event_id=$1 order by resource_id',
            [ids.event],
          )
        ).rows,
    );
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.id === ids.task)).toEqual(before);
    expect(after.map((r) => r.resource_id).sort()).toEqual(
      ids.resources.sort(),
    );
    const events = await withOwner(
      async (c) =>
        (
          await c.query('select id from stay_event where item_id=$1', [
            ids.item,
          ])
        ).rows,
    );
    expect(events).toEqual([{ id: ids.event }]);
    expect(
      await runOperationsIntake(orm, {
        tenantId: tenant,
        propertyId: ids.property,
      }),
    ).toMatchObject({ processed: 0, created: 0 });
  } finally {
    await orm.close(true);
  }
});
