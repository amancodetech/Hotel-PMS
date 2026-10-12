import { api } from './client.js';

export interface BoardAssignment {
  id: string;
  item_id: string;
  resource_id: string;
  segment_id: string | null;
  state: string;
  start_date: string;
  end_date: string;
  version: number;
  checked_in_at: string | null;
}

export interface BoardRoomRef {
  resource_id: string;
  code: string;
  display_label?: string | null;
  location_path?: string[];
  parent_display_label?: string | null;
  resource_type: string;
  parent_code: string | null;
  state: string;
  housekeeping_state: string;
  maintenance_state: string;
  version: number;
}

export interface BoardCandidate {
  resource_id: string;
  code: string;
  display_label?: string | null;
  location_path?: string[];
  parent_display_label?: string | null;
  resource_type: string;
  parent_code: string | null;
  housekeeping_state: string;
  maintenance_state: string;
  eligible: boolean;
  reason: string | null;
}

export interface StayCapability {
  supported: boolean;
  reason: string | null;
}

export interface StayCapabilities {
  assign: StayCapability;
  check_in: StayCapability;
  check_out: StayCapability;
  move: StayCapability;
  extend: StayCapability;
  split: StayCapability;
  early_departure: StayCapability;
  partial_departure: StayCapability;
}

export interface AllocationReadiness {
  resource_id: string;
  eligible: boolean | null;
  reason: string | null;
}

export interface BoardStay {
  item_id: string;
  reservation_id: string;
  reservation_version: number | null;
  item_version: number;
  product_id: string | null;
  product_kind: string | null;
  state: string;
  arrival: string;
  departure: string;
  adults: number;
  quantity: number;
  commitment_id: string | null;
  segment_id: string | null;
  segment_state: string | null;
  assignment: BoardAssignment | null;
  room: BoardRoomRef | null;
  assignments: BoardAssignment[];
  rooms: BoardRoomRef[];
  allocated_rooms: BoardRoomRef[];
  allocation_readiness: AllocationReadiness[];
  group_assignment: boolean;
  capabilities: StayCapabilities;
  candidates: BoardCandidate[];
}

export interface BoardRoom extends BoardRoomRef {
  assignment: BoardAssignment | null;
}

export interface FrontDeskBoard {
  date: string;
  timezone: string;
  arrivals: BoardStay[];
  departures: BoardStay[];
  inHouse: BoardStay[];
  rooms: BoardRoom[];
}

function tenantRoot(tenantId: string, propertyId: string) {
  return `/api/v1/tenants/${tenantId}/properties/${propertyId}`;
}

function itemRoot(
  tenantId: string,
  propertyId: string,
  reservationId: string,
  itemId: string,
) {
  return `${tenantRoot(tenantId, propertyId)}/reservations/${reservationId}/items/${itemId}`;
}

function idempotencyKey() {
  return crypto.randomUUID();
}

function write(path: string, body: unknown) {
  return api<Record<string, unknown>>(path, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey() },
  });
}

export const frontdeskApi = {
  getBoard: (tenantId: string, propertyId: string, date?: string) =>
    api<FrontDeskBoard>(
      `${tenantRoot(tenantId, propertyId)}/front-desk/board${date ? `?date=${date}` : ''}`,
    ),
  assignRoom: (
    tenantId: string,
    propertyId: string,
    reservationId: string,
    itemId: string,
    body: {
      resource_id: string;
      start_date?: string;
      end_date?: string;
      version: number;
    },
  ) =>
    write(
      `${itemRoot(tenantId, propertyId, reservationId, itemId)}/assignments`,
      body,
    ),
  checkInStay: (
    tenantId: string,
    propertyId: string,
    reservationId: string,
    itemId: string,
    body: { resource_id?: string; version: number },
  ) =>
    write(
      `${itemRoot(tenantId, propertyId, reservationId, itemId)}/check-in`,
      body,
    ),
  moveStay: (
    tenantId: string,
    propertyId: string,
    reservationId: string,
    itemId: string,
    body: { to_resource_id: string; effective_date: string; version: number },
  ) =>
    write(
      `${itemRoot(tenantId, propertyId, reservationId, itemId)}/move`,
      body,
    ),
  extendStay: (
    tenantId: string,
    propertyId: string,
    reservationId: string,
    itemId: string,
    body: { new_departure: string; version: number },
  ) =>
    write(
      `${itemRoot(tenantId, propertyId, reservationId, itemId)}/extend`,
      body,
    ),
  splitStay: (
    tenantId: string,
    propertyId: string,
    reservationId: string,
    itemId: string,
    body: { at_date: string; version: number },
  ) =>
    write(
      `${itemRoot(tenantId, propertyId, reservationId, itemId)}/split`,
      body,
    ),
  earlyDepartureStay: (
    tenantId: string,
    propertyId: string,
    reservationId: string,
    itemId: string,
    body: { effective_date: string; version: number },
  ) =>
    write(
      `${itemRoot(tenantId, propertyId, reservationId, itemId)}/early-departure`,
      body,
    ),
  partialDepartureStay: (
    tenantId: string,
    propertyId: string,
    reservationId: string,
    itemId: string,
    body: { guest_ids: string[]; version: number },
  ) =>
    write(
      `${itemRoot(tenantId, propertyId, reservationId, itemId)}/partial-departure`,
      body,
    ),
  checkOutStay: (
    tenantId: string,
    propertyId: string,
    reservationId: string,
    itemId: string,
    body: { version: number },
  ) =>
    write(
      `${itemRoot(tenantId, propertyId, reservationId, itemId)}/check-out`,
      body,
    ),
};
