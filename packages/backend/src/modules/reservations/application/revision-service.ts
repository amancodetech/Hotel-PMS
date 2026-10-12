import { randomUUID } from 'node:crypto';
import type { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertSharingScopeGuests } from '../domain/sharing-policy.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import {
  bumpPropertyInventoryVersion,
  lockProperty,
} from '../../property/persistence/property-repository.js';
import { findProduct } from '../../property/persistence/product-repository.js';
import {
  findLatestExceptionForInbox,
  listOpenExceptions,
  openException,
  resolveException,
} from '../../distribution/persistence/exception-repository.js';
import { applyInventoryTimeouts } from '../../inventory/application/timeouts.js';
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
import { cancelPlannedAssignmentsForItem } from '../../front-office/persistence/room-assignment-repository.js';
import {
  deriveReservationState,
  isReservationItemState,
} from '../domain/reservation-state.js';
import type { ReservationItemState } from '../domain/reservation-state.js';
import * as repo from '../persistence/reservation-repository.js';
import * as revisions from '../persistence/channel-revision-repository.js';

interface RevisionPayloadItem {
  arrival: string;
  departure: string;
  occupancy: number;
}

function readOccupancy(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 20
  )
    return null;
  return value;
}

function payloadItems(
  payload: Record<string, unknown>,
): RevisionPayloadItem[] | null {
  const raw = payload['items'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const envelopeOccupancy = readOccupancy(payload['occupancy']);
  const items: RevisionPayloadItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    if (
      typeof item['arrival'] !== 'string' ||
      typeof item['departure'] !== 'string'
    )
      return null;
    try {
      assertIsoDate(item['arrival'], 'items.arrival');
      assertIsoDate(item['departure'], 'items.departure');
    } catch {
      return null;
    }
    if (item['departure'] <= item['arrival']) return null;
    const occupancy = readOccupancy(item['occupancy']) ?? envelopeOccupancy;
    if (occupancy === null) return null;
    items.push({
      arrival: item['arrival'],
      departure: item['departure'],
      occupancy,
    });
  }
  return items;
}

function isNumeric(value: string): boolean {
  return /^\d+$/.test(value);
}

async function closeOpenRevisionException(
  em: EntityManager,
  context: ServiceContext,
  revision: revisions.ChannelRevisionRow,
  resolution: string,
): Promise<string | null> {
  const existing = await findLatestExceptionForInbox(
    em,
    revision.id,
    'REVISION_CONFLICT',
  );
  if (
    !existing ||
    (existing.state !== 'OPEN' && existing.state !== 'IN_PROGRESS')
  )
    return null;
  await resolveException(em, existing.id, resolution, context.actor.userId);
  return existing.id;
}

async function markException(
  em: EntityManager,
  context: ServiceContext,
  propertyId: string,
  revision: revisions.ChannelRevisionRow,
  code: string,
  details: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const superseded = await closeOpenRevisionException(
    em,
    context,
    revision,
    'SUPERSEDED',
  );
  const exception = await openException(em, {
    tenantId: context.tenantId,
    propertyId,
    connectionId: revision.connection_id,
    inboxRevisionId: revision.id,
    outboxId: null,
    type: 'REVISION_CONFLICT',
    detailsSafe: {
      error_code: code,
      provider_revision_id: revision.provider_revision_id,
      ...details,
    },
  });
  await revisions.markChannelRevision(em, {
    revisionId: revision.id,
    reservationId: revision.reservation_ref,
    processingState: 'EXCEPTION',
    safeErrorCode: code,
    exceptionId: exception.id,
  });
  await recordAudit(em, {
    tenantId: context.tenantId,
    propertyId,
    ...auditActor(context),
    action: 'channel.revision_reprocess',
    resourceType: 'DistributionInboxRevision',
    resourceId: revision.id,
    outcome: 'FAILED',
    afterSafe: {
      error_code: code,
      exception_id: exception.id,
      superseded_exception_id: superseded,
    },
    correlationId: context.correlationId,
  });
  return {
    outcome: 'EXCEPTION',
    error_code: code,
    exception_id: exception.id,
    reservation_id: revision.reservation_ref,
    replayed: false,
  };
}

export async function listChannelExceptions(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<Record<string, unknown>> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'channel.reprocess', propertyId);
      const property = await repo.findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const exceptions = await listOpenExceptions(
        em,
        context.tenantId,
        propertyId,
      );
      return {
        items: exceptions.map((row) => ({
          id: row.id,
          type: row.type,
          state: row.state,
          connection_id: row.connection_id,
          inbox_revision_id: row.inbox_revision_id,
          outbox_id: row.outbox_id,
          owner: row.owner,
          resolution: row.resolution,
          details_safe: row.details_safe,
          version: row.version,
          created_at: row.created_at,
          updated_at: row.updated_at,
        })),
      };
    },
  );
}

export async function reprocessChannelRevision(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  revisionId: string,
): Promise<Record<string, unknown>> {
  try {
    return await runScopedTransaction(
      orm,
      { tenantId: context.tenantId, userId: context.actor.userId },
      async (em) => {
        await applyInventoryTimeouts(em);
        await authorize(em, context, 'channel.reprocess', propertyId);
        const property = await lockProperty(em, context.tenantId, propertyId);
        const diskVersion = property.inventory_version;
        const expired = await expireDueHolds(em, context.tenantId, propertyId);
        let currentVersion = diskVersion;
        if (expired > 0) {
          await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
          currentVersion = diskVersion + 1;
        }
        const revision = await revisions.findChannelRevision(
          em,
          context.tenantId,
          propertyId,
          revisionId,
        );
        if (!revision) throw new PropertyError('NOT_FOUND');
        // Transport APPLIED only records the external booking. A linked PMS
        // reservation is required before this consumer can treat it as a replay.
        if (
          revision.processing_state === 'APPLIED' &&
          revision.reservation_ref !== null
        )
          return {
            outcome: 'DUPLICATE',
            reservation_id: revision.reservation_ref,
            replayed: true,
          };
        if (
          revision.revision_type !== 'new' &&
          revision.revision_type !== 'modified' &&
          revision.revision_type !== 'cancelled'
        )
          return markException(
            em,
            context,
            propertyId,
            revision,
            'PAYLOAD_UNSUPPORTED',
          );
        if (revision.source_sequence) {
          const maxSequence = await revisions.findMaxAppliedSequence(
            em,
            revision.connection_id,
          );
          if (
            maxSequence &&
            isNumeric(maxSequence) &&
            isNumeric(revision.source_sequence) &&
            BigInt(revision.source_sequence) < BigInt(maxSequence)
          )
            return markException(
              em,
              context,
              propertyId,
              revision,
              'OUT_OF_ORDER',
              { last_applied_sequence: maxSequence },
            );
        }
        const found = await revisions.findReservationByExternalKey(
          em,
          context.tenantId,
          propertyId,
          revision.connection_id,
          revision.external_booking_id,
        );
        let reservationId = revision.reservation_ref ?? found?.id ?? null;
        if (!reservationId) {
          const resolution = await revisions.resolveReservationForExternalKey(
            em,
            context.tenantId,
            propertyId,
            revision.connection_id,
            revision.external_booking_id,
          );
          if (resolution.kind === 'ambiguous')
            return markException(
              em,
              context,
              propertyId,
              revision,
              'EXTERNAL_KEY_AMBIGUOUS',
              { candidate_count: resolution.candidateCount },
            );
          if (resolution.kind === 'adopt') {
            const attached = await revisions.attachReservationConnection(em, {
              tenantId: context.tenantId,
              propertyId,
              reservationId: resolution.reservationId,
              connectionId: revision.connection_id,
            });
            if (!attached)
              return markException(
                em,
                context,
                propertyId,
                revision,
                'LINK_MISSING',
              );
            reservationId = resolution.reservationId;
            await recordAudit(em, {
              tenantId: context.tenantId,
              propertyId,
              ...auditActor(context),
              action: 'channel.external_booking_adopted',
              resourceType: 'Reservation',
              resourceId: resolution.reservationId,
              outcome: 'SUCCESS',
              afterSafe: {
                connection_id: revision.connection_id,
                external_booking_id: revision.external_booking_id,
                revision_id: revision.provider_revision_id,
              },
              correlationId: context.correlationId,
            });
          }
        }
        const items = payloadItems(revision.payload_safe);

        if (revision.revision_type === 'new') {
          if (reservationId)
            return markException(
              em,
              context,
              propertyId,
              revision,
              'DUPLICATE_BOOKING',
              { reservation_id: reservationId },
            );
          if (!items)
            return markException(
              em,
              context,
              propertyId,
              revision,
              'PAYLOAD_UNSUPPORTED',
            );
          const reservation = await translatePropertyWrite(() =>
            repo.insertReservation(em, {
              id: randomUUID(),
              tenantId: context.tenantId,
              propertyId,
              source: 'OTA',
              channelConnectionId: revision.connection_id,
              externalBookingKey: revision.external_booking_id,
              state: 'INQUIRY',
            }),
          );
          for (const item of items) {
            const row = await translatePropertyWrite(() =>
              repo.insertReservationItem(em, {
                id: randomUUID(),
                tenantId: context.tenantId,
                propertyId,
                reservationId: reservation.id,
                productId: null,
                arrival: item.arrival,
                departure: item.departure,
                adults: item.occupancy,
                childAges: [],
                quantity: 1,
                state: 'INQUIRY',
              }),
            );
            await translatePropertyWrite(() =>
              repo.insertStaySegment(em, {
                id: randomUUID(),
                tenantId: context.tenantId,
                propertyId,
                itemId: row.id,
                startDate: item.arrival,
                endDate: item.departure,
              }),
            );
          }
          const resolvedExceptionId = await closeOpenRevisionException(
            em,
            context,
            revision,
            'REPROCESSED',
          );
          await revisions.markChannelRevision(em, {
            revisionId: revision.id,
            reservationId: reservation.id,
            processingState: 'APPLIED',
            safeErrorCode: null,
          });
          await recordAudit(em, {
            tenantId: context.tenantId,
            propertyId,
            ...auditActor(context),
            action: 'channel.revision_reprocess',
            resourceType: 'DistributionInboxRevision',
            resourceId: revision.id,
            outcome: 'SUCCESS',
            afterSafe: {
              outcome: 'CREATED',
              reservation_id: reservation.id,
              item_count: items.length,
              resolved_exception_id: resolvedExceptionId,
            },
            correlationId: context.correlationId,
          });
          return {
            outcome: 'CREATED',
            reservation_id: reservation.id,
            replayed: false,
          };
        }

        if (!reservationId)
          return markException(
            em,
            context,
            propertyId,
            revision,
            'LINK_MISSING',
          );
        if (!items)
          return markException(
            em,
            context,
            propertyId,
            revision,
            'PAYLOAD_UNSUPPORTED',
          );
        const reservation = await repo.findReservation(
          em,
          context.tenantId,
          propertyId,
          reservationId,
        );
        if (!reservation)
          return markException(
            em,
            context,
            propertyId,
            revision,
            'LINK_MISSING',
          );
        const existing = await repo.listReservationItems(em, reservation.id);

        if (revision.revision_type === 'cancelled') {
          for (const item of existing) {
            if (
              item.state === 'CANCELLED' ||
              item.state === 'NO_SHOW' ||
              item.state === 'IN_HOUSE' ||
              item.state === 'CHECKED_OUT' ||
              item.state === 'COMPLETED'
            )
              continue;
            const active = await repo.findActiveCommitmentForItem(
              em,
              context.tenantId,
              propertyId,
              item.id,
            );
            if (active)
              await releaseCommitment(em, {
                tenantId: context.tenantId,
                propertyId,
                commitmentId: active.id,
                state: 'RELEASED',
              });
            await translatePropertyWrite(() =>
              repo.cancelReservationItemRow(em, {
                tenantId: context.tenantId,
                propertyId,
                itemId: item.id,
                reason: 'EXTERNAL_CANCEL',
              }),
            );
            await translatePropertyWrite(() =>
              cancelPlannedAssignmentsForItem(
                em,
                context.tenantId,
                propertyId,
                item.id,
              ),
            );
          }
          const refreshed = await repo.listReservationItems(em, reservation.id);
          const states = refreshed
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
          const resolvedExceptionId = await closeOpenRevisionException(
            em,
            context,
            revision,
            'REPROCESSED',
          );
          await revisions.markChannelRevision(em, {
            revisionId: revision.id,
            reservationId: reservation.id,
            processingState: 'APPLIED',
            safeErrorCode: null,
          });
          await recordAudit(em, {
            tenantId: context.tenantId,
            propertyId,
            ...auditActor(context),
            action: 'channel.revision_reprocess',
            resourceType: 'DistributionInboxRevision',
            resourceId: revision.id,
            outcome: 'SUCCESS',
            afterSafe: {
              outcome: 'CANCELLED',
              reservation_id: reservation.id,
              inventory_version: currentVersion + 1,
              resolved_exception_id: resolvedExceptionId,
            },
            correlationId: context.correlationId,
          });
          return {
            outcome: 'CANCELLED',
            reservation_id: reservation.id,
            state: derivedState,
            replayed: false,
          };
        }

        if (existing.length !== items.length)
          return markException(
            em,
            context,
            propertyId,
            revision,
            'ITEM_COUNT_MISMATCH',
            { expected: existing.length, received: items.length },
          );

        const planned: Array<{
          item: repo.ReservationItemRow;
          arrival: string;
          departure: string;
          occupancy: number;
          commitmentId: string | null;
        }> = [];
        for (let index = 0; index < existing.length; index += 1) {
          const item = existing[index]!;
          const target = items[index]!;
          if (
            item.state === 'CANCELLED' ||
            item.state === 'NO_SHOW' ||
            item.state === 'IN_HOUSE' ||
            item.state === 'CHECKED_OUT' ||
            item.state === 'COMPLETED'
          )
            return markException(
              em,
              context,
              propertyId,
              revision,
              'INVALID_STATE_TRANSITION',
              { state: item.state, item_id: item.id },
            );
          let commitmentId: string | null = null;
          if (item.state === 'CONFIRMED' && item.product_id) {
            const active = await repo.findActiveCommitmentForItem(
              em,
              context.tenantId,
              propertyId,
              item.id,
            );
            const product = await findProduct(
              em,
              context.tenantId,
              propertyId,
              item.product_id,
            );
            if (!product)
              return markException(
                em,
                context,
                propertyId,
                revision,
                'LINK_MISSING',
              );
            assertSharingScopeGuests({
              scope: product.sharing_scope,
              productId: product.id,
              itemId: item.id,
              guests: await repo.listReservationGuests(em, reservation.id),
            });
            if (active) {
              await releaseAllocationsForCommitment(em, active.id);
              await touchCommitmentVersion(em, active.id, currentVersion);
              commitmentId = active.id;
            } else {
              const createdCommitmentId = randomUUID();
              commitmentId = createdCommitmentId;
              await translatePropertyWrite(() =>
                insertCommitment(em, {
                  id: createdCommitmentId,
                  tenantId: context.tenantId,
                  propertyId,
                  sourceKind: 'ITEM',
                  sourceId: item.id,
                  expiresAt: null,
                  inventoryVersion: currentVersion,
                }),
              );
            }
            const resolved = await resolveAvailabilityForProduct(em, {
              tenantId: context.tenantId,
              propertyId,
              product,
              period: { arrival: target.arrival, departure: target.departure },
              occupancy: {
                adults: target.occupancy,
                childAges: item.child_ages,
              },
              quantity: item.quantity,
              budget: await searchBudgetForProperty(
                em,
                context.tenantId,
                propertyId,
              ),
            });
            if (resolved.result !== 'AVAILABLE')
              throw new PropertyError('RESOURCE_UNAVAILABLE', {
                product_id: item.product_id,
                reason_codes: resolved.reasonCodes,
              });
            const allocationCommitmentId: string = commitmentId;
            for (const unit of resolved.units)
              for (const resource of unit.resources)
                await translatePropertyWrite(() =>
                  insertPlanAllocation(em, {
                    commitmentId: allocationCommitmentId,
                    tenantId: context.tenantId,
                    propertyId,
                    resourceId: resource.resourceId,
                    startDate: target.arrival,
                    endDate: target.departure,
                  }),
                );
          }
          planned.push({
            item,
            arrival: target.arrival,
            departure: target.departure,
            occupancy: target.occupancy,
            commitmentId,
          });
        }
        for (const plan of planned) {
          await translatePropertyWrite(() =>
            repo.updateReservationItem(em, {
              tenantId: context.tenantId,
              propertyId,
              itemId: plan.item.id,
              arrival: plan.arrival,
              departure: plan.departure,
              adults: plan.occupancy,
              childAges: plan.item.child_ages,
              quantity: plan.item.quantity,
              priceSnapshotId: plan.item.price_snapshot_id,
            }),
          );
          await translatePropertyWrite(() =>
            repo.updateStaySegmentPeriod(
              em,
              plan.item.id,
              plan.arrival,
              plan.departure,
            ),
          );
        }
        const refreshed = await repo.listReservationItems(em, reservation.id);
        const states = refreshed
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
        const resolvedExceptionId = await closeOpenRevisionException(
          em,
          context,
          revision,
          'REPROCESSED',
        );
        await revisions.markChannelRevision(em, {
          revisionId: revision.id,
          reservationId: reservation.id,
          processingState: 'APPLIED',
          safeErrorCode: null,
        });
        await recordAudit(em, {
          tenantId: context.tenantId,
          propertyId,
          ...auditActor(context),
          action: 'channel.revision_reprocess',
          resourceType: 'DistributionInboxRevision',
          resourceId: revision.id,
          outcome: 'SUCCESS',
          afterSafe: {
            outcome: 'APPLIED',
            reservation_id: reservation.id,
            item_count: planned.length,
            inventory_version: currentVersion + 1,
            resolved_exception_id: resolvedExceptionId,
          },
          correlationId: context.correlationId,
        });
        return {
          outcome: 'APPLIED',
          reservation_id: reservation.id,
          state: derivedState,
          inventory_version: currentVersion + 1,
          replayed: false,
        };
      },
    );
  } catch (error) {
    const permanentCode: Partial<Record<PropertyError['code'], string>> = {
      RESOURCE_UNAVAILABLE: 'EXTERNAL_CONFLICT',
      GUEST_GENDER_REQUIRED: 'EXTERNAL_CONFLICT',
      SHARING_POLICY_VIOLATION: 'EXTERNAL_CONFLICT',
      CONFLICT: 'EXTERNAL_CONFLICT',
      INVALID_REQUEST: 'PAYLOAD_UNSUPPORTED',
      CROSS_SCOPE_REFERENCE: 'LINK_MISSING',
    };
    const code =
      error instanceof PropertyError ? permanentCode[error.code] : undefined;
    const reason = error instanceof PropertyError ? error.code : null;
    if (code && reason)
      return runScopedTransaction(
        orm,
        { tenantId: context.tenantId, userId: context.actor.userId },
        async (em) => {
          await applyInventoryTimeouts(em);
          await authorize(em, context, 'channel.reprocess', propertyId);
          const revision = await revisions.findChannelRevision(
            em,
            context.tenantId,
            propertyId,
            revisionId,
          );
          if (!revision) throw new PropertyError('NOT_FOUND');
          return markException(em, context, propertyId, revision, code, {
            reason,
          });
        },
      );
    throw error;
  }
}
