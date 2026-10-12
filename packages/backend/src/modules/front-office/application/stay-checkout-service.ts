import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import { lockProperty } from '../../property/persistence/property-repository.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from '../../reservations/application/idempotency-service.js';
import * as reservationRepo from '../../reservations/persistence/reservation-repository.js';
import * as repo from '../persistence/room-assignment-repository.js';
import { insertStayEvent } from '../persistence/stay-event-repository.js';
import { createPrepTaskForStayEvent } from '../../operations/application/operations-service.js';
import { assignmentView, businessToday } from './front-office-service.js';

export interface CheckOutStayInput {
  version: number;
  idempotencyKey?: string | null;
}

export function deriveCheckoutReservationState(
  states: readonly string[],
): string {
  const active = states.filter((state) => state !== 'CANCELLED');
  if (active.length === 0) return 'CANCELLED';
  if (active.every((state) => state === 'CHECKED_OUT' || state === 'COMPLETED'))
    return 'CHECKED_OUT';
  return 'PARTIALLY_CHECKED_OUT';
}

function primaryClosedSegmentId(
  segments: readonly reservationRepo.StaySegmentRow[],
  today: string,
): string | null {
  const closed = segments.filter((segment) => segment.state === 'CHECKED_OUT');
  const current = closed.find(
    (segment) => segment.start_date <= today && segment.end_date > today,
  );
  return current?.id ?? closed[0]?.id ?? null;
}

export async function checkOutStay(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  itemId: string,
  input: CheckOutStayInput,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'CheckOutStay',
    reservation_id: reservationId,
    item_id: itemId,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'stay.checkout', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'CheckOutStay',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      const item = await reservationRepo.findReservationItem(
        em,
        context.tenantId,
        propertyId,
        itemId,
      );
      if (!item) throw new PropertyError('NOT_FOUND');
      if (item.reservation_id !== reservationId)
        throw new PropertyError('CROSS_SCOPE_REFERENCE');
      if (item.version !== input.version)
        throw new PropertyError('STALE_VERSION', {
          expected: input.version,
          current: item.version,
        });
      if (item.state !== 'IN_HOUSE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      const reservation = await reservationRepo.findReservation(
        em,
        context.tenantId,
        propertyId,
        item.reservation_id,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      const today = businessToday(property.timezone);
      const current = await repo.findCurrentAssignmentForItem(
        em,
        context.tenantId,
        propertyId,
        item.id,
      );
      const completed = await translatePropertyWrite(() =>
        repo.completeLiveAssignmentsForItem(em, {
          tenantId: context.tenantId,
          propertyId,
          itemId: item.id,
        }),
      );
      if (current && !completed.some((row) => row.id === current.id))
        throw new PropertyError('CONFLICT', { reason: 'assignment_changed' });
      const checkoutAssignment =
        completed.find((row) => row.id === current?.id) ?? completed[0] ?? null;
      const segments = await translatePropertyWrite(() =>
        reservationRepo.checkOutStaySegments(em, {
          tenantId: context.tenantId,
          propertyId,
          itemId: item.id,
        }),
      );
      const updated = await translatePropertyWrite(() =>
        reservationRepo.checkOutReservationItem(em, {
          tenantId: context.tenantId,
          propertyId,
          itemId: item.id,
        }),
      );
      if (!updated)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: 'IN_HOUSE',
        });
      const roomIds = new Set(completed.map((row) => row.resource_id));
      for (const resourceId of roomIds)
        await translatePropertyWrite(() =>
          repo.markRoomHousekeepingDirty(em, {
            tenantId: context.tenantId,
            propertyId,
            resourceId,
          }),
        );
      const segmentIds = segments.map((segment) => segment.id);
      const event = await insertStayEvent(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: item.reservation_id,
        itemId: item.id,
        segmentId: primaryClosedSegmentId(segments, today),
        type: 'STAY_CHECKED_OUT',
        resourceId: checkoutAssignment?.resource_id ?? null,
        payload: {
          item_id: item.id,
          resource_id: checkoutAssignment?.resource_id ?? null,
          assignment_id: checkoutAssignment?.id ?? null,
          resource_ids: [...roomIds],
          assignment_ids: completed.map((row) => row.id),
          segment_ids: segmentIds,
          segments: segments.map((segment) => ({
            id: segment.id,
            state: segment.state,
            start_date: segment.start_date,
            end_date: segment.end_date,
          })),
          departure: today,
          checked_out_at: updated.checked_out_at,
          business_date: today,
        },
        itemVersion: updated.version,
      });
      if (!event.inserted)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          reason: 'duplicate_stay_event',
        });
      await translatePropertyWrite(() =>
        createPrepTaskForStayEvent(em, {
          tenantId: context.tenantId,
          propertyId,
          event: event.row,
          vacate: false,
          correlationId: context.correlationId,
        }),
      );
      const items = await reservationRepo.listReservationItems(
        em,
        item.reservation_id,
      );
      const derivedState = deriveCheckoutReservationState(
        items.map((row) => row.state),
      );
      const reservationRow = await translatePropertyWrite(() =>
        reservationRepo.updateReservationCheckoutState(em, {
          tenantId: context.tenantId,
          propertyId,
          reservationId: item.reservation_id,
          state: derivedState,
        }),
      );
      if (!reservationRow) throw new PropertyError('NOT_FOUND');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'stay.checked_out',
        resourceType: 'ReservationItem',
        resourceId: item.id,
        outcome: 'SUCCESS',
        beforeSafe: {
          state: item.state,
          assignment_id: current?.id ?? null,
          resource_id: current?.resource_id ?? null,
        },
        afterSafe: {
          state: 'CHECKED_OUT',
          reservation_state: derivedState,
          financial_clearance_state: 'PENDING',
          assignment_id: checkoutAssignment?.id ?? null,
          resource_id: checkoutAssignment?.resource_id ?? null,
          segment_ids: segmentIds,
          checked_out_at: updated.checked_out_at,
          item_version: updated.version,
        },
        correlationId: context.correlationId,
      });
      const response = {
        reservation_id: item.reservation_id,
        item_id: item.id,
        state: 'CHECKED_OUT' as const,
        item_version: updated.version,
        reservation_state: derivedState,
        reservation_version: reservationRow.version,
        checked_out_at: updated.checked_out_at,
        segment_ids: segmentIds,
        assignment: checkoutAssignment
          ? assignmentView(checkoutAssignment)
          : null,
        financial_clearance_state: 'PENDING',
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CheckOutStay',
        key,
        requestHash,
        response,
        resourceId: item.id,
      });
      return { ...response, replayed: false };
    },
  );
}
