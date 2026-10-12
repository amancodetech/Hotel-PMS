import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { applyInventoryTimeouts } from './timeouts.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import { findProduct } from '../../property/persistence/product-repository.js';
import {
  bumpPropertyInventoryVersion,
  lockProperty,
} from '../../property/persistence/property-repository.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import {
  expireDueHolds,
  findCommitment,
  insertCommitment,
  insertPlanAllocation,
  listAllocationsForCommitment,
  listCommitments,
  releaseCommitment,
} from '../persistence/guarantee-repository.js';
import type {
  CommitmentRow,
  PlanAllocationRow,
} from '../persistence/guarantee-repository.js';
import {
  findPriceQuote,
  findLimitsProfile,
} from '../persistence/rate-repository.js';
import {
  resolveAvailabilityForProduct,
  type OccupancyInput,
  type PeriodInput,
} from './availability-service.js';

export interface HoldItemInput {
  productId: string;
  period: PeriodInput;
  occupancy: OccupancyInput;
  quantity: number;
  priceSnapshotId?: string | null;
}

export interface HoldInput {
  items: HoldItemInput[];
  inventoryVersion: number;
  ttlSeconds: number;
}

export interface HoldResult {
  commitment: CommitmentRow;
  allocations: PlanAllocationRow[];
}

function assertHoldInput(input: HoldInput): void {
  if (!Array.isArray(input.items) || input.items.length < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'items' });
  if (
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds < 30 ||
    input.ttlSeconds > 900
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'ttl_seconds' });
  if (!Number.isInteger(input.inventoryVersion) || input.inventoryVersion < 1)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'inventory_version',
    });
  for (const item of input.items) {
    assertIsoDate(item.period.arrival, 'period.arrival');
    assertIsoDate(item.period.departure, 'period.departure');
    if (item.period.departure <= item.period.arrival)
      throw new PropertyError('INVALID_REQUEST', { field: 'period' });
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 20
    )
      throw new PropertyError('INVALID_REQUEST', { field: 'quantity' });
  }
}

export async function createHold(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: HoldInput,
): Promise<HoldResult> {
  assertHoldInput(input);
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'reservation.create', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const diskVersion = property.inventory_version;
      const expired = await expireDueHolds(em, context.tenantId, propertyId);
      let currentVersion = diskVersion;
      if (expired > 0) {
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
        currentVersion = diskVersion + 1;
      }
      const versionAccepted =
        input.inventoryVersion === diskVersion ||
        (expired > 0 && input.inventoryVersion === currentVersion);
      if (!versionAccepted)
        throw new PropertyError('STALE_VERSION', {
          expected: input.inventoryVersion,
          current: diskVersion,
        });
      const limits = await findLimitsProfile(em, context.tenantId, propertyId);
      const maxItems = limits?.max_items_per_request ?? 20;
      if (input.items.length > maxItems)
        throw new PropertyError('LIMIT_EXCEEDED', {
          field: 'items',
          max_items_per_request: maxItems,
        });
      const budget = {
        deadline: Date.now() + (limits?.search_budget_ms ?? 500),
      };
      const units: Array<{ resourceIds: string[]; item: HoldItemInput }> = [];
      for (const item of input.items) {
        const product = await findProduct(
          em,
          context.tenantId,
          propertyId,
          item.productId,
        );
        if (!product) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        if (item.priceSnapshotId) {
          const quote = await findPriceQuote(
            em,
            context.tenantId,
            propertyId,
            item.priceSnapshotId,
          );
          if (!quote) throw new PropertyError('CROSS_SCOPE_REFERENCE');
          const expiredQuote =
            quote.expires_at !== null &&
            Date.parse(quote.expires_at) <= Date.now();
          if (
            expiredQuote ||
            quote.product_id !== item.productId ||
            quote.start_date !== item.period.arrival ||
            quote.end_date !== item.period.departure ||
            quote.quantity !== item.quantity
          )
            throw new PropertyError('INVALID_REQUEST', {
              field: 'price_snapshot_id',
            });
        }
        const resolved = await resolveAvailabilityForProduct(em, {
          tenantId: context.tenantId,
          propertyId,
          product,
          period: item.period,
          occupancy: item.occupancy,
          quantity: item.quantity,
          budget,
        });
        if (resolved.result === 'UNDETERMINED')
          throw new PropertyError('LIMIT_EXCEEDED', {
            field: 'search_budget',
          });
        if (resolved.result !== 'AVAILABLE')
          throw new PropertyError('RESOURCE_UNAVAILABLE', {
            product_id: item.productId,
            reason_codes: resolved.reasonCodes,
          });
        for (const unit of resolved.units)
          units.push({
            item,
            resourceIds: unit.resources.map((resource) => resource.resourceId),
          });
      }
      const seen = new Set<string>();
      for (const unit of units)
        for (const resourceId of unit.resourceIds) {
          if (seen.has(resourceId))
            throw new PropertyError('CONFLICT', {
              reason: 'duplicate_resource',
              resource_id: resourceId,
            });
          seen.add(resourceId);
        }
      const commitmentId = randomUUID();
      const commitment = await translatePropertyWrite(() =>
        insertCommitment(em, {
          id: commitmentId,
          tenantId: context.tenantId,
          propertyId,
          sourceKind: 'HOLD',
          sourceId: commitmentId,
          expiresAt: new Date(
            Date.now() + input.ttlSeconds * 1000,
          ).toISOString(),
          inventoryVersion: currentVersion,
        }),
      );
      const allocations: PlanAllocationRow[] = [];
      for (const unit of units) {
        for (const resourceId of unit.resourceIds) {
          const allocation = await translatePropertyWrite(() =>
            insertPlanAllocation(em, {
              commitmentId,
              tenantId: context.tenantId,
              propertyId,
              resourceId,
              startDate: unit.item.period.arrival,
              endDate: unit.item.period.departure,
            }),
          );
          allocations.push(allocation);
        }
      }
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'hold.created',
        resourceType: 'Commitment',
        resourceId: commitmentId,
        outcome: 'SUCCESS',
        afterSafe: {
          source_kind: 'HOLD',
          expires_at: commitment.expires_at,
          allocation_count: allocations.length,
          inventory_version: currentVersion + 1,
        },
        correlationId: context.correlationId,
      });
      return { commitment, allocations };
    },
  );
}

export async function releaseHold(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  holdId: string,
): Promise<CommitmentRow> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'reservation.create', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      await expireDueHolds(em, context.tenantId, propertyId);
      const current = await findCommitment(
        em,
        context.tenantId,
        propertyId,
        holdId,
      );
      if (!current || current.source_kind !== 'HOLD')
        throw new PropertyError('NOT_FOUND');
      if (current.state === 'EXPIRED') throw new PropertyError('HOLD_EXPIRED');
      const released = await releaseCommitment(em, {
        tenantId: context.tenantId,
        propertyId,
        commitmentId: holdId,
        state: 'RELEASED',
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
        action: 'hold.released',
        resourceType: 'Commitment',
        resourceId: holdId,
        outcome: 'SUCCESS',
        beforeSafe: { state: current.state },
        afterSafe: { state: 'RELEASED' },
        correlationId: context.correlationId,
      });
      return released;
    },
  );
}

export async function readHolds(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<Array<CommitmentRow & { allocations: PlanAllocationRow[] }>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'reservation.read', propertyId);
      const commitments = await listCommitments(
        em,
        context.tenantId,
        propertyId,
        ['ACTIVE', 'EXPIRED'],
      );
      const holds = commitments.filter(
        (commitment) => commitment.source_kind === 'HOLD',
      );
      const result = [] as Array<
        CommitmentRow & { allocations: PlanAllocationRow[] }
      >;
      for (const hold of holds)
        result.push({
          ...hold,
          allocations: await listAllocationsForCommitment(em, hold.id),
        });
      return result;
    },
  );
}
