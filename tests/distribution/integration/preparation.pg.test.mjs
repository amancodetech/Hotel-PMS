import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import {
  ProviderRegistry,
  SimulatorAdapter,
  SimulatorEngine,
  deadLetters,
  dispatchDueEvents,
  findOutbox,
  listAttempts,
  listOpenExceptions,
  realChannelKeys,
  simulatorTestProfile,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import {
  PROPERTY_ID,
  TENANT_ID,
  forkTx,
  initOrm,
  resetAll,
  seedConnection,
  seedOutbox,
} from './helpers.mjs';

let orm;
const now0 = '2026-09-13T00:00:00Z';
const clockAt = (value) => () => value;

const defaultProfile = (context) => simulatorTestProfile(context.channel_key);

function adapterWith(options = {}) {
  return new SimulatorAdapter({
    engine: new SimulatorEngine({ seed: 'R6', start_time: now0, ...options }),
    allowedChannelKeys: realChannelKeys(),
  });
}

async function dispatch(adapter, extra = {}) {
  return dispatchDueEvents({
    orm,
    registry: new ProviderRegistry([adapter]),
    profileFor: defaultProfile,
    owner: 'integration-test',
    ...extra,
  });
}

beforeAll(async () => {
  orm = await initOrm();
});

afterAll(async () => {
  await orm?.close(true);
});

beforeEach(async () => {
  await resetAll(orm);
  await forkTx(orm, (em) => seedConnection(em));
});

test('an invalid payload is dead-lettered once with a preparation attempt', async () => {
  const seeded = await forkTx(orm, (em) =>
    seedOutbox(em, { cells: [{ invalid: true }] }),
  );
  const summary = await dispatch(adapterWith(), {
    now: clockAt(now0),
    maxAttempts: 2,
  });
  expect(summary.deadLettered).toBe(1);
  expect(summary.retried).toBe(0);
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.status).toBe('DEAD_LETTER');
  expect(event.attempt_count).toBe(1);
  const attempts = await forkTx(orm, (em) => listAttempts(em, seeded.row.id));
  expect(attempts).toHaveLength(1);
  expect(attempts[0].status).toBe('REJECTED');
  expect(attempts[0].response_safe.phase).toBe('PREPARATION');
  const letters = await deadLetters(orm);
  expect(letters).toHaveLength(1);
  expect(letters[0].reason).toBe('PREPARATION_FAILED');
  const exceptions = await forkTx(orm, (em) =>
    listOpenExceptions(em, TENANT_ID, PROPERTY_ID),
  );
  expect(exceptions.map((row) => row.type)).toContain('PREPARATION_FAILED');
  const second = await dispatch(adapterWith(), {
    now: clockAt('2026-09-13T00:01:00Z'),
    maxAttempts: 2,
  });
  expect(second.leased).toBe(0);
});

test('a missing provider is isolated instead of retried forever', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  const summary = await dispatchDueEvents({
    orm,
    registry: new ProviderRegistry([]),
    profileFor: defaultProfile,
    owner: 'integration-test',
    now: clockAt(now0),
    maxAttempts: 3,
  });
  expect(summary.deadLettered).toBe(1);
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.status).toBe('DEAD_LETTER');
  expect(event.last_safe_error_code).toBe('UNSUPPORTED');
  const letters = await deadLetters(orm);
  expect(letters[0].reason).toBe('PREPARATION_FAILED');
});

test('temporary preparation failures retry within the attempt budget', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  let calls = 0;
  const flakyProfile = (context) => {
    calls += 1;
    if (calls === 1) throw new Error('synthetic profile outage');
    return simulatorTestProfile(context.channel_key);
  };
  const first = await dispatch(adapterWith(), {
    now: clockAt(now0),
    maxAttempts: 2,
    profileFor: flakyProfile,
  });
  expect(first.retried).toBe(1);
  expect(first.deadLettered).toBe(0);
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.status).toBe('RETRY_SCHEDULED');
  expect(event.attempt_count).toBe(1);
  const attempts = await forkTx(orm, (em) => listAttempts(em, seeded.row.id));
  expect(attempts[0].status).toBe('FAILED');
  expect(attempts[0].response_safe.phase).toBe('PREPARATION');
  const second = await dispatch(adapterWith(), {
    now: clockAt(event.next_attempt_at),
    maxAttempts: 2,
    profileFor: flakyProfile,
  });
  expect(second.acknowledged).toBe(1);
});

test('poison events stop consuming ticks after their preparation failure', async () => {
  const poison = await forkTx(orm, (em) =>
    seedOutbox(em, {
      cells: [{ bad: true }],
      aggregateId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
      nextAttemptAt: now0,
    }),
  );
  const healthy = await forkTx(orm, (em) =>
    seedOutbox(em, {
      aggregateId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2',
      nextAttemptAt: '2026-09-13T00:00:01Z',
    }),
  );
  const first = await dispatch(adapterWith(), {
    now: clockAt('2026-09-13T00:00:02Z'),
    maxAttempts: 2,
    limit: 1,
  });
  expect(first.leased).toBe(1);
  expect(first.deadLettered).toBe(1);
  const second = await dispatch(adapterWith(), {
    now: clockAt('2026-09-13T00:00:02Z'),
    maxAttempts: 2,
    limit: 1,
  });
  expect(second.acknowledged).toBe(1);
  const third = await dispatch(adapterWith(), {
    now: clockAt('2026-09-13T00:00:03Z'),
    maxAttempts: 2,
    limit: 1,
  });
  expect(third.leased).toBe(0);
  const poisonEvent = await forkTx(orm, (em) => findOutbox(em, poison.row.id));
  const healthyEvent = await forkTx(orm, (em) =>
    findOutbox(em, healthy.row.id),
  );
  expect(poisonEvent.status).toBe('DEAD_LETTER');
  expect(healthyEvent.status).toBe('ACKNOWLEDGED');
});

test('provider warning text and refs never reach the stored attempt', async () => {
  const seeded = await forkTx(orm, (em) => seedOutbox(em));
  class CanaryAdapter extends SimulatorAdapter {
    async pushAvailability(_context, snapshot) {
      return {
        schema_version: 1,
        provider_request_id: 'guest@example.test#4111111111111111',
        provider_task_id: null,
        observed_at: now0,
        certainty: 'PARTIAL',
        safe_error_code: 'UNKNOWN',
        retry_after_ms: null,
        warnings: ['4111111111111111', 'Synthetic Guest', 'CELL_DELAYED'],
        cell_results: snapshot.cells.map((cell) => ({
          cell_key: `${cell.product_ref}:${cell.date}`,
          status: 'UNKNOWN',
          safe_error_code: 'UNKNOWN',
        })),
      };
    }
  }
  const summary = await dispatch(
    new CanaryAdapter({
      engine: new SimulatorEngine({ seed: 'R5', start_time: now0 }),
      allowedChannelKeys: realChannelKeys(),
    }),
    { now: clockAt(now0) },
  );
  expect(summary.partial).toBe(1);
  const attempts = await forkTx(orm, (em) => listAttempts(em, seeded.row.id));
  const serialized = JSON.stringify(attempts[0].response_safe);
  expect(serialized).not.toContain('guest@example.test');
  expect(serialized).not.toContain('4111111111111111');
  expect(serialized).not.toContain('Synthetic Guest');
  expect(serialized).toContain('UNRECOGNIZED_PROVIDER_WARNING');
  expect(serialized).toContain('CELL_DELAYED');
  const event = await forkTx(orm, (em) => findOutbox(em, seeded.row.id));
  expect(event.provider_request_id).toMatch(/^ref-[0-9a-f]{16}$/);
  expect(event.provider_request_id).not.toContain('4111');
});
