import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { applyInventoryTimeouts } from './timeouts.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import {
  assertIsoDate,
  assertSafeText,
} from '../../property/domain/lifecycle.js';
import {
  findResource,
  listDescendantResources,
} from '../../property/persistence/resource-repository.js';
import {
  bumpPropertyInventoryVersion,
  lockProperty,
} from '../../property/persistence/property-repository.js';
import {
  expireDueHolds,
  findBlock,
  insertBlockResources,
  insertDisruption,
  insertInventoryBlock,
  listAllocationConflictsForResources,
  listAssignedAllocationConflictsForResources,
  listBlocks,
  listDisruptions,
  releaseBlockById,
  resolveDisruptionsForBlock,
} from '../persistence/guarantee-repository.js';
import type {
  InventoryBlockRow,
  InventoryDisruptionRow,
  PlanAllocationRow,
} from '../persistence/guarantee-repository.js';

export interface BlockInput {
  resourceIds: string[];
  period: { arrival: string; departure: string };
  reason: string;
  mode: 'PLANNED' | 'EMERGENCY';
}

interface EmergencyDisruptionSource {
  allocationId: string;
  resourceId: string;
  startDate: string;
  endDate: string;
}

async function listEmergencyDisruptionSources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceIds: readonly string[],
  arrival: string,
  departure: string,
  allocationConflicts: readonly PlanAllocationRow[],
): Promise<EmergencyDisruptionSource[]> {
  const sources: EmergencyDisruptionSource[] = allocationConflicts.map(
    (row) => ({
      allocationId: row.id,
      resourceId: row.resource_id,
      startDate: row.start_date,
      endDate: row.end_date,
    }),
  );
  const seen = new Set(sources.map((source) => source.allocationId));
  const assigned = await listAssignedAllocationConflictsForResources(
    em,
    tenantId,
    propertyId,
    resourceIds,
    arrival,
    departure,
  );
  for (const row of assigned) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    sources.push({
      allocationId: row.id,
      resourceId: row.assigned_resource_id,
      startDate: row.start_date,
      endDate: row.end_date,
    });
  }
  return sources;
}

function assertBlockInput(input: BlockInput): void {
  if (
    !Array.isArray(input.resourceIds) ||
    input.resourceIds.length < 1 ||
    input.resourceIds.length > 100
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'resource_ids' });
  if (new Set(input.resourceIds).size !== input.resourceIds.length)
    throw new PropertyError('INVALID_REQUEST', { field: 'resource_ids' });
  assertIsoDate(input.period.arrival, 'period.arrival');
  assertIsoDate(input.period.departure, 'period.departure');
  if (input.period.departure <= input.period.arrival)
    throw new PropertyError('INVALID_REQUEST', { field: 'period' });
  assertSafeText(input.reason, 'reason');
  if (input.mode !== 'PLANNED' && input.mode !== 'EMERGENCY')
    throw new PropertyError('INVALID_REQUEST', { field: 'mode' });
}

export async function createBlock(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: BlockInput,
): Promise<{
  block: InventoryBlockRow;
  disruptions: InventoryDisruptionRow[];
}> {
  assertBlockInput(input);
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'inventory.block', propertyId);
      if (input.mode === 'EMERGENCY')
        await authorize(em, context, 'maintenance.emergency', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      for (const resourceId of input.resourceIds) {
        const resource = await findResource(
          em,
          context.tenantId,
          propertyId,
          resourceId,
        );
        if (!resource) throw new PropertyError('NOT_FOUND');
        if (resource.state === 'RETIRED')
          throw new PropertyError('RESOURCE_RETIRED');
      }
      await expireDueHolds(em, context.tenantId, propertyId);
      const descendants = await listDescendantResources(
        em,
        context.tenantId,
        propertyId,
        input.resourceIds,
      );
      const coveredResourceIds =
        descendants.length > 0
          ? descendants.map((row) => row.id)
          : [...input.resourceIds];
      const conflicts = await listAllocationConflictsForResources(
        em,
        context.tenantId,
        propertyId,
        coveredResourceIds,
        input.period.arrival,
        input.period.departure,
      );
      if (input.mode === 'PLANNED' && conflicts.length > 0)
        throw new PropertyError('BLOCK_CONFLICT', {
          allocation_ids: conflicts.map((row) => row.id),
        });
      const disruptionSources =
        input.mode === 'EMERGENCY'
          ? await listEmergencyDisruptionSources(
              em,
              context.tenantId,
              propertyId,
              coveredResourceIds,
              input.period.arrival,
              input.period.departure,
              conflicts,
            )
          : [];
      const block = await insertInventoryBlock(em, {
        tenantId: context.tenantId,
        propertyId,
        mode: input.mode,
        reason: input.reason.trim(),
        startDate: input.period.arrival,
        endDate: input.period.departure,
      });
      await insertBlockResources(em, {
        blockId: block.id,
        tenantId: context.tenantId,
        propertyId,
        resourceIds: coveredResourceIds,
      });
      const disruptions: InventoryDisruptionRow[] = [];
      for (const source of disruptionSources) {
        disruptions.push(
          await insertDisruption(em, {
            tenantId: context.tenantId,
            propertyId,
            blockId: block.id,
            allocationId: source.allocationId,
            resourceId: source.resourceId,
            startDate: source.startDate,
            endDate: source.endDate,
            note: input.reason.trim(),
          }),
        );
      }
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action:
          input.mode === 'EMERGENCY'
            ? 'block.emergency_created'
            : 'block.created',
        resourceType: 'InventoryBlock',
        resourceId: block.id,
        outcome: 'SUCCESS',
        afterSafe: {
          mode: block.mode,
          start_date: block.start_date,
          end_date: block.end_date,
          requested_resource_count: input.resourceIds.length,
          resource_count: coveredResourceIds.length,
          disruption_count: disruptions.length,
        },
        correlationId: context.correlationId,
      });
      return { block, disruptions };
    },
  );
}

export interface MaintenanceBlockInput {
  tenantId: string;
  propertyId: string;
  resourceId: string;
  startDate: string;
  endDate: string;
  reason: string;
  actor: { kind: 'USER' | 'SERVICE'; id: string | null; label: string | null };
  correlationId: string | null;
}

export async function createEmergencyMaintenanceBlock(
  em: EntityManager,
  input: MaintenanceBlockInput,
): Promise<{
  block: InventoryBlockRow;
  disruptions: InventoryDisruptionRow[];
}> {
  assertIsoDate(input.startDate, 'period.arrival');
  assertIsoDate(input.endDate, 'period.departure');
  if (input.endDate <= input.startDate)
    throw new PropertyError('INVALID_REQUEST', { field: 'period' });
  await expireDueHolds(em, input.tenantId, input.propertyId);
  const descendants = await listDescendantResources(
    em,
    input.tenantId,
    input.propertyId,
    [input.resourceId],
  );
  const coveredResourceIds =
    descendants.length > 0
      ? descendants.map((row) => row.id)
      : [input.resourceId];
  const conflicts = await listAllocationConflictsForResources(
    em,
    input.tenantId,
    input.propertyId,
    coveredResourceIds,
    input.startDate,
    input.endDate,
  );
  const disruptionSources = await listEmergencyDisruptionSources(
    em,
    input.tenantId,
    input.propertyId,
    coveredResourceIds,
    input.startDate,
    input.endDate,
    conflicts,
  );
  const block = await insertInventoryBlock(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    mode: 'EMERGENCY',
    reason: input.reason.trim(),
    startDate: input.startDate,
    endDate: input.endDate,
  });
  await insertBlockResources(em, {
    blockId: block.id,
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    resourceIds: coveredResourceIds,
  });
  const disruptions: InventoryDisruptionRow[] = [];
  for (const source of disruptionSources) {
    disruptions.push(
      await insertDisruption(em, {
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        blockId: block.id,
        allocationId: source.allocationId,
        resourceId: source.resourceId,
        startDate: source.startDate,
        endDate: source.endDate,
        note: input.reason.trim(),
      }),
    );
  }
  await bumpPropertyInventoryVersion(em, input.tenantId, input.propertyId);
  await recordAudit(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    actorType: input.actor.kind,
    actorId: input.actor.id,
    actorLabel: input.actor.label,
    action: 'block.emergency_created',
    resourceType: 'InventoryBlock',
    resourceId: block.id,
    outcome: 'SUCCESS',
    afterSafe: {
      mode: block.mode,
      start_date: block.start_date,
      end_date: block.end_date,
      resource_count: coveredResourceIds.length,
      disruption_count: disruptions.length,
      source: 'work_order',
    },
    correlationId: input.correlationId,
  });
  return { block, disruptions };
}

export async function resolveBlockDisruptions(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    blockId: string;
    note: string;
  },
): Promise<InventoryDisruptionRow[]> {
  return resolveDisruptionsForBlock(em, input);
}

export async function releaseBlock(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  blockId: string,
  reason: string,
): Promise<InventoryBlockRow> {
  const cleanReason = assertSafeText(reason, 'reason');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'inventory.block', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const current = await findBlock(
        em,
        context.tenantId,
        propertyId,
        blockId,
      );
      if (!current) throw new PropertyError('NOT_FOUND');
      const released = await releaseBlockById(em, {
        tenantId: context.tenantId,
        propertyId,
        blockId,
      });
      if (!released)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: current.state,
        });
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'block.released',
        resourceType: 'InventoryBlock',
        resourceId: blockId,
        outcome: 'SUCCESS',
        beforeSafe: { state: current.state },
        afterSafe: { state: 'RELEASED', reason: cleanReason },
        correlationId: context.correlationId,
      });
      return released;
    },
  );
}

export async function readBlocks(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<{
  blocks: Array<InventoryBlockRow & { resource_ids: string[] }>;
  disruptions: InventoryDisruptionRow[];
}> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'property.read', propertyId);
      const blocks = await listBlocks(em, context.tenantId, propertyId);
      const disruptions = await listDisruptions(
        em,
        context.tenantId,
        propertyId,
      );
      return { blocks, disruptions };
    },
  );
}
