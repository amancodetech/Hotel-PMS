import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import {
  insertCommitment,
  insertPlanAllocation,
  releaseAllocationsForCommitment,
  touchCommitmentVersion,
} from '../../inventory/persistence/guarantee-repository.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import {
  bumpPropertyInventoryVersion,
  lockProperty,
} from '../../property/persistence/property-repository.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import {
  deriveReservationState,
  isReservationItemState,
} from '../../reservations/domain/reservation-state.js';
import type { ReservationItemState } from '../../reservations/domain/reservation-state.js';
import * as reservationRepo from '../../reservations/persistence/reservation-repository.js';
import * as repo from '../persistence/room-assignment-repository.js';
import { insertStayEvent } from '../persistence/stay-event-repository.js';
import type { StayEventRow } from '../persistence/stay-event-repository.js';
import { createPrepTaskForStayEvent } from '../../operations/application/operations-service.js';
import {
  assignmentView,
  authorizeRoom,
  businessToday,
  findSegmentForDate,
} from './front-office-service.js';

export interface MoveStayInput {
  to_resource_id: string;
  effective_date: string;
  version: number;
  idempotencyKey?: string | null;
}

export interface ExtendStayInput {
  new_departure: string;
  version: number;
  idempotencyKey?: string | null;
}

export interface SplitStayInput {
  at_date: string;
  version: number;
  idempotencyKey?: string | null;
}

export interface EarlyDepartureStayInput {
  effective_date: string;
  version: number;
  idempotencyKey?: string | null;
}

export interface PartialDepartureStayInput {
  guest_ids: string[];
  version: number;
  idempotencyKey?: string | null;
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
}

function assertDateField(value: string, field: string): string {
  assertIsoDate(value, field);
  return value;
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

async function loadItemForWrite(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  itemId: string,
  version: number,
): Promise<reservationRepo.ReservationItemRow> {
  const item = await reservationRepo.findReservationItem(
    em,
    context.tenantId,
    propertyId,
    itemId,
  );
  if (!item) throw new PropertyError('NOT_FOUND');
  if (item.reservation_id !== reservationId)
    throw new PropertyError('CROSS_SCOPE_REFERENCE');
  if (item.version !== version)
    throw new PropertyError('STALE_VERSION', {
      expected: version,
      current: item.version,
    });
  return item;
}

async function assertSingleComponentStay(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  itemId: string,
  operation: string,
): Promise<void> {
  const [assignments, allocations] = await Promise.all([
    repo.listAssignmentsForItems(em, tenantId, propertyId, [itemId]),
    repo.listActiveItemAllocations(em, tenantId, propertyId, [itemId]),
  ]);
  const components = Math.max(assignments.length, allocations.length);
  if (assignments.length > 1 || allocations.length > 1)
    throw new PropertyError('GROUP_STAY_OPERATION_UNSUPPORTED', {
      operation,
      components,
      reason: 'GROUP_COMPONENT_SELECTION_REQUIRED',
      treatment: 'REBOOK_AFTER_EARLY_DEPARTURE',
    });
}

async function insertStayEventOnce(
  em: EntityManager,
  input: Parameters<typeof insertStayEvent>[1],
): Promise<StayEventRow> {
  const event = await insertStayEvent(em, input);
  if (!event.inserted)
    throw new PropertyError('INVALID_STATE_TRANSITION', {
      reason: 'duplicate_stay_event',
    });
  return event.row;
}

export async function moveStay(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  itemId: string,
  input: MoveStayInput,
): Promise<Record<string, unknown>> {
  if (typeof input.to_resource_id !== 'string' || input.to_resource_id === '')
    throw new PropertyError('INVALID_REQUEST', { field: 'to_resource_id' });
  assertDateField(input.effective_date, 'effective_date');
  assertVersion(input.version);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'MoveStay',
    reservation_id: reservationId,
    item_id: itemId,
    to_resource_id: input.to_resource_id,
    effective_date: input.effective_date,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'stay.move', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'MoveStay',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const item = await loadItemForWrite(
        em,
        context,
        propertyId,
        reservationId,
        itemId,
        input.version,
      );
      if (item.state !== 'IN_HOUSE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      const today = businessToday(property.timezone);
      if (
        input.effective_date < today ||
        input.effective_date >= item.departure
      )
        throw new PropertyError('INVALID_REQUEST', {
          field: 'effective_date',
        });
      await assertSingleComponentStay(
        em,
        context.tenantId,
        propertyId,
        itemId,
        'move',
      );
      await authorizeRoom(
        em,
        context.tenantId,
        propertyId,
        input.to_resource_id,
        {
          startDate: input.effective_date,
          endDate: item.departure,
        },
      );
      const current = await repo.findCurrentAssignmentForItem(
        em,
        context.tenantId,
        propertyId,
        item.id,
      );
      if (!current)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: 'NO_ASSIGNMENT',
        });
      if (current.state !== 'ACTIVE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: current.state,
        });
      if (current.resource_id === input.to_resource_id)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'to_resource_id',
          reason: 'same_room',
        });
      const overlaps = await repo.listOverlappingAssignments(em, {
        tenantId: context.tenantId,
        propertyId,
        resourceIds: [input.to_resource_id],
        startDate: input.effective_date,
        endDate: item.departure,
        excludeItemId: item.id,
      });
      if (overlaps.length > 0)
        throw new PropertyError('CONFLICT', {
          reason: 'resource_occupied',
          resource_id: input.to_resource_id,
        });
      const replaced = await translatePropertyWrite(() =>
        repo.insertRoomAssignment(em, {
          id: randomUUID(),
          tenantId: context.tenantId,
          propertyId,
          itemId: item.id,
          segmentId: current.segment_id,
          resourceId: input.to_resource_id,
          startDate: input.effective_date,
          endDate: item.departure,
          state: 'ACTIVE',
          checkedInAt: new Date().toISOString(),
        }),
      );
      const cancelOld = input.effective_date <= current.start_date;
      const closed = await translatePropertyWrite(() =>
        repo.updateRoomAssignmentPeriod(em, {
          tenantId: context.tenantId,
          propertyId,
          assignmentId: current.id,
          endDate: cancelOld ? current.end_date : input.effective_date,
          state: cancelOld ? 'CANCELLED' : 'COMPLETED',
          expectedState: 'ACTIVE',
        }),
      );
      if (!closed)
        throw new PropertyError('CONFLICT', { reason: 'assignment_changed' });
      const updated = await reservationRepo.bumpReservationItemVersion(em, {
        tenantId: context.tenantId,
        propertyId,
        itemId: item.id,
      });
      if (!updated) throw new PropertyError('NOT_FOUND');
      const movedEvent = await insertStayEventOnce(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: item.reservation_id,
        itemId: item.id,
        segmentId: current.segment_id,
        type: 'STAY_MOVED',
        resourceId: replaced.resource_id,
        payload: {
          assignment_id: replaced.id,
          previous_assignment_id: current.id,
          from_resource_id: current.resource_id,
          to_resource_id: replaced.resource_id,
          effective_date: input.effective_date,
        },
        itemVersion: updated.version,
      });
      await translatePropertyWrite(() =>
        createPrepTaskForStayEvent(em, {
          tenantId: context.tenantId,
          propertyId,
          event: movedEvent,
          vacate: input.effective_date <= businessToday(property.timezone),
          correlationId: context.correlationId,
        }),
      );
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'stay.moved',
        resourceType: 'ReservationItem',
        resourceId: item.id,
        outcome: 'SUCCESS',
        beforeSafe: {
          assignment_id: current.id,
          resource_id: current.resource_id,
          assignment_end_date: current.end_date,
        },
        afterSafe: {
          assignment_id: replaced.id,
          resource_id: replaced.resource_id,
          effective_date: input.effective_date,
          item_version: updated.version,
        },
        correlationId: context.correlationId,
      });
      const response = {
        reservation_id: item.reservation_id,
        item_id: item.id,
        state: item.state,
        item_version: updated.version,
        segment_id: current.segment_id,
        previous_assignment_id: current.id,
        assignment: assignmentView(replaced),
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'MoveStay',
        key,
        requestHash,
        response,
        resourceId: item.id,
      });
      return { ...response, replayed: false };
    },
  );
}

export async function extendStay(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  itemId: string,
  input: ExtendStayInput,
): Promise<Record<string, unknown>> {
  assertDateField(input.new_departure, 'new_departure');
  assertVersion(input.version);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'ExtendStay',
    reservation_id: reservationId,
    item_id: itemId,
    new_departure: input.new_departure,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'stay.move', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const inventoryVersion = property.inventory_version;
      const replayed = await checkIdempotency(
        em,
        context,
        'ExtendStay',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const item = await loadItemForWrite(
        em,
        context,
        propertyId,
        reservationId,
        itemId,
        input.version,
      );
      if (item.state !== 'CONFIRMED' && item.state !== 'IN_HOUSE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      if (input.new_departure <= item.departure)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'new_departure',
        });
      const active = await reservationRepo.findActiveCommitmentForItem(
        em,
        context.tenantId,
        propertyId,
        item.id,
      );
      let allocationCount = 0;
      if (active) {
        const allocations = await reservationRepo.listActiveAllocations(
          em,
          active.id,
        );
        await releaseAllocationsForCommitment(em, active.id);
        for (const allocation of allocations) {
          if (allocation.start_date >= input.new_departure) continue;
          await translatePropertyWrite(() =>
            insertPlanAllocation(em, {
              commitmentId: active.id,
              tenantId: context.tenantId,
              propertyId,
              resourceId: allocation.resource_id,
              startDate: allocation.start_date,
              endDate: input.new_departure,
            }),
          );
          allocationCount += 1;
        }
        await touchCommitmentVersion(em, active.id, inventoryVersion);
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      }
      const liveAssignments = await repo.listAssignmentsForItems(
        em,
        context.tenantId,
        propertyId,
        [item.id],
      );
      const extendedAssignments: repo.RoomAssignmentRow[] = [];
      for (const live of liveAssignments) {
        const extended = await translatePropertyWrite(() =>
          repo.updateRoomAssignmentPeriod(em, {
            tenantId: context.tenantId,
            propertyId,
            assignmentId: live.id,
            endDate: input.new_departure,
            expectedState: live.state,
          }),
        );
        if (!extended)
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            state: live.state,
          });
        extendedAssignments.push(extended);
      }
      const extendedAssignment = extendedAssignments[0] ?? null;
      const updated = await translatePropertyWrite(() =>
        reservationRepo.updateReservationItem(em, {
          tenantId: context.tenantId,
          propertyId,
          itemId: item.id,
          arrival: item.arrival,
          departure: input.new_departure,
          adults: item.adults,
          childAges: item.child_ages,
          quantity: item.quantity,
          priceSnapshotId: item.price_snapshot_id,
        }),
      );
      if (!updated)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      await reservationRepo.extendStaySegments(em, {
        tenantId: context.tenantId,
        propertyId,
        itemId: item.id,
        endDate: input.new_departure,
      });
      const segments = await reservationRepo.listStaySegments(em, [item.id]);
      const segment = findSegmentForDate(segments, item.arrival);
      await insertStayEventOnce(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: item.reservation_id,
        itemId: item.id,
        segmentId: segment?.id ?? null,
        type: 'STAY_EXTENDED',
        resourceId: extendedAssignment?.resource_id ?? null,
        payload: {
          previous_departure: item.departure,
          new_departure: input.new_departure,
          commitment_id: active?.id ?? null,
          allocation_count: allocationCount,
          assignment_ids: extendedAssignments.map((row) => row.id),
        },
        itemVersion: updated.version,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'stay.extended',
        resourceType: 'ReservationItem',
        resourceId: item.id,
        outcome: 'SUCCESS',
        beforeSafe: { departure: item.departure },
        afterSafe: {
          departure: input.new_departure,
          assignment_id: extendedAssignment?.id ?? null,
          assignment_ids: extendedAssignments.map((row) => row.id),
          allocation_count: allocationCount,
          inventory_version: active ? inventoryVersion + 1 : inventoryVersion,
          item_version: updated.version,
        },
        correlationId: context.correlationId,
      });
      const response = {
        reservation_id: item.reservation_id,
        item_id: item.id,
        state: item.state,
        item_version: updated.version,
        departure: input.new_departure,
        assignment: extendedAssignment
          ? assignmentView(extendedAssignment)
          : null,
        inventory_version: active ? inventoryVersion + 1 : inventoryVersion,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'ExtendStay',
        key,
        requestHash,
        response,
        resourceId: item.id,
      });
      return { ...response, replayed: false };
    },
  );
}

export async function splitStay(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  itemId: string,
  input: SplitStayInput,
): Promise<Record<string, unknown>> {
  assertDateField(input.at_date, 'at_date');
  assertVersion(input.version);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'SplitStay',
    reservation_id: reservationId,
    item_id: itemId,
    at_date: input.at_date,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'stay.move', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const inventoryVersion = property.inventory_version;
      const replayed = await checkIdempotency(
        em,
        context,
        'SplitStay',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const item = await loadItemForWrite(
        em,
        context,
        propertyId,
        reservationId,
        itemId,
        input.version,
      );
      if (item.state !== 'IN_HOUSE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      if (input.at_date <= item.arrival || input.at_date >= item.departure)
        throw new PropertyError('INVALID_REQUEST', { field: 'at_date' });
      await assertSingleComponentStay(
        em,
        context.tenantId,
        propertyId,
        itemId,
        'split',
      );
      if (!item.product_id)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'item_id',
          reason: 'product_required',
        });
      const reservation = await reservationRepo.findReservation(
        em,
        context.tenantId,
        propertyId,
        item.reservation_id,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      const current = await repo.findCurrentAssignmentForItem(
        em,
        context.tenantId,
        propertyId,
        item.id,
      );
      if (!current || current.state !== 'ACTIVE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: 'NO_ACTIVE_ASSIGNMENT',
        });
      const active = await reservationRepo.findActiveCommitmentForItem(
        em,
        context.tenantId,
        propertyId,
        item.id,
      );
      if (!active)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: 'NO_COMMITMENT',
        });
      const allocations = await reservationRepo.listActiveAllocations(
        em,
        active.id,
      );
      const followUpItemId = randomUUID();
      const followUpSegmentId = randomUUID();
      const followUpCommitmentId = randomUUID();
      await translatePropertyWrite(() =>
        insertCommitment(em, {
          id: followUpCommitmentId,
          tenantId: context.tenantId,
          propertyId,
          sourceKind: 'ITEM',
          sourceId: followUpItemId,
          expiresAt: null,
          inventoryVersion,
        }),
      );
      await releaseAllocationsForCommitment(em, active.id);
      const placed: Array<{
        resourceId: string;
        arrival: string;
        departure: string;
      }> = [];
      for (const allocation of allocations) {
        const start = allocation.start_date;
        const end = allocation.end_date;
        const firstEnd = end < input.at_date ? end : input.at_date;
        const secondStart = start > input.at_date ? start : input.at_date;
        if (start < firstEnd) {
          placed.push({
            resourceId: allocation.resource_id,
            arrival: start,
            departure: firstEnd,
          });
          await translatePropertyWrite(() =>
            insertPlanAllocation(em, {
              commitmentId: active.id,
              tenantId: context.tenantId,
              propertyId,
              resourceId: allocation.resource_id,
              startDate: start,
              endDate: firstEnd,
            }),
          );
        }
        if (secondStart < end) {
          placed.push({
            resourceId: allocation.resource_id,
            arrival: secondStart,
            departure: end,
          });
          await translatePropertyWrite(() =>
            insertPlanAllocation(em, {
              commitmentId: followUpCommitmentId,
              tenantId: context.tenantId,
              propertyId,
              resourceId: allocation.resource_id,
              startDate: secondStart,
              endDate: end,
            }),
          );
        }
      }
      assertOverlapFree(placed);
      await touchCommitmentVersion(em, active.id, inventoryVersion);
      const updated = await translatePropertyWrite(() =>
        reservationRepo.updateReservationItem(em, {
          tenantId: context.tenantId,
          propertyId,
          itemId: item.id,
          arrival: item.arrival,
          departure: input.at_date,
          adults: item.adults,
          childAges: item.child_ages,
          quantity: item.quantity,
          priceSnapshotId: item.price_snapshot_id,
        }),
      );
      if (!updated)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      await reservationRepo.clipStaySegments(em, {
        tenantId: context.tenantId,
        propertyId,
        itemId: item.id,
        endDate: input.at_date,
      });
      const followUpItem = await translatePropertyWrite(() =>
        reservationRepo.insertReservationItem(em, {
          id: followUpItemId,
          tenantId: context.tenantId,
          propertyId,
          reservationId: item.reservation_id,
          productId: item.product_id,
          arrival: input.at_date,
          departure: item.departure,
          adults: item.adults,
          childAges: item.child_ages,
          quantity: item.quantity,
          state: item.state,
          ownerStay: item.owner_stay,
          splitFromId: item.id,
          priceSnapshotId: item.price_snapshot_id,
          checkedInAt: current.checked_in_at ?? new Date().toISOString(),
        }),
      );
      const followUpSegment = await translatePropertyWrite(() =>
        reservationRepo.insertStaySegment(em, {
          id: followUpSegmentId,
          tenantId: context.tenantId,
          propertyId,
          itemId: followUpItemId,
          startDate: input.at_date,
          endDate: item.departure,
          state: 'IN_HOUSE',
          checkedInAt: current.checked_in_at ?? new Date().toISOString(),
        }),
      );
      const cancelOld = input.at_date <= current.start_date;
      const closed = await translatePropertyWrite(() =>
        repo.updateRoomAssignmentPeriod(em, {
          tenantId: context.tenantId,
          propertyId,
          assignmentId: current.id,
          endDate: cancelOld ? current.end_date : input.at_date,
          state: cancelOld ? 'CANCELLED' : 'COMPLETED',
          expectedState: 'ACTIVE',
        }),
      );
      if (!closed)
        throw new PropertyError('CONFLICT', { reason: 'assignment_changed' });
      const followUpAssignment = await translatePropertyWrite(() =>
        repo.insertRoomAssignment(em, {
          id: randomUUID(),
          tenantId: context.tenantId,
          propertyId,
          itemId: followUpItemId,
          segmentId: followUpSegment.id,
          resourceId: current.resource_id,
          startDate: input.at_date,
          endDate: item.departure,
          state: 'ACTIVE',
          checkedInAt: current.checked_in_at ?? new Date().toISOString(),
        }),
      );
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const items = await reservationRepo.listReservationItems(
        em,
        item.reservation_id,
      );
      const states = items
        .map((row) => row.state)
        .filter(isReservationItemState) as ReservationItemState[];
      const derivedState = deriveReservationState(states);
      await reservationRepo.updateReservationState(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: item.reservation_id,
        state: derivedState,
      });
      await insertStayEventOnce(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: item.reservation_id,
        itemId: item.id,
        segmentId: followUpSegment.id,
        type: 'STAY_SPLIT',
        resourceId: current.resource_id,
        payload: {
          follow_up_item_id: followUpItemId,
          at_date: input.at_date,
          previous_departure: item.departure,
          follow_up_commitment_id: followUpCommitmentId,
          follow_up_assignment_id: followUpAssignment.id,
        },
        itemVersion: updated.version,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'stay.split',
        resourceType: 'ReservationItem',
        resourceId: item.id,
        outcome: 'SUCCESS',
        beforeSafe: { departure: item.departure },
        afterSafe: {
          departure: input.at_date,
          follow_up_item_id: followUpItemId,
          follow_up_departure: item.departure,
          follow_up_assignment_id: followUpAssignment.id,
          state: derivedState,
          item_version: updated.version,
        },
        correlationId: context.correlationId,
      });
      const response = {
        reservation_id: item.reservation_id,
        item_id: item.id,
        state: item.state,
        item_version: updated.version,
        follow_up_item_id: followUpItemId,
        follow_up_item_version: followUpItem.version,
        at_date: input.at_date,
        departure: input.at_date,
        follow_up_departure: followUpItem.departure,
        segment_id: followUpSegment.id,
        follow_up_assignment: assignmentView(followUpAssignment),
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'SplitStay',
        key,
        requestHash,
        response,
        resourceId: item.id,
      });
      return { ...response, replayed: false };
    },
  );
}

export async function earlyDepartureStay(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  itemId: string,
  input: EarlyDepartureStayInput,
): Promise<Record<string, unknown>> {
  assertDateField(input.effective_date, 'effective_date');
  assertVersion(input.version);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'EarlyDepartureStay',
    reservation_id: reservationId,
    item_id: itemId,
    effective_date: input.effective_date,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'stay.move', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const inventoryVersion = property.inventory_version;
      const replayed = await checkIdempotency(
        em,
        context,
        'EarlyDepartureStay',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const item = await loadItemForWrite(
        em,
        context,
        propertyId,
        reservationId,
        itemId,
        input.version,
      );
      if (item.state !== 'IN_HOUSE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      const today = businessToday(property.timezone);
      if (
        input.effective_date < today ||
        input.effective_date >= item.departure
      )
        throw new PropertyError('INVALID_REQUEST', {
          field: 'effective_date',
        });
      if (input.effective_date <= item.arrival)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'effective_date',
          reason: 'zero_night_stay',
        });
      const active = await reservationRepo.findActiveCommitmentForItem(
        em,
        context.tenantId,
        propertyId,
        item.id,
      );
      let allocationCount = 0;
      if (active) {
        const allocations = await reservationRepo.listActiveAllocations(
          em,
          active.id,
        );
        await releaseAllocationsForCommitment(em, active.id);
        for (const allocation of allocations) {
          if (allocation.start_date >= input.effective_date) continue;
          const end =
            allocation.end_date < input.effective_date
              ? allocation.end_date
              : input.effective_date;
          await translatePropertyWrite(() =>
            insertPlanAllocation(em, {
              commitmentId: active.id,
              tenantId: context.tenantId,
              propertyId,
              resourceId: allocation.resource_id,
              startDate: allocation.start_date,
              endDate: end,
            }),
          );
          allocationCount += 1;
        }
        await touchCommitmentVersion(em, active.id, inventoryVersion);
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      }
      const liveAssignments = await repo.listAssignmentsForItems(
        em,
        context.tenantId,
        propertyId,
        [item.id],
      );
      const shortenedAssignments: repo.RoomAssignmentRow[] = [];
      for (const live of liveAssignments) {
        const cancelAssignment = input.effective_date <= live.start_date;
        const shortened = await translatePropertyWrite(() =>
          repo.updateRoomAssignmentPeriod(em, {
            tenantId: context.tenantId,
            propertyId,
            assignmentId: live.id,
            endDate: cancelAssignment ? live.end_date : input.effective_date,
            ...(cancelAssignment ? { state: 'CANCELLED' as const } : {}),
            expectedState: live.state,
          }),
        );
        if (!shortened)
          throw new PropertyError('INVALID_STATE_TRANSITION', {
            state: live.state,
          });
        shortenedAssignments.push(shortened);
      }
      const shortenedAssignment = shortenedAssignments[0] ?? null;
      const updated = await translatePropertyWrite(() =>
        reservationRepo.updateReservationItem(em, {
          tenantId: context.tenantId,
          propertyId,
          itemId: item.id,
          arrival: item.arrival,
          departure: input.effective_date,
          adults: item.adults,
          childAges: item.child_ages,
          quantity: item.quantity,
          priceSnapshotId: item.price_snapshot_id,
        }),
      );
      if (!updated)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      await reservationRepo.clipStaySegments(em, {
        tenantId: context.tenantId,
        propertyId,
        itemId: item.id,
        endDate: input.effective_date,
      });
      const segments = await reservationRepo.listStaySegments(em, [item.id]);
      const segment = findSegmentForDate(segments, item.arrival);
      await insertStayEventOnce(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: item.reservation_id,
        itemId: item.id,
        segmentId: segment?.id ?? null,
        type: 'STAY_EARLY_DEPARTURE',
        resourceId: shortenedAssignment?.resource_id ?? null,
        payload: {
          previous_departure: item.departure,
          effective_date: input.effective_date,
          commitment_id: active?.id ?? null,
          allocation_count: allocationCount,
          assignment_ids: shortenedAssignments.map((row) => row.id),
        },
        itemVersion: updated.version,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'stay.early_departure',
        resourceType: 'ReservationItem',
        resourceId: item.id,
        outcome: 'SUCCESS',
        beforeSafe: { departure: item.departure },
        afterSafe: {
          departure: input.effective_date,
          assignment_id: shortenedAssignment?.id ?? null,
          assignment_ids: shortenedAssignments.map((row) => row.id),
          allocation_count: allocationCount,
          inventory_version: active ? inventoryVersion + 1 : inventoryVersion,
          item_version: updated.version,
        },
        correlationId: context.correlationId,
      });
      const response = {
        reservation_id: item.reservation_id,
        item_id: item.id,
        state: item.state,
        item_version: updated.version,
        departure: input.effective_date,
        assignment: shortenedAssignment
          ? assignmentView(shortenedAssignment)
          : null,
        inventory_version: active ? inventoryVersion + 1 : inventoryVersion,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'EarlyDepartureStay',
        key,
        requestHash,
        response,
        resourceId: item.id,
      });
      return { ...response, replayed: false };
    },
  );
}

export async function partialDepartureStay(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  itemId: string,
  input: PartialDepartureStayInput,
): Promise<Record<string, unknown>> {
  if (
    !Array.isArray(input.guest_ids) ||
    input.guest_ids.length < 1 ||
    input.guest_ids.length > 20
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'guest_ids' });
  const guestIds = [...new Set(input.guest_ids)].sort();
  if (
    guestIds.length !== input.guest_ids.length ||
    guestIds.some((id) => typeof id !== 'string' || id.length === 0)
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'guest_ids' });
  assertVersion(input.version);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'PartialDepartureStay',
    reservation_id: reservationId,
    item_id: itemId,
    guest_ids: guestIds,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'stay.checkout', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'PartialDepartureStay',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const item = await loadItemForWrite(
        em,
        context,
        propertyId,
        reservationId,
        itemId,
        input.version,
      );
      if (item.state !== 'IN_HOUSE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      const guests = await reservationRepo.listReservationGuests(
        em,
        item.reservation_id,
      );
      const known = new Set(guests.map((guest) => guest.guest_id));
      for (const guestId of guestIds)
        if (!known.has(guestId))
          throw new PropertyError('CROSS_SCOPE_REFERENCE', {
            field: 'guest_ids',
            guest_id: guestId,
          });
      const departed = await reservationRepo.markReservationGuestsDeparted(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: item.reservation_id,
        guestIds,
      });
      if (departed.length === 0)
        throw new PropertyError('CONFLICT', {
          reason: 'guests_already_departed',
        });
      const updated = await reservationRepo.bumpReservationItemVersion(em, {
        tenantId: context.tenantId,
        propertyId,
        itemId: item.id,
      });
      if (!updated) throw new PropertyError('NOT_FOUND');
      await insertStayEventOnce(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: item.reservation_id,
        itemId: item.id,
        segmentId: null,
        type: 'STAY_PARTIAL_DEPARTURE',
        resourceId: null,
        payload: {
          guest_ids: departed,
          requested_guest_ids: guestIds,
        },
        itemVersion: updated.version,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'stay.partial_departure',
        resourceType: 'ReservationItem',
        resourceId: item.id,
        outcome: 'SUCCESS',
        afterSafe: {
          departed_guest_ids: departed,
          item_version: updated.version,
        },
        correlationId: context.correlationId,
      });
      const response = {
        reservation_id: item.reservation_id,
        item_id: item.id,
        state: item.state,
        item_version: updated.version,
        departed_guest_ids: departed,
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'PartialDepartureStay',
        key,
        requestHash,
        response,
        resourceId: item.id,
      });
      return { ...response, replayed: false };
    },
  );
}
