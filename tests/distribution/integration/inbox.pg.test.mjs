import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import {
  claimPendingAck,
  countInboxRevisions,
  findExternalBookingForUpdate,
  findInboxRevision,
  listOpenExceptions,
  reprocessInboxRevision,
  storeChannelRevision,
  updateAckResult,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import {
  CONNECTION_ID,
  initOrm,
  pullRevisions,
  resetAll,
  seedConnection,
  seedMapping,
  storeOptions,
  forkTx,
} from './helpers.mjs';

let orm;

beforeAll(async () => {
  orm = await initOrm();
});

afterAll(async () => {
  await orm?.close(true);
});

beforeEach(async () => {
  await resetAll(orm);
  await forkTx(orm, (em) => seedConnection(em));
  await forkTx(orm, (em) => seedMapping(em));
});

test('applies a new revision once and treats a replay hash-identically', async () => {
  const { revisions } = await pullRevisions({});
  const [first] = revisions;
  const applied = await forkTx(orm, (em) =>
    storeChannelRevision(em, first, storeOptions),
  );
  expect(applied.status).toBe('APPLIED');
  expect(applied.created).toBe(true);

  const booking = await forkTx(orm, (em) =>
    findExternalBookingForUpdate(em, CONNECTION_ID, first.external_booking_id),
  );
  expect(booking.state).toBe('ACTIVE');
  expect(booking.latest_revision_id).toBe(first.provider_revision_id);

  const inbox = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, first.provider_revision_id),
  );
  expect(inbox.processing_state).toBe('APPLIED');
  expect(inbox.ack_state).toBe('PENDING');

  const replay = await forkTx(orm, (em) =>
    storeChannelRevision(em, first, storeOptions),
  );
  expect(replay.status).toBe('DUPLICATE');
  expect(replay.created).toBe(false);
  expect(await forkTx(orm, (em) => countInboxRevisions(em))).toBe(1);
  const bookingAfter = await forkTx(orm, (em) =>
    findExternalBookingForUpdate(em, CONNECTION_ID, first.external_booking_id),
  );
  expect(bookingAfter.version).toBe(booking.version);
  expect(bookingAfter.latest_revision_id).toBe(first.provider_revision_id);
});

test('same revision id with different payload quarantines instead of overwriting', async () => {
  const { revisions } = await pullRevisions({});
  const [first] = revisions;
  await forkTx(orm, (em) => storeChannelRevision(em, first, storeOptions));
  const tampered = {
    ...first,
    payload_hash: 'f'.repeat(64),
    amount_total: '999.00',
  };
  const conflict = await forkTx(orm, (em) =>
    storeChannelRevision(em, tampered, storeOptions),
  );
  expect(conflict.status).toBe('REPLAY_CONFLICT');
  expect(conflict.created).toBe(false);
  const stored = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, first.provider_revision_id),
  );
  expect(stored.payload_hash).toBe(first.payload_hash);
  expect(stored.payload_safe.amount_total).toBe('1250000.50');
  const exceptions = await forkTx(orm, (em) =>
    listOpenExceptions(em, storeOptions.tenantId, storeOptions.propertyId),
  );
  expect(exceptions).toHaveLength(1);
  expect(exceptions[0].type).toBe('DUPLICATE_REVISION_HASH_CONFLICT');
});

test('missing mapping stores the revision as a resumable exception', async () => {
  await resetAll(orm);
  await forkTx(orm, (em) => seedConnection(em));
  const { revisions } = await pullRevisions({});
  const [first] = revisions;
  const result = await forkTx(orm, (em) =>
    storeChannelRevision(em, first, storeOptions),
  );
  expect(result.status).toBe('EXCEPTION');
  const inbox = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, first.provider_revision_id),
  );
  expect(inbox.processing_state).toBe('EXCEPTION');
  expect(inbox.ack_state).toBe('PENDING');
  const exceptions = await forkTx(orm, (em) =>
    listOpenExceptions(em, storeOptions.tenantId, storeOptions.propertyId),
  );
  expect(exceptions[0].type).toBe('MAPPING_MISSING');

  await forkTx(orm, (em) => seedMapping(em));
  const resumed = await forkTx(orm, (em) =>
    reprocessInboxRevision(em, result.inboxId, storeOptions),
  );
  expect(resumed.processing_state).toBe('APPLIED');
  const booking = await forkTx(orm, (em) =>
    findExternalBookingForUpdate(em, CONNECTION_ID, first.external_booking_id),
  );
  expect(booking.state).toBe('ACTIVE');
});

test('out-of-order delivery never revives a cancelled booking', async () => {
  const { revisions } = await pullRevisions({
    deliveryOrder: ['tiket-com-R3', 'tiket-com-R2', 'tiket-com-R1'],
  });
  const results = [];
  for (const revision of revisions)
    results.push(
      await forkTx(orm, (em) =>
        storeChannelRevision(em, revision, storeOptions),
      ),
    );
  expect(results.map((result) => result.status)).toEqual([
    'APPLIED',
    'IGNORED_STALE',
    'IGNORED_STALE',
  ]);
  const booking = await forkTx(orm, (em) =>
    findExternalBookingForUpdate(em, CONNECTION_ID, 'SYNTH-tiket-com-1'),
  );
  expect(booking.state).toBe('CANCELLED');
  expect(booking.latest_revision_id).toBe('tiket-com-R3');
});

test('crash before commit leaves no partial state', async () => {
  const { revisions } = await pullRevisions({});
  const [first] = revisions;
  await expect(
    forkTx(orm, async (em) => {
      await storeChannelRevision(em, first, storeOptions);
      throw new Error('synthetic-crash');
    }),
  ).rejects.toThrow('synthetic-crash');
  expect(await forkTx(orm, (em) => countInboxRevisions(em))).toBe(0);
  const booking = await forkTx(orm, (em) =>
    findExternalBookingForUpdate(em, CONNECTION_ID, first.external_booking_id),
  );
  expect(booking).toBeNull();
});

test('crash after commit before ACK resumes from a durable fenced lease', async () => {
  const { revisions } = await pullRevisions({});
  const [first] = revisions;
  await forkTx(orm, (em) => storeChannelRevision(em, first, storeOptions));
  const at = '2026-09-13T00:00:10Z';
  const firstClaim = await forkTx(orm, (em) =>
    claimPendingAck(em, {
      owner: 'worker-a',
      limit: 10,
      maxAttempts: 4,
      now: at,
      leaseMs: 1000,
    }),
  );
  expect(firstClaim).toHaveLength(1);
  expect(firstClaim[0].provider_revision_id).toBe(first.provider_revision_id);
  expect(firstClaim[0].ack_attempt_count).toBe(1);
  expect(firstClaim[0].ack_lease_token).toEqual(expect.any(String));
  const whileLeased = await forkTx(orm, (em) =>
    claimPendingAck(em, {
      owner: 'worker-b',
      limit: 10,
      maxAttempts: 4,
      now: at,
      leaseMs: 1000,
    }),
  );
  expect(whileLeased).toHaveLength(0);
  const reclaimAt = '2026-09-13T00:00:12Z';
  const reclaimed = await forkTx(orm, (em) =>
    claimPendingAck(em, {
      owner: 'worker-b',
      limit: 10,
      maxAttempts: 4,
      now: reclaimAt,
      leaseMs: 1000,
    }),
  );
  expect(reclaimed).toHaveLength(1);
  expect(reclaimed[0].ack_attempt_count).toBe(2);
  const stale = await forkTx(orm, (em) =>
    updateAckResult(em, reclaimed[0].id, firstClaim[0].ack_lease_token, {
      ackState: 'SENT',
      ackProviderRequestId: 'stale-worker',
      ackNextAttemptAt: null,
    }),
  );
  expect(stale).toBeNull();
  const settled = await forkTx(orm, (em) =>
    updateAckResult(em, reclaimed[0].id, reclaimed[0].ack_lease_token, {
      ackState: 'SENT',
      ackProviderRequestId: 'sim-ack-1',
      ackNextAttemptAt: null,
    }),
  );
  expect(settled.ack_state).toBe('SENT');
  expect(settled.ack_attempt_count).toBe(2);
  const after = await forkTx(orm, (em) =>
    claimPendingAck(em, {
      owner: 'worker-c',
      limit: 10,
      maxAttempts: 4,
      now: reclaimAt,
      leaseMs: 1000,
    }),
  );
  expect(after).toHaveLength(0);
  const inbox = await forkTx(orm, (em) =>
    findInboxRevision(em, CONNECTION_ID, first.provider_revision_id),
  );
  expect(inbox.ack_state).toBe('SENT');
  expect(inbox.processing_state).toBe('APPLIED');
});
