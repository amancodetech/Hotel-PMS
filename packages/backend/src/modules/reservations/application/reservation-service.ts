import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { evaluatePolicy } from '../../identity/application/policy-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import {
  deriveReservationState,
  isReservationItemState,
} from '../domain/reservation-state.js';
import type { ReservationItemState } from '../domain/reservation-state.js';
import * as repo from '../persistence/reservation-repository.js';
import { findGuest } from '../persistence/guest-repository.js';
import { assertSharingScopeGuests } from '../domain/sharing-policy.js';
import {
  checkIdempotency,
  hashRequest,
  requireIdempotencyKey,
  storeIdempotency,
} from './idempotency-service.js';

export interface DraftItemInput {
  product_id?: string | null;
  period: { arrival: string; departure: string };
  occupancy: { adults: number; child_ages: number[] };
  quantity?: number;
  owner_stay?: boolean;
}

export interface DraftGuestInput {
  guest_id: string;
  role?: 'LEAD' | 'ACCOMPANYING';
}

export interface DraftInput {
  source?: 'DIRECT' | 'OTA' | 'IMPORT';
  channel_connection_id?: string | null;
  external_booking_key?: string | null;
  items: DraftItemInput[];
  guests?: DraftGuestInput[];
  idempotencyKey?: string | null;
}

function assertDraftInput(input: DraftInput): void {
  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 20
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'items' });
  const source = input.source ?? 'DIRECT';
  if (source !== 'DIRECT' && source !== 'OTA' && source !== 'IMPORT')
    throw new PropertyError('INVALID_REQUEST', { field: 'source' });
  if (source === 'DIRECT' && input.external_booking_key)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'external_booking_key',
    });
  if (source !== 'DIRECT' && !input.external_booking_key)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'external_booking_key',
    });
  if (source !== 'DIRECT' && !input.channel_connection_id)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'channel_connection_id',
    });
  for (const item of input.items) {
    assertIsoDate(item.period.arrival, 'period.arrival');
    assertIsoDate(item.period.departure, 'period.departure');
    if (item.period.departure <= item.period.arrival)
      throw new PropertyError('INVALID_REQUEST', { field: 'period' });
    if (
      !Number.isInteger(item.occupancy.adults) ||
      item.occupancy.adults < 1 ||
      item.occupancy.adults > 20
    )
      throw new PropertyError('INVALID_REQUEST', { field: 'occupancy' });
    if (
      !Array.isArray(item.occupancy.child_ages) ||
      item.occupancy.child_ages.some(
        (age) => !Number.isInteger(age) || age < 0 || age > 17,
      )
    )
      throw new PropertyError('INVALID_REQUEST', { field: 'occupancy' });
    const quantity = item.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20)
      throw new PropertyError('INVALID_REQUEST', { field: 'quantity' });
  }
  const guests = input.guests ?? [];
  if (guests.length > 20)
    throw new PropertyError('INVALID_REQUEST', { field: 'guests' });
  let leads = 0;
  for (const guest of guests) {
    if (typeof guest.guest_id !== 'string')
      throw new PropertyError('INVALID_REQUEST', { field: 'guests' });
    if (
      guest.role !== undefined &&
      guest.role !== 'LEAD' &&
      guest.role !== 'ACCOMPANYING'
    )
      throw new PropertyError('INVALID_REQUEST', { field: 'guests' });
    if (guest.role === 'LEAD') leads += 1;
  }
  if (leads > 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'guests' });
}

export async function createReservationDraft(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: DraftInput,
): Promise<Record<string, unknown>> {
  assertDraftInput(input);
  const source = input.source ?? 'DIRECT';
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'CreateReservationDraft',
    property_id: propertyId,
    source,
    channel_connection_id: input.channel_connection_id ?? null,
    external_booking_key: input.external_booking_key ?? null,
    items: input.items,
    guests: input.guests ?? [],
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'reservation.create', propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'CreateReservationDraft',
        key,
        requestHash,
        propertyId,
      );
      if (replayed) return replayed;
      if (input.channel_connection_id) {
        const connection = await repo.findConnectionInScope(
          em,
          context.tenantId,
          propertyId,
          input.channel_connection_id,
        );
        if (!connection) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      }
      const draftGuests: Array<{
        guest_id: string;
        item_id: null;
        gender: 'FEMALE' | 'MALE' | null;
      }> = [];
      for (const guest of input.guests ?? []) {
        const found = await findGuest(em, context.tenantId, guest.guest_id);
        if (!found) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        draftGuests.push({
          guest_id: found.id,
          item_id: null,
          gender: found.gender,
        });
      }
      for (const item of input.items) {
        if (item.product_id) {
          const product = await repo.findProductInScope(
            em,
            context.tenantId,
            propertyId,
            item.product_id,
          );
          if (!product) throw new PropertyError('CROSS_SCOPE_REFERENCE');
          // Restricted sharing scopes fail closed at sale time: a FEMALE/MALE
          // bed cannot be drafted with a male or unknown-gender guest.
          assertSharingScopeGuests({
            scope: product.sharing_scope,
            productId: product.id,
            itemId: null,
            guests: draftGuests,
          });
        }
      }
      const reservation = await translatePropertyWrite(() =>
        repo.insertReservation(em, {
          id: randomUUID(),
          tenantId: context.tenantId,
          propertyId,
          source,
          channelConnectionId: input.channel_connection_id ?? null,
          externalBookingKey: input.external_booking_key ?? null,
          state: 'INQUIRY',
        }),
      );
      for (const item of input.items) {
        const itemRow = await translatePropertyWrite(() =>
          repo.insertReservationItem(em, {
            id: randomUUID(),
            tenantId: context.tenantId,
            propertyId,
            reservationId: reservation.id,
            productId: item.product_id ?? null,
            arrival: item.period.arrival,
            departure: item.period.departure,
            adults: item.occupancy.adults,
            childAges: item.occupancy.child_ages,
            quantity: item.quantity ?? 1,
            state: 'INQUIRY',
            ownerStay: item.owner_stay ?? false,
          }),
        );
        await translatePropertyWrite(() =>
          repo.insertStaySegment(em, {
            id: randomUUID(),
            tenantId: context.tenantId,
            propertyId,
            itemId: itemRow.id,
            startDate: item.period.arrival,
            endDate: item.period.departure,
          }),
        );
      }
      for (const guest of input.guests ?? []) {
        await translatePropertyWrite(() =>
          repo.insertReservationGuest(em, {
            id: randomUUID(),
            tenantId: context.tenantId,
            propertyId,
            reservationId: reservation.id,
            itemId: null,
            guestId: guest.guest_id,
            role: guest.role ?? 'ACCOMPANYING',
          }),
        );
      }
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'reservation.draft_created',
        resourceType: 'Reservation',
        resourceId: reservation.id,
        outcome: 'SUCCESS',
        afterSafe: {
          source,
          state: reservation.state,
          item_count: input.items.length,
          external_booking_key: reservation.external_booking_key,
        },
        correlationId: context.correlationId,
      });
      const response = {
        reservation: {
          id: reservation.id,
          source: reservation.source,
          state: reservation.state,
          version: reservation.version,
          external_booking_key: reservation.external_booking_key,
        },
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CreateReservationDraft',
        key,
        requestHash,
        response,
        resourceId: reservation.id,
      });
      return response;
    },
  );
}

export interface ReservationSummary {
  id: string;
  source: string;
  state: string;
  version: number;
  created_at: string;
  item_states: string[];
  item_count: number;
}

export async function listReservations(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  query: { cursor: string | null; limit: number },
): Promise<{ items: ReservationSummary[]; next_cursor: string | null }> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'reservation.read', propertyId);
      const property = await repo.findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const reservations = await repo.listReservationRows(
        em,
        context.tenantId,
        propertyId,
        query,
      );
      const aggregated = await repo.listItemStatesForReservations(
        em,
        reservations.map((row) => row.id),
      );
      const statesByReservation = new Map(
        aggregated.map((row) => [row.reservation_id, row.states]),
      );
      const items = reservations.map((row) => {
        const states = (statesByReservation.get(row.id) ?? []).filter(
          isReservationItemState,
        ) as ReservationItemState[];
        return {
          id: row.id,
          source: row.source,
          state: deriveReservationState(states),
          version: row.version,
          created_at: row.created_at,
          item_states: states,
          item_count: states.length,
        };
      });
      return {
        items,
        next_cursor:
          items.length === query.limit
            ? (reservations.at(-1)?.id ?? null)
            : null,
      };
    },
  );
}

export async function getReservation(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
): Promise<Record<string, unknown> | null> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'reservation.read', propertyId);
      const reservation = await repo.findReservation(
        em,
        context.tenantId,
        propertyId,
        reservationId,
      );
      if (!reservation) return null;
      const items = await repo.listReservationItems(em, reservation.id);
      const segments = await repo.listStaySegments(
        em,
        items.map((item) => item.id),
      );
      const states = items
        .map((item) => item.state)
        .filter(isReservationItemState) as ReservationItemState[];
      const guestDecision = await evaluatePolicy(em, {
        actor: context.actor,
        tenantId: context.tenantId,
        permission: 'guest.read',
        propertyRef: propertyId,
      });
      const guests = guestDecision.allowed
        ? await repo.listReservationGuests(em, reservation.id)
        : null;
      return {
        reservation: {
          ...reservation,
          state: deriveReservationState(states),
        },
        items: items.map((item) => ({
          ...item,
          segments: segments
            .filter((segment) => segment.item_id === item.id)
            .map((segment) => ({
              id: segment.id,
              start_date: segment.start_date,
              end_date: segment.end_date,
            })),
        })),
        guests:
          guests?.map((guest) => ({
            guest_id: guest.guest_id,
            item_id: guest.item_id,
            role: guest.role,
            full_name: guest.guest_name,
            email: guest.guest_email,
            gender: guest.gender,
          })) ?? null,
      };
    },
  );
}
