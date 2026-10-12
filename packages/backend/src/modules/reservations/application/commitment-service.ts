import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import {
  assertIsoDate,
  assertSafeText,
} from '../../property/domain/lifecycle.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import {
  bumpPropertyInventoryVersion,
  lockProperty,
} from '../../property/persistence/property-repository.js';
import { findProduct } from '../../property/persistence/product-repository.js';
import { enqueueOutbox } from '../../distribution/persistence/outbox-repository.js';
import { applyInventoryTimeouts } from '../../inventory/application/timeouts.js';
import type { ReservationAriTransactionHook } from '../../inventory/application/reservation-ari-service.js';
import {
  resolveAvailabilityForProduct,
  searchBudgetForProperty,
} from '../../inventory/application/availability-service.js';
import {
  expireDueHolds,
  insertCommitment,
  insertPlanAllocation,
  releaseAllocationsForCommitment,
  releaseCommitment,
  touchCommitmentVersion,
} from '../../inventory/persistence/guarantee-repository.js';
import { findPriceQuote } from '../../inventory/persistence/rate-repository.js';
import { cancelPlannedAssignmentsForItem } from '../../front-office/persistence/room-assignment-repository.js';
import {
  deriveReservationState,
  isReservationItemState,
} from '../domain/reservation-state.js';
import { assertSharingScopeGuests } from '../domain/sharing-policy.js';
import type { ReservationItemState } from '../domain/reservation-state.js';
import * as repo from '../persistence/reservation-repository.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from './idempotency-service.js';

const modifiableStates = new Set([
  'INQUIRY',
  'TENTATIVE',
  'WAITLIST',
  'CONFIRMED',
  'PARTIALLY_CONFIRMED',
]);

const inventoryHoldingStates = new Set(['CONFIRMED', 'IN_HOUSE']);

async function enqueueReservationEvent(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    connectionId: string | null;
    reservationId: string;
    eventType:
      'ReservationConfirmed' | 'ReservationModified' | 'ReservationCancelled';
    eventVersion: number;
    inventoryVersion: number;
    itemIds: string[];
    state: string;
  },
): Promise<void> {
  if (!input.connectionId) return;
  const connection = await repo.findConnectionChannel(em, input.connectionId);
  if (!connection) return;
  await enqueueOutbox(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    connectionId: input.connectionId,
    channelKey: connection.channel_key,
    aggregateType: 'Reservation',
    aggregateId: input.reservationId,
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    inventoryVersion: input.inventoryVersion,
    payloadSafe: {
      reservation_id: input.reservationId,
      item_ids: input.itemIds,
      state: input.state,
      inventory_version: input.inventoryVersion,
    },
  });
}

export interface ConfirmInput {
  reservationId: string;
  inventoryVersion: number;
  items: Array<{ item_id: string; price_snapshot_id: string }>;
  idempotencyKey?: string | null;
}

function assertConfirmInput(input: ConfirmInput): void {
  if (!Array.isArray(input.items) || input.items.length < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'items' });
  if (!Number.isInteger(input.inventoryVersion) || input.inventoryVersion < 1)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'inventory_version',
    });
  const ids = new Set<string>();
  for (const item of input.items) {
    if (
      typeof item.item_id !== 'string' ||
      typeof item.price_snapshot_id !== 'string'
    )
      throw new PropertyError('INVALID_REQUEST', { field: 'items' });
    if (ids.has(item.item_id))
      throw new PropertyError('INVALID_REQUEST', { field: 'items' });
    ids.add(item.item_id);
  }
}

export async function confirmReservation(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: ConfirmInput,
  reservationAri?: ReservationAriTransactionHook,
): Promise<Record<string, unknown>> {
  assertConfirmInput(input);
  const normalized = [...input.items].sort((a, b) =>
    a.item_id.localeCompare(b.item_id),
  );
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'ConfirmReservation',
    reservation_id: input.reservationId,
    inventory_version: input.inventoryVersion,
    items: normalized,
  });
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
      const replayed = await checkIdempotency(
        em,
        context,
        'ConfirmReservation',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const versionAccepted =
        input.inventoryVersion === diskVersion ||
        (expired > 0 && input.inventoryVersion === currentVersion);
      if (!versionAccepted)
        throw new PropertyError('STALE_VERSION', {
          expected: input.inventoryVersion,
          current: diskVersion,
        });
      const reservation = await repo.findReservation(
        em,
        context.tenantId,
        propertyId,
        input.reservationId,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      const items = await repo.listReservationItems(em, reservation.id);
      const reservationGuests = await repo.listReservationGuests(
        em,
        reservation.id,
      );
      const byId = new Map(items.map((item) => [item.id, item]));
      const targets = input.items.map((requested) => {
        const item = byId.get(requested.item_id);
        if (!item) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        if (!item.product_id)
          throw new PropertyError('INVALID_REQUEST', {
            field: 'items',
            reason: 'product_required',
          });
        if (!modifiableStates.has(item.state) || item.state === 'CANCELLED')
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            state: item.state,
          });
        if (item.state === 'CONFIRMED')
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            state: item.state,
          });
        return { requested, item };
      });
      const units: Array<{ itemId: string; resourceIds: string[] }> = [];
      for (const { requested, item } of targets) {
        const product = await findProduct(
          em,
          context.tenantId,
          propertyId,
          item.product_id!,
        );
        if (!product) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        assertSharingScopeGuests({
          scope: product.sharing_scope,
          productId: product.id,
          itemId: item.id,
          guests: reservationGuests,
        });
        const quote = await findPriceQuote(
          em,
          context.tenantId,
          propertyId,
          requested.price_snapshot_id,
        );
        const expiredQuote =
          !quote ||
          (quote.expires_at !== null &&
            Date.parse(quote.expires_at) <= Date.now());
        if (
          !quote ||
          expiredQuote ||
          quote.product_id !== item.product_id ||
          quote.start_date !== item.arrival ||
          quote.end_date !== item.departure ||
          quote.quantity !== item.quantity ||
          quote.adults !== item.adults
        )
          throw new PropertyError('INVALID_REQUEST', {
            field: 'price_snapshot_id',
            item_id: item.id,
          });
        const resolved = await resolveAvailabilityForProduct(em, {
          tenantId: context.tenantId,
          propertyId,
          product,
          period: { arrival: item.arrival, departure: item.departure },
          occupancy: { adults: item.adults, childAges: item.child_ages },
          quantity: item.quantity,
          budget: await searchBudgetForProperty(
            em,
            context.tenantId,
            propertyId,
          ),
        });
        if (resolved.result === 'UNDETERMINED')
          throw new PropertyError('LIMIT_EXCEEDED', { field: 'search_budget' });
        if (resolved.result !== 'AVAILABLE')
          throw new PropertyError('RESOURCE_UNAVAILABLE', {
            product_id: item.product_id,
            reason_codes: resolved.reasonCodes,
          });
        for (const unit of resolved.units)
          units.push({
            itemId: item.id,
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
      const confirmedIds = new Set(targets.map(({ item }) => item.id));
      const commitmentByItem = new Map<string, string>();
      for (const itemId of confirmedIds) {
        if (!units.some((unit) => unit.itemId === itemId)) continue;
        const commitmentId = randomUUID();
        await translatePropertyWrite(() =>
          insertCommitment(em, {
            id: commitmentId,
            tenantId: context.tenantId,
            propertyId,
            sourceKind: 'ITEM',
            sourceId: itemId,
            expiresAt: null,
            inventoryVersion: currentVersion,
          }),
        );
        commitmentByItem.set(itemId, commitmentId);
      }
      for (const unit of units) {
        const item = byId.get(unit.itemId)!;
        for (const resourceId of unit.resourceIds) {
          await translatePropertyWrite(() =>
            insertPlanAllocation(em, {
              commitmentId: commitmentByItem.get(unit.itemId)!,
              tenantId: context.tenantId,
              propertyId,
              resourceId,
              startDate: item.arrival,
              endDate: item.departure,
            }),
          );
        }
      }
      for (const { requested, item } of targets) {
        const updated = await translatePropertyWrite(() =>
          repo.confirmReservationItem(em, {
            tenantId: context.tenantId,
            propertyId,
            itemId: item.id,
            priceSnapshotId: requested.price_snapshot_id,
          }),
        );
        if (!updated)
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            state: item.state,
          });
      }
      const states = items
        .map((item) => (confirmedIds.has(item.id) ? 'CONFIRMED' : item.state))
        .filter(isReservationItemState) as ReservationItemState[];
      const derivedState = deriveReservationState(states);
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const updatedReservation = await repo.markReservationConfirmed(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: reservation.id,
        state: derivedState,
      });
      if (!updatedReservation) throw new PropertyError('NOT_FOUND');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'reservation.confirmed',
        resourceType: 'Reservation',
        resourceId: reservation.id,
        outcome: 'SUCCESS',
        afterSafe: {
          state: derivedState,
          item_ids: [...confirmedIds],
          inventory_version: currentVersion + 1,
        },
        correlationId: context.correlationId,
      });
      await enqueueReservationEvent(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: reservation.channel_connection_id,
        reservationId: reservation.id,
        eventType: 'ReservationConfirmed',
        eventVersion: updatedReservation.version,
        inventoryVersion: currentVersion + 1,
        itemIds: [...confirmedIds],
        state: derivedState,
      });
      if (reservation.source === 'DIRECT')
        await reservationAri?.(em, {
          tenantId: context.tenantId,
          propertyId,
          reservationId: reservation.id,
          reservationVersion: updatedReservation.version,
          inventoryVersion: currentVersion + 1,
          operation: 'CONFIRM',
          affected: targets.map(({ item }) => ({ productId: item.product_id, arrival: item.arrival, departure: item.departure })),
        });
      const response = {
        reservation_id: reservation.id,
        state: derivedState,
        version: updatedReservation.version,
        item_ids: [...confirmedIds],
        inventory_version: currentVersion + 1,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'ConfirmReservation',
        key,
        requestHash,
        response,
        resourceId: reservation.id,
      });
      return { ...response, replayed: false };
    },
  );
}

export interface ModifyItemInput {
  item_id: string;
  period?: { arrival: string; departure: string };
  occupancy?: { adults: number; child_ages: number[] };
  quantity?: number;
  price_snapshot_id?: string;
}

export interface ModifyInput {
  version: number;
  items: ModifyItemInput[];
  idempotencyKey?: string | null;
}

function assertModifyInput(input: ModifyInput): void {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 20
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'items' });
  const ids = new Set<string>();
  for (const item of input.items) {
    if (typeof item.item_id !== 'string')
      throw new PropertyError('INVALID_REQUEST', { field: 'items' });
    if (ids.has(item.item_id))
      throw new PropertyError('INVALID_REQUEST', { field: 'items' });
    ids.add(item.item_id);
    if (item.period) {
      assertIsoDate(item.period.arrival, 'period.arrival');
      assertIsoDate(item.period.departure, 'period.departure');
      if (item.period.departure <= item.period.arrival)
        throw new PropertyError('INVALID_REQUEST', { field: 'period' });
    }
    if (item.occupancy) {
      if (
        !Number.isInteger(item.occupancy.adults) ||
        item.occupancy.adults < 1 ||
        item.occupancy.adults > 20 ||
        !Array.isArray(item.occupancy.child_ages) ||
        item.occupancy.child_ages.some(
          (age) => !Number.isInteger(age) || age < 0 || age > 17,
        )
      )
        throw new PropertyError('INVALID_REQUEST', { field: 'occupancy' });
    }
    if (item.quantity !== undefined) {
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 20
      )
        throw new PropertyError('INVALID_REQUEST', { field: 'quantity' });
    }
  }
}

export async function modifyReservation(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  input: ModifyInput,
  reservationAri?: ReservationAriTransactionHook,
): Promise<Record<string, unknown>> {
  assertModifyInput(input);
  const normalized = [...input.items].sort((a, b) =>
    a.item_id.localeCompare(b.item_id),
  );
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'ModifyReservation',
    reservation_id: reservationId,
    version: input.version,
    items: normalized,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'reservation.modify', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const diskVersion = property.inventory_version;
      const expired = await expireDueHolds(em, context.tenantId, propertyId);
      let currentVersion = diskVersion;
      if (expired > 0) {
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
        currentVersion = diskVersion + 1;
      }
      const replayed = await checkIdempotency(
        em,
        context,
        'ModifyReservation',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const reservation = await repo.findReservation(
        em,
        context.tenantId,
        propertyId,
        reservationId,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      if (reservation.version !== input.version)
        throw new PropertyError('STALE_VERSION', {
          expected: input.version,
          current: reservation.version,
        });
      const items = await repo.listReservationItems(em, reservation.id);
      const reservationGuests = await repo.listReservationGuests(
        em,
        reservation.id,
      );
      const byId = new Map(items.map((item) => [item.id, item]));
      const planned: Array<{
        item: repo.ReservationItemRow;
        arrival: string;
        departure: string;
        adults: number;
        childAges: number[];
        quantity: number;
        priceSnapshotId: string | null;
        productId: string;
        changed: boolean;
      }> = [];
      for (const change of input.items) {
        const item = byId.get(change.item_id);
        if (!item) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        if (!modifiableStates.has(item.state) || item.state === 'CANCELLED')
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            state: item.state,
          });
        if (!item.product_id)
          throw new PropertyError('INVALID_REQUEST', {
            field: 'items',
            reason: 'product_required',
          });
        const arrival = change.period?.arrival ?? item.arrival;
        const departure = change.period?.departure ?? item.departure;
        const adults = change.occupancy?.adults ?? item.adults;
        const childAges = change.occupancy?.child_ages ?? item.child_ages;
        const quantity = change.quantity ?? item.quantity;
        const changed =
          arrival !== item.arrival ||
          departure !== item.departure ||
          adults !== item.adults ||
          quantity !== item.quantity ||
          JSON.stringify(childAges) !== JSON.stringify(item.child_ages);
        let priceSnapshotId = item.price_snapshot_id;
        if (changed) {
          if (!change.price_snapshot_id)
            throw new PropertyError('INVALID_REQUEST', {
              field: 'price_snapshot_id',
              item_id: item.id,
            });
          const quote = await findPriceQuote(
            em,
            context.tenantId,
            propertyId,
            change.price_snapshot_id,
          );
          const expiredQuote =
            !quote ||
            (quote.expires_at !== null &&
              Date.parse(quote.expires_at) <= Date.now());
          if (
            !quote ||
            expiredQuote ||
            quote.product_id !== item.product_id ||
            quote.start_date !== arrival ||
            quote.end_date !== departure ||
            quote.quantity !== quantity ||
            quote.adults !== adults
          )
            throw new PropertyError('INVALID_REQUEST', {
              field: 'price_snapshot_id',
              item_id: item.id,
            });
          priceSnapshotId = change.price_snapshot_id;
        }
        planned.push({
          item,
          arrival,
          departure,
          adults,
          childAges,
          quantity,
          priceSnapshotId,
          productId: item.product_id,
          changed,
        });
      }
      const units: Array<{ itemId: string; resourceIds: string[] }> = [];
      const commitmentByItem = new Map<string, string>();
      for (const plan of planned) {
        if (inventoryHoldingStates.has(plan.item.state)) continue;
        const stale = await repo.findActiveCommitmentForItem(
          em,
          context.tenantId,
          propertyId,
          plan.item.id,
        );
        if (!stale) continue;
        await releaseAllocationsForCommitment(em, stale.id);
        const released = await releaseCommitment(em, {
          tenantId: context.tenantId,
          propertyId,
          commitmentId: stale.id,
          state: 'RELEASED',
        });
        if (!released)
          throw new PropertyError('CONFLICT', {
            reason: 'commitment_release_failed',
          });
      }
      for (const plan of planned.filter(
        (row) => row.changed && inventoryHoldingStates.has(row.item.state),
      )) {
        const active = await repo.findActiveCommitmentForItem(
          em,
          context.tenantId,
          propertyId,
          plan.item.id,
        );
        if (active) {
          await releaseAllocationsForCommitment(em, active.id);
          await touchCommitmentVersion(em, active.id, currentVersion);
          commitmentByItem.set(plan.item.id, active.id);
        }
        const product = await findProduct(
          em,
          context.tenantId,
          propertyId,
          plan.productId,
        );
        if (!product) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        assertSharingScopeGuests({
          scope: product.sharing_scope,
          productId: product.id,
          itemId: plan.item.id,
          guests: reservationGuests,
        });
        const resolved = await resolveAvailabilityForProduct(em, {
          tenantId: context.tenantId,
          propertyId,
          product,
          period: { arrival: plan.arrival, departure: plan.departure },
          occupancy: { adults: plan.adults, childAges: plan.childAges },
          quantity: plan.quantity,
          budget: await searchBudgetForProperty(
            em,
            context.tenantId,
            propertyId,
          ),
        });
        if (resolved.result === 'UNDETERMINED')
          throw new PropertyError('LIMIT_EXCEEDED', { field: 'search_budget' });
        if (resolved.result !== 'AVAILABLE')
          throw new PropertyError('RESOURCE_UNAVAILABLE', {
            product_id: plan.productId,
            reason_codes: resolved.reasonCodes,
          });
        for (const unit of resolved.units)
          units.push({
            itemId: plan.item.id,
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
      for (const unit of units) {
        let commitmentId = commitmentByItem.get(unit.itemId) ?? null;
        if (!commitmentId) {
          const newCommitmentId = randomUUID();
          commitmentId = newCommitmentId;
          await translatePropertyWrite(() =>
            insertCommitment(em, {
              id: newCommitmentId,
              tenantId: context.tenantId,
              propertyId,
              sourceKind: 'ITEM',
              sourceId: unit.itemId,
              expiresAt: null,
              inventoryVersion: currentVersion,
            }),
          );
          commitmentByItem.set(unit.itemId, newCommitmentId);
        }
        for (const resourceId of unit.resourceIds) {
          await translatePropertyWrite(() =>
            insertPlanAllocation(em, {
              commitmentId,
              tenantId: context.tenantId,
              propertyId,
              resourceId,
              startDate: planned.find((row) => row.item.id === unit.itemId)!
                .arrival,
              endDate: planned.find((row) => row.item.id === unit.itemId)!
                .departure,
            }),
          );
        }
      }
      for (const plan of planned) {
        const updated = await translatePropertyWrite(() =>
          repo.updateReservationItem(em, {
            tenantId: context.tenantId,
            propertyId,
            itemId: plan.item.id,
            arrival: plan.arrival,
            departure: plan.departure,
            adults: plan.adults,
            childAges: plan.childAges,
            quantity: plan.quantity,
            priceSnapshotId: plan.priceSnapshotId,
          }),
        );
        if (!updated)
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            state: plan.item.state,
          });
        if (plan.changed)
          await repo.updateStaySegmentPeriod(
            em,
            plan.item.id,
            plan.arrival,
            plan.departure,
          );
      }
      const refreshed = await repo.listReservationItems(em, reservation.id);
      const states = refreshed
        .map((item) => item.state)
        .filter(isReservationItemState) as ReservationItemState[];
      const derivedState = deriveReservationState(states);
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await repo.updateReservationState(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: reservation.id,
        state: derivedState,
      });
      const changedIds = planned.map((plan) => plan.item.id);
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'reservation.modified',
        resourceType: 'Reservation',
        resourceId: reservation.id,
        outcome: 'SUCCESS',
        afterSafe: {
          state: derivedState,
          item_ids: changedIds,
          inventory_version: currentVersion + 1,
        },
        correlationId: context.correlationId,
      });
      await enqueueReservationEvent(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: reservation.channel_connection_id,
        reservationId: reservation.id,
        eventType: 'ReservationModified',
        eventVersion: reservation.version + 1,
        inventoryVersion: currentVersion + 1,
        itemIds: changedIds,
        state: derivedState,
      });
      if (reservation.source === 'DIRECT')
        await reservationAri?.(em, {
          tenantId: context.tenantId,
          propertyId,
          reservationId: reservation.id,
          reservationVersion: reservation.version + 1,
          inventoryVersion: currentVersion + 1,
          operation: 'MODIFY',
          affected: planned.flatMap((plan) => [
            { productId: plan.item.product_id, arrival: plan.item.arrival, departure: plan.item.departure },
            { productId: plan.productId, arrival: plan.arrival, departure: plan.departure },
          ]),
        });
      const response = {
        reservation_id: reservation.id,
        state: derivedState,
        version: reservation.version + 1,
        item_ids: changedIds,
        inventory_version: currentVersion + 1,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'ModifyReservation',
        key,
        requestHash,
        response,
        resourceId: reservation.id,
      });
      return { ...response, replayed: false };
    },
  );
}

export interface CancelItemInput {
  version: number;
  reason: string;
  idempotencyKey?: string | null;
}

export async function cancelItem(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  itemId: string,
  input: CancelItemInput,
  reservationAri?: ReservationAriTransactionHook,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  if (typeof input.reason !== 'string' || input.reason.trim().length < 3)
    throw new PropertyError('INVALID_REQUEST', { field: 'reason' });
  assertSafeText(input.reason, 'reason', 500);
  const reason = input.reason.trim();
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'CancelItem',
    item_id: itemId,
    version: input.version,
    reason,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'reservation.cancel', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const diskVersion = property.inventory_version;
      const expired = await expireDueHolds(em, context.tenantId, propertyId);
      let currentVersion = diskVersion;
      if (expired > 0) {
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
        currentVersion = diskVersion + 1;
      }
      const replayed = await checkIdempotency(
        em,
        context,
        'CancelItem',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const item = await repo.findReservationItem(
        em,
        context.tenantId,
        propertyId,
        itemId,
      );
      if (!item) throw new PropertyError('NOT_FOUND');
      if (item.version !== input.version)
        throw new PropertyError('STALE_VERSION', {
          expected: input.version,
          current: item.version,
        });
      const reservation = await repo.findReservation(
        em,
        context.tenantId,
        propertyId,
        item.reservation_id,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      const active = await repo.findActiveCommitmentForItem(
        em,
        context.tenantId,
        propertyId,
        item.id,
      );
      if (active) {
        const released = await releaseCommitment(em, {
          tenantId: context.tenantId,
          propertyId,
          commitmentId: active.id,
          state: 'RELEASED',
        });
        if (!released)
          throw new PropertyError('CONFLICT', {
            reason: 'commitment_release_failed',
          });
      }
      const cancelled = await translatePropertyWrite(() =>
        repo.cancelReservationItemRow(em, {
          tenantId: context.tenantId,
          propertyId,
          itemId: item.id,
          reason,
        }),
      );
      if (!cancelled)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      const cancelledAssignments = await translatePropertyWrite(() =>
        cancelPlannedAssignmentsForItem(
          em,
          context.tenantId,
          propertyId,
          item.id,
        ),
      );
      const items = await repo.listReservationItems(em, reservation.id);
      const states = items
        .map((row) => row.state)
        .filter(isReservationItemState) as ReservationItemState[];
      const derivedState = deriveReservationState(states);
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await repo.updateReservationState(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: reservation.id,
        state: derivedState,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'reservation.item_cancelled',
        resourceType: 'ReservationItem',
        resourceId: item.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: item.state },
        afterSafe: {
          state: 'CANCELLED',
          inventory_version: currentVersion + 1,
          cancelled_assignment_ids: cancelledAssignments,
        },
        reason,
        correlationId: context.correlationId,
      });
      await enqueueReservationEvent(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: reservation.channel_connection_id,
        reservationId: reservation.id,
        eventType: 'ReservationCancelled',
        eventVersion: reservation.version + 1,
        inventoryVersion: currentVersion + 1,
        itemIds: [item.id],
        state: derivedState,
      });
      if (reservation.source === 'DIRECT')
        await reservationAri?.(em, {
          tenantId: context.tenantId,
          propertyId,
          reservationId: reservation.id,
          reservationVersion: reservation.version + 1,
          inventoryVersion: currentVersion + 1,
          operation: 'CANCEL',
          affected: [{ productId: item.product_id, arrival: item.arrival, departure: item.departure }],
        });
      const response = {
        reservation_id: reservation.id,
        item_id: item.id,
        state: derivedState,
        version: reservation.version + 1,
        item_version: cancelled.version,
        inventory_version: currentVersion + 1,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CancelItem',
        key,
        requestHash,
        response,
        resourceId: reservation.id,
      });
      return { ...response, replayed: false };
    },
  );
}
