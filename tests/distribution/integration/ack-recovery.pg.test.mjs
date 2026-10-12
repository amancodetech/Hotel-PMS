import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { createOrm } from '../../../packages/backend/dist/persistence/orm.js';
import {
  DistributionRuntime,
  ProviderRegistry,
  SimulatorAdapter,
  SimulatorEngine,
  claimPendingAck,
  findInboxRevision,
  lifecycleSeeds,
  listOpenExceptions,
  processPendingAcks,
  realChannelKeys,
  requeueExhaustedAck,
  simulatorTestProfile,
  storeChannelRevision,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import {
  CONNECTION_ID,
  PROPERTY_ID,
  TENANT_ID,
  forkTx,
  initOrm,
  pullRevisions,
  resetAll,
  seedConnection,
  seedMapping,
  storeOptions,
} from './helpers.mjs';

let orm;
let ormSecond;
const now0 = '2026-09-13T00:00:00Z';
const clockAt = (value) => () => value;

function adapterWith(options = {}) {
  return new SimulatorAdapter({
    engine: new SimulatorEngine({
      seed: 'R2',
      start_time: now0,
      revisions: lifecycleSeeds('tiket-com'),
      ...options,
    }),
    allowedChannelKeys: realChannelKeys(),
  });
}

function runtimeFor(adapter, targetOrm = orm) {
  return new DistributionRuntime({
    orm: targetOrm,
    registry: new ProviderRegistry([adapter]),
    profileFor: (context) => simulatorTestProfile(context.channel_key),
    owner: 'ack-regression',
  });
}

function countingAdapter(seed) {
  return new (class CountingAdapter extends SimulatorAdapter {
    calls = [];
    async acknowledgeRevision(context, providerRevisionId, meta) {
      this.calls.push(providerRevisionId);
      return super.acknowledgeRevision(context, providerRevisionId, meta);
    }
  })({
    engine: new SimulatorEngine({
      seed,
      start_time: now0,
      revisions: lifecycleSeeds('tiket-com'),
    }),
    allowedChannelKeys: realChannelKeys(),
  });
}

async function seedRevisions(count = 3) {
  await forkTx(orm, (em) => seedMapping(em));
  const { revisions } = await pullRevisions({});
  for (const revision of revisions.slice(0, count))
    await forkTx(orm, (em) => storeChannelRevision(em, revision, storeOptions));
  return revisions;
}

async function waitFor(condition, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
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

test('two workers never share an ACK claim while a send is in flight', async () => {
  await seedRevisions(1);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = runtimeFor(adapterWith());
  const base = runtime.resolveAckTarget.bind(runtime);
  const hangingTarget = async (connectionId) => {
    const target = await base(connectionId);
    if (!target) return target;
    return {
      ...target,
      adapter: {
        acknowledgeRevision: async (...args) => {
          await gate;
          return target.adapter.acknowledgeRevision(...args);
        },
      },
    };
  };
  const inFlight = processPendingAcks({
    orm,
    resolveTarget: hangingTarget,
    owner: 'worker-a',
    leaseMs: 60_000,
    now: clockAt(now0),
  });
  await waitFor(async () => {
    const row = await forkTx(orm, (em) =>
      findInboxRevision(em, CONNECTION_ID, 'tiket-com-R1'),
    );
    return row?.ack_attempt_count === 1 && row.ack_lease_owner === 'worker-a';
  });
  const second = await processPendingAcks({
    orm: ormSecond,
    resolveTarget: base,
    owner: 'worker-b',
    leaseMs: 60_000,
    now: clockAt(now0),
  });
  expect(second.processed).toBe(0);
  release();
  const first = await inFlight;
  expect(first.processed).toBe(1);
  expect(first.sent).toBe(1);
});

test('a crashed worker after send is recovered by a later tick', async () => {
  await seedRevisions();
  const runtime = runtimeFor(adapterWith());
  const claimed = await forkTx(orm, (em) =>
    claimPendingAck(em, {
      owner: 'worker-a',
      limit: 10,
      maxAttempts: 4,
      now: now0,
      leaseMs: 1000,
    }),
  );
  expect(claimed).toHaveLength(3);
  const summary = await processPendingAcks({
    orm,
    resolveTarget: (connectionId) => runtime.resolveAckTarget(connectionId),
    owner: 'worker-b',
    now: clockAt('2026-09-13T00:00:02Z'),
  });
  expect(summary.processed).toBe(3);
  expect(summary.sent).toBe(3);
  const row = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, 'tiket-com-R1'),
  );
  expect(row.ack_state).toBe('SENT');
  expect(row.ack_attempt_count).toBe(2);
});

test('an abandoned final attempt is swept into a permanent exception and can be requeued', async () => {
  await seedRevisions(1);
  const runtime = runtimeFor(adapterWith());
  const claimed = await forkTx(orm, (em) =>
    claimPendingAck(em, {
      owner: 'worker-a',
      limit: 10,
      maxAttempts: 1,
      now: now0,
      leaseMs: 1000,
    }),
  );
  expect(claimed).toHaveLength(1);
  const summary = await processPendingAcks({
    orm,
    resolveTarget: (connectionId) => runtime.resolveAckTarget(connectionId),
    owner: 'worker-b',
    maxAttempts: 1,
    now: clockAt('2026-09-13T00:00:02Z'),
  });
  expect(summary.exhausted).toBe(1);
  expect(summary.processed).toBe(0);
  const exhausted = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, 'tiket-com-R1'),
  );
  expect(exhausted.ack_state).toBe('UNKNOWN');
  expect(exhausted.ack_attempt_count).toBe(1);
  expect(exhausted.ack_lease_owner).toBeNull();
  const exceptions = await forkTx(orm, (em) =>
    listOpenExceptions(em, TENANT_ID, PROPERTY_ID),
  );
  expect(exceptions.map((row) => row.type)).toContain('ACK_EXHAUSTED');

  await expect(
    requeueExhaustedAck({
      orm,
      inboxRevisionId: claimed[0].id,
      by: '',
      reason: '',
    }),
  ).rejects.toThrow('actor');
  const requeued = await requeueExhaustedAck({
    orm,
    inboxRevisionId: claimed[0].id,
    by: 'ops-synthetic',
    reason: 'reviewed exhausted ack in regression test',
  });
  expect(requeued.ack_state).toBe('PENDING');
  expect(requeued.ack_attempt_count).toBe(0);
  expect(requeued.ack_lease_owner).toBeNull();

  const retried = await processPendingAcks({
    orm,
    resolveTarget: (connectionId) => runtime.resolveAckTarget(connectionId),
    owner: 'worker-c',
    maxAttempts: 1,
    now: clockAt('2026-09-13T00:00:03Z'),
  });
  expect(retried.sent).toBe(1);
});

test('rate limited ACKs respect retry_after before the next attempt', async () => {
  await seedRevisions();
  const adapter = adapterWith({
    failures: [
      { operation: 'acknowledgeRevision', kind: 'rate_limited', times: 1 },
    ],
  });
  const runtime = runtimeFor(adapter);
  const resolveTarget = (connectionId) =>
    runtime.resolveAckTarget(connectionId);
  const first = await processPendingAcks({
    orm,
    resolveTarget,
    owner: 'worker-a',
    now: clockAt(now0),
  });
  expect(first.sent).toBe(2);
  expect(first.retryable).toBe(1);
  const row = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, 'tiket-com-R1'),
  );
  expect(row.ack_state).toBe('UNKNOWN');
  expect(Date.parse(row.ack_next_attempt_at)).toBe(Date.parse(now0) + 1000);
  const early = await processPendingAcks({
    orm,
    resolveTarget,
    owner: 'worker-b',
    now: clockAt('2026-09-13T00:00:00.500Z'),
  });
  expect(early.processed).toBe(0);
  const late = await processPendingAcks({
    orm,
    resolveTarget,
    owner: 'worker-c',
    now: clockAt('2026-09-13T00:00:01.001Z'),
  });
  expect(late.sent).toBe(1);
});

test('a batch item is skipped when its ownership moved before its send', async () => {
  await seedRevisions(2);
  const adapterB = countingAdapter('R2-batch-b');
  const runtimeB = runtimeFor(adapterB, ormSecond);
  let summaryB = null;
  class ReclaimingAdapter extends SimulatorAdapter {
    calls = [];
    async acknowledgeRevision(context, providerRevisionId, meta) {
      this.calls.push(providerRevisionId);
      if (this.calls.length === 1)
        summaryB = await processPendingAcks({
          orm: ormSecond,
          resolveTarget: (connectionId) =>
            runtimeB.resolveAckTarget(connectionId),
          owner: 'worker-b',
          leaseMs: 60_000,
          now: clockAt('2026-09-13T00:00:02Z'),
        });
      return super.acknowledgeRevision(context, providerRevisionId, meta);
    }
  }
  const adapterA = new ReclaimingAdapter({
    engine: new SimulatorEngine({
      seed: 'R2-batch-a',
      start_time: now0,
      revisions: lifecycleSeeds('tiket-com'),
    }),
    allowedChannelKeys: realChannelKeys(),
  });
  const runtimeA = runtimeFor(adapterA);
  const summaryA = await processPendingAcks({
    orm,
    resolveTarget: (connectionId) => runtimeA.resolveAckTarget(connectionId),
    owner: 'worker-a',
    limit: 2,
    leaseMs: 1000,
    now: clockAt(now0),
  });
  expect(summaryA.processed).toBe(1);
  expect(summaryA.sent).toBe(0);
  expect(summaryA.lost).toBe(2);
  expect(adapterA.calls).toEqual(['tiket-com-R1']);
  expect(summaryB.processed).toBe(2);
  expect(summaryB.sent).toBe(2);
  expect(adapterB.calls).toEqual(
    expect.arrayContaining(['tiket-com-R1', 'tiket-com-R2']),
  );
  expect(adapterB.calls).toHaveLength(2);
  const second = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, 'tiket-com-R2'),
  );
  expect(second.ack_state).toBe('SENT');
});

test('an expired ACK lease without a successor is renewed and sent once', async () => {
  await seedRevisions(1);
  const claimed = await forkTx(orm, (em) =>
    claimPendingAck(em, {
      owner: 'worker-a',
      limit: 1,
      maxAttempts: 4,
      now: now0,
      leaseMs: 1000,
    }),
  );
  expect(claimed).toHaveLength(1);
  const adapter = countingAdapter('R2-renew');
  const runtime = runtimeFor(adapter);
  const summary = await processPendingAcks({
    orm,
    resolveTarget: (connectionId) => runtime.resolveAckTarget(connectionId),
    owner: 'worker-a',
    leaseMs: 30_000,
    now: clockAt('2026-09-13T00:00:02Z'),
  });
  expect(summary.processed).toBe(1);
  expect(summary.sent).toBe(1);
  expect(summary.lost).toBe(0);
  expect(adapter.calls).toEqual(['tiket-com-R1']);
  const row = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, 'tiket-com-R1'),
  );
  expect(row.ack_state).toBe('SENT');
  expect(row.ack_attempt_count).toBe(2);
});
