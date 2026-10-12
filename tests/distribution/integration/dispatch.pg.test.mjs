import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { createOrm } from '../../../packages/backend/dist/persistence/orm.js';
import {
  DistributionRuntime,
  ProviderRegistry,
  SimulatorAdapter,
  SimulatorEngine,
  countInboxRevisions,
  deadLetters,
  dispatchDueEvents,
  findInboxRevision,
  findOutbox,
  getCheckpoint,
  insertConnection,
  listAttempts,
  lifecycleSeeds,
  listOpenExceptions,
  processPendingAcks,
  pullRevisionsOnce,
  realChannelKeys,
  reprocessDeadLetter,
  simulatorTestProfile,
  startDistributionScheduler,
  storeChannelRevision,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import {
  CONNECTION_ID,
  PROPERTY_ID,
  TENANT_ID,
  ensureProperty,
  forkTx,
  initOrm,
  pullRevisions,
  resetAll,
  seedConnection,
  seedOutbox,
  simulatorContext,
  storeOptions,
} from './helpers.mjs';

let orm;
let ormSecond;
const now0 = '2026-09-13T00:00:00Z';
const clockAt = (value) => () => value;

const profileFor = (context) =>
  simulatorTestProfile(context.channel_key, context.environment);

function adapterWith(options = {}) {
  return new SimulatorAdapter({
    engine: new SimulatorEngine({
      seed: 'P02-04',
      start_time: now0,
      ...options,
    }),
    allowedChannelKeys: realChannelKeys(),
  });
}

function runtimeFor(adapter) {
  return new DistributionRuntime({
    orm,
    registry: new ProviderRegistry([adapter]),
    profileFor,
    owner: 'integration-test',
  });
}

async function dispatch(adapter, extra = {}) {
  return dispatchDueEvents({
    orm,
    registry: new ProviderRegistry([adapter]),
    profileFor,
    owner: 'integration-test',
    ...extra,
  });
}

beforeAll(async () => {
  orm = await initOrm();
  ormSecond = await createOrm(process.env.TEST_DATABASE_URL, {
    pool: { min: 0, max: 5 },
  });
});

afterAll(async () => {
  await ormSecond?.close(true);
  await orm?.close(true);
});

beforeEach(async () => {
  await resetAll(orm);
  await forkTx(orm, (em) => seedConnection(em));
});

test('dispatch acknowledges a provider-accepted snapshot once', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  const summary = await dispatch(adapterWith(), { now: clockAt(now0) });
  expect(summary.acknowledged).toBe(1);
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.status).toBe('ACKNOWLEDGED');
  expect(event.provider_request_id).toEqual(expect.any(String));
  expect(event.attempt_count).toBe(1);
  const attempts = await forkTx(orm, (em) => listAttempts(em, seeded.row.id));
  expect(attempts).toHaveLength(1);
  expect(attempts[0].status).toBe('SUCCEEDED');
});

test('rate limited sends are retried with retry_after and then succeed', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  const adapter = adapterWith({
    failures: [
      { operation: 'pushAvailability', kind: 'rate_limited', times: 1 },
    ],
  });
  const first = await dispatch(adapter, { now: clockAt(now0) });
  expect(first.retried).toBe(1);
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.status).toBe('RETRY_SCHEDULED');
  expect(event.last_safe_error_code).toBe('RATE_LIMITED');
  expect(Date.parse(event.next_attempt_at)).toBe(Date.parse(now0) + 1000);
  const second = await dispatch(adapter, {
    now: clockAt('2026-09-13T00:00:02Z'),
  });
  expect(second.acknowledged).toBe(1);
});

test('permanent provider rejection moves to DLQ and can be reprocessed with reason', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  const adapter = adapterWith({
    failures: [
      {
        operation: 'pushAvailability',
        kind: 'validation_rejected',
        times: 1,
      },
    ],
  });
  const summary = await dispatch(adapter, { now: clockAt(now0) });
  expect(summary.deadLettered).toBe(1);
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.status).toBe('DEAD_LETTER');
  const letters = await deadLetters(orm);
  expect(letters).toHaveLength(1);
  expect(letters[0].reason).toBe('REJECTED_BY_PROVIDER');
  await expect(
    reprocessDeadLetter({
      orm,
      deadLetterId: letters[0].id,
      by: '',
      reason: '',
    }),
  ).rejects.toThrow('actor');
  const reprocessed = await reprocessDeadLetter({
    orm,
    deadLetterId: letters[0].id,
    by: 'ops-synthetic',
    reason: 'mapping corrected in test',
    now: clockAt('2026-09-13T00:05:00Z'),
  });
  expect(reprocessed.status).toBe('RETRY_SCHEDULED');
  const lettersAfter = await deadLetters(orm);
  expect(lettersAfter[0].reprocessed_by).toBe('ops-synthetic');
});

test('a poison tenant event does not starve another connection', async () => {
  const secondConnectionId = '22222222-2222-4333-8444-555555555555';
  const secondTenantId = '22222222-2222-4333-8444-666666666666';
  const secondPropertyId = '22222222-2222-4333-8444-777777777777';
  await forkTx(orm, async (em) => {
    await ensureProperty(em, secondTenantId, secondPropertyId);
    return insertConnection(em, {
      id: secondConnectionId,
      tenantId: secondTenantId,
      propertyId: secondPropertyId,
      providerKey: 'simulator',
      environment: 'simulator',
      channelKey: 'tiket-com',
      externalPropertyId: 'EXT-2',
      secretRef: 'secret:synthetic-2',
    });
  });
  const first = await forkTx(orm, (em) =>
    seedOutbox(em, {
      aggregateId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    }),
  );
  const second = await forkTx(orm, (em) =>
    seedOutbox(em, {
      connectionId: secondConnectionId,
      tenantId: secondTenantId,
      propertyId: secondPropertyId,
      aggregateId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    }),
  );

  class PoisonFirstAdapter extends SimulatorAdapter {
    calls = 0;
    async pushAvailability(context, snapshot, meta) {
      this.calls += 1;
      if (this.calls === 1) throw new Error('synthetic poison');
      return super.pushAvailability(context, snapshot, meta);
    }
  }

  const adapter = new PoisonFirstAdapter({
    engine: new SimulatorEngine({ seed: 'poison', start_time: now0 }),
    allowedChannelKeys: realChannelKeys(),
  });
  const summary = await dispatch(adapter, { now: clockAt(now0) });
  expect(summary.leased).toBe(2);
  expect(summary.retried).toBe(1);
  expect(summary.acknowledged).toBe(1);
  const poisonEvent = await forkTx(orm, (em) => findOutbox(em, first.row.id));
  const goodEvent = await forkTx(orm, (em) => findOutbox(em, second.row.id));
  expect(poisonEvent.status).toBe('RETRY_SCHEDULED');
  expect(goodEvent.status).toBe('ACKNOWLEDGED');
});

test('attempt budget exhaustion dead-letters the event', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  const adapter = adapterWith({
    failures: [
      { operation: 'pushAvailability', kind: 'server_error', times: 5 },
    ],
  });
  const summary = await dispatch(adapter, {
    now: clockAt(now0),
    maxAttempts: 1,
  });
  expect(summary.deadLettered).toBe(1);
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.status).toBe('DEAD_LETTER');
  const letters = await deadLetters(orm);
  expect(letters[0].reason).toBe('ATTEMPTS_EXHAUSTED');
});

test('two workers never own the same attempt', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  const first = dispatchDueEvents({
    orm,
    registry: new ProviderRegistry([adapterWith()]),
    profileFor,
    owner: 'worker-a',
    now: clockAt(now0),
  });
  const second = dispatchDueEvents({
    orm: ormSecond,
    registry: new ProviderRegistry([adapterWith()]),
    profileFor,
    owner: 'worker-b',
    now: clockAt(now0),
  });
  const [a, b] = await Promise.all([first, second]);
  expect(a.acknowledged + b.acknowledged).toBe(1);
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.attempt_count).toBe(1);
  expect(event.status).toBe('ACKNOWLEDGED');
  const attempts = await forkTx(orm, (em) => listAttempts(em, seeded.row.id));
  expect(attempts).toHaveLength(1);
});

test('pending ACKs are idempotent and survive a rate limited attempt', async () => {
  await forkTx(orm, (em) => seedMappingFor(em));
  const { revisions } = await pullRevisions({});
  for (const revision of revisions)
    await forkTx(orm, (em) => storeChannelRevision(em, revision, storeOptions));
  const adapter = adapterWith({
    revisions: lifecycleSeeds('tiket-com'),
    failures: [
      { operation: 'acknowledgeRevision', kind: 'rate_limited', times: 1 },
    ],
  });
  const runtime = runtimeFor(adapter);
  const first = await processPendingAcks({
    orm,
    resolveTarget: runtime.resolveAckTarget.bind(runtime),
    now: clockAt(now0),
  });
  expect(first.processed).toBe(3);
  expect(first.sent).toBe(2);
  expect(first.retryable).toBe(1);
  const unknown = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, revisions[0].provider_revision_id),
  );
  expect(unknown.ack_state).toBe('UNKNOWN');
  expect(unknown.ack_attempt_count).toBe(1);
  const second = await processPendingAcks({
    orm,
    resolveTarget: runtime.resolveAckTarget.bind(runtime),
    now: clockAt('2026-09-13T00:00:02Z'),
  });
  expect(second.sent).toBe(1);
  const settled = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, revisions[0].provider_revision_id),
  );
  expect(settled.ack_state).toBe('SENT');
  const third = await processPendingAcks({
    orm,
    resolveTarget: runtime.resolveAckTarget.bind(runtime),
    now: clockAt('2026-09-13T00:00:03Z'),
  });
  expect(third.processed).toBe(0);
});

test('rejected ACK opens an exception without erasing the revision', async () => {
  await forkTx(orm, (em) => seedMappingFor(em));
  const { revisions } = await pullRevisions({});
  await forkTx(orm, (em) =>
    storeChannelRevision(em, revisions[0], storeOptions),
  );
  const adapter = adapterWith({
    revisions: lifecycleSeeds('tiket-com'),
    failures: [
      { operation: 'acknowledgeRevision', kind: 'auth_failed', times: 1 },
    ],
  });
  const runtime = runtimeFor(adapter);
  const summary = await processPendingAcks({
    orm,
    resolveTarget: runtime.resolveAckTarget.bind(runtime),
    now: clockAt(now0),
  });
  expect(summary.rejected).toBe(1);
  const inbox = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, revisions[0].provider_revision_id),
  );
  expect(inbox.ack_state).toBe('FAILED');
  expect(inbox.processing_state).toBe('APPLIED');
  const exceptions = await forkTx(orm, (em) =>
    listOpenExceptions(em, TENANT_ID, PROPERTY_ID),
  );
  expect(exceptions.map((row) => row.type)).toContain('ACK_REJECTED');
});

test('pull stores revisions and cursor atomically, and replays deduplicate', async () => {
  const adapter = adapterWith({ revisions: lifecycleSeeds('tiket-com') });
  const context = simulatorContext('tiket-com');
  const failingStore = async () => {
    failingStore.calls += 1;
    if (failingStore.calls === 2) throw new Error('synthetic store crash');
    return { status: 'APPLIED' };
  };
  failingStore.calls = 0;
  await expect(
    pullRevisionsOnce({
      orm,
      adapter,
      context,
      profile: simulatorTestProfile('tiket-com'),
      tenantId: TENANT_ID,
      propertyId: PROPERTY_ID,
      limit: 2,
      now: clockAt(now0),
      store: failingStore,
    }),
  ).rejects.toThrow('synthetic store crash');
  expect(await forkTx(orm, (em) => countInboxRevisions(em))).toBe(0);
  const empty = await forkTx(orm, (em) =>
    getCheckpoint(em, CONNECTION_ID, 'revisions'),
  );
  expect(empty).toBeNull();

  const realStore = (em, revision, options) =>
    storeChannelRevision(em, revision, options);
  const first = await pullRevisionsOnce({
    orm,
    adapter,
    context,
    profile: simulatorTestProfile('tiket-com'),
    tenantId: TENANT_ID,
    propertyId: PROPERTY_ID,
    limit: 2,
    now: clockAt(now0),
    store: realStore,
  });
  expect(first.stored).toBe(2);
  expect(await forkTx(orm, (em) => countInboxRevisions(em))).toBe(2);
  const second = await pullRevisionsOnce({
    orm,
    adapter,
    context,
    profile: simulatorTestProfile('tiket-com'),
    tenantId: TENANT_ID,
    propertyId: PROPERTY_ID,
    limit: 2,
    now: clockAt(now0),
    store: realStore,
  });
  expect(second.stored).toBe(1);
  const checkpoint = await forkTx(orm, (em) =>
    getCheckpoint(em, CONNECTION_ID, 'revisions'),
  );
  expect(checkpoint.cursor).toBeNull();
  const replay = await pullRevisionsOnce({
    orm,
    adapter,
    context,
    profile: simulatorTestProfile('tiket-com'),
    tenantId: TENANT_ID,
    propertyId: PROPERTY_ID,
    limit: 50,
    now: clockAt(now0),
    store: realStore,
  });
  expect(replay.statuses.every((status) => status === 'DUPLICATE')).toBe(true);
  expect(await forkTx(orm, (em) => countInboxRevisions(em))).toBe(3);
});

test('work survives a lost Redis because PostgreSQL is the source', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  const runtime = runtimeFor(adapterWith());
  const scheduler = await startDistributionScheduler({
    runtime,
    redisUrl: 'redis://127.0.0.1:1/0',
    intervalMs: 20,
  });
  expect(scheduler.mode).toBe('interval');
  await new Promise((resolve) => setTimeout(resolve, 150));
  await scheduler.stop();
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.status).toBe('ACKNOWLEDGED');
});

async function seedMappingFor(em) {
  const { upsertMapping } =
    await import('../../../packages/backend/dist/modules/distribution/persistence/mapping-repository.js');
  await upsertMapping(em, {
    connectionId: CONNECTION_ID,
    channelKey: 'tiket-com',
    externalRoomRef: 'ROOM-1',
    externalRateRef: 'RATE-1',
    occupancy: 2,
    mealPlanRef: null,
    internalProductRef: null,
    internalRateRef: null,
    effectiveAt: now0,
    status: 'ACTIVE',
    mappingVersion: 1,
  });
}
