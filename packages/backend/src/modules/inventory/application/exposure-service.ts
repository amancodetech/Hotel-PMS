import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { applyInventoryTimeouts } from './timeouts.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { findConnection } from '../../distribution/persistence/connection-repository.js';
import { listMappingsForConnection } from '../../distribution/persistence/mapping-repository.js';
import { enqueueOutbox } from '../../distribution/persistence/outbox-repository.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import {
  assertIsoDate,
  assertSafeText,
} from '../../property/domain/lifecycle.js';
import { findProduct } from '../../property/persistence/product-repository.js';
import {
  bumpPropertyInventoryVersion,
  lockProperty,
} from '../../property/persistence/property-repository.js';
import {
  countActiveCompositions,
  listCandidateResources,
  listCompositionCoverage,
  listSearchResources,
} from '../persistence/availability-repository.js';
import {
  expireDueHolds,
  listOccupancyConflicts,
} from '../persistence/guarantee-repository.js';
import {
  findRatePlan,
  listNightlyPrices,
} from '../persistence/rate-repository.js';
import { hasFractionBeyond, parseDecimal } from '../domain/pricing.js';
import * as repo from '../persistence/exposure-repository.js';
import {
  listExposureEvents,
  listSyncAttempts,
  summarizeConnectionOutbox,
} from '../persistence/sync-repository.js';

export interface ExposurePreviewInput {
  connectionId: string;
  productId: string;
  period: { arrival: string; departure: string };
  resourceIds: string[];
  inventoryVersion: number;
}

export interface ExposurePreviewResult {
  previewId: string;
  inventoryVersion: number;
  expiresAt: string;
  allowed: boolean;
  reasonCodes: string[];
  previewVersion: number;
}

export interface PublishInput {
  previewId: string;
  previewVersion: number;
  approvalId?: string | null;
}

export interface SaleResultShape {
  operationId: string;
  resourceId: string;
  version: number;
  effectiveOpen: boolean;
  reasonCodes: string[];
  syncState: string;
}

function datesOf(arrival: string, departure: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${arrival}T00:00:00Z`);
  const end = new Date(`${departure}T00:00:00Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function assertPreviewInput(input: ExposurePreviewInput): void {
  assertIsoDate(input.period.arrival, 'period.arrival');
  assertIsoDate(input.period.departure, 'period.departure');
  if (input.period.departure <= input.period.arrival)
    throw new PropertyError('INVALID_REQUEST', { field: 'period' });
  if (
    !Array.isArray(input.resourceIds) ||
    input.resourceIds.length < 1 ||
    input.resourceIds.length > 32 ||
    new Set(input.resourceIds).size !== input.resourceIds.length
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'resource_ids' });
  if (!Number.isInteger(input.inventoryVersion) || input.inventoryVersion < 1)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'inventory_version',
    });
}

async function assertMapping(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  connectionId: string,
  productId: string,
): Promise<{
  externalRateRef: string;
  occupancy: number;
  ratePlanId: string;
} | null> {
  const mappings = await listMappingsForConnection(em, connectionId);
  const mapping = mappings.find(
    (entry) =>
      entry.internal_product_ref === productId &&
      entry.internal_rate_ref !== null,
  );
  if (!mapping || !mapping.internal_rate_ref) return null;
  const plan = await findRatePlan(
    em,
    tenantId,
    propertyId,
    mapping.internal_rate_ref,
  );
  if (!plan || plan.product_id !== productId) return null;
  return {
    externalRateRef: mapping.external_rate_ref,
    occupancy: mapping.occupancy,
    ratePlanId: plan.id,
  };
}

async function fractionalIdrBlocked(
  em: EntityManager,
  connectionId: string,
): Promise<boolean> {
  const rows = (await em.execute(
    `select 1 from "distribution_channel_capability"
      where "connection_id" = ? and "capability_code" = 'FRACTIONAL_IDR'
        and "status" = 'VERIFIED'
      limit 1`,
    [connectionId] as never[],
  )) as unknown[];
  return rows.length === 0;
}

async function evaluateExposure(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    connectionId: string;
    productId: string;
    period: { arrival: string; departure: string };
    resourceIds: string[];
  },
): Promise<{
  allowed: boolean;
  reasonCodes: string[];
  mode: 'WHOLE' | 'PARTS';
  sellableUnits: number;
}> {
  const reasonCodes = new Set<string>();
  const product = await findProduct(
    em,
    input.tenantId,
    input.propertyId,
    input.productId,
  );
  if (!product || product.status !== 'ACTIVE') {
    reasonCodes.add('PRODUCT_INACTIVE');
    return {
      allowed: false,
      reasonCodes: [...reasonCodes],
      mode: 'PARTS',
      sellableUnits: 0,
    };
  }
  const resources = await listSearchResources(
    em,
    input.tenantId,
    input.propertyId,
    input.resourceIds,
  );
  if (resources.length !== input.resourceIds.length)
    throw new PropertyError('CROSS_SCOPE_REFERENCE');
  const compositionCount = await countActiveCompositions(
    em,
    input.tenantId,
    input.propertyId,
    product.id,
  );
  let mode: 'WHOLE' | 'PARTS' = 'PARTS';
  if (compositionCount > 0) {
    const coverage = await listCompositionCoverage(
      em,
      input.tenantId,
      input.propertyId,
      product.id,
      input.period.arrival,
      input.period.departure,
    );
    const leaves = [...new Set(coverage.map((row) => row.resource_id))].sort();
    const requested = [...input.resourceIds].sort();
    if (
      leaves.length === 0 ||
      leaves.length !== requested.length ||
      leaves.some((leaf, index) => leaf !== requested[index])
    ) {
      reasonCodes.add('COMPOSITION_INCOMPLETE');
    } else mode = 'WHOLE';
  } else {
    const candidates = await listCandidateResources(
      em,
      input.tenantId,
      input.propertyId,
      product.id,
      input.period.arrival,
      input.period.departure,
    );
    const allowedResources = new Set(candidates.map((row) => row.resource_id));
    if (!input.resourceIds.every((id) => allowedResources.has(id)))
      throw new PropertyError('CROSS_SCOPE_REFERENCE');
  }
  for (const resource of resources) {
    if (resource.state !== 'ACTIVE' || resource.maintenance_state !== 'NONE')
      reasonCodes.add('RESOURCE_UNAVAILABLE');
  }
  const conflicts = await listOccupancyConflicts(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    resourceIds: input.resourceIds,
    arrival: input.period.arrival,
    departure: input.period.departure,
  });
  for (const conflict of conflicts) {
    if (conflict.kind === 'EXPOSURE') reasonCodes.add('EXPOSURE_PROTECTED');
    else if (conflict.kind === 'BLOCK') reasonCodes.add('BLOCKED');
    else reasonCodes.add('COMMITTED');
  }
  const existing = await repo.listExposures(
    em,
    input.tenantId,
    input.propertyId,
    input.connectionId,
  );
  for (const exposure of existing) {
    if (exposure.product_id !== input.productId) continue;
    if (exposure.state === 'RELEASED') continue;
    const overlaps =
      exposure.start_date < input.period.departure &&
      exposure.end_date > input.period.arrival;
    if (overlaps && exposure.mode !== mode)
      reasonCodes.add('MODE_SWITCH_REQUIRES_WITHDRAWAL');
  }
  const mapping = await assertMapping(
    em,
    input.tenantId,
    input.propertyId,
    input.connectionId,
    input.productId,
  );
  if (!mapping) reasonCodes.add('MAPPING_INCOMPLETE');
  else {
    const prices = await listNightlyPrices(
      em,
      input.tenantId,
      input.propertyId,
      input.period.arrival,
      input.period.departure,
    );
    const byDate = new Map<string, string>();
    for (const price of prices)
      if (
        price.rate_plan_id === mapping.ratePlanId &&
        price.occupancy === mapping.occupancy
      )
        byDate.set(price.stay_date, price.amount);
    const fractionalBlocked = await fractionalIdrBlocked(
      em,
      input.connectionId,
    );
    for (const date of datesOf(input.period.arrival, input.period.departure)) {
      const amount = byDate.get(date);
      if (!amount) {
        reasonCodes.add('RATE_MISSING');
        continue;
      }
      const scaled = parseDecimal(amount, 'amount');
      if (fractionalBlocked && hasFractionBeyond(scaled, 2))
        reasonCodes.add('FRACTION_NOT_SUPPORTED');
    }
  }
  return {
    allowed: reasonCodes.size === 0,
    reasonCodes: [...reasonCodes],
    mode,
    // Complete composition coverage is one sellable product unit. Independent
    // candidate resources each represent one unit, including CATEGORY quotas.
    sellableUnits:
      reasonCodes.size === 0 ? (mode === 'WHOLE' ? 1 : resources.length) : 0,
  };
}

export async function previewExposure(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: ExposurePreviewInput,
): Promise<ExposurePreviewResult> {
  assertPreviewInput(input);
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'channel.sale.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const diskVersion = property.inventory_version;
      const expired = await expireDueHolds(em, context.tenantId, propertyId);
      let inventoryVersion = diskVersion;
      if (expired > 0) {
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
        inventoryVersion = diskVersion + 1;
      }
      const connection = await findConnection(em, input.connectionId);
      if (
        !connection ||
        connection.tenant_id !== context.tenantId ||
        connection.property_id !== propertyId
      )
        throw new PropertyError('NOT_FOUND');
      const versionAccepted =
        input.inventoryVersion === diskVersion ||
        (expired > 0 && input.inventoryVersion === inventoryVersion);
      if (!versionAccepted)
        throw new PropertyError('PREVIEW_STALE', {
          expected: input.inventoryVersion,
          current: diskVersion,
        });
      const evaluation = await evaluateExposure(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: input.connectionId,
        productId: input.productId,
        period: input.period,
        resourceIds: input.resourceIds,
      });
      const previewVersion = await repo.nextPreviewVersion(
        em,
        context.tenantId,
        propertyId,
      );
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const preview = await repo.insertExposurePreview(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: input.connectionId,
        productId: input.productId,
        startDate: input.period.arrival,
        endDate: input.period.departure,
        mode: evaluation.mode,
        resourceIds: input.resourceIds,
        inventoryVersion,
        previewVersion,
        allowed: evaluation.allowed,
        reasonCodes: evaluation.reasonCodes,
        expiresAt,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'exposure.previewed',
        resourceType: 'ExposurePreview',
        resourceId: preview.id,
        outcome: evaluation.allowed ? 'SUCCESS' : 'FAILED',
        afterSafe: {
          connection_id: input.connectionId,
          product_id: input.productId,
          allowed: evaluation.allowed,
          reason_codes: evaluation.reasonCodes,
          mode: evaluation.mode,
        },
        correlationId: context.correlationId,
      });
      return {
        previewId: preview.id,
        inventoryVersion,
        expiresAt,
        allowed: evaluation.allowed,
        reasonCodes: evaluation.reasonCodes,
        previewVersion,
      };
    },
  );
}

async function enqueueExposurePublishEvents(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    connectionId: string;
    channelKey: string;
    exposureId: string;
    productRef: string;
    externalRateRef: string;
    period: { arrival: string; departure: string };
    inventoryVersion: number;
    available: number;
  },
): Promise<void> {
  const dates = datesOf(input.period.arrival, input.period.departure);
  const eventVersion = input.inventoryVersion;
  await enqueueOutbox(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    connectionId: input.connectionId,
    channelKey: input.channelKey,
    aggregateType: 'Exposure',
    aggregateId: input.exposureId,
    eventType: 'AvailabilitySnapshot',
    eventVersion,
    inventoryVersion: input.inventoryVersion,
    payloadSafe: {
      cells: dates.map((date) => ({
        product_ref: input.productRef,
        date,
        available: input.available,
        inventory_version: input.inventoryVersion,
      })),
    },
  });
  await enqueueOutbox(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    connectionId: input.connectionId,
    channelKey: input.channelKey,
    aggregateType: 'Exposure',
    aggregateId: input.exposureId,
    eventType: 'RestrictionSnapshot',
    eventVersion,
    inventoryVersion: input.inventoryVersion,
    payloadSafe: {
      cells: dates.map((date) => ({
        rate_ref: input.externalRateRef,
        date,
        price: null,
        currency: null,
        min_stay: null,
        max_stay: null,
        stop_sell: false,
        closed_to_arrival: null,
        closed_to_departure: null,
        inventory_version: input.inventoryVersion,
      })),
    },
  });
}

export async function publishExposure(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: PublishInput,
): Promise<repo.ExposureRow> {
  if (!Number.isInteger(input.previewVersion) || input.previewVersion < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'preview_version' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'channel.sale.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const expired = await expireDueHolds(em, context.tenantId, propertyId);
      if (expired > 0)
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const inventoryVersion =
        property.inventory_version + (expired > 0 ? 1 : 0);
      const preview = await repo.findExposurePreview(
        em,
        context.tenantId,
        propertyId,
        input.previewId,
      );
      if (!preview) throw new PropertyError('NOT_FOUND');
      if (
        preview.preview_version !== input.previewVersion ||
        preview.inventory_version !== inventoryVersion ||
        Date.parse(preview.expires_at) <= Date.now()
      )
        throw new PropertyError('PREVIEW_STALE', {
          preview_version: preview.preview_version,
          current_inventory_version: inventoryVersion,
        });
      if (!preview.allowed)
        throw new PropertyError('PREVIEW_NOT_ALLOWED', {
          reason_codes: preview.reason_codes,
        });
      const connection = await findConnection(em, preview.connection_id);
      if (!connection) throw new PropertyError('NOT_FOUND');
      const evaluation = await evaluateExposure(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: preview.connection_id,
        productId: preview.product_id,
        period: {
          arrival: preview.start_date,
          departure: preview.end_date,
        },
        resourceIds: preview.resource_ids,
      });
      if (!evaluation.allowed)
        throw new PropertyError('PREVIEW_NOT_ALLOWED', {
          reason_codes: evaluation.reasonCodes,
        });
      const exposure = await repo.insertExposure(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: preview.connection_id,
        productId: preview.product_id,
        startDate: preview.start_date,
        endDate: preview.end_date,
        mode: evaluation.mode,
        state: 'PUBLISHING',
        inventoryVersion,
        previewVersion: preview.preview_version,
        cutoff: null,
      });
      for (const resourceId of preview.resource_ids)
        await repo.insertExposureAllocation(em, {
          exposureId: exposure.id,
          tenantId: context.tenantId,
          propertyId,
          resourceId,
          startDate: preview.start_date,
          endDate: preview.end_date,
        });
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const mapping = await assertMapping(
        em,
        context.tenantId,
        propertyId,
        preview.connection_id,
        preview.product_id,
      );
      if (!mapping) throw new PropertyError('MAPPING_INCOMPLETE');
      await enqueueExposurePublishEvents(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: preview.connection_id,
        channelKey: connection.channel_key,
        exposureId: exposure.id,
        productRef: preview.product_id,
        externalRateRef: mapping.externalRateRef,
        period: {
          arrival: preview.start_date,
          departure: preview.end_date,
        },
        inventoryVersion: inventoryVersion + 1,
        available: evaluation.sellableUnits,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'exposure.published',
        resourceType: 'Exposure',
        resourceId: exposure.id,
        outcome: 'SUCCESS',
        afterSafe: {
          connection_id: preview.connection_id,
          product_id: preview.product_id,
          mode: preview.mode,
          state: 'PUBLISHING',
          allocation_count: preview.resource_ids.length,
        },
        correlationId: context.correlationId,
      });
      return exposure;
    },
  );
}

export async function withdrawExposure(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  exposureId: string,
  reason: string,
): Promise<repo.ExposureRow> {
  const cleanReason = assertSafeText(reason, 'reason');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'channel.sale.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const exposure = await repo.findExposure(
        em,
        context.tenantId,
        propertyId,
        exposureId,
      );
      if (!exposure) throw new PropertyError('NOT_FOUND');
      if (
        exposure.state === 'WITHDRAWING' ||
        exposure.state === 'RECONCILING' ||
        exposure.state === 'RELEASED'
      )
        throw new PropertyError('EXPOSURE_STATE', { state: exposure.state });
      const connection = await findConnection(em, exposure.connection_id);
      if (!connection) throw new PropertyError('NOT_FOUND');
      const mapping = await assertMapping(
        em,
        context.tenantId,
        propertyId,
        exposure.connection_id,
        exposure.product_id,
      );
      if (!mapping) throw new PropertyError('MAPPING_INCOMPLETE');
      await repo.insertSaleRestriction(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: exposure.connection_id,
        productId: exposure.product_id,
        startDate: exposure.start_date,
        endDate: exposure.end_date,
        reason: cleanReason,
      });
      const cutoff = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const updated = await repo.updateExposureState(em, {
        tenantId: context.tenantId,
        propertyId,
        exposureId,
        state: 'WITHDRAWING',
        cutoff,
      });
      if (!updated) throw new PropertyError('NOT_FOUND');
      const dates = datesOf(exposure.start_date, exposure.end_date);
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const refreshed = await lockProperty(em, context.tenantId, propertyId);
      await enqueueOutbox(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: exposure.connection_id,
        channelKey: connection.channel_key,
        aggregateType: 'Exposure',
        aggregateId: exposureId,
        eventType: 'RestrictionSnapshot',
        eventVersion: refreshed.inventory_version,
        inventoryVersion: refreshed.inventory_version,
        payloadSafe: {
          cells: dates.map((date) => ({
            rate_ref: mapping.externalRateRef,
            date,
            price: null,
            currency: null,
            min_stay: null,
            max_stay: null,
            stop_sell: true,
            closed_to_arrival: null,
            closed_to_departure: null,
            inventory_version: refreshed.inventory_version,
          })),
        },
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'exposure.withdraw_requested',
        resourceType: 'Exposure',
        resourceId: exposureId,
        outcome: 'SUCCESS',
        beforeSafe: { state: exposure.state },
        afterSafe: { state: 'WITHDRAWING', cutoff, reason: cleanReason },
        correlationId: context.correlationId,
      });
      return updated;
    },
  );
}

export async function listExposuresForProperty(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  connectionId?: string,
): Promise<
  Array<repo.ExposureRow & { allocations: repo.ExposureAllocationRow[] }>
> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'channel.read', propertyId);
      const exposures = await repo.listExposures(
        em,
        context.tenantId,
        propertyId,
        connectionId,
      );
      const result = [];
      for (const exposure of exposures)
        result.push({
          ...exposure,
          allocations: await repo.listExposureAllocations(em, exposure.id),
        });
      return result;
    },
  );
}

export async function setDistributionSaleStatus(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  connectionId: string,
  input:
    | {
        action: 'STOP_SELL';
        productId: string;
        period: { arrival: string; departure: string };
        reason: string;
      }
    | {
        action: 'OPEN';
        restrictionId: string;
        reason: string;
      },
): Promise<SaleResultShape> {
  const cleanReason = assertSafeText(input.reason, 'reason');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'channel.sale.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const connection = await findConnection(em, connectionId);
      if (
        !connection ||
        connection.tenant_id !== context.tenantId ||
        connection.property_id !== propertyId
      )
        throw new PropertyError('NOT_FOUND');
      if (input.action === 'STOP_SELL') {
        assertIsoDate(input.period.arrival, 'period.arrival');
        assertIsoDate(input.period.departure, 'period.departure');
        if (input.period.departure <= input.period.arrival)
          throw new PropertyError('INVALID_REQUEST', { field: 'period' });
        const mapping = await assertMapping(
          em,
          context.tenantId,
          propertyId,
          connectionId,
          input.productId,
        );
        if (!mapping) throw new PropertyError('MAPPING_INCOMPLETE');
        const restriction = await repo.insertSaleRestriction(em, {
          tenantId: context.tenantId,
          propertyId,
          connectionId,
          productId: input.productId,
          startDate: input.period.arrival,
          endDate: input.period.departure,
          reason: cleanReason,
        });
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
        const inventoryVersion = (
          await lockProperty(em, context.tenantId, propertyId)
        ).inventory_version;
        const dates = datesOf(input.period.arrival, input.period.departure);
        await enqueueOutbox(em, {
          tenantId: context.tenantId,
          propertyId,
          connectionId,
          channelKey: connection.channel_key,
          aggregateType: 'SaleRestriction',
          aggregateId: restriction.id,
          eventType: 'RestrictionSnapshot',
          eventVersion: inventoryVersion,
          inventoryVersion,
          payloadSafe: {
            cells: dates.map((date) => ({
              rate_ref: mapping.externalRateRef,
              date,
              price: null,
              currency: null,
              min_stay: null,
              max_stay: null,
              stop_sell: true,
              closed_to_arrival: null,
              closed_to_departure: null,
              inventory_version: inventoryVersion,
            })),
          },
        });
        await recordAudit(em, {
          tenantId: context.tenantId,
          propertyId,
          ...auditActor(context),
          action: 'sale.stop_sell',
          resourceType: 'SaleRestriction',
          resourceId: restriction.id,
          outcome: 'SUCCESS',
          afterSafe: {
            product_id: input.productId,
            start_date: restriction.start_date,
            end_date: restriction.end_date,
            reason: cleanReason,
          },
          correlationId: context.correlationId,
        });
        return {
          operationId: restriction.id,
          resourceId: input.productId,
          version: restriction.version,
          effectiveOpen: false,
          reasonCodes: ['STOP_SELL'],
          syncState: 'QUEUED',
        };
      }
      const restriction = await repo.findSaleRestriction(
        em,
        context.tenantId,
        propertyId,
        input.restrictionId,
      );
      if (!restriction || restriction.connection_id !== connectionId)
        throw new PropertyError('NOT_FOUND');
      const opened = await repo.openSaleRestriction(em, {
        tenantId: context.tenantId,
        propertyId,
        restrictionId: input.restrictionId,
        openedBy: context.actor.userId,
      });
      if (!opened)
        throw new PropertyError('EXPOSURE_STATE', {
          state: restriction.state,
        });
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const refreshed = await lockProperty(em, context.tenantId, propertyId);
      const remaining = await repo.listActiveRestrictions(
        em,
        context.tenantId,
        propertyId,
        connectionId,
        restriction.product_id,
      );
      const reasons: string[] = [];
      if (remaining.length > 0) reasons.push('STOP_SELL');
      const candidates = await listCandidateResources(
        em,
        context.tenantId,
        propertyId,
        restriction.product_id,
        restriction.start_date,
        restriction.end_date,
      );
      const resourceIds = [
        ...new Set(candidates.map((row) => row.resource_id)),
      ];
      if (resourceIds.length > 0) {
        const conflicts = await listOccupancyConflicts(em, {
          tenantId: context.tenantId,
          propertyId,
          resourceIds,
          arrival: restriction.start_date,
          departure: restriction.end_date,
        });
        for (const conflict of conflicts) {
          if (conflict.kind === 'EXPOSURE') reasons.push('EXPOSURE_RESERVED');
          else if (conflict.kind === 'BLOCK') reasons.push('BLOCKED');
          else reasons.push('COMMITTED');
        }
      }
      const activeExposures = await repo.listExposures(
        em,
        context.tenantId,
        propertyId,
        connectionId,
      );
      for (const exposure of activeExposures) {
        if (
          ['WITHDRAWING', 'RECONCILING', 'UNKNOWN'].includes(exposure.state) &&
          exposure.product_id === restriction.product_id &&
          exposure.start_date < restriction.end_date &&
          exposure.end_date > restriction.start_date
        )
          reasons.push('WITHDRAWAL_PENDING');
      }
      const mapping = await assertMapping(
        em,
        context.tenantId,
        propertyId,
        connectionId,
        restriction.product_id,
      );
      if (mapping) {
        const dates = datesOf(restriction.start_date, restriction.end_date);
        await enqueueOutbox(em, {
          tenantId: context.tenantId,
          propertyId,
          connectionId,
          channelKey: connection.channel_key,
          aggregateType: 'SaleRestriction',
          aggregateId: opened.id,
          eventType: 'RestrictionSnapshot',
          eventVersion: refreshed.inventory_version,
          inventoryVersion: refreshed.inventory_version,
          payloadSafe: {
            cells: dates.map((date) => ({
              rate_ref: mapping.externalRateRef,
              date,
              price: null,
              currency: null,
              min_stay: null,
              max_stay: null,
              stop_sell: false,
              closed_to_arrival: null,
              closed_to_departure: null,
              inventory_version: refreshed.inventory_version,
            })),
          },
        });
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'sale.opened',
        resourceType: 'SaleRestriction',
        resourceId: opened.id,
        outcome: 'SUCCESS',
        afterSafe: {
          reason: cleanReason,
          effective_open: reasons.length === 0,
          reason_codes: reasons,
        },
        correlationId: context.correlationId,
      });
      return {
        operationId: opened.id,
        resourceId: restriction.product_id,
        version: opened.version,
        effectiveOpen: reasons.length === 0,
        reasonCodes: reasons,
        syncState: 'QUEUED',
      };
    },
  );
}

function deriveSyncState(
  summary: {
    pending: number;
    failed: number;
    unknown: number;
    partial: number;
    verified: number;
    provider_accepted_version: number | null;
    channel_verified_version: number | null;
  },
  desiredVersion: number,
): string {
  if (summary.channel_verified_version === desiredVersion)
    return 'CHANNEL_VERIFIED';
  if (
    summary.pending === 0 &&
    summary.failed === 0 &&
    summary.unknown === 0 &&
    summary.partial === 0 &&
    summary.provider_accepted_version === desiredVersion
  )
    return 'PROVIDER_ACCEPTED';
  if (summary.partial > 0) return 'PARTIAL';
  if (summary.unknown > 0 && summary.pending === 0) return 'UNKNOWN';
  if (summary.failed > 0 && summary.pending === 0) return 'FAILED';
  return 'QUEUED';
}

export async function getSyncStatus(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  connectionId: string,
  includeAttempts: boolean,
) {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'channel.read', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const connection = await findConnection(em, connectionId);
      if (
        !connection ||
        connection.tenant_id !== context.tenantId ||
        connection.property_id !== propertyId
      )
        throw new PropertyError('NOT_FOUND');
      const summary = await summarizeConnectionOutbox(em, connectionId);
      const desired = property.inventory_version;
      const state = deriveSyncState(summary, desired);
      const attempts = includeAttempts
        ? await listSyncAttempts(em, connectionId)
        : [];
      return {
        connectionId,
        desiredVersion: desired,
        providerAcceptedVersion: summary.provider_accepted_version,
        channelVerifiedVersion: summary.channel_verified_version,
        state,
        observedAt: summary.observed_at,
        pending: summary.pending,
        failed: summary.failed,
        unknown: summary.unknown,
        partial: summary.partial,
        attempts,
      };
    },
  );
}

export async function reconcileConnection(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  connectionId: string,
  reason: string,
): Promise<{ activated: number; released: number; reconciling: number }> {
  const cleanReason = assertSafeText(reason, 'reason');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'channel.reconcile', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const connection = await findConnection(em, connectionId);
      if (
        !connection ||
        connection.tenant_id !== context.tenantId ||
        connection.property_id !== propertyId
      )
        throw new PropertyError('NOT_FOUND');
      const exposures = await repo.listExposures(
        em,
        context.tenantId,
        propertyId,
        connectionId,
      );
      let activated = 0;
      const released = 0;
      let reconciling = 0;
      for (const exposure of exposures) {
        if (
          !['PUBLISHING', 'WITHDRAWING', 'RECONCILING', 'UNKNOWN'].includes(
            exposure.state,
          )
        )
          continue;
        const events = await repo.countPendingExposureEvents(
          em,
          connectionId,
          exposure.id,
        );
        if (events.pending > 0) continue;
        if (exposure.state === 'PUBLISHING' || exposure.state === 'UNKNOWN') {
          if (
            events.failed === 0 &&
            events.unknown === 0 &&
            events.accepted > 0
          ) {
            await repo.updateExposureState(em, {
              tenantId: context.tenantId,
              propertyId,
              exposureId: exposure.id,
              state: 'ACTIVE',
            });
            activated += 1;
          } else if (
            exposure.state !== 'UNKNOWN' &&
            (events.unknown > 0 || events.failed > 0)
          ) {
            await repo.updateExposureState(em, {
              tenantId: context.tenantId,
              propertyId,
              exposureId: exposure.id,
              state: 'UNKNOWN',
            });
          }
          continue;
        }
        if (
          exposure.state === 'WITHDRAWING' ||
          exposure.state === 'RECONCILING'
        ) {
          // Transport acceptance and channel readback do not prove that every
          // booking revision through the withdrawal cutoff has been reconciled.
          // RELEASE_PROOF_NOT_IMPLEMENTED: retain the allocation until a complete,
          // authorized proof mechanism exists; do not infer proof from counters.
          if (exposure.state !== 'RECONCILING')
            await repo.updateExposureState(em, {
              tenantId: context.tenantId,
              propertyId,
              exposureId: exposure.id,
              state: 'RECONCILING',
            });
          reconciling += 1;
        }
      }
      if (activated + released > 0)
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'connection.reconciled',
        resourceType: 'Connection',
        resourceId: connectionId,
        outcome: 'SUCCESS',
        afterSafe: {
          activated,
          released,
          reconciling,
          ...(reconciling > 0
            ? { releaseCapability: 'RELEASE_PROOF_NOT_IMPLEMENTED' }
            : {}),
          reason: cleanReason,
        },
        correlationId: context.correlationId,
      });
      return { activated, released, reconciling };
    },
  );
}

export async function getExposureDetail(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  exposureId: string,
) {
  const exposure = await repo.findExposure(
    em,
    tenantId,
    propertyId,
    exposureId,
  );
  if (!exposure) return null;
  return {
    exposure,
    allocations: await repo.listExposureAllocations(em, exposureId),
    events: await listExposureEvents(em, exposure.connection_id, exposureId),
  };
}
