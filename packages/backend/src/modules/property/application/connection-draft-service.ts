import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import {
  findConnection,
  insertConnection,
  listConnections,
} from '../../distribution/persistence/connection-repository.js';
import { listCapabilitiesForConnection } from '../../distribution/persistence/capability-repository.js';
import {
  listMappingsForConnection,
  upsertMapping,
} from '../../distribution/persistence/mapping-repository.js';
import type {
  CapabilityRow,
  ConnectionRow,
  MappingRow,
} from '../../distribution/persistence/index.js';
import { PropertyError } from '../domain/errors.js';
import { auditActor, authorize } from './context.js';
import type { ServiceContext } from './context.js';
import { findProduct } from '../persistence/product-repository.js';
import { findRatePlan } from '../../inventory/persistence/rate-repository.js';
import {
  findPropertyView,
  lockProperty,
} from '../persistence/property-repository.js';
import { translatePropertyWrite } from '../persistence/db.js';

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const secretRefPattern = /^(secret|vault|env|local|aws-sm):[A-Za-z0-9._/-]+$/;

function assertKey(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 64 || !keyPattern.test(trimmed))
    throw new PropertyError('INVALID_REQUEST', { field });
  return trimmed;
}

function assertRef(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200)
    throw new PropertyError('INVALID_REQUEST', { field });
  return trimmed;
}

export interface ConnectionInput {
  providerKey: string;
  environment: string;
  channelKey: string;
  externalPropertyId: string | null;
  secretRef: string;
}

export interface MappingInput {
  channelKey: string;
  externalRoomRef: string;
  externalRateRef: string;
  occupancy: number;
  mealPlanRef: string | null;
  internalProductRef: string | null;
  internalRateRef: string | null;
}

export async function readConnections(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<ConnectionRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'channel.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      return listConnections(em, context.tenantId, propertyId);
    },
  );
}

export async function createConnectionDraft(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: ConnectionInput,
): Promise<ConnectionRow> {
  const providerKey = assertKey(input.providerKey, 'provider_key');
  const environment = assertKey(input.environment, 'environment');
  const channelKey = assertKey(input.channelKey, 'channel_key');
  const secretRef = input.secretRef.trim();
  if (
    secretRef.length < 3 ||
    secretRef.length > 200 ||
    !secretRefPattern.test(secretRef)
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'secret_ref' });
  const externalPropertyId =
    input.externalPropertyId === null
      ? null
      : assertRef(input.externalPropertyId, 'external_property_id');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'channel.connection.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      if (property.status === 'ARCHIVED')
        throw new PropertyError('PROPERTY_ARCHIVED');
      const connection = await translatePropertyWrite(() =>
        insertConnection(em, {
          tenantId: context.tenantId,
          propertyId,
          providerKey,
          environment,
          channelKey,
          externalPropertyId,
          secretRef,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'connection.draft_created',
        resourceType: 'Connection',
        resourceId: connection.id,
        outcome: 'SUCCESS',
        afterSafe: {
          provider_key: connection.provider_key,
          environment: connection.environment,
          channel_key: connection.channel_key,
          status: connection.status,
          secret_ref_set: true,
        },
        correlationId: context.correlationId,
      });
      return connection;
    },
  );
}

async function withScopedConnection<T>(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  connectionId: string,
  permission: 'channel.read' | 'channel.mapping.manage',
  work: (em: EntityManager, connection: ConnectionRow) => Promise<T>,
): Promise<T> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, permission, propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      const connection = await findConnection(em, connectionId);
      if (
        !connection ||
        connection.tenant_id !== context.tenantId ||
        connection.property_id !== propertyId
      )
        throw new PropertyError('NOT_FOUND');
      return work(em, connection);
    },
  );
}

export async function readConnectionCapabilities(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  connectionId: string,
): Promise<CapabilityRow[]> {
  return withScopedConnection(
    orm,
    context,
    propertyId,
    connectionId,
    'channel.read',
    (em) => listCapabilitiesForConnection(em, connectionId),
  );
}

export async function readConnectionMappings(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  connectionId: string,
): Promise<MappingRow[]> {
  return withScopedConnection(
    orm,
    context,
    propertyId,
    connectionId,
    'channel.read',
    (em) => listMappingsForConnection(em, connectionId),
  );
}

export async function saveMappingDraft(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  connectionId: string,
  input: MappingInput,
): Promise<MappingRow> {
  const channelKey = assertKey(input.channelKey, 'channel_key');
  const externalRoomRef = assertRef(input.externalRoomRef, 'external_room_ref');
  const externalRateRef = assertRef(input.externalRateRef, 'external_rate_ref');
  if (
    !Number.isInteger(input.occupancy) ||
    input.occupancy < 1 ||
    input.occupancy > 100
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'occupancy' });
  const mealPlanRef =
    input.mealPlanRef === null
      ? null
      : assertRef(input.mealPlanRef, 'meal_plan_ref');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'channel.mapping.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      if (property.status === 'ARCHIVED')
        throw new PropertyError('PROPERTY_ARCHIVED');
      const connection = await findConnection(em, connectionId);
      if (
        !connection ||
        connection.tenant_id !== context.tenantId ||
        connection.property_id !== propertyId
      )
        throw new PropertyError('NOT_FOUND');
      if (connection.channel_key !== channelKey)
        throw new PropertyError('INVALID_REQUEST', { field: 'channel_key' });
      if (input.internalProductRef) {
        const product = await findProduct(
          em,
          context.tenantId,
          propertyId,
          input.internalProductRef,
        );
        if (!product) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      }
      if (input.internalRateRef) {
        const ratePlan = await findRatePlan(
          em,
          context.tenantId,
          propertyId,
          input.internalRateRef,
        );
        if (!ratePlan) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        if (ratePlan.status === 'RETIRED')
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            from: ratePlan.status,
            to: 'ACTIVE',
          });
        if (
          input.internalProductRef &&
          input.internalProductRef !== ratePlan.product_id
        )
          throw new PropertyError('INVALID_REQUEST', {
            field: 'internal_rate_ref',
            reason: 'product_mismatch',
          });
      }
      const mapping = await translatePropertyWrite(() =>
        upsertMapping(em, {
          connectionId,
          channelKey,
          externalRoomRef,
          externalRateRef,
          occupancy: input.occupancy,
          mealPlanRef,
          internalProductRef: input.internalProductRef,
          internalRateRef: input.internalRateRef,
          effectiveAt: new Date().toISOString(),
          status: 'DRAFT',
          mappingVersion: 1,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'mapping.draft_saved',
        resourceType: 'MappingVersion',
        resourceId: mapping.id,
        outcome: 'SUCCESS',
        afterSafe: {
          connection_id: connectionId,
          channel_key: mapping.channel_key,
          external_room_ref: mapping.external_room_ref,
          external_rate_ref: mapping.external_rate_ref,
          occupancy: mapping.occupancy,
          internal_product_ref: mapping.internal_product_ref,
          internal_rate_ref: mapping.internal_rate_ref,
          status: mapping.status,
        },
        correlationId: context.correlationId,
      });
      return mapping;
    },
  );
}
