import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';

export interface ReservationRow {
  id: string;
  tenant_id: string;
  property_id: string;
  source: 'DIRECT' | 'OTA' | 'IMPORT';
  channel_connection_id: string | null;
  external_booking_key: string | null;
  state: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ReservationItemRow {
  id: string;
  tenant_id: string;
  property_id: string;
  reservation_id: string;
  product_id: string | null;
  arrival: string;
  departure: string;
  adults: number;
  child_ages: number[];
  quantity: number;
  state: string;
  price_snapshot_id: string | null;
  owner_stay: boolean;
  split_from_id: string | null;
  version: number;
  checked_in_at: string | null;
  checked_out_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StaySegmentRow {
  id: string;
  item_id: string;
  start_date: string;
  end_date: string;
  composition_version_id: string | null;
  rate_snapshot: unknown;
  state: 'PLANNED' | 'IN_HOUSE' | 'CHECKED_OUT' | 'CANCELLED';
  checked_in_at: string | null;
}

export interface ReservationGuestRow {
  id: string;
  reservation_id: string;
  item_id: string | null;
  guest_id: string;
  role: 'LEAD' | 'ACCOMPANYING';
  guest_name: string;
  guest_email: string | null;
  gender: 'FEMALE' | 'MALE' | null;
  departed_at: string | null;
}

export async function insertReservation(
  em: EntityManager,
  input: {
    id: string;
    tenantId: string;
    propertyId: string;
    source: 'DIRECT' | 'OTA' | 'IMPORT';
    channelConnectionId: string | null;
    externalBookingKey: string | null;
    state: string;
  },
): Promise<ReservationRow> {
  const row = await one<ReservationRow>(
    em,
    `insert into "reservation" (
        "id", "tenant_id", "property_id", "source",
        "channel_connection_id", "external_booking_key", "state"
     ) values (?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.id,
      input.tenantId,
      input.propertyId,
      input.source,
      input.channelConnectionId,
      input.externalBookingKey,
      input.state,
    ],
  );
  if (!row) throw new Error('reservation insert returned no row');
  return row;
}

export async function insertReservationItem(
  em: EntityManager,
  input: {
    id: string;
    tenantId: string;
    propertyId: string;
    reservationId: string;
    productId: string | null;
    arrival: string;
    departure: string;
    adults: number;
    childAges: number[];
    quantity: number;
    state: string;
    ownerStay?: boolean;
    splitFromId?: string | null;
    priceSnapshotId?: string | null;
    checkedInAt?: string | null;
  },
): Promise<ReservationItemRow> {
  const row = await one<ReservationItemRow>(
    em,
    `insert into "reservation_item" (
        "id", "tenant_id", "property_id", "reservation_id", "product_id",
        "arrival", "departure", "adults", "child_ages", "quantity", "state",
        "owner_stay", "split_from_id", "price_snapshot_id", "checked_in_at"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.id,
      input.tenantId,
      input.propertyId,
      input.reservationId,
      input.productId,
      input.arrival,
      input.departure,
      input.adults,
      JSON.stringify(input.childAges),
      input.quantity,
      input.state,
      input.ownerStay ?? false,
      input.splitFromId ?? null,
      input.priceSnapshotId ?? null,
      input.checkedInAt ?? null,
    ],
  );
  if (!row) throw new Error('reservation_item insert returned no row');
  return row;
}

export async function insertStaySegment(
  em: EntityManager,
  input: {
    id: string;
    tenantId: string;
    propertyId: string;
    itemId: string;
    startDate: string;
    endDate: string;
    state?: 'PLANNED' | 'IN_HOUSE';
    checkedInAt?: string | null;
  },
): Promise<StaySegmentRow> {
  const row = await one<StaySegmentRow>(
    em,
    `insert into "stay_segment" (
        "id", "tenant_id", "property_id", "item_id", "start_date", "end_date",
        "state", "checked_in_at"
     ) values (?, ?, ?, ?, ?, ?, coalesce(?, 'PLANNED'), ?)
     returning "id", "item_id", "start_date", "end_date",
               "composition_version_id", "rate_snapshot", "state", "checked_in_at"`,
    [
      input.id,
      input.tenantId,
      input.propertyId,
      input.itemId,
      input.startDate,
      input.endDate,
      input.state ?? null,
      input.checkedInAt ?? null,
    ] as never[],
  );
  if (!row) throw new Error('stay_segment insert returned no row');
  return row;
}

export async function insertReservationGuest(
  em: EntityManager,
  input: {
    id: string;
    tenantId: string;
    propertyId: string;
    reservationId: string;
    itemId: string | null;
    guestId: string;
    role: 'LEAD' | 'ACCOMPANYING';
  },
): Promise<void> {
  await em.execute(
    `insert into "reservation_guest" (
        "id", "tenant_id", "property_id", "reservation_id", "item_id",
        "guest_id", "role"
     ) values (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.tenantId,
      input.propertyId,
      input.reservationId,
      input.itemId,
      input.guestId,
      input.role,
    ] as never[],
  );
}

export async function findReservation(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  reservationId: string,
): Promise<ReservationRow | null> {
  return one<ReservationRow>(
    em,
    `select * from "reservation"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [reservationId, tenantId, propertyId],
  );
}

export async function listReservationRows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  input: { cursor: string | null; limit: number },
): Promise<ReservationRow[]> {
  const params: unknown[] = [tenantId, propertyId];
  if (input.cursor) {
    params.push(input.cursor);
    params.push(input.cursor);
  }
  return rows<ReservationRow>(
    em,
    `select * from "reservation"
      where "tenant_id" = ? and "property_id" = ?
        ${input.cursor ? `and ("created_at", "id") < (select "created_at", "id" from "reservation" where "id" = ?)` : ''}
      order by "created_at" desc, "id" desc
      limit ?`,
    [...params, input.limit],
  );
}

export async function listReservationItems(
  em: EntityManager,
  reservationId: string,
): Promise<ReservationItemRow[]> {
  return rows<ReservationItemRow>(
    em,
    `select * from "reservation_item"
      where "reservation_id" = ?
      order by "created_at", "id"`,
    [reservationId],
  );
}

export async function listStaySegments(
  em: EntityManager,
  itemIds: string[],
): Promise<StaySegmentRow[]> {
  if (itemIds.length === 0) return [];
  return rows<StaySegmentRow>(
    em,
    `select "id", "item_id", "start_date", "end_date",
            "composition_version_id", "rate_snapshot", "state", "checked_in_at"
       from "stay_segment"
      where "item_id" = any(string_to_array(?, ',')::uuid[])
      order by "item_id", "start_date"`,
    [itemIds.join(',')],
  );
}

export async function listReservationGuests(
  em: EntityManager,
  reservationId: string,
): Promise<ReservationGuestRow[]> {
  return rows<ReservationGuestRow>(
    em,
    `select rg."id", rg."reservation_id", rg."item_id", rg."guest_id",
            rg."role", g."full_name" as "guest_name", g."email" as "guest_email",
            g."gender", rg."departed_at"::text as "departed_at"
       from "reservation_guest" rg
       join "guest" g on g."id" = rg."guest_id" and g."tenant_id" = rg."tenant_id"
      where rg."reservation_id" = ?
      order by case when rg."role" = 'LEAD' then 0 else 1 end, rg."created_at"`,
    [reservationId],
  );
}

export async function listItemStatesForReservations(
  em: EntityManager,
  reservationIds: string[],
): Promise<Array<{ reservation_id: string; states: string[] }>> {
  if (reservationIds.length === 0) return [];
  return rows<{ reservation_id: string; states: string[] }>(
    em,
    `select "reservation_id", array_agg("state" order by "created_at", "id") as "states"
       from "reservation_item"
      where "reservation_id" = any(string_to_array(?, ',')::uuid[])
      group by "reservation_id"`,
    [reservationIds.join(',')],
  );
}

export async function updateReservationState(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    reservationId: string;
    state: string;
  },
): Promise<void> {
  await em.execute(
    `update "reservation"
        set "state" = ?, "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [
      input.state,
      input.reservationId,
      input.tenantId,
      input.propertyId,
    ] as never[],
  );
}

export async function findPropertyScope(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<{ id: string; timezone: string } | null> {
  return one<{ id: string; timezone: string }>(
    em,
    `select "id", "timezone" from "property" where "id" = ? and "tenant_id" = ?`,
    [propertyId, tenantId],
  );
}

export async function findProductInScope(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<{
  id: string;
  sharing_scope: 'MIXED' | 'FEMALE' | 'MALE' | null;
} | null> {
  return one<{ id: string; sharing_scope: 'MIXED' | 'FEMALE' | 'MALE' | null }>(
    em,
    `select "id", "sharing_scope" from "product"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [productId, tenantId, propertyId],
  );
}

export async function findConnectionInScope(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  connectionId: string,
): Promise<{ id: string } | null> {
  return one<{ id: string }>(
    em,
    `select "id" from "distribution_connection"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [connectionId, tenantId, propertyId],
  );
}

export async function findReservationItem(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  itemId: string,
): Promise<ReservationItemRow | null> {
  return one<ReservationItemRow>(
    em,
    `select * from "reservation_item"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [itemId, tenantId, propertyId],
  );
}

export async function updateReservationItem(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    itemId: string;
    arrival: string;
    departure: string;
    adults: number;
    childAges: number[];
    quantity: number;
    priceSnapshotId: string | null;
  },
): Promise<ReservationItemRow | null> {
  return one<ReservationItemRow>(
    em,
    `update "reservation_item"
        set "arrival" = ?, "departure" = ?, "adults" = ?, "child_ages" = ?::jsonb,
            "quantity" = ?, "price_snapshot_id" = ?,
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      returning *`,
    [
      input.arrival,
      input.departure,
      input.adults,
      JSON.stringify(input.childAges),
      input.quantity,
      input.priceSnapshotId,
      input.itemId,
      input.tenantId,
      input.propertyId,
    ],
  );
}

export async function confirmReservationItem(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    itemId: string;
    priceSnapshotId: string;
  },
): Promise<ReservationItemRow | null> {
  return one<ReservationItemRow>(
    em,
    `update "reservation_item"
        set "state" = 'CONFIRMED', "price_snapshot_id" = ?, "confirmed_at" = now(),
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      returning *`,
    [input.priceSnapshotId, input.itemId, input.tenantId, input.propertyId],
  );
}

export async function cancelReservationItemRow(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    itemId: string;
    reason: string;
  },
): Promise<ReservationItemRow | null> {
  return one<ReservationItemRow>(
    em,
    `update "reservation_item"
        set "state" = 'CANCELLED', "cancellation_reason" = ?, "cancelled_at" = now(),
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" in ('INQUIRY','TENTATIVE','WAITLIST','CONFIRMED','PARTIALLY_CONFIRMED')
      returning *`,
    [input.reason, input.itemId, input.tenantId, input.propertyId],
  );
}

export async function updateStaySegmentPeriod(
  em: EntityManager,
  itemId: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  await em.execute(
    `update "stay_segment"
        set "start_date" = ?, "end_date" = ?
      where "item_id" = ?`,
    [startDate, endDate, itemId] as never[],
  );
}

export async function markReservationConfirmed(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    reservationId: string;
    state: string;
  },
): Promise<ReservationRow | null> {
  return one<ReservationRow>(
    em,
    `update "reservation"
        set "state" = ?, "confirmed_at" = coalesce("confirmed_at", now()),
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      returning *`,
    [input.state, input.reservationId, input.tenantId, input.propertyId],
  );
}

export async function findActiveCommitmentForItem(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  itemId: string,
): Promise<{ id: string; state: string } | null> {
  return one<{ id: string; state: string }>(
    em,
    `select "id", "state" from "commitment"
      where "tenant_id" = ? and "property_id" = ?
        and "source_kind" = 'ITEM' and "source_id" = ? and "state" = 'ACTIVE'`,
    [tenantId, propertyId, itemId],
  );
}

export async function findConnectionChannel(
  em: EntityManager,
  connectionId: string,
): Promise<{ channel_key: string } | null> {
  return one<{ channel_key: string }>(
    em,
    `select "channel_key" from "distribution_connection" where "id" = ?`,
    [connectionId],
  );
}

export async function markReservationItemNoShow(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    itemId: string;
    reason: string;
  },
): Promise<ReservationItemRow | null> {
  return one<ReservationItemRow>(
    em,
    `update "reservation_item"
        set "state" = 'NO_SHOW', "cancellation_reason" = ?,
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'CONFIRMED'
      returning *`,
    [input.reason, input.itemId, input.tenantId, input.propertyId],
  );
}

export interface GroupAllotmentRow {
  id: string;
  tenant_id: string;
  property_id: string;
  reservation_id: string;
  product_id: string;
  start_date: string;
  end_date: string;
  quantity: number;
  state: 'ACTIVE' | 'PICKED_UP' | 'RELEASED';
  commitment_id: string;
  version: number;
}

export async function insertGroupAllotment(
  em: EntityManager,
  input: {
    id: string;
    tenantId: string;
    propertyId: string;
    reservationId: string;
    productId: string;
    startDate: string;
    endDate: string;
    quantity: number;
    commitmentId: string;
  },
): Promise<GroupAllotmentRow> {
  const row = await one<GroupAllotmentRow>(
    em,
    `insert into "reservation_group_allotment" (
        "id", "tenant_id", "property_id", "reservation_id", "product_id",
        "start_date", "end_date", "quantity", "commitment_id"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.id,
      input.tenantId,
      input.propertyId,
      input.reservationId,
      input.productId,
      input.startDate,
      input.endDate,
      input.quantity,
      input.commitmentId,
    ],
  );
  if (!row) throw new Error('group allotment insert returned no row');
  return row;
}

export async function findGroupAllotment(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  reservationId: string,
): Promise<GroupAllotmentRow | null> {
  return one<GroupAllotmentRow>(
    em,
    `select * from "reservation_group_allotment"
      where "reservation_id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'ACTIVE'`,
    [reservationId, tenantId, propertyId],
  );
}

export async function markGroupAllotmentPickedUp(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  allotmentId: string,
): Promise<GroupAllotmentRow | null> {
  return one<GroupAllotmentRow>(
    em,
    `update "reservation_group_allotment"
        set "state" = 'PICKED_UP', "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ? and "state" = 'ACTIVE'
      returning *`,
    [allotmentId, tenantId, propertyId],
  );
}

export async function listActiveAllocations(
  em: EntityManager,
  commitmentId: string,
): Promise<
  Array<{
    id: string;
    resource_id: string;
    start_date: string;
    end_date: string;
  }>
> {
  return rows<{
    id: string;
    resource_id: string;
    start_date: string;
    end_date: string;
  }>(
    em,
    `select "id", "resource_id", "start_date"::text as "start_date",
            "end_date"::text as "end_date"
       from "plan_allocation"
      where "commitment_id" = ? and "state" = 'ACTIVE'
      order by "resource_id", "start_date"`,
    [commitmentId],
  );
}

export async function bumpReservationItemVersion(
  em: EntityManager,
  input: { tenantId: string; propertyId: string; itemId: string },
): Promise<ReservationItemRow | null> {
  return one<ReservationItemRow>(
    em,
    `update "reservation_item"
        set "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      returning *`,
    [input.itemId, input.tenantId, input.propertyId],
  );
}

export async function checkInReservationItem(
  em: EntityManager,
  input: { tenantId: string; propertyId: string; itemId: string },
): Promise<ReservationItemRow | null> {
  return one<ReservationItemRow>(
    em,
    `update "reservation_item"
        set "state" = 'IN_HOUSE', "checked_in_at" = now(),
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'CONFIRMED'
      returning *`,
    [input.itemId, input.tenantId, input.propertyId],
  );
}

export async function checkInStaySegment(
  em: EntityManager,
  itemId: string,
  date: string,
): Promise<StaySegmentRow | null> {
  const current = await one<StaySegmentRow>(
    em,
    `update "stay_segment"
        set "state" = 'IN_HOUSE', "checked_in_at" = now(), "updated_at" = now()
      where "item_id" = ? and "state" = 'PLANNED'
        and "start_date" <= ?::date and "end_date" > ?::date
      returning "id", "item_id", "start_date", "end_date",
                "composition_version_id", "rate_snapshot", "state", "checked_in_at"`,
    [itemId, date, date],
  );
  if (current) return current;
  return one<StaySegmentRow>(
    em,
    `update "stay_segment"
        set "state" = 'IN_HOUSE', "checked_in_at" = now(), "updated_at" = now()
      where "id" = (
        select "id" from "stay_segment"
         where "item_id" = ? and "state" = 'PLANNED'
         order by "start_date", "id"
         limit 1
      )
      returning "id", "item_id", "start_date", "end_date",
                "composition_version_id", "rate_snapshot", "state", "checked_in_at"`,
    [itemId],
  );
}

export async function clipStaySegments(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    itemId: string;
    endDate: string;
  },
): Promise<void> {
  await em.execute(
    `update "stay_segment"
        set "end_date" = ?::date, "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "item_id" = ?
        and "state" in ('PLANNED', 'IN_HOUSE')
        and "start_date" < ?::date and "end_date" > ?::date`,
    [
      input.endDate,
      input.tenantId,
      input.propertyId,
      input.itemId,
      input.endDate,
      input.endDate,
    ] as never[],
  );
  await em.execute(
    `update "stay_segment"
        set "state" = 'CANCELLED', "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "item_id" = ?
        and "state" in ('PLANNED', 'IN_HOUSE')
        and "start_date" >= ?::date`,
    [input.tenantId, input.propertyId, input.itemId, input.endDate] as never[],
  );
}

export async function extendStaySegments(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    itemId: string;
    endDate: string;
  },
): Promise<void> {
  await em.execute(
    `update "stay_segment"
        set "end_date" = ?::date, "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "item_id" = ?
        and "state" in ('PLANNED', 'IN_HOUSE')
        and "start_date" < ?::date and "end_date" < ?::date`,
    [
      input.endDate,
      input.tenantId,
      input.propertyId,
      input.itemId,
      input.endDate,
      input.endDate,
    ] as never[],
  );
}

export async function checkOutReservationItem(
  em: EntityManager,
  input: { tenantId: string; propertyId: string; itemId: string },
): Promise<ReservationItemRow | null> {
  return one<ReservationItemRow>(
    em,
    `update "reservation_item"
        set "state" = 'CHECKED_OUT', "checked_out_at" = now(),
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'IN_HOUSE'
      returning *`,
    [input.itemId, input.tenantId, input.propertyId],
  );
}

export async function checkOutStaySegments(
  em: EntityManager,
  input: { tenantId: string; propertyId: string; itemId: string },
): Promise<StaySegmentRow[]> {
  return rows<StaySegmentRow>(
    em,
    `update "stay_segment"
        set "state" = case
              when "state" = 'IN_HOUSE' then 'CHECKED_OUT'
              else 'CANCELLED'
            end,
            "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "item_id" = ?
        and "state" in ('IN_HOUSE', 'PLANNED')
      returning "id", "item_id",
                "start_date"::text as "start_date",
                "end_date"::text as "end_date",
                "composition_version_id", "rate_snapshot", "state",
                "checked_in_at"`,
    [input.tenantId, input.propertyId, input.itemId],
  );
}

export async function updateReservationCheckoutState(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    reservationId: string;
    state: string;
  },
): Promise<ReservationRow | null> {
  return one<ReservationRow>(
    em,
    `update "reservation"
        set "state" = ?, "financial_clearance_state" = 'PENDING',
            "financial_cleared_at" = null,
            "financial_clearance_basis" = null,
            "financial_clearance_reference" = null,
            "financial_clearance_payer_folio_id" = null,
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      returning *`,
    [input.state, input.reservationId, input.tenantId, input.propertyId],
  );
}

export async function markReservationGuestsDeparted(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    reservationId: string;
    guestIds: readonly string[];
  },
): Promise<string[]> {
  if (input.guestIds.length === 0) return [];
  const updated = await rows<{ guest_id: string }>(
    em,
    `update "reservation_guest"
        set "departed_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "reservation_id" = ?
        and "guest_id" = any(string_to_array(?, ',')::uuid[])
        and "departed_at" is null
      returning "guest_id"`,
    [
      input.tenantId,
      input.propertyId,
      input.reservationId,
      input.guestIds.join(','),
    ],
  );
  return updated.map((row) => row.guest_id);
}
