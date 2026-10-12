import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import { createOrm } from '../../../packages/backend/dist/persistence/orm.js';
import {
  ProviderRegistry,
  SimulatorAdapter,
  SimulatorEngine,
  deadLetters,
  dispatchDueEvents,
  findOutbox,
  incrementOutboxAttempt,
  leaseDueOutbox,
  listAttempts,
  realChannelKeys,
  renewOutboxLease,
  simulatorTestProfile,
  updateOutboxResult,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import {
  forkTx,
  initOrm,
  resetAll,
  seedConnection,
  seedOutbox,
} from './helpers.mjs';

let orm;
let ormSecond;
const now0 = '2026-09-13T00:00:00Z';
const afterLease = '2026-09-13T00:00:02Z';
const clockAt = (value) => () => value;

const profileFor = (context) => simulatorTestProfile(context.channel_key);

function simulator(options = {}) {
  return new SimulatorAdapter({
    engine: new SimulatorEngine({ seed: 'R1', start_time: now0, ...options }),
    allowedChannelKeys: realChannelKeys(),
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

test('a reclaimed event cannot be overwritten by the expired owner', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  const [first] = await forkTx(orm, (em) =>
    leaseDueOutbox(em, {
      owner: 'worker-a',
      limit: 1,
      now: now0,
      leaseMs: 1000,
    }),
  );
  const [second] = await forkTx(orm, (em) =>
    leaseDueOutbox(em, {
      owner: 'worker-b',
      limit: 1,
      now: afterLease,
      leaseMs: 60_000,
    }),
  );
  expect(second.lease_token).toEqual(expect.any(String));
  expect(second.lease_token).not.toBe(first.lease_token);

  const stale = await forkTx(orm, (em) =>
    updateOutboxResult(
      em,
      seeded.row.id,
      { status: 'ACKNOWLEDGED', clearLease: true },
      { fence: { owner: 'worker-a', token: first.lease_token } },
    ),
  );
  expect(stale).toBeNull();
  const current = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(current.status).toBe('LEASED');
  expect(current.lease_owner).toBe('worker-b');
  expect(current.lease_token).toBe(second.lease_token);

  const accepted = await forkTx(orm, (em) =>
    updateOutboxResult(
      em,
      seeded.row.id,
      { status: 'ACKNOWLEDGED', clearLease: true },
      { fence: { owner: 'worker-b', token: second.lease_token } },
    ),
  );
  expect(accepted.status).toBe('ACKNOWLEDGED');
  expect(accepted.lease_token).toBeNull();
});

test('an expired owner cannot increment attempts or renew a newer lease', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  const [first] = await forkTx(orm, (em) =>
    leaseDueOutbox(em, {
      owner: 'worker-a',
      limit: 1,
      now: now0,
      leaseMs: 1000,
    }),
  );
  const [second] = await forkTx(orm, (em) =>
    leaseDueOutbox(em, {
      owner: 'worker-b',
      limit: 1,
      now: afterLease,
      leaseMs: 1000,
    }),
  );
  const staleIncrement = await forkTx(orm, (em) =>
    incrementOutboxAttempt(em, seeded.row.id, {
      owner: 'worker-a',
      token: first.lease_token,
    }),
  );
  expect(staleIncrement).toBeNull();
  const staleRenew = await forkTx(orm, (em) =>
    renewOutboxLease(em, {
      id: seeded.row.id,
      owner: 'worker-a',
      token: first.lease_token,
      now: afterLease,
      leaseMs: 1000,
    }),
  );
  expect(staleRenew).toBeNull();
  const ownerRenew = await forkTx(orm, (em) =>
    renewOutboxLease(em, {
      id: seeded.row.id,
      owner: 'worker-b',
      token: second.lease_token,
      now: afterLease,
      leaseMs: 60_000,
    }),
  );
  expect(ownerRenew).not.toBeNull();
  const row = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(row.attempt_count).toBe(0);
  expect(row.lease_owner).toBe('worker-b');
});

test('a slow worker that lost its lease cannot overwrite the newer result', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  const rejecting = simulator({
    failures: [
      { operation: 'pushAvailability', kind: 'validation_rejected', times: 1 },
    ],
  });
  class SlowAdapter extends SimulatorAdapter {
    async pushAvailability(context, snapshot) {
      await dispatchDueEvents({
        orm: ormSecond,
        registry: new ProviderRegistry([rejecting]),
        profileFor,
        owner: 'worker-b',
        leaseMs: 60_000,
        now: clockAt(afterLease),
      });
      return {
        schema_version: 1,
        provider_request_id: 'slow-worker-a',
        provider_task_id: null,
        observed_at: afterLease,
        certainty: 'PROVIDER_ACCEPTED',
        safe_error_code: null,
        retry_after_ms: null,
        warnings: [],
        cell_results: snapshot.cells.map((cell) => ({
          cell_key: `${cell.product_ref}:${cell.date}`,
          status: 'ACCEPTED',
          safe_error_code: null,
        })),
      };
    }
  }
  const slow = new SlowAdapter({
    engine: new SimulatorEngine({ seed: 'R1-slow', start_time: now0 }),
    allowedChannelKeys: realChannelKeys(),
  });
  const summary = await dispatchDueEvents({
    orm,
    registry: new ProviderRegistry([slow]),
    profileFor,
    owner: 'worker-a',
    leaseMs: 1000,
    now: clockAt(now0),
  });
  expect(summary.lost).toBe(1);
  expect(summary.acknowledged).toBe(0);
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.status).toBe('DEAD_LETTER');
  expect(event.provider_request_id).not.toBe('slow-worker-a');
  const attempts = await forkTx(orm, (em) => listAttempts(em, seeded.row.id));
  expect(attempts).toHaveLength(2);
  const letters = await deadLetters(orm);
  expect(letters).toHaveLength(1);
  expect(letters[0].reason).toBe('REJECTED_BY_PROVIDER');
});

test('events reclaimed while waiting in the batch are skipped, not sent', async () => {
  const first = await forkTx(orm, (em) =>
    seedOutbox(em, { aggregateId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1' }),
  );
  const second = await forkTx(orm, (em) =>
    seedOutbox(em, { aggregateId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2' }),
  );
  class ReclaimingAdapter extends SimulatorAdapter {
    calls = 0;
    async pushAvailability(context, snapshot, meta) {
      this.calls += 1;
      if (this.calls === 1)
        await forkTx(ormSecond, (em) =>
          leaseDueOutbox(em, {
            owner: 'worker-b',
            limit: 10,
            now: afterLease,
            leaseMs: 60_000,
          }),
        );
      return super.pushAvailability(context, snapshot, meta);
    }
  }
  const adapter = new ReclaimingAdapter({
    engine: new SimulatorEngine({ seed: 'R1-batch', start_time: now0 }),
    allowedChannelKeys: realChannelKeys(),
  });
  const summary = await dispatchDueEvents({
    orm,
    registry: new ProviderRegistry([adapter]),
    profileFor,
    owner: 'worker-a',
    limit: 2,
    leaseMs: 1000,
    now: clockAt(now0),
  });
  expect(summary.leased).toBe(2);
  expect(summary.acknowledged).toBe(0);
  expect(summary.retried).toBe(0);
  expect(summary.deadLettered).toBe(0);
  expect(summary.lost).toBe(2);
  for (const seeded of [first, second]) {
    const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
    expect(event.status).toBe('LEASED');
    expect(event.lease_owner).toBe('worker-b');
  }
  const counts = await Promise.all(
    [first, second].map(async (seeded) => {
      const attempts = await forkTx(orm, (em) =>
        listAttempts(em, seeded.row.id),
      );
      return attempts.length;
    }),
  );
  expect(counts.sort()).toEqual([0, 1]);
});
