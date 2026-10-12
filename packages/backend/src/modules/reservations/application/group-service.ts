import { randomUUID } from 'node:crypto';
import type { MikroORM, EntityManager } from '@mikro-orm/postgresql';
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
import { applyInventoryTimeouts } from '../../inventory/application/timeouts.js';
import {
  resolveAvailabilityForProduct,
  searchBudgetForProperty,
} from '../../inventory/application/availability-service.js';
import {
  expireDueHolds,
  insertCommitment,
  insertPlanAllocation,
  moveAllocationsToCommitment,
  releaseAllocationsForCommitment,
  releaseCommitment,
} from '../../inventory/persistence/guarantee-repository.js';
import { findPriceQuote } from '../../inventory/persistence/rate-repository.js';
import { enqueueOutbox } from '../../distribution/persistence/outbox-repository.js';
import { cancelPlannedAssignmentsForItem } from '../../front-office/persistence/room-assignment-repository.js';
import {
  deriveReservationState,
  isReservationItemState,
} from '../domain/reservation-state.js';
import type { ReservationItemState } from '../domain/reservation-state.js';
import { assertSharingScopeGuests } from '../domain/sharing-policy.js';
import * as repo from '../persistence/reservation-repository.js';

interface QuoteCheck {
  itemId: string;
  productId: string;
  arrival: string;
  departure: string;
  adults: number;
  quantity: number;
  priceSnapshotId: string;
}

async function assertQuote(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  check: QuoteCheck,
): Promise<void> {
  const quote = await findPriceQuote(
    em,
    tenantId,
    propertyId,
    check.priceSnapshotId,
  );
  const expired =
    !quote ||
    (quote.expires_at !== null && Date.parse(quote.expires_at) <= Date.now());
  if (
    !quote ||
    expired ||
    quote.product_id !== check.productId ||
    quote.start_date !== check.arrival ||
    quote.end_date !== check.departure ||
    quote.quantity !== check.quantity ||
    quote.adults !== check.adults
  )
    throw new PropertyError('INVALID_REQUEST', {
      field: 'price_snapshot_id',
      item_id: check.itemId,
    });
}

function assertOverlapFree(
  entries: Array<{
    resourceId: string;
    arrival: string;
    departure: string;
  }>,
): void {
  for (let i = 0; i < entries.length; i += 1)
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i]!;
      const b = entries[j]!;
      if (
        a.resourceId === b.resourceId &&
        a.arrival < b.departure &&
        b.arrival < a.departure
      )
        throw new PropertyError('CONFLICT', {
          reason: 'duplicate_resource',
          resource_id: a.resourceId,
        });
    }
}

async function enqueueCancelled(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    connectionId: string | null;
    reservationId: string;
    eventVersion: number;
    inventoryVersion: number;
    itemIds: string[];
    state: string;
    reason: string;
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
    eventType: 'ReservationCancelled',
    eventVersion: input.eventVersion,
    inventoryVersion: input.inventoryVersion,
    payloadSafe: {
      reservation_id: input.reservationId,
      item_ids: input.itemIds,
      state: input.state,
      reason: input.reason,
      inventory_version: input.inventoryVersion,
    },
  });
}

export interface GroupAllotmentInput {
  product_id: string;
  period: { arrival: string; departure: string };
  quantity: number;
  inventory_version: number;
}

export async function createGroupAllotment(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  input: GroupAllotmentInput,
): Promise<Record<string, unknown>> {
  assertIsoDate(input.period.arrival, 'period.arrival');
  assertIsoDate(input.period.departure, 'period.departure');
  if (input.period.departure <= input.period.arrival)
    throw new PropertyError('INVALID_REQUEST', { field: 'period' });
  if (
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 20
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'quantity' });
  if (!Number.isInteger(input.inventory_version) || input.inventory_version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'inventory_version' });
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
      if (
        input.inventory_version !== diskVersion &&
        !(expired > 0 && input.inventory_version === currentVersion)
      )
        throw new PropertyError('STALE_VERSION', {
          expected: input.inventory_version,
          current: diskVersion,
        });
      const reservation = await repo.findReservation(
        em,
        context.tenantId,
        propertyId,
        reservationId,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      if (reservation.state === 'CANCELLED')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: reservation.state,
        });
      const existing = await repo.findGroupAllotment(
        em,
        context.tenantId,
        propertyId,
        reservationId,
      );
      if (existing)
        throw new PropertyError('CONFLICT', {
          reason: 'group_allotment_exists',
        });
      const product = await findProduct(
        em,
        context.tenantId,
        propertyId,
        input.product_id,
      );
      if (!product) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      // A group allotment holds inventory for a restricted sharing scope, so
      // it must fail closed exactly like the direct sale paths.
      assertSharingScopeGuests({
        scope: product.sharing_scope,
        productId: product.id,
        itemId: null,
        guests: await repo.listReservationGuests(em, reservation.id),
      });
      const resolved = await resolveAvailabilityForProduct(em, {
        tenantId: context.tenantId,
        propertyId,
        product,
        period: input.period,
        occupancy: { adults: 1, childAges: [] },
        quantity: input.quantity,
        budget: await searchBudgetForProperty(em, context.tenantId, propertyId),
      });
      if (resolved.result === 'UNDETERMINED')
        throw new PropertyError('LIMIT_EXCEEDED', { field: 'search_budget' });
      if (resolved.result !== 'AVAILABLE')
        throw new PropertyError('RESOURCE_UNAVAILABLE', {
          product_id: input.product_id,
          reason_codes: resolved.reasonCodes,
        });
      const commitmentId = randomUUID();
      await translatePropertyWrite(() =>
        insertCommitment(em, {
          id: commitmentId,
          tenantId: context.tenantId,
          propertyId,
          sourceKind: 'GROUP',
          sourceId: reservationId,
          expiresAt: null,
          inventoryVersion: currentVersion,
        }),
      );
      let allocationCount = 0;
      for (const unit of resolved.units)
        for (const resource of unit.resources) {
          await translatePropertyWrite(() =>
            insertPlanAllocation(em, {
              commitmentId,
              tenantId: context.tenantId,
              propertyId,
              resourceId: resource.resourceId,
              startDate: input.period.arrival,
              endDate: input.period.departure,
            }),
          );
          allocationCount += 1;
        }
      const allotment = await translatePropertyWrite(() =>
        repo.insertGroupAllotment(em, {
          id: randomUUID(),
          tenantId: context.tenantId,
          propertyId,
          reservationId,
          productId: input.product_id,
          startDate: input.period.arrival,
          endDate: input.period.departure,
          quantity: input.quantity,
          commitmentId,
        }),
      );
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'reservation.group_allotment_created',
        resourceType: 'ReservationGroupAllotment',
        resourceId: allotment.id,
        outcome: 'SUCCESS',
        afterSafe: {
          reservation_id: reservationId,
          product_id: input.product_id,
          allocation_count: allocationCount,
          inventory_version: currentVersion + 1,
        },
        correlationId: context.correlationId,
      });
      return {
        allotment: {
          id: allotment.id,
          reservation_id: reservationId,
          product_id: input.product_id,
          period: {
            arrival: allotment.start_date,
            departure: allotment.end_date,
          },
          quantity: allotment.quantity,
          state: allotment.state,
        },
        allocation_count: allocationCount,
        inventory_version: currentVersion + 1,
      };
    },
  );
}

export interface GroupPickupInput {
  item_id: string;
  price_snapshot_id: string;
}

export async function pickupGroupAllotment(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  input: GroupPickupInput,
): Promise<Record<string, unknown>> {
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
      const reservation = await repo.findReservation(
        em,
        context.tenantId,
        propertyId,
        reservationId,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      const allotment = await repo.findGroupAllotment(
        em,
        context.tenantId,
        propertyId,
        reservationId,
      );
      if (!allotment) throw new PropertyError('NOT_FOUND');
      const item = await repo.findReservationItem(
        em,
        context.tenantId,
        propertyId,
        input.item_id,
      );
      if (!item || item.reservation_id !== reservationId)
        throw new PropertyError('CROSS_SCOPE_REFERENCE');
      if (item.state !== 'INQUIRY' && item.state !== 'TENTATIVE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      if (
        item.product_id !== allotment.product_id ||
        item.arrival !== String(allotment.start_date).slice(0, 10) ||
        item.departure !== String(allotment.end_date).slice(0, 10) ||
        item.quantity !== allotment.quantity
      )
        throw new PropertyError('INVALID_REQUEST', { field: 'item_id' });
      const product = await findProduct(
        em,
        context.tenantId,
        propertyId,
        allotment.product_id,
      );
      if (!product) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      // Pickup confirms the item, so it re-checks the restricted sharing
      // scope against the declared genders before any allocation moves.
      assertSharingScopeGuests({
        scope: product.sharing_scope,
        productId: product.id,
        itemId: item.id,
        guests: await repo.listReservationGuests(em, reservation.id),
      });
      await assertQuote(em, context.tenantId, propertyId, {
        itemId: item.id,
        productId: allotment.product_id,
        arrival: item.arrival,
        departure: item.departure,
        adults: item.adults,
        quantity: item.quantity,
        priceSnapshotId: input.price_snapshot_id,
      });
      const commitmentId = randomUUID();
      await translatePropertyWrite(() =>
        insertCommitment(em, {
          id: commitmentId,
          tenantId: context.tenantId,
          propertyId,
          sourceKind: 'ITEM',
          sourceId: item.id,
          expiresAt: null,
          inventoryVersion: currentVersion,
        }),
      );
      const moved = await moveAllocationsToCommitment(em, {
        fromCommitmentId: allotment.commitment_id,
        toCommitmentId: commitmentId,
      });
      if (moved < 1)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: 'GROUP_RELEASED',
        });
      const released = await releaseCommitment(em, {
        tenantId: context.tenantId,
        propertyId,
        commitmentId: allotment.commitment_id,
        state: 'RELEASED',
      });
      if (!released)
        throw new PropertyError('CONFLICT', {
          reason: 'group_release_failed',
        });
      const picked = await repo.markGroupAllotmentPickedUp(
        em,
        context.tenantId,
        propertyId,
        allotment.id,
      );
      if (!picked)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: allotment.state,
        });
      const confirmed = await translatePropertyWrite(() =>
        repo.confirmReservationItem(em, {
          tenantId: context.tenantId,
          propertyId,
          itemId: item.id,
          priceSnapshotId: input.price_snapshot_id,
        }),
      );
      if (!confirmed)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      const items = await repo.listReservationItems(em, reservation.id);
      const states = items
        .map((row) => row.state)
        .filter(isReservationItemState) as ReservationItemState[];
      const derivedState = deriveReservationState(states);
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const updated = await repo.markReservationConfirmed(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: reservation.id,
        state: derivedState,
      });
      if (!updated) throw new PropertyError('NOT_FOUND');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'reservation.group_pickup',
        resourceType: 'ReservationGroupAllotment',
        resourceId: allotment.id,
        outcome: 'SUCCESS',
        afterSafe: {
          reservation_id: reservationId,
          item_id: item.id,
          moved_allocations: moved,
          inventory_version: currentVersion + 1,
        },
        correlationId: context.correlationId,
      });
      return {
        reservation_id: reservationId,
        item_id: item.id,
        state: derivedState,
        moved_allocations: moved,
        inventory_version: currentVersion + 1,
      };
    },
  );
}

export interface SplitItemInput {
  version: number;
  split_date: string;
  first_price_snapshot_id: string;
  second_price_snapshot_id: string;
}

export async function splitReservationItem(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  itemId: string,
  input: SplitItemInput,
): Promise<Record<string, unknown>> {
  assertIsoDate(input.split_date, 'split_date');
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
      if (item.state !== 'CONFIRMED')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      if (!item.product_id)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'item_id',
          reason: 'product_required',
        });
      if (
        input.split_date <= item.arrival ||
        input.split_date >= item.departure
      )
        throw new PropertyError('INVALID_REQUEST', { field: 'split_date' });
      const reservation = await repo.findReservation(
        em,
        context.tenantId,
        propertyId,
        item.reservation_id,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      await assertQuote(em, context.tenantId, propertyId, {
        itemId: item.id,
        productId: item.product_id,
        arrival: item.arrival,
        departure: input.split_date,
        adults: item.adults,
        quantity: item.quantity,
        priceSnapshotId: input.first_price_snapshot_id,
      });
      await assertQuote(em, context.tenantId, propertyId, {
        itemId: item.id,
        productId: item.product_id,
        arrival: input.split_date,
        departure: item.departure,
        adults: item.adults,
        quantity: item.quantity,
        priceSnapshotId: input.second_price_snapshot_id,
      });
      const active = await repo.findActiveCommitmentForItem(
        em,
        context.tenantId,
        propertyId,
        item.id,
      );
      if (!active)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: 'NO_COMMITMENT',
        });
      const allocations = await repo.listActiveAllocations(em, active.id);
      await releaseAllocationsForCommitment(em, active.id);
      await repo.updateReservationItem(em, {
        tenantId: context.tenantId,
        propertyId,
        itemId: item.id,
        arrival: item.arrival,
        departure: input.split_date,
        adults: item.adults,
        childAges: item.child_ages,
        quantity: item.quantity,
        priceSnapshotId: input.first_price_snapshot_id,
      });
      await repo.updateStaySegmentPeriod(
        em,
        item.id,
        item.arrival,
        input.split_date,
      );
      const secondItemId = randomUUID();
      await repo.insertReservationItem(em, {
        id: secondItemId,
        tenantId: context.tenantId,
        propertyId,
        reservationId: reservation.id,
        productId: item.product_id,
        arrival: input.split_date,
        departure: item.departure,
        adults: item.adults,
        childAges: item.child_ages,
        quantity: item.quantity,
        state: 'CONFIRMED',
        ownerStay: item.owner_stay,
        splitFromId: item.id,
      });
      await repo.insertStaySegment(em, {
        id: randomUUID(),
        tenantId: context.tenantId,
        propertyId,
        itemId: secondItemId,
        startDate: input.split_date,
        endDate: item.departure,
      });
      const secondCommitmentId = randomUUID();
      await translatePropertyWrite(() =>
        insertCommitment(em, {
          id: secondCommitmentId,
          tenantId: context.tenantId,
          propertyId,
          sourceKind: 'ITEM',
          sourceId: secondItemId,
          expiresAt: null,
          inventoryVersion: currentVersion,
        }),
      );
      const placed: Array<{
        resourceId: string;
        arrival: string;
        departure: string;
      }> = [];
      for (const allocation of allocations) {
        const start = String(allocation.start_date).slice(0, 10);
        const end = String(allocation.end_date).slice(0, 10);
        const firstEnd = end < input.split_date ? end : input.split_date;
        const secondStart = start > input.split_date ? start : input.split_date;
        if (start < firstEnd) {
          placed.push({
            resourceId: allocation.resource_id,
            arrival: start,
            departure: firstEnd,
          });
          await insertPlanAllocation(em, {
            commitmentId: active.id,
            tenantId: context.tenantId,
            propertyId,
            resourceId: allocation.resource_id,
            startDate: start,
            endDate: firstEnd,
          });
        }
        if (secondStart < end) {
          placed.push({
            resourceId: allocation.resource_id,
            arrival: secondStart,
            departure: end,
          });
          await insertPlanAllocation(em, {
            commitmentId: secondCommitmentId,
            tenantId: context.tenantId,
            propertyId,
            resourceId: allocation.resource_id,
            startDate: secondStart,
            endDate: end,
          });
        }
      }
      assertOverlapFree(placed);
      await repo.confirmReservationItem(em, {
        tenantId: context.tenantId,
        propertyId,
        itemId: secondItemId,
        priceSnapshotId: input.second_price_snapshot_id,
      });
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
        action: 'reservation.item_split',
        resourceType: 'ReservationItem',
        resourceId: item.id,
        outcome: 'SUCCESS',
        afterSafe: {
          first_item_id: item.id,
          second_item_id: secondItemId,
          split_date: input.split_date,
          inventory_version: currentVersion + 1,
        },
        correlationId: context.correlationId,
      });
      return {
        reservation_id: reservation.id,
        first_item_id: item.id,
        second_item_id: secondItemId,
        state: derivedState,
        inventory_version: currentVersion + 1,
      };
    },
  );
}

export interface NoShowInput {
  version: number;
  reason: string;
}

export async function markItemNoShow(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  itemId: string,
  input: NoShowInput,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  if (typeof input.reason !== 'string' || input.reason.trim().length < 3)
    throw new PropertyError('INVALID_REQUEST', { field: 'reason' });
  assertSafeText(input.reason, 'reason', 500);
  const reason = input.reason.trim();
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
      const marked = await repo.markReservationItemNoShow(em, {
        tenantId: context.tenantId,
        propertyId,
        itemId: item.id,
        reason,
      });
      if (!marked)
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
        action: 'reservation.item_no_show',
        resourceType: 'ReservationItem',
        resourceId: item.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: item.state },
        afterSafe: {
          state: 'NO_SHOW',
          inventory_version: currentVersion + 1,
          cancelled_assignment_ids: cancelledAssignments,
        },
        reason,
        correlationId: context.correlationId,
      });
      await enqueueCancelled(em, {
        tenantId: context.tenantId,
        propertyId,
        connectionId: reservation.channel_connection_id,
        reservationId: reservation.id,
        eventVersion: reservation.version + 1,
        inventoryVersion: currentVersion + 1,
        itemIds: [item.id],
        state: derivedState,
        reason: 'NO_SHOW',
      });
      return {
        reservation_id: reservation.id,
        item_id: item.id,
        state: derivedState,
        item_version: marked.version,
        inventory_version: currentVersion + 1,
      };
    },
  );
}
