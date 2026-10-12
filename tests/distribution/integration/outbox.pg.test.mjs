import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import {
  enqueueOutbox,
  leaseDueOutbox,
  nextAttemptNumber,
  registerDedup,
  startAttempt,
  updateOutboxResult,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import {
  CONNECTION_ID,
  PROPERTY_ID,
  TENANT_ID,
  forkTx,
  initOrm,
  resetAll,
  seedConnection,
} from './helpers.mjs';

let orm;
const aggregateId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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

function event(version = 1) {
  return {
    tenantId: TENANT_ID,
    propertyId: PROPERTY_ID,
    connectionId: CONNECTION_ID,
    channelKey: 'tiket-com',
    aggregateType: 'inventory',
    aggregateId,
    eventType: 'AvailabilitySnapshot',
    eventVersion: version,
    inventoryVersion: version,
    payloadSafe: { cells: [{ product_ref: 'ROOM-1', date: '2026-10-01' }] },
    nextAttemptAt: '2026-09-13T00:00:00Z',
  };
}

test('one logical outbox event regardless of enqueue attempts', async () => {
  const first = await forkTx(orm, (em) => enqueueOutbox(em, event()));
  const second = await forkTx(orm, (em) => enqueueOutbox(em, event()));
  expect(first.inserted).toBe(true);
  expect(second.inserted).toBe(false);
  expect(second.row.id).toBe(first.row.id);
  const nextVersion = await forkTx(orm, (em) => enqueueOutbox(em, event(2)));
  expect(nextVersion.inserted).toBe(true);
});

test('leasing is exclusive, expires, and retries the same event', async () => {
  await forkTx(orm, (em) => enqueueOutbox(em, event()));
  const now = '2026-09-13T00:00:00Z';
  const first = await forkTx(orm, (em) =>
    leaseDueOutbox(em, { owner: 'worker-a', limit: 10, now, leaseMs: 30000 }),
  );
  expect(first).toHaveLength(1);
  expect(first[0].status).toBe('LEASED');
  const second = await forkTx(orm, (em) =>
    leaseDueOutbox(em, { owner: 'worker-b', limit: 10, now, leaseMs: 30000 }),
  );
  expect(second).toHaveLength(0);
  const afterExpiry = '2026-09-13T00:01:00Z';
  const third = await forkTx(orm, (em) =>
    leaseDueOutbox(em, {
      owner: 'worker-b',
      limit: 10,
      now: afterExpiry,
      leaseMs: 30000,
    }),
  );
  expect(third).toHaveLength(1);
  expect(third[0].id).toBe(first[0].id);
  expect(third[0].lease_token).toEqual(expect.any(String));
  expect(third[0].lease_token).not.toBe(first[0].lease_token);

  await forkTx(orm, (em) =>
    startAttempt(em, {
      outboxId: third[0].id,
      attemptNo: 1,
      startedAt: afterExpiry,
    }),
  );
  await expect(
    forkTx(orm, (em) =>
      startAttempt(em, {
        outboxId: third[0].id,
        attemptNo: 1,
        startedAt: afterExpiry,
      }),
    ),
  ).rejects.toThrow();
  expect(await forkTx(orm, (em) => nextAttemptNumber(em, third[0].id))).toBe(2);

  const retryAt = '2026-09-13T00:02:00Z';
  await forkTx(orm, (em) =>
    updateOutboxResult(
      em,
      third[0].id,
      {
        status: 'RETRY_SCHEDULED',
        safeErrorCode: 'RATE_LIMITED',
        nextAttemptAt: retryAt,
        clearLease: true,
      },
      { fence: { owner: 'worker-b', token: third[0].lease_token } },
    ),
  );
  const beforeRetry = await forkTx(orm, (em) =>
    leaseDueOutbox(em, {
      owner: 'worker-a',
      limit: 10,
      now: '2026-09-13T00:01:30Z',
      leaseMs: 30000,
    }),
  );
  expect(beforeRetry).toHaveLength(0);
  const atRetry = await forkTx(orm, (em) =>
    leaseDueOutbox(em, {
      owner: 'worker-a',
      limit: 10,
      now: retryAt,
      leaseMs: 30000,
    }),
  );
  expect(atRetry).toHaveLength(1);
});

test('dedup separates new, identical replay and hash conflict', async () => {
  const input = {
    scope: 'conn:env',
    key: 'webhook-1',
    payloadHash: 'a'.repeat(64),
    inboxRevisionId: null,
  };
  const first = await forkTx(orm, (em) => registerDedup(em, input));
  const same = await forkTx(orm, (em) => registerDedup(em, input));
  const conflict = await forkTx(orm, (em) =>
    registerDedup(em, { ...input, payloadHash: 'b'.repeat(64) }),
  );
  expect(first.kind).toBe('new');
  expect(same.kind).toBe('duplicate');
  expect(conflict.kind).toBe('conflict');
  expect(conflict.row.payload_hash).toBe('a'.repeat(64));
});
