import { afterAll, beforeAll, beforeEach, expect, test } from '@jest/globals';
import {
  DistributionRuntime,
  ProviderRegistry,
  countInboxRevisions,
  dispatchDueEvents,
  findInboxRevision,
  findOutbox,
  processPendingAcks,
  pullRevisionsOnce,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import {
  AlternateAdapter,
  alternateAdapterVersion,
  alternateProfile,
  alternateProviderKey,
} from '../support/alternate-adapter.mjs';
import {
  CONNECTION_ID,
  initOrm,
  resetAll,
  seedConnection,
  seedMapping,
  seedOutbox,
  simulatorContext,
  TENANT_ID,
  PROPERTY_ID,
} from './helpers.mjs';

let orm;
let alternate;
const context = {
  ...simulatorContext('test-sixth-channel'),
  provider_key: alternateProviderKey,
  environment: 'test',
  secret_ref: 'secret:alternate',
  adapter_version: alternateAdapterVersion,
};
const profileFor = () => alternateProfile();

beforeAll(async () => {
  orm = await initOrm();
});

afterAll(async () => {
  await orm?.close(true);
});

beforeEach(async () => {
  await resetAll(orm);
  await orm.em.fork().transactional(async (em) => {
    await seedConnection(em, {
      providerKey: alternateProviderKey,
      environment: 'test',
      channelKey: 'test-sixth-channel',
      externalPropertyId: 'ALT-EXT-1',
      secretRef: 'secret:alternate',
    });
    await seedMapping(em, { channelKey: 'test-sixth-channel' });
  });
  alternate = new AlternateAdapter();
});

function registry() {
  return new ProviderRegistry([alternate]);
}

test('dispatcher works through an alternate adapter without Channex', async () => {
  const seeded = await orm.em.fork().transactional((em) =>
    seedOutbox(em, {
      channelKey: 'test-sixth-channel',
      nextAttemptAt: '2026-09-13T00:00:00Z',
    }),
  );
  const summary = await dispatchDueEvents({
    orm,
    registry: registry(),
    profileFor,
    owner: 'alternate-worker',
    now: () => '2026-09-13T00:00:00Z',
  });
  expect(summary.acknowledged).toBe(1);
  const event = await orm.em
    .fork()
    .transactional((em) => findOutbox(em, seeded.row.id));
  expect(event.status).toBe('ACKNOWLEDGED');
});

test('pull and ack run through the alternate adapter', async () => {
  const pulled = await pullRevisionsOnce({
    orm,
    adapter: alternate,
    context,
    profile: alternateProfile(),
    tenantId: TENANT_ID,
    propertyId: PROPERTY_ID,
    limit: 2,
    now: () => '2026-09-13T00:00:01Z',
  });
  expect(pulled.stored).toBe(2);
  const second = await pullRevisionsOnce({
    orm,
    adapter: alternate,
    context,
    profile: alternateProfile(),
    tenantId: TENANT_ID,
    propertyId: PROPERTY_ID,
    limit: 2,
    now: () => '2026-09-13T00:00:01Z',
  });
  expect(second.stored).toBe(1);
  const count = await orm.em
    .fork()
    .transactional((em) => countInboxRevisions(em));
  expect(count).toBe(3);
  const runtime = new DistributionRuntime({
    orm,
    registry: registry(),
    profileFor,
    owner: 'alternate-worker',
  });
  const acked = await processPendingAcks({
    orm,
    resolveTarget: (connectionId) => runtime.resolveAckTarget(connectionId),
    now: () => '2026-09-13T00:00:02Z',
  });
  expect(acked.sent).toBe(3);
  expect(alternate.acked).toHaveLength(3);
  const inbox = await orm.em
    .fork()
    .transactional((em) => findInboxRevision(em, CONNECTION_ID, 'ALT-R1'));
  expect(inbox.ack_state).toBe('SENT');
});
