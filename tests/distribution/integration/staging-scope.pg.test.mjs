import { afterAll, beforeAll, expect, test } from '@jest/globals';
import {
  insertInboxRevision,
  leaseDueOutbox,
  processPendingAcks,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import {
  CONNECTION_ID,
  TENANT_ID,
  PROPERTY_ID,
  forkTx,
  initOrm,
  resetAll,
  seedConnection,
  seedOutbox,
} from './helpers.mjs';
let orm;
beforeAll(async () => {
  orm = await initOrm();
  await resetAll(orm);
});
afterAll(async () => {
  await orm?.close(true);
});
const otherConnection = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
const foreignConnection = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000003';
const foreignTenant = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000004';
const foreignProperty = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000005';
const now = '2026-10-11T00:00:00Z';
test('scoped leasing and full ACK processing preserve same-tenant and foreign pending/exhausted work', async () => {
  for (const [connectionId, tenantId, propertyId] of [
    [CONNECTION_ID, TENANT_ID, PROPERTY_ID],
    [otherConnection, TENANT_ID, PROPERTY_ID],
    [foreignConnection, foreignTenant, foreignProperty],
  ]) {
    await forkTx(orm, async (em) => {
      await seedConnection(em, {
        id: connectionId,
        tenantId,
        propertyId,
        externalPropertyId: `EXT-SCOPED-${connectionId}`,
      });
      await seedOutbox(em, { connectionId, tenantId, propertyId });
      for (const kind of ['pending', 'legacy', 'expired']) {
        const inserted = await insertInboxRevision(em, {
          connectionId,
          channelKey: 'tiket-com',
          providerKey: 'simulator',
          environment: 'simulator',
          providerRevisionId: kind,
          externalBookingId: `synthetic-${kind}`,
          revisionType: 'new',
          payloadHash: 'a'.repeat(64),
          payloadSafe: {},
          sourceSequence: null,
          sourceTime: null,
          receivedAt: now,
        });
        if (kind !== 'pending')
          await em.execute(
            'update distribution_inbox_revision set ack_attempt_count=4, ack_lease_expires_at=? where id=?',
            [
              kind === 'expired' ? '2026-10-10T00:00:00Z' : null,
              inserted.row.id,
            ],
          );
      }
    });
  }
  const snapshot = () =>
    forkTx(orm, async (em) => ({
      outbox: await em.execute(
        'select * from distribution_outbox_event where connection_id<>? order by id',
        [CONNECTION_ID],
      ),
      inbox: await em.execute(
        'select * from distribution_inbox_revision where connection_id<>? order by id',
        [CONNECTION_ID],
      ),
      exceptions: await em.execute(
        'select * from distribution_exception_case where connection_id<>? order by id',
        [CONNECTION_ID],
      ),
    }));
  const before = await snapshot();
  const leased = await forkTx(orm, (em) =>
    leaseDueOutbox(em, {
      connectionId: CONNECTION_ID,
      owner: 'scoped-staging-test',
      now,
      leaseMs: 1000,
      limit: 10,
    }),
  );
  expect(leased).toHaveLength(1);
  expect(leased[0].connection_id).toBe(CONNECTION_ID);
  const acked = [];
  const summary = await processPendingAcks({
    orm,
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    owner: 'scoped-staging-test',
    now: () => now,
    maxAttempts: 4,
    resolveTarget: async (connectionId) => {
      expect(connectionId).toBe(CONNECTION_ID);
      return {
        tenantId: TENANT_ID,
        propertyId: PROPERTY_ID,
        context: {},
        profile: {},
        adapter: {
          acknowledgeRevision: async (_context, revisionId) => {
            acked.push(revisionId);
            return {
              certainty: 'PROVIDER_ACCEPTED',
              provider_request_id: null,
              observed_at: now,
              safe_error_code: null,
              retry_after_ms: null,
            };
          },
        },
      };
    },
  });
  expect(summary).toMatchObject({ sent: 1, recovered: 1, exhausted: 1 });
  expect(acked).toEqual(['pending']);
  expect(await snapshot()).toEqual(before);
  const selected = await forkTx(orm, (em) =>
    em.execute(
      'select provider_revision_id, ack_state, ack_exception_id from distribution_inbox_revision where connection_id=? order by provider_revision_id',
      [CONNECTION_ID],
    ),
  );
  expect(
    selected.find((row) => row.provider_revision_id === 'pending').ack_state,
  ).toBe('SENT');
  for (const kind of ['legacy', 'expired'])
    expect(
      selected.find((row) => row.provider_revision_id === kind)
        .ack_exception_id,
    ).toBeTruthy();
});
