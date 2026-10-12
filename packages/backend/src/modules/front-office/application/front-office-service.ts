import { randomUUID } from 'node:crypto';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { clockNow } from '../../../clock.js';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import { lockProperty } from '../../property/persistence/property-repository.js';
import { findProduct } from '../../property/persistence/product-repository.js';
import {
  findResource,
  listAncestorResources,
  listChildResources,
} from '../../property/persistence/resource-repository.js';
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
import { assertSharingScopeGuests } from '../../reservations/domain/sharing-policy.js';
import * as reservationRepo from '../../reservations/persistence/reservation-repository.js';
import type {
  ReservationItemRow,
  StaySegmentRow,
} from '../../reservations/persistence/reservation-repository.js';
import * as repo from '../persistence/room-assignment-repository.js';
import type {
  BoardRoomRow,
  RoomAssignmentRow,
} from '../persistence/room-assignment-repository.js';
import { insertStayEvent } from '../persistence/stay-event-repository.js';
import { findOperationsPolicy } from '../../operations/persistence/operations-repository.js';

export interface AssignRoomInput {
  resource_id: string;
  start_date?: string | null;
  end_date?: string | null;
  version: number;
  idempotencyKey?: string | null;
}

export interface CheckInInput {
  resource_id?: string | null;
  version: number;
  idempotencyKey?: string | null;
}

interface BoardCandidate {
  resource_type: string;
  parent_code: string | null;
  display_label: string | null;
  location_path: string[];
  parent_display_label: string | null;
  resource_id: string;
  code: string;
  housekeeping_state: string;
  maintenance_state: string;
  eligible: boolean;
  reason: string | null;
}

export function businessToday(timezone: string, at: Date = clockNow()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function assignmentView(row: RoomAssignmentRow) {
  return {
    id: row.id,
    item_id: row.item_id,
    resource_id: row.resource_id,
    segment_id: row.segment_id,
    state: row.state,
    start_date: row.start_date,
    end_date: row.end_date,
    version: row.version,
    checked_in_at: row.checked_in_at,
  };
}

function roomView(row: BoardRoomRow) {
  return {
    resource_id: row.id,
    code: row.code,
    display_label: row.display_label,
    location_path: row.location_path,
    parent_display_label: row.parent_display_label,
    resource_type: row.resource_type,
    parent_code: row.parent_code,
    state: row.state,
    housekeeping_state: row.housekeeping_state,
    maintenance_state: row.maintenance_state,
    version: row.version,
  };
}

export function currentAssignment(
  rows: readonly RoomAssignmentRow[],
): RoomAssignmentRow | null {
  let active: RoomAssignmentRow | null = null;
  let planned: RoomAssignmentRow | null = null;
  for (const row of rows) {
    if (row.state === 'ACTIVE') {
      active ??= row;
      continue;
    }
    planned ??= row;
  }
  return active ?? planned;
}

function readinessReason(input: {
  state: string;
  housekeeping_state: string;
  maintenance_state: string;
  inspectionRequired: boolean;
}): string | null {
  if (input.state !== 'ACTIVE') return 'INACTIVE';
  if (input.housekeeping_state === 'DIRTY') return 'DIRTY';
  if (input.housekeeping_state === 'CLEANING') return 'CLEANING';
  if (input.maintenance_state === 'OOO') return 'OOO';
  if (input.maintenance_state === 'OOS') return 'OOS';
  if (input.inspectionRequired && input.housekeeping_state !== 'INSPECTED')
    return 'INSPECTION_REQUIRED';
  return null;
}

function candidateReason(
  room: BoardRoomRow,
  ancestors: ReadonlyArray<{
    state: string;
    housekeeping_state: string;
    maintenance_state: string;
  }>,
  occupied: ReadonlySet<string>,
  blocked: ReadonlySet<string>,
  inspectionRequired: boolean,
): string | null {
  const own = readinessReason({
    state: room.state,
    housekeeping_state: room.housekeeping_state,
    maintenance_state: room.maintenance_state,
    inspectionRequired,
  });
  if (own) return own;
  for (const ancestor of ancestors) {
    const parent = readinessReason({
      state: ancestor.state,
      housekeeping_state: ancestor.housekeeping_state,
      maintenance_state: ancestor.maintenance_state,
      inspectionRequired,
    });
    if (parent) return `PARENT_${parent}`;
  }
  if (blocked.has(room.id)) return 'BLOCKED';
  if (occupied.has(room.id)) return 'OCCUPIED';
  return null;
}

export async function authorizeRoom(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceId: string,
  period?: { startDate: string; endDate: string },
) {
  const resource = await findResource(em, tenantId, propertyId, resourceId);
  if (!resource) throw new PropertyError('CROSS_SCOPE_REFERENCE');
  const children = await listChildResources(
    em,
    tenantId,
    propertyId,
    resourceId,
  );
  if (children.length > 0)
    throw new PropertyError('RESOURCE_HAS_CHILDREN', {
      resource_id: resourceId,
      reason: 'composite_parent',
    });
  const policy = await findOperationsPolicy(em, tenantId, propertyId);
  const inspectionRequired = policy?.inspection_required === true;
  const own = readinessReason({
    state: resource.state,
    housekeeping_state: resource.housekeeping_state,
    maintenance_state: resource.maintenance_state,
    inspectionRequired,
  });
  if (own)
    throw new PropertyError('INVALID_REQUEST', {
      field: 'resource_id',
      reason: own,
    });
  const ancestors = await listAncestorResources(em, tenantId, propertyId, [
    resourceId,
  ]);
  for (const ancestor of ancestors) {
    const reason = readinessReason({
      state: ancestor.state,
      housekeeping_state: ancestor.housekeeping_state,
      maintenance_state: ancestor.maintenance_state,
      inspectionRequired,
    });
    if (reason)
      throw new PropertyError('INVALID_REQUEST', {
        field: 'resource_id',
        reason: `PARENT_${reason}`,
        parent_code: ancestor.code,
      });
  }
  if (period) {
    const blocked = await repo.listBlockedResourceIds(em, {
      tenantId,
      propertyId,
      resourceIds: [resourceId],
      startDate: period.startDate,
      endDate: period.endDate,
    });
    if (blocked.length > 0)
      throw new PropertyError('INVALID_REQUEST', {
        field: 'resource_id',
        reason: 'BLOCKED',
      });
  }
  return resource;
}

interface StayCapability {
  supported: boolean;
  reason: string | null;
}

export function stayCapabilities(input: {
  state: string;
  group: boolean;
  hasActiveAssignment: boolean;
}): Record<string, StayCapability> {
  const groupReason = 'GROUP_COMPONENT_SELECTION_REQUIRED';
  const build = (
    supported: boolean,
    reason: string | null,
  ): StayCapability => ({ supported, reason });
  const confirmed = input.state === 'CONFIRMED';
  const inHouse = input.state === 'IN_HOUSE';
  const confirmedReason = confirmed
    ? null
    : inHouse
      ? 'ALREADY_IN_HOUSE'
      : 'STATE_NOT_CONFIRMED';
  const inHouseReason = inHouse ? null : 'STATE_NOT_IN_HOUSE';
  const assignSupported = confirmed && !input.group;
  const moveSupported = inHouse && !input.group && input.hasActiveAssignment;
  const splitSupported = moveSupported;
  // Reasons follow the blocking precondition order: stay state first, then
  // the active-assignment requirement, and only then the group rule, so a
  // group row never hides a more fundamental blocker behind the group hint.
  const moveReason = (): string | null => {
    if (!inHouse) return inHouseReason;
    if (!input.hasActiveAssignment) return 'NO_ACTIVE_ASSIGNMENT';
    return groupReason;
  };
  return {
    assign: build(
      assignSupported,
      assignSupported ? null : confirmed ? groupReason : confirmedReason,
    ),
    check_in: build(confirmed, confirmedReason),
    check_out: build(inHouse, inHouseReason),
    move: build(moveSupported, moveSupported ? null : moveReason()),
    extend: build(
      confirmed || inHouse,
      confirmed || inHouse ? null : 'STATE_NOT_CONFIRMED',
    ),
    split: build(splitSupported, splitSupported ? null : moveReason()),
    early_departure: build(inHouse, inHouse ? null : 'STATE_NOT_IN_HOUSE'),
    partial_departure: build(inHouse, inHouseReason),
  };
}

export function findSegmentForDate(
  segments: readonly StaySegmentRow[],
  date: string,
): StaySegmentRow | null {
  return (
    segments.find(
      (segment) => segment.start_date <= date && segment.end_date > date,
    ) ??
    segments[0] ??
    null
  );
}

export async function getFrontDeskBoard(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  date?: string | null,
): Promise<Record<string, unknown>> {
  if (date) assertIsoDate(date, 'date');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'frontdesk.read', propertyId);
      const property = await reservationRepo.findPropertyScope(
        em,
        context.tenantId,
        propertyId,
      );
      if (!property) throw new PropertyError('NOT_FOUND');
      const boardDate = date ?? businessToday(property.timezone);
      const [arrivals, departures, inHouse, rooms] = await Promise.all([
        repo.listArrivalItems(em, context.tenantId, propertyId, boardDate),
        repo.listDepartureItems(em, context.tenantId, propertyId, boardDate),
        repo.listInHouseItems(em, context.tenantId, propertyId),
        repo.listBoardResources(em, context.tenantId, propertyId),
      ]);
      const itemIds = [
        ...new Set([
          ...arrivals.map((item) => item.id),
          ...departures.map((item) => item.id),
          ...inHouse.map((item) => item.id),
        ]),
      ];
      const [assignments, segments, commitments, allocations, reservations] =
        await Promise.all([
          repo.listAssignmentsForItems(
            em,
            context.tenantId,
            propertyId,
            itemIds,
          ),
          reservationRepo.listStaySegments(em, itemIds),
          repo.listActiveItemCommitmentIds(
            em,
            context.tenantId,
            propertyId,
            itemIds,
          ),
          repo.listActiveItemAllocations(
            em,
            context.tenantId,
            propertyId,
            itemIds,
          ),
          repo.listReservationsByIds(em, context.tenantId, propertyId, [
            ...new Set(
              [...arrivals, ...departures, ...inHouse].map(
                (item) => item.reservation_id,
              ),
            ),
          ]),
        ]);
      const liveAssignments = await repo.listLiveRoomAssignments(
        em,
        context.tenantId,
        propertyId,
      );
      const productIds = [
        ...new Set(
          [...arrivals, ...departures, ...inHouse].flatMap((item) =>
            item.product_id ? [item.product_id] : [],
          ),
        ),
      ];
      const products = await repo.listProductsByIds(
        em,
        context.tenantId,
        propertyId,
        productIds,
      );
      const productKindById = new Map(
        products.map((row) => [row.id, row.kind]),
      );
      const reservationById = new Map(reservations.map((row) => [row.id, row]));
      const commitmentByItem = new Map(
        commitments.map((row) => [row.source_id, row.id]),
      );
      const allocationResourceIdsByItem = new Map<string, string[]>();
      for (const row of allocations) {
        const list = allocationResourceIdsByItem.get(row.source_id) ?? [];
        if (!list.includes(row.resource_id)) list.push(row.resource_id);
        allocationResourceIdsByItem.set(row.source_id, list);
      }
      const roomById = new Map(rooms.map((row) => [row.id, row]));
      // Readiness is inherited from the whole containment chain: the board
      // must agree with authorizeRoom, which walks every ancestor.
      const ancestors = await listAncestorResources(
        em,
        context.tenantId,
        propertyId,
        rooms.map((row) => row.id),
      );
      const ancestorsByResource = new Map<string, typeof ancestors>();
      for (const row of ancestors) {
        const list = ancestorsByResource.get(row.origin_id) ?? [];
        list.push(row);
        ancestorsByResource.set(row.origin_id, list);
      }
      const assignmentsByItem = new Map<string, RoomAssignmentRow[]>();
      for (const row of assignments) {
        const list = assignmentsByItem.get(row.item_id) ?? [];
        list.push(row);
        assignmentsByItem.set(row.item_id, list);
      }
      const segmentsByItem = new Map<string, StaySegmentRow[]>();
      for (const row of segments) {
        const list = segmentsByItem.get(row.item_id) ?? [];
        list.push(row);
        segmentsByItem.set(row.item_id, list);
      }

      const candidatesByItem = new Map<string, BoardCandidate[]>();
      const operationsPolicy = await findOperationsPolicy(
        em,
        context.tenantId,
        propertyId,
      );
      const inspectionRequired = operationsPolicy?.inspection_required === true;
      for (const item of arrivals) {
        const candidateIds = item.product_id
          ? await repo.listCandidateResourceIdsForProduct(
              em,
              context.tenantId,
              propertyId,
              item.product_id,
            )
          : [];
        const allocatedIds = allocationResourceIdsByItem.get(item.id) ?? [];
        const pool =
          candidateIds.length > 0
            ? candidateIds
            : allocatedIds.length > 0
              ? allocatedIds
              : rooms.map((row) => row.id);
        const overlaps = await repo.listOverlappingAssignments(em, {
          tenantId: context.tenantId,
          propertyId,
          resourceIds: pool,
          startDate: item.arrival,
          endDate: item.departure,
          excludeItemId: item.id,
        });
        const blocked = await repo.listBlockedResourceIds(em, {
          tenantId: context.tenantId,
          propertyId,
          resourceIds: pool,
          startDate: item.arrival,
          endDate: item.departure,
        });
        const occupied = new Set(overlaps.map((row) => row.resource_id));
        const blockedSet = new Set(blocked);
        candidatesByItem.set(
          item.id,
          pool.flatMap((resourceId) => {
            const room = roomById.get(resourceId);
            if (!room) return [];
            const reason = candidateReason(
              room,
              ancestorsByResource.get(room.id) ?? [],
              occupied,
              blockedSet,
              inspectionRequired,
            );
            return [
              {
                resource_id: room.id,
                code: room.code,
                resource_type: room.resource_type,
                parent_code: room.parent_code,
                display_label: room.display_label,
                location_path: room.location_path,
                parent_display_label: room.parent_display_label,
                housekeeping_state: room.housekeeping_state,
                maintenance_state: room.maintenance_state,
                eligible: reason === null,
                reason,
              },
            ];
          }),
        );
      }

      const build = (item: ReservationItemRow, withCandidates: boolean) => {
        const itemAssignments = assignmentsByItem.get(item.id) ?? [];
        const assignment = currentAssignment(itemAssignments) ?? null;
        const segment = findSegmentForDate(
          segmentsByItem.get(item.id) ?? [],
          item.arrival,
        );
        const room = assignment
          ? (roomById.get(assignment.resource_id) ?? null)
          : null;
        const assignedRooms = itemAssignments.flatMap((row) => {
          const assignedRoom = roomById.get(row.resource_id);
          return assignedRoom ? [roomView(assignedRoom)] : [];
        });
        const allocatedRooms = (
          allocationResourceIdsByItem.get(item.id) ?? []
        ).flatMap((resourceId) => {
          const allocatedRoom = roomById.get(resourceId);
          return allocatedRoom ? [roomView(allocatedRoom)] : [];
        });
        const itemCandidates = withCandidates
          ? (candidatesByItem.get(item.id) ?? [])
          : [];
        const candidateById = new Map(
          itemCandidates.map((row) => [row.resource_id, row]),
        );
        const componentCount = Math.max(
          allocatedRooms.length,
          itemAssignments.length,
        );
        const group = componentCount > 1;
        return {
          item_id: item.id,
          reservation_id: item.reservation_id,
          reservation_version:
            reservationById.get(item.reservation_id)?.version ?? null,
          item_version: item.version,
          product_id: item.product_id,
          product_kind: item.product_id
            ? (productKindById.get(item.product_id) ?? null)
            : null,
          state: item.state,
          arrival: item.arrival,
          departure: item.departure,
          adults: item.adults,
          quantity: item.quantity,
          commitment_id: commitmentByItem.get(item.id) ?? null,
          segment_id: segment?.id ?? null,
          segment_state: segment?.state ?? null,
          assignment: assignment ? assignmentView(assignment) : null,
          room: room ? roomView(room) : null,
          assignments: itemAssignments.map(assignmentView),
          rooms: assignedRooms,
          allocated_rooms: allocatedRooms,
          allocation_readiness: allocatedRooms.map((row) => {
            const candidate = candidateById.get(row.resource_id);
            return {
              resource_id: row.resource_id,
              eligible: candidate?.eligible ?? null,
              reason: candidate?.reason ?? null,
            };
          }),
          group_assignment: group,
          capabilities: stayCapabilities({
            state: item.state,
            group,
            hasActiveAssignment: itemAssignments.some(
              (row) => row.state === 'ACTIVE',
            ),
          }),
          candidates: itemCandidates,
        };
      };

      return {
        date: boardDate,
        timezone: property.timezone,
        arrivals: arrivals.map((item) => build(item, true)),
        departures: departures.map((item) => build(item, false)),
        inHouse: inHouse.map((item) => build(item, false)),
        rooms: rooms.map((room) => {
          const assignment = currentAssignment(
            liveAssignments.filter((row) => row.resource_id === room.id),
          );
          return {
            ...roomView(room),
            assignment: assignment ? assignmentView(assignment) : null,
          };
        }),
      };
    },
  );
}

function assertAssignInput(input: AssignRoomInput): void {
  if (typeof input.resource_id !== 'string' || input.resource_id.length === 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'resource_id' });
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  if (input.start_date) assertIsoDate(input.start_date, 'start_date');
  if (input.end_date) assertIsoDate(input.end_date, 'end_date');
  if (input.start_date && input.end_date && input.end_date <= input.start_date)
    throw new PropertyError('INVALID_REQUEST', { field: 'period' });
}

export async function assignRoom(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  itemId: string,
  input: AssignRoomInput,
): Promise<Record<string, unknown>> {
  assertAssignInput(input);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'AssignRoom',
    reservation_id: reservationId,
    item_id: itemId,
    resource_id: input.resource_id,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'assignment.manage', propertyId);
      await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'AssignRoom',
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
      if (item.state !== 'CONFIRMED')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      const startDate = input.start_date ?? item.arrival;
      const endDate = input.end_date ?? item.departure;
      if (
        startDate < item.arrival ||
        endDate > item.departure ||
        endDate <= startDate
      )
        throw new PropertyError('INVALID_REQUEST', { field: 'period' });
      await authorizeRoom(em, context.tenantId, propertyId, input.resource_id, {
        startDate,
        endDate,
      });
      const existing = await repo.findCurrentAssignmentForItem(
        em,
        context.tenantId,
        propertyId,
        item.id,
      );
      if (existing && existing.state === 'ACTIVE')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: 'IN_HOUSE',
        });
      const overlaps = await repo.listOverlappingAssignments(em, {
        tenantId: context.tenantId,
        propertyId,
        resourceIds: [input.resource_id],
        startDate,
        endDate,
        excludeItemId: item.id,
      });
      if (overlaps.length > 0)
        throw new PropertyError('CONFLICT', {
          reason: 'resource_occupied',
          resource_id: input.resource_id,
        });
      await translatePropertyWrite(() =>
        repo.cancelPlannedAssignmentsForItem(
          em,
          context.tenantId,
          propertyId,
          item.id,
        ),
      );
      const segments = await reservationRepo.listStaySegments(em, [item.id]);
      const segment = findSegmentForDate(segments, startDate);
      const assignment = await translatePropertyWrite(() =>
        repo.insertRoomAssignment(em, {
          id: randomUUID(),
          tenantId: context.tenantId,
          propertyId,
          itemId: item.id,
          segmentId: segment?.id ?? null,
          resourceId: input.resource_id,
          startDate,
          endDate,
          state: 'PLANNED',
        }),
      );
      const updated = await reservationRepo.bumpReservationItemVersion(em, {
        tenantId: context.tenantId,
        propertyId,
        itemId: item.id,
      });
      if (!updated) throw new PropertyError('NOT_FOUND');
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'stay.assignment.created',
        resourceType: 'RoomAssignment',
        resourceId: assignment.id,
        outcome: 'SUCCESS',
        afterSafe: {
          item_id: item.id,
          resource_id: input.resource_id,
          start_date: startDate,
          end_date: endDate,
          segment_id: segment?.id ?? null,
          item_version: updated.version,
        },
        correlationId: context.correlationId,
      });
      const response = {
        reservation_id: reservationId,
        item_id: item.id,
        item_version: updated.version,
        assignment: assignmentView(assignment),
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'AssignRoom',
        key,
        requestHash,
        response,
        resourceId: item.id,
      });
      return { ...response, replayed: false };
    },
  );
}

function assertCheckInInput(input: CheckInInput): void {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  if (input.resource_id !== undefined && input.resource_id !== null) {
    if (typeof input.resource_id !== 'string' || input.resource_id.length === 0)
      throw new PropertyError('INVALID_REQUEST', { field: 'resource_id' });
  }
}

export async function checkInStay(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  reservationId: string,
  itemId: string,
  input: CheckInInput,
): Promise<Record<string, unknown>> {
  assertCheckInInput(input);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestHash = hashRequest({
    operation: 'CheckInStay',
    reservation_id: reservationId,
    item_id: itemId,
    resource_id: input.resource_id ?? null,
    version: input.version,
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await authorize(em, context, 'stay.checkin', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const replayed = await checkIdempotency(
        em,
        context,
        'CheckInStay',
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
      if (item.state !== 'CONFIRMED')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
        });
      const today = businessToday(property.timezone);
      if (item.arrival > today)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: item.state,
          reason: 'not_arrival_date',
        });
      const reservation = await reservationRepo.findReservation(
        em,
        context.tenantId,
        propertyId,
        item.reservation_id,
      );
      if (!reservation) throw new PropertyError('NOT_FOUND');
      // SET-07.6: re-check the restricted sharing scope at entry time, when the
      // actual guests (and any late changes) are known.
      if (item.product_id) {
        const product = await findProduct(
          em,
          context.tenantId,
          propertyId,
          item.product_id,
        );
        if (!product) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        assertSharingScopeGuests({
          scope: product.sharing_scope,
          productId: product.id,
          itemId: item.id,
          guests: await reservationRepo.listReservationGuests(
            em,
            reservation.id,
          ),
        });
      }
      const plannedAssignments = await repo.listAssignmentsForItems(
        em,
        context.tenantId,
        propertyId,
        [item.id],
      );
      if (plannedAssignments.some((row) => row.state !== 'PLANNED'))
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: 'IN_HOUSE',
        });
      const activeCommitment =
        await reservationRepo.findActiveCommitmentForItem(
          em,
          context.tenantId,
          propertyId,
          item.id,
        );
      const allocationResourceIds = activeCommitment
        ? [
            ...new Set(
              (
                await reservationRepo.listActiveAllocations(
                  em,
                  activeCommitment.id,
                )
              ).map((row) => row.resource_id),
            ),
          ]
        : [];
      const isGroupAssignment = allocationResourceIds.length > 1;
      if (isGroupAssignment && input.resource_id)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'resource_id',
          reason: 'group_assignment_is_automatic',
        });
      const plannedResourceIds = plannedAssignments.map(
        (row) => row.resource_id,
      );
      if (
        !isGroupAssignment &&
        input.resource_id &&
        plannedResourceIds.length === 1 &&
        plannedResourceIds[0] !== input.resource_id
      )
        throw new PropertyError('CONFLICT', {
          reason: 'assignment_resource_mismatch',
          resource_id: plannedResourceIds[0],
        });
      if (
        isGroupAssignment &&
        plannedResourceIds.length > 0 &&
        (plannedResourceIds.length !== allocationResourceIds.length ||
          plannedResourceIds.some(
            (resourceId) => !allocationResourceIds.includes(resourceId),
          ))
      )
        throw new PropertyError('CONFLICT', {
          reason: 'group_assignment_mismatch',
        });
      const resourceIds = isGroupAssignment
        ? allocationResourceIds
        : [input.resource_id ?? plannedResourceIds[0] ?? ''].filter(Boolean);
      if (resourceIds.length === 0)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'resource_id',
          reason: 'required',
        });
      for (const resourceId of resourceIds)
        await authorizeRoom(em, context.tenantId, propertyId, resourceId, {
          startDate: item.arrival,
          endDate: item.departure,
        });
      const overlaps = await repo.listOverlappingAssignments(em, {
        tenantId: context.tenantId,
        propertyId,
        resourceIds,
        startDate: item.arrival,
        endDate: item.departure,
        excludeItemId: item.id,
      });
      if (overlaps.length > 0)
        throw new PropertyError('CONFLICT', {
          reason: 'resource_occupied',
          resource_id: overlaps[0]?.resource_id,
        });
      const updated = await reservationRepo.checkInReservationItem(em, {
        tenantId: context.tenantId,
        propertyId,
        itemId: item.id,
      });
      if (!updated)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          state: 'CONFIRMED',
        });
      const segment = await reservationRepo.checkInStaySegment(
        em,
        item.id,
        today,
      );
      const checkedInAssignments: RoomAssignmentRow[] = [];
      if (plannedAssignments.length > 0) {
        for (const planned of plannedAssignments) {
          const activated = await repo.activateRoomAssignment(
            em,
            context.tenantId,
            propertyId,
            planned.id,
            segment?.id ?? null,
          );
          if (!activated)
            throw new PropertyError('INVALID_STATE_TRANSITION', {
              state: planned.state,
            });
          checkedInAssignments.push(activated);
        }
      } else {
        for (const resourceId of resourceIds)
          checkedInAssignments.push(
            await translatePropertyWrite(() =>
              repo.insertRoomAssignment(em, {
                id: randomUUID(),
                tenantId: context.tenantId,
                propertyId,
                itemId: item.id,
                segmentId: segment?.id ?? null,
                resourceId,
                startDate: item.arrival,
                endDate: item.departure,
                state: 'ACTIVE',
                checkedInAt: new Date().toISOString(),
              }),
            ),
          );
      }
      const assignment = checkedInAssignments[0];
      if (!assignment) throw new Error('check-in created no assignments');
      const event = await insertStayEvent(em, {
        tenantId: context.tenantId,
        propertyId,
        reservationId: item.reservation_id,
        itemId: item.id,
        segmentId: segment?.id ?? assignment.segment_id,
        type: 'STAY_CHECKED_IN',
        resourceId: assignment.resource_id,
        payload: {
          assignment_id: assignment.id,
          assignment_ids: checkedInAssignments.map((row) => row.id),
          resource_ids: checkedInAssignments.map((row) => row.resource_id),
          business_date: today,
        },
        itemVersion: updated.version,
      });
      if (!event.inserted)
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          reason: 'duplicate_stay_event',
        });
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
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'stay.checked_in',
        resourceType: 'ReservationItem',
        resourceId: item.id,
        outcome: 'SUCCESS',
        beforeSafe: { state: item.state },
        afterSafe: {
          state: 'IN_HOUSE',
          reservation_state: derivedState,
          assignment_id: assignment.id,
          resource_id: assignment.resource_id,
          assignment_ids: checkedInAssignments.map((row) => row.id),
          resource_ids: checkedInAssignments.map((row) => row.resource_id),
          segment_id: segment?.id ?? null,
          item_version: updated.version,
        },
        correlationId: context.correlationId,
      });
      const response = {
        reservation_id: item.reservation_id,
        item_id: item.id,
        state: derivedState,
        item_version: updated.version,
        reservation_version: reservation.version + 1,
        segment_id: segment?.id ?? null,
        assignment: assignmentView(assignment),
        assignments: checkedInAssignments.map(assignmentView),
      };
      await storeIdempotency(em, context, {
        propertyId,
        operation: 'CheckInStay',
        key,
        requestHash,
        response,
        resourceId: item.id,
      });
      return { ...response, replayed: false };
    },
  );
}
