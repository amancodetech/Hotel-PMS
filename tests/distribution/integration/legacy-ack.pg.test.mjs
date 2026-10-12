import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { createOrm } from '../../../packages/backend/dist/persistence/orm.js';
import {
  DistributionRuntime,
  ProviderRegistry,
  findInboxRevision,
  listDistributionWorkTenants,
  processPendingAcks,
  requeueExhaustedAck,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import {
  AlternateAdapter,
  alternateProfile,
} from '../support/alternate-adapter.mjs';
import { legacyAckFixture } from './legacy-ack-fixtures.mjs';

const databaseUrl = process.env.TEST_LEGACY_ACK_DATABASE_URL;
const registration = databaseUrl ? test : test.skip;
const now = (value) => () => value;
const fixture = legacyAckFixture;

let ormA;
let ormB;
let workerOrm;
let adapter;

beforeAll(async () => {
  if (!databaseUrl) return;
  ormA = await createOrm(databaseUrl, { pool: { min: 0, max: 3 } });
  ormB = await createOrm(databaseUrl, { pool: { min: 0, max: 3 } });
  const workerUrl = new URL(process.env.WORKER_DATABASE_URL);
  workerUrl.pathname = new URL(databaseUrl).pathname;
  workerOrm = await createOrm(workerUrl.href, { pool: { min: 0, max: 3 } });
  adapter = new AlternateAdapter();
});

afterAll(async () => {
  await workerOrm?.close(true);
  await ormB?.close(true);
  await ormA?.close(true);
});

function runtimeFor(orm) {
  return new DistributionRuntime({
    orm,
    registry: new ProviderRegistry([adapter]),
    profileFor: (context) => alternateProfile(context.channel_key),
    owner: 'legacy-recovery',
  });
}

function loadRevision(orm, providerRevisionId) {
  return orm.em
    .fork()
    .transactional((em) =>
      findInboxRevision(em, fixture.connectionId, providerRevisionId),
    );
}

async function countOpenExhausted(orm, inboxRevisionId) {
  const rows = await orm.em.fork().execute(
    `select count(*)::int as count from "distribution_exception_case"
     where "inbox_revision_id" = ? and "type" = 'ACK_EXHAUSTED'
       and "state" in ('OPEN', 'IN_PROGRESS')`,
    [inboxRevisionId],
  );
  return rows[0].count;
}

registration(
  'competing workers recover legacy ACK exhaustion exactly once after upgrade',
  async () => {
    expect(ormA).not.toBeNull();
    const runtimeA = runtimeFor(ormA);
    const runtimeB = runtimeFor(ormB);
    const at = '2026-09-13T00:00:10Z';
    const [first, second] = await Promise.all([
      processPendingAcks({
        orm: ormA,
        resolveTarget: (connectionId) =>
          runtimeA.resolveAckTarget(connectionId),
        owner: 'worker-a',
        maxAttempts: 4,
        now: now(at),
      }),
      processPendingAcks({
        orm: ormB,
        resolveTarget: (connectionId) =>
          runtimeB.resolveAckTarget(connectionId),
        owner: 'worker-b',
        maxAttempts: 4,
        now: now(at),
      }),
    ]);
    expect(first.recovered + second.recovered).toBe(3);
    expect(first.processed + second.processed).toBe(1);
    expect(first.sent + second.sent).toBe(1);
    expect(adapter.acked).toEqual([
      fixture.revisions.retryable.providerRevisionId,
    ]);

    const exhausted = await loadRevision(
      ormA,
      fixture.revisions.exhausted.providerRevisionId,
    );
    expect(exhausted.ack_state).toBe('UNKNOWN');
    expect(exhausted.ack_attempt_count).toBe(4);
    expect(exhausted.ack_exception_id).toEqual(expect.any(String));
    expect(exhausted.exception_id).toBeNull();
    expect(await countOpenExhausted(ormA, exhausted.id)).toBe(1);

    const withException = await loadRevision(
      ormA,
      fixture.revisions.exhaustedWithException.providerRevisionId,
    );
    expect(withException.ack_exception_id).toBe(fixture.existingExceptionId);
    expect(withException.exception_id).toBe(fixture.existingExceptionId);
    expect(await countOpenExhausted(ormA, withException.id)).toBe(1);

    const unlinked = await loadRevision(
      ormA,
      fixture.revisions.exhaustedWithUnlinkedException.providerRevisionId,
    );
    expect(unlinked.ack_exception_id).toBe(fixture.unlinkedAckExceptionId);
    expect(unlinked.exception_id).toBeNull();
    expect(await countOpenExhausted(ormA, unlinked.id)).toBe(1);

    const withMapping = await loadRevision(
      ormA,
      fixture.revisions.exhaustedWithMappingException.providerRevisionId,
    );
    expect(withMapping.processing_state).toBe('EXCEPTION');
    expect(withMapping.exception_id).toBe(fixture.mappingExceptionId);
    expect(withMapping.ack_exception_id).toEqual(expect.any(String));
    expect(withMapping.ack_exception_id).not.toBe(fixture.mappingExceptionId);
    expect(await countOpenExhausted(ormA, withMapping.id)).toBe(1);

    const sent = await loadRevision(
      ormA,
      fixture.revisions.sent.providerRevisionId,
    );
    expect(sent.ack_state).toBe('SENT');
    expect(sent.ack_attempt_count).toBe(1);

    const failed = await loadRevision(
      ormA,
      fixture.revisions.failed.providerRevisionId,
    );
    expect(failed.ack_state).toBe('FAILED');
    expect(failed.ack_attempt_count).toBe(1);

    const retryable = await loadRevision(
      ormA,
      fixture.revisions.retryable.providerRevisionId,
    );
    expect(retryable.ack_state).toBe('SENT');
    expect(retryable.ack_attempt_count).toBe(2);

    const repeat = await processPendingAcks({
      orm: ormA,
      resolveTarget: (connectionId) => runtimeA.resolveAckTarget(connectionId),
      owner: 'worker-c',
      maxAttempts: 4,
      now: now('2026-09-13T00:00:15Z'),
    });
    expect(repeat.recovered).toBe(0);
    expect(repeat.processed).toBe(0);
    for (const revision of [exhausted, withException, unlinked, withMapping])
      expect(await countOpenExhausted(ormA, revision.id)).toBe(1);

    await expect(
      requeueExhaustedAck({
        orm: ormA,
        inboxRevisionId: withMapping.id,
        by: '',
        reason: '',
      }),
    ).rejects.toThrow('actor');
    const requeued = await requeueExhaustedAck({
      orm: ormA,
      inboxRevisionId: withMapping.id,
      by: 'ops-synthetic',
      reason: 'legacy mapping fix reviewed',
    });
    expect(requeued.ack_state).toBe('PENDING');
    expect(requeued.ack_attempt_count).toBe(0);
    expect(requeued.ack_exception_id).toBeNull();
    expect(requeued.exception_id).toBe(fixture.mappingExceptionId);
    const audit = await ormA.em.fork().execute(
      `select count(*)::int as count from "distribution_exception_case"
       where "inbox_revision_id" = ? and "type" = 'ACK_REQUEUED'`,
      [withMapping.id],
    );
    expect(audit[0].count).toBe(1);

    const third = await processPendingAcks({
      orm: ormA,
      resolveTarget: (connectionId) => runtimeA.resolveAckTarget(connectionId),
      owner: 'worker-d',
      maxAttempts: 4,
      now: now('2026-09-13T00:00:20Z'),
    });
    expect(third.processed).toBe(1);
    expect(third.sent).toBe(1);
    const recovered = await loadRevision(
      ormA,
      fixture.revisions.exhaustedWithMappingException.providerRevisionId,
    );
    expect(recovered.ack_state).toBe('SENT');
    expect(recovered.ack_attempt_count).toBe(1);
    expect(recovered.processing_state).toBe('EXCEPTION');
    expect(recovered.exception_id).toBe(fixture.mappingExceptionId);
    expect(await countOpenExhausted(ormA, recovered.id)).toBe(1);
    const mapping = await ormA.em
      .fork()
      .execute(
        `select state from "distribution_exception_case" where "id" = ?`,
        [fixture.mappingExceptionId],
      );
    expect(mapping[0].state).toBe('OPEN');
    expect(adapter.acked).toContain(
      fixture.revisions.exhaustedWithMappingException.providerRevisionId,
    );
  },
);

registration(
  'worker-role runtime discovers and recovers an exhausted ACK on the upgraded schema',
  async () => {
    const providerRevisionId = `LEGACY-WORKER-${randomUUID().slice(0, 8)}`;
    const inboxId = randomUUID();
    await ormA.em.getConnection().execute(
      `insert into "distribution_inbox_revision"
         ("id","connection_id","property_id","channel_key","provider_key",
          "environment","provider_revision_id","external_booking_id",
          "revision_type","payload_hash","payload_safe","received_at",
          "ack_state","ack_attempt_count","ack_next_attempt_at")
       values (?, ?, (select "property_id" from "distribution_connection" where "id" = ?),
               'test-sixth-channel', 'test-alternate', 'test', ?,
               'LEGACY-WORKER-BOOKING', 'new', repeat('e', 64), '{}'::jsonb,
               now(), 'PENDING', 4, null)`,
      [inboxId, fixture.connectionId, fixture.connectionId, providerRevisionId],
    );
    const discovered = await listDistributionWorkTenants(workerOrm, 4);
    expect(discovered).toContain(fixture.tenantId);
    const runtime = runtimeFor(workerOrm);
    const first = await runtime.tick();
    expect(first.ack.recovered).toBeGreaterThanOrEqual(1);
    const exceptions = await ormA.em.getConnection().execute(
      `select count(*)::int as count from "distribution_exception_case"
        where "inbox_revision_id" = ? and "type" = 'ACK_EXHAUSTED'`,
      [inboxId],
    );
    expect(exceptions[0].count).toBe(1);
    const second = await runtime.tick();
    expect(second.ack.recovered).toBe(0);
    const again = await ormA.em.getConnection().execute(
      `select count(*)::int as count from "distribution_exception_case"
        where "inbox_revision_id" = ? and "type" = 'ACK_EXHAUSTED'`,
      [inboxId],
    );
    expect(again[0].count).toBe(1);
    const after = await listDistributionWorkTenants(workerOrm, 4);
    expect(after).not.toContain(fixture.tenantId);
  },
);
