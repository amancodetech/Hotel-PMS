import { createOrm } from '../../../packages/backend/dist/persistence/orm.js';
import {
  SimulatorAdapter,
  SimulatorEngine,
  lifecycleScenario,
  realChannelKeys,
  simulatorAdapterVersion,
} from '../../../packages/backend/dist/modules/distribution/index.js';
import { insertConnection } from '../../../packages/backend/dist/modules/distribution/persistence/connection-repository.js';
import { upsertMapping } from '../../../packages/backend/dist/modules/distribution/persistence/mapping-repository.js';
import { enqueueOutbox } from '../../../packages/backend/dist/modules/distribution/persistence/outbox-repository.js';

export const TENANT_ID = '11111111-2222-4333-8444-666666666666';
export const PROPERTY_ID = '11111111-2222-4333-8444-777777777777';
export const CONNECTION_ID = '11111111-2222-4333-8444-555555555555';
export const SYNTHETIC_TIME = '2026-09-13T00:00:01Z';
export const storeOptions = {
  receivedAt: SYNTHETIC_TIME,
  tenantId: TENANT_ID,
  propertyId: PROPERTY_ID,
};

const truncateSql = `truncate table
  "distribution_dead_letter",
  "distribution_sync_checkpoint",
  "distribution_sync_attempt",
  "distribution_outbox_event",
  "distribution_dedup_key",
  "distribution_exception_case",
  "distribution_inbox_revision",
  "distribution_external_booking",
  "distribution_mapping_version",
  "distribution_channel_capability",
  "distribution_connection"
  cascade`;

export async function initOrm() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  return createOrm(url, { pool: { min: 0, max: 5 } });
}

export async function forkTx(orm, fn) {
  return orm.em.fork().transactional(async (em) => fn(em));
}

export async function resetAll(orm) {
  await orm.em.getConnection().execute(truncateSql, []);
}

export async function ensureTenant(em, tenantId) {
  await em.execute(
    `insert into "tenant" ("id", "name", "slug")
     values (?, ?, ?)
     on conflict ("id") do nothing`,
    [
      tenantId,
      `Synthetic ${tenantId.slice(0, 8)}`,
      `synthetic-${tenantId.replaceAll('-', '').slice(0, 24)}`,
    ],
  );
}

export async function ensureProperty(
  em,
  tenantId = TENANT_ID,
  propertyId = PROPERTY_ID,
) {
  await ensureTenant(em, tenantId);
  await em.execute(
    `insert into "property" ("id", "tenant_id", "code", "name", "timezone")
     values (?, ?, ?, ?, 'Asia/Jakarta')
     on conflict do nothing`,
    [
      propertyId,
      tenantId,
      `SYN-${propertyId.slice(0, 8)}`,
      `Synthetic property ${propertyId.slice(0, 8)}`,
    ],
  );
}

export async function seedConnection(em, overrides = {}) {
  await ensureProperty(
    em,
    overrides.tenantId ?? TENANT_ID,
    overrides.propertyId ?? PROPERTY_ID,
  );
  return insertConnection(em, {
    id: CONNECTION_ID,
    tenantId: TENANT_ID,
    propertyId: PROPERTY_ID,
    providerKey: 'simulator',
    environment: 'simulator',
    channelKey: 'tiket-com',
    externalPropertyId: 'EXT-1',
    secretRef: 'secret:synthetic',
    ...overrides,
  });
}

export async function seedMapping(em, overrides = {}) {
  return upsertMapping(em, {
    connectionId: CONNECTION_ID,
    channelKey: 'tiket-com',
    externalRoomRef: 'ROOM-1',
    externalRateRef: 'RATE-1',
    occupancy: 2,
    mealPlanRef: null,
    internalProductRef: null,
    internalRateRef: null,
    effectiveAt: SYNTHETIC_TIME,
    status: 'ACTIVE',
    mappingVersion: 1,
    ...overrides,
  });
}

export async function seedOutbox(
  em,
  {
    connectionId = CONNECTION_ID,
    tenantId = TENANT_ID,
    propertyId = PROPERTY_ID,
    eventType = 'AvailabilitySnapshot',
    eventVersion = 1,
    inventoryVersion = 1,
    channelKey = 'tiket-com',
    nextAttemptAt = '2026-09-13T00:00:00Z',
    aggregateId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    cells = [
      {
        product_ref: 'ROOM-1',
        date: '2026-10-01',
        available: 2,
        inventory_version: inventoryVersion,
      },
    ],
  } = {},
) {
  return enqueueOutbox(em, {
    tenantId,
    propertyId,
    connectionId,
    channelKey,
    aggregateType: 'inventory',
    aggregateId,
    eventType,
    eventVersion,
    inventoryVersion,
    payloadSafe: { schema_version: 1, cells },
    nextAttemptAt,
  });
}

export function simulatorContext(channelKey) {
  return {
    connection_id: CONNECTION_ID,
    tenant_id: TENANT_ID,
    property_id: PROPERTY_ID,
    provider_key: 'simulator',
    environment: 'simulator',
    channel_key: channelKey,
    secret_ref: 'secret:synthetic',
    external_property_id: 'EXT-1',
    adapter_version: simulatorAdapterVersion,
  };
}

export async function pullRevisions({
  channelKey = 'tiket-com',
  duplicateDeliveries = 0,
  deliveryOrder,
} = {}) {
  const engine = new SimulatorEngine(
    lifecycleScenario(channelKey, {
      duplicate_deliveries: duplicateDeliveries,
      ...(deliveryOrder ? { delivery_order: deliveryOrder } : {}),
    }),
  );
  const adapter = new SimulatorAdapter({
    engine,
    allowedChannelKeys: realChannelKeys(),
  });
  const context = simulatorContext(channelKey);
  const page = await adapter.pullRevisions(context, null, 50, {
    deadline_ms: 2000,
    correlation_id: 'P02-03-test',
  });
  return { engine, adapter, context, revisions: page.revisions };
}
