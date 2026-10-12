import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, test } from '@jest/globals';
import { createOrm } from '../../packages/backend/dist/persistence/orm.js';
import { testOwnerUrl } from './support/harness.mjs';
import { createReservationAriLocalHook } from '../../packages/backend/dist/modules/inventory/application/reservation-ari-service.js';
import { confirmReservation, modifyReservation, cancelItem } from '../../packages/backend/dist/modules/reservations/application/commitment-service.js';
import { insertReservation, insertReservationItem } from '../../packages/backend/dist/modules/reservations/persistence/reservation-repository.js';
import { insertRatePlan, insertPolicyVersion, insertPriceQuote } from '../../packages/backend/dist/modules/inventory/persistence/rate-repository.js';
import { insertConnection } from '../../packages/backend/dist/modules/distribution/persistence/connection-repository.js';
import { upsertMapping } from '../../packages/backend/dist/modules/distribution/persistence/mapping-repository.js';

let orm;
let context;
beforeAll(async () => {
  if (!/^hotel_test_[a-z0-9_]+_property$/.test(process.env.IDENTITY_TEST_DB ?? ''))
    throw new Error('ISOLATED_PROPERTY_DATABASE_REQUIRED');
  orm = await createOrm(testOwnerUrl, { pool: { min: 0, max: 3 } });
  const actor = await orm.em.getConnection().execute(`select m.user_id from membership m
    join role_grant g on g.membership_id=m.id and g.tenant_id=m.tenant_id
    join role r on r.id=g.role_id and r.tenant_id=g.tenant_id
    where m.tenant_id=? and r.code='TENANT_ADMIN' limit 1`, [process.env.IDENTITY_TENANT_A]);
  if (!actor[0]) throw new Error('SYNTHETIC_ADMIN_REQUIRED');
  context = { tenantId: process.env.IDENTITY_TENANT_A, correlationId: null,
    actor: { kind: 'USER', userId: actor[0].user_id, sessionId: 'ari-fixture', displayName: null, mfa: true } };
});
afterAll(async () => { await orm?.close(true); });

async function fixture(mode = 'PARTS') {
  const tenantId = context.tenantId;
  const propertyId = randomUUID();
  const connectionId = randomUUID();
  const atoms = [randomUUID(), randomUUID(), randomUUID()];
  const products = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const compositionVersionId = randomUUID();
  const bindings = [];
  const rates = [];
  await orm.em.fork().transactional(async (em) => {
    await em.execute(`insert into property(id,tenant_id,code,name,timezone,status) values(?,?,?,?,'Asia/Jakarta','ACTIVE')`, [propertyId, tenantId, propertyId, 'Synthetic ARI']);
    for (const resource of atoms)
      await em.execute(`insert into resource(id,tenant_id,property_id,code,resource_type,capacity) values(?,?,?,?,'ROOM',2)`, [resource, tenantId, propertyId, resource]);
    await insertConnection(em, { id: connectionId, tenantId, propertyId, providerKey: 'simulator', environment: 'simulator', channelKey: 'tiket-com', externalPropertyId: 'SYNTHETIC-VILLA', secretRef: 'synthetic:unused' });
    for (const [index, productId] of products.entries()) {
      await em.execute(`insert into product(id,tenant_id,property_id,code,name,kind,status,occupancy_adults_max) values(?,?,?,?,?,?,'ACTIVE',?)`, [productId, tenantId, propertyId, productId, 'Synthetic ARI', index === 0 ? 'VILLA' : 'ROOM', index === 0 ? 6 : 2]);
      if (index !== 0)
        await em.execute(`insert into product_resource_candidate(product_id,tenant_id,property_id,resource_id) values(?,?,?,?)`, [productId, tenantId, propertyId, atoms[index - 1]]);
      const mapping = await upsertMapping(em, { connectionId, channelKey: 'tiket-com', externalRoomRef: `ROOM-${index}`, externalRateRef: `RATE-${index}`, occupancy: 2, mealPlanRef: null, internalProductRef: productId, internalRateRef: null, effectiveAt: '2026-10-01T00:00:00Z', status: 'DRAFT', mappingVersion: 1 });
      bindings.push({ productId, resourceIds: index === 0 ? atoms : [atoms[index - 1]], mappingId: mapping.id, mappingVersion: 1, mappingStatus: 'DRAFT', externalRoomRef: `ROOM-${index}`, externalRateRef: `RATE-${index}` });
      const base = { tenantId, propertyId, occupancyBasis: 2, mealPlan: 'NONE', inclusions: [], cancellationPolicy: {}, freePolicy: false };
      const rate = await insertRatePlan(em, { ...base, productId, code: `RATE-${index}`, name: 'Synthetic rate', currency: 'IDR' });
      const version = await insertPolicyVersion(em, { ...base, ratePlanId: rate.id, versionNumber: 1 });
      rates.push({ rate, version });
    }
    await em.execute(`insert into composition_version(id,tenant_id,property_id,product_id,version_number,effective_from,effective_to,status) values(?,?,?,?,1,'2026-10-01','2026-11-01','ACTIVE')`, [compositionVersionId, tenantId, propertyId, products[0]]);
    for (const atom of atoms)
      await em.execute(`insert into composition_leaf(version_id,tenant_id,property_id,resource_id,depth) values(?,?,?,?,1)`, [compositionVersionId, tenantId, propertyId, atom]);
  });
  const policy = { databaseName: process.env.IDENTITY_TEST_DB, tenantId, propertyId, connectionId, connectionVersion: 1, connectionStatus: 'DRAFT', externalPropertyId: 'SYNTHETIC-VILLA', date: '2026-10-15', departure: '2026-10-16', mode, compositionVersionId, whole: bindings[0], parts: bindings.slice(1) };
  const hook = createReservationAriLocalHook(policy);
  const current = async () => (await orm.em.getConnection().execute('select inventory_version from property where id=?', [propertyId]))[0].inventory_version;
  async function quote(index, arrival = policy.date, departure = policy.departure) {
    return orm.em.fork().transactional((em) => insertPriceQuote(em, { tenantId, propertyId, ratePlanId: rates[index].rate.id, policyVersionId: rates[index].version.id, productId: products[index], currency: 'IDR', startDate: arrival, endDate: departure, quantity: 1, adults: 2, childAges: [], totalAmount: '100000', cells: [], inventoryVersion: 1, expiresAt: null }));
  }
  async function draft(indices, source = 'DIRECT') {
    const reservationId = randomUUID();
    const items = [];
    await orm.em.fork().transactional(async (em) => {
      await insertReservation(em, { id: reservationId, tenantId, propertyId, source, channelConnectionId: null, externalBookingKey: null, state: 'INQUIRY' });
      for (const index of indices)
        items.push(await insertReservationItem(em, { id: randomUUID(), tenantId, propertyId, reservationId, productId: products[index], arrival: policy.date, departure: policy.departure, adults: 2, childAges: [], quantity: 1, state: 'INQUIRY' }));
    });
    return { reservationId, items };
  }
  async function confirm(draft, suppliedHook = hook, key = randomUUID()) {
    const items = [];
    for (const item of draft.items) items.push({ item_id: item.id, price_snapshot_id: (await quote(products.indexOf(item.product_id))).id });
    const input = { reservationId: draft.reservationId, inventoryVersion: await current(), items, idempotencyKey: key };
    return { result: await confirmReservation(orm, context, propertyId, input, suppliedHook), input };
  }
  const events = async () => orm.em.getConnection().execute(`select * from distribution_outbox_event where property_id=? and event_type='ReservationAriLocalSnapshot' order by created_at,id`, [propertyId]);
  const latest = async () => { const rows = await events(); return rows.at(-1)?.payload_safe.canonical_ari; };
  return { policy, hook, propertyId, products, atoms, draft, quote, confirm, current, events, latest };
}

test('parts confirmation and partial cancellation recompute whole and retain other-room commitment; replay emits once', async () => {
  const f = await fixture();
  const draft = await f.draft([1, 2]);
  const confirmed = await f.confirm(draft);
  expect((await f.latest()).map((cell) => cell.available)).toEqual([0, 0, 0, 1]);
  const replay = await confirmReservation(orm, context, f.propertyId, confirmed.input, () => { throw new Error('REPLAY_HOOK_CALLED'); });
  expect(replay.replayed).toBe(true);
  expect(await f.events()).toHaveLength(1);
  await cancelItem(orm, context, f.propertyId, draft.items[0].id, { version: 2, reason: 'synthetic cancellation', idempotencyKey: randomUUID() }, f.hook);
  const cells = await f.latest();
  expect(cells.map((cell) => cell.available)).toEqual([0, 1, 0, 1]);
  expect(cells[0].reason_codes).toContain('COMMITTED');
  expect(cells.every((cell) => cell.inventory_version === confirmed.result.inventory_version + 1)).toBe(true);
  for (const event of await f.events()) {
    expect(event.status).toBe('CANCELLED');
    expect(event.payload_safe.cells).toBeUndefined();
    expect(event.payload_safe.local_only).toBe(true);
  }
});

test.each(['WHOLE', 'PARTS'])('whole confirmation closes every room in %s mode; cancellation reopens selected variants', async (mode) => {
  const f = await fixture(mode);
  const draft = await f.draft([0]);
  await f.confirm(draft);
  expect((await f.latest()).map((cell) => cell.available)).toEqual([0, 0, 0, 0]);
  await cancelItem(orm, context, f.propertyId, draft.items[0].id, { version: 2, reason: 'synthetic cancellation', idempotencyKey: randomUUID() }, f.hook);
  expect((await f.latest()).map((cell) => cell.available)).toEqual(mode === 'WHOLE' ? [1, 0, 0, 0] : [0, 1, 1, 1]);
});

test('same-leaf replacement composition rejects the pinned version and rolls back confirm', async () => {
  const f = await fixture();
  const draft = await f.draft([1]);
  const before = await f.current();
  await orm.em.fork().transactional(async (em) => {
    const replacement = randomUUID();
    await em.execute(`update composition_version set status='RETIRED' where id=?`, [f.policy.compositionVersionId]);
    await em.execute(`insert into composition_version(id,tenant_id,property_id,product_id,version_number,effective_from,effective_to,status) values(?,?,?,?,2,'2026-10-01','2026-11-01','ACTIVE')`, [replacement, context.tenantId, f.propertyId, f.products[0]]);
    for (const atom of f.atoms)
      await em.execute(`insert into composition_leaf(version_id,tenant_id,property_id,resource_id,depth) values(?,?,?,?,1)`, [replacement, context.tenantId, f.propertyId, atom]);
  });
  await expect(f.confirm(draft)).rejects.toMatchObject({ code: 'STALE_VERSION' });
  expect(await f.current()).toBe(before);
  expect(await f.events()).toHaveLength(0);
});

test('reserved exposure allocation survives cancellation and closes its atom', async () => {
  const f = await fixture();
  const draft = await f.draft([1]);
  await f.confirm(draft);
  const exposureId = randomUUID();
  await orm.em.fork().transactional(async (em) => {
    await em.execute(`insert into exposure(id,tenant_id,property_id,connection_id,product_id,start_date,end_date,state,inventory_version) values(?,?,?,?,?,?,?,'RESERVED',1)`, [exposureId, context.tenantId, f.propertyId, f.policy.connectionId, f.products[1], f.policy.date, f.policy.departure]);
    await em.execute(`insert into exposure_allocation(exposure_id,tenant_id,property_id,resource_id,start_date,end_date) values(?,?,?,?,?,?)`, [exposureId, context.tenantId, f.propertyId, f.atoms[0], f.policy.date, f.policy.departure]);
  });
  await cancelItem(orm, context, f.propertyId, draft.items[0].id, { version: 2, reason: 'synthetic cancellation', idempotencyKey: randomUUID() }, f.hook);
  expect((await f.latest())[1]).toMatchObject({ available: 0, stop_sell: true });
  expect((await f.latest())[1].reason_codes).toContain('EXPOSURE_PROTECTED');
  expect(await orm.em.getConnection().execute('select state from exposure_allocation where exposure_id=?', [exposureId])).toEqual([{ state: 'RESERVED' }]);
  expect(await orm.em.getConnection().execute('select state from exposure where id=?', [exposureId])).toEqual([{ state: 'RESERVED' }]);
});

test('parent readiness and inactive product remain closed after reservation cancellation', async () => {
  const f = await fixture();
  const draft = await f.draft([1]);
  await f.confirm(draft);
  await orm.em.fork().transactional(async (em) => {
    const parent = randomUUID();
    await em.execute(`insert into resource(id,tenant_id,property_id,code,resource_type,capacity,state) values(?,?,?,?,'VILLA',6,'INACTIVE')`, [parent, context.tenantId, f.propertyId, parent]);
    await em.execute('update resource set parent_resource_id=? where id=?', [parent, f.atoms[0]]);
    await em.execute(`update product set status='INACTIVE' where id=?`, [f.products[2]]);
  });
  await cancelItem(orm, context, f.propertyId, draft.items[0].id, { version: 2, reason: 'synthetic cancellation', idempotencyKey: randomUUID() }, f.hook);
  const cells = await f.latest();
  expect(cells.map((cell) => cell.available)).toEqual([0, 0, 0, 1]);
  expect(cells[1].reason_codes).toContain('RESOURCE_NOT_READY');
  expect(cells[2].reason_codes).toContain('PRODUCT_NOT_ACTIVE');
});

test('modify away and back covers old and new periods without publishing adjacent night', async () => {
  const f = await fixture();
  const draft = await f.draft([1]);
  const confirmed = await f.confirm(draft);
  const away = await f.quote(1, '2026-10-16', '2026-10-17');
  const result = await modifyReservation(orm, context, f.propertyId, draft.reservationId, { version: confirmed.result.version, idempotencyKey: randomUUID(), items: [{ item_id: draft.items[0].id, period: { arrival: '2026-10-16', departure: '2026-10-17' }, price_snapshot_id: away.id }] }, f.hook);
  expect((await f.latest()).map((cell) => cell.available)).toEqual([0, 1, 1, 1]);
  const back = await f.quote(1);
  await modifyReservation(orm, context, f.propertyId, draft.reservationId, { version: result.version, idempotencyKey: randomUUID(), items: [{ item_id: draft.items[0].id, period: { arrival: f.policy.date, departure: f.policy.departure }, price_snapshot_id: back.id }] }, f.hook);
  expect((await f.latest()).map((cell) => cell.available)).toEqual([0, 0, 1, 1]);
  expect((await f.events()).flatMap((event) => event.payload_safe.canonical_ari).every((cell) => cell.date === f.policy.date)).toBe(true);
});

test('block, stop-sell and UNKNOWN/RECONCILING exposure headers prevent reopening after cancellation', async () => {
  const f = await fixture();
  const draft = await f.draft([1]);
  await f.confirm(draft);
  await orm.em.fork().transactional(async (em) => {
    const block = randomUUID();
    await em.execute(`insert into inventory_block(id,tenant_id,property_id,mode,reason,start_date,end_date) values(?,?,?,'EMERGENCY','synthetic',?,?)`, [block, context.tenantId, f.propertyId, f.policy.date, f.policy.departure]);
    await em.execute(`insert into inventory_block_resource(block_id,tenant_id,property_id,resource_id) values(?,?,?,?)`, [block, context.tenantId, f.propertyId, f.atoms[0]]);
    await em.execute(`insert into sale_restriction(tenant_id,property_id,connection_id,product_id,start_date,end_date,reason) values(?,?,?,?,?,?,'synthetic')`, [context.tenantId, f.propertyId, f.policy.connectionId, f.products[2], f.policy.date, f.policy.departure]);
    for (const state of ['UNKNOWN', 'RECONCILING'])
      await em.execute(`insert into exposure(tenant_id,property_id,connection_id,product_id,start_date,end_date,state,inventory_version) values(?,?,?,?,?,?,?,1)`, [context.tenantId, f.propertyId, f.policy.connectionId, f.products[3], f.policy.date, f.policy.departure, state]);
  });
  await cancelItem(orm, context, f.propertyId, draft.items[0].id, { version: 2, reason: 'synthetic cancellation', idempotencyKey: randomUUID() }, f.hook);
  const cells = await f.latest();
  expect(cells.every((cell) => cell.available === 0)).toBe(true);
  expect(cells[1].reason_codes).toContain('BLOCKED');
  expect(cells[2].reason_codes).toContain('STOP_SELL_RETAINED');
  expect(cells[3].reason_codes).toContain('EXPOSURE_PROTECTED');
});

test('mapping drift rolls back allocations, reservation version, inventory and idempotency result', async () => {
  const f = await fixture();
  const draft = await f.draft([1]);
  const version = await f.current();
  await orm.em.getConnection().execute('update distribution_mapping_version set mapping_version=2 where id=?', [f.policy.parts[0].mappingId]);
  await expect(f.confirm(draft)).rejects.toMatchObject({ code: 'STALE_VERSION' });
  expect(await f.current()).toBe(version);
  expect(await f.events()).toHaveLength(0);
  const items = await orm.em.getConnection().execute('select state,version from reservation_item where id=?', [draft.items[0].id]);
  expect(items[0]).toMatchObject({ state: 'INQUIRY', version: 1 });
  const allocations = await orm.em.getConnection().execute('select id from plan_allocation where property_id=?', [f.propertyId]);
  expect(allocations).toHaveLength(0);
  expect(await orm.em.getConnection().execute('select id from api_idempotency where property_id=?', [f.propertyId])).toHaveLength(0);
  await orm.em.getConnection().execute('update distribution_mapping_version set mapping_version=1 where id=?', [f.policy.parts[0].mappingId]);
  await f.confirm(draft);
  expect(await f.events()).toHaveLength(1);
});

test('absent hook leaves baseline unchanged; other property/date/product scope is ignored before drift reads', async () => {
  const f = await fixture();
  const second = await f.draft([2]);
  const quote = await f.quote(2);
  const before = (await f.events()).length;
  await confirmReservation(orm, context, f.propertyId, { reservationId: second.reservationId, inventoryVersion: await f.current(), items: [{ item_id: second.items[0].id, price_snapshot_id: quote.id }], idempotencyKey: randomUUID() });
  expect(await f.events()).toHaveLength(before);
  const em = { execute() { throw new Error('UNRELATED_SCOPE_READ'); } };
  const base = { tenantId: context.tenantId, propertyId: f.propertyId, reservationId: randomUUID(), reservationVersion: 1, inventoryVersion: 1, operation: 'CONFIRM' };
  await f.hook(em, { ...base, tenantId: randomUUID(), affected: [{ productId: f.products[1], arrival: f.policy.date, departure: f.policy.departure }] });
  await f.hook(em, { ...base, propertyId: randomUUID(), affected: [{ productId: f.products[1], arrival: f.policy.date, departure: f.policy.departure }] });
  await f.hook(em, { ...base, affected: [{ productId: f.products[1], arrival: f.policy.departure, departure: '2026-10-17' }] });
  await f.hook(em, { ...base, affected: [{ productId: randomUUID(), arrival: f.policy.date, departure: f.policy.departure }] });
});
