import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { PropertyError } from '../domain/errors.js';
import {
  assertCode,
  assertIsoDate,
  assertName,
  assertPoolTransition,
  assertPropertyConfigurable,
  isPoolStatus,
  isResourceKind,
  type PoolStatus,
  type ResourceKind,
} from '../domain/lifecycle.js';
import { auditActor, authorize } from './context.js';
import type { ServiceContext } from './context.js';
import {
  endPoolMember,
  findPool,
  findPoolMember,
  insertPool,
  insertPoolMember,
  listPoolMembers,
  listPools,
  updatePool,
} from '../persistence/pool-repository.js';
import {
  findPropertyView,
  lockProperty,
} from '../persistence/property-repository.js';
import { findResource } from '../persistence/resource-repository.js';
import { translatePropertyWrite } from '../persistence/db.js';
import type { InventoryPoolRow, PoolMemberRow } from '../persistence/types.js';

export interface PoolInput {
  code: string;
  name: string;
  resourceType: ResourceKind;
}

export interface PoolPatch {
  version: number;
  name?: string;
  status?: PoolStatus;
}

function poolAudit(pool: InventoryPoolRow): Record<string, unknown> {
  return {
    code: pool.code,
    name: pool.name,
    resource_type: pool.resource_type,
    status: pool.status,
    version: pool.version,
  };
}

function memberAudit(member: PoolMemberRow): Record<string, unknown> {
  return {
    pool_id: member.pool_id,
    resource_id: member.resource_id,
    resource_type: member.resource_type,
    effective_from: member.effective_from,
    effective_to: member.effective_to,
  };
}

export async function readPools(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<InventoryPoolRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const property = await findPropertyView(em, context.tenantId, propertyId);
      if (!property) throw new PropertyError('NOT_FOUND');
      return listPools(em, context.tenantId, propertyId);
    },
  );
}

export async function createPool(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: PoolInput,
): Promise<InventoryPoolRow> {
  const code = assertCode(input.code, 80);
  const name = assertName(input.name);
  if (!isResourceKind(input.resourceType))
    throw new PropertyError('INVALID_REQUEST', { field: 'resource_type' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const pool = await translatePropertyWrite(() =>
        insertPool(em, {
          tenantId: context.tenantId,
          propertyId,
          code,
          name,
          resourceType: input.resourceType,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'pool.created',
        resourceType: 'InventoryPool',
        resourceId: pool.id,
        outcome: 'SUCCESS',
        afterSafe: poolAudit(pool),
        correlationId: context.correlationId,
      });
      return pool;
    },
  );
}

export async function updatePoolById(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  poolId: string,
  patch: PoolPatch,
): Promise<InventoryPoolRow> {
  const name = patch.name === undefined ? undefined : assertName(patch.name);
  if (patch.status !== undefined && !isPoolStatus(patch.status))
    throw new PropertyError('INVALID_REQUEST', { field: 'status' });
  if (!Number.isInteger(patch.version) || patch.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const current = await findPool(em, context.tenantId, propertyId, poolId);
      if (!current) throw new PropertyError('NOT_FOUND');
      if (patch.status !== undefined)
        assertPoolTransition(current.status, patch.status);
      const updated = await updatePool(em, {
        tenantId: context.tenantId,
        propertyId,
        poolId,
        version: patch.version,
        name,
        status: patch.status,
      });
      if (!updated) throw new PropertyError('STALE_VERSION');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'pool.updated',
        resourceType: 'InventoryPool',
        resourceId: poolId,
        outcome: 'SUCCESS',
        beforeSafe: poolAudit(current),
        afterSafe: poolAudit(updated),
        correlationId: context.correlationId,
      });
      return updated;
    },
  );
}

export async function readPoolMembers(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  poolId: string,
): Promise<PoolMemberRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.read', propertyId);
      const pool = await findPool(em, context.tenantId, propertyId, poolId);
      if (!pool) throw new PropertyError('NOT_FOUND');
      return listPoolMembers(em, context.tenantId, propertyId, poolId);
    },
  );
}

export async function addPoolMember(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  poolId: string,
  input: { resourceId: string; effectiveFrom?: string },
): Promise<PoolMemberRow> {
  const effectiveFrom = input.effectiveFrom
    ? assertIsoDate(input.effectiveFrom, 'effective_from')
    : new Date().toISOString().slice(0, 10);
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const pool = await findPool(em, context.tenantId, propertyId, poolId);
      if (!pool) throw new PropertyError('NOT_FOUND');
      const resource = await findResource(
        em,
        context.tenantId,
        propertyId,
        input.resourceId,
      );
      if (!resource) throw new PropertyError('NOT_FOUND');
      if (resource.state === 'RETIRED')
        throw new PropertyError('RESOURCE_RETIRED');
      if (resource.resource_type !== pool.resource_type)
        throw new PropertyError('TYPE_MISMATCH', {
          pool_type: pool.resource_type,
          resource_type: resource.resource_type,
        });
      const member = await translatePropertyWrite(() =>
        insertPoolMember(em, {
          tenantId: context.tenantId,
          propertyId,
          poolId,
          resourceId: input.resourceId,
          resourceType: resource.resource_type,
          effectiveFrom,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'pool.member_added',
        resourceType: 'InventoryPool',
        resourceId: poolId,
        outcome: 'SUCCESS',
        afterSafe: memberAudit(member),
        correlationId: context.correlationId,
      });
      return member;
    },
  );
}

export async function endPoolMemberById(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  poolId: string,
  resourceId: string,
  effectiveTo: string,
): Promise<PoolMemberRow> {
  assertIsoDate(effectiveTo, 'effective_to');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'property.resource.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const current = await findPoolMember(
        em,
        context.tenantId,
        propertyId,
        poolId,
        resourceId,
      );
      if (!current) throw new PropertyError('NOT_FOUND');
      if (effectiveTo < current.effective_from)
        throw new PropertyError('INVALID_REQUEST', { field: 'effective_to' });
      const updated = await endPoolMember(em, {
        tenantId: context.tenantId,
        propertyId,
        poolId,
        resourceId,
        effectiveTo,
      });
      if (!updated) throw new PropertyError('NOT_FOUND');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'pool.member_ended',
        resourceType: 'InventoryPool',
        resourceId: poolId,
        outcome: 'SUCCESS',
        beforeSafe: memberAudit(current),
        afterSafe: memberAudit(updated),
        correlationId: context.correlationId,
      });
      return updated;
    },
  );
}
