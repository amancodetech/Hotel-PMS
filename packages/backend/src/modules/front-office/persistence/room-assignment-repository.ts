import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { resourceLocationPathSql } from '../../property/persistence/resource-display.js';
import { one, rows } from '../../../persistence/sql.js';
import type {
  ReservationItemRow,
  ReservationRow,
} from '../../reservations/persistence/reservation-repository.js';

export interface RoomAssignmentRow {
  id: string;
  tenant_id: string;
  property_id: string;
  item_id: string;
  segment_id: string | null;
  resource_id: string;
  start_date: string;
  end_date: string;
  state: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  version: number;
  assigned_at: string;
  checked_in_at: string | null;
  checked_out_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardRoomRow {
  display_label: string | null;
  location_path: string[];
  parent_display_label: string | null;
  id: string;
  code: string;
  resource_type: string;
  state: string;
  housekeeping_state: 'CLEAN' | 'DIRTY' | 'CLEANING' | 'INSPECTED';
  maintenance_state: 'NONE' | 'OOO' | 'OOS';
  version: number;
  parent_code: string | null;
  parent_state: string | null;
  parent_housekeeping_state:
    'CLEAN' | 'DIRTY' | 'CLEANING' | 'INSPECTED' | null;
  parent_maintenance_state: 'NONE' | 'OOO' | 'OOS' | null;
}

export interface ActiveItemAllocationRow {
  source_id: string;
  commitment_id: string;
  resource_id: string;
  start_date: string;
  end_date: string;
}

const assignmentColumns = `"id", "tenant_id", "property_id", "item_id", "segment_id",
  "resource_id", "start_date"::text as "start_date", "end_date"::text as "end_date",
  "state", "version", "assigned_at", "checked_in_at", "checked_out_at",
  "created_at", "updated_at"`;

export async function insertRoomAssignment(
  em: EntityManager,
  input: {
    id?: string;
    tenantId: string;
    propertyId: string;
    itemId: string;
    segmentId: string | null;
    resourceId: string;
    startDate: string;
    endDate: string;
    state: 'PLANNED' | 'ACTIVE';
    checkedInAt?: string | null;
  },
): Promise<RoomAssignmentRow> {
  const row = await one<RoomAssignmentRow>(
    em,
    `insert into "room_assignment" (
        "id", "tenant_id", "property_id", "item_id", "segment_id",
        "resource_id", "start_date", "end_date", "state", "checked_in_at"
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning ${assignmentColumns}`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.propertyId,
      input.itemId,
      input.segmentId,
      input.resourceId,
      input.startDate,
      input.endDate,
      input.state,
      input.checkedInAt ?? null,
    ],
  );
  if (!row) throw new Error('room_assignment insert returned no row');
  return row;
}

export async function findCurrentAssignmentForItem(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  itemId: string,
): Promise<RoomAssignmentRow | null> {
  return one<RoomAssignmentRow>(
    em,
    `select ${assignmentColumns} from "room_assignment"
      where "tenant_id" = ? and "property_id" = ? and "item_id" = ?
        and "state" in ('PLANNED', 'ACTIVE')
      order by case when "state" = 'ACTIVE' then 0 else 1 end,
               "assigned_at" desc, "id" desc
      limit 1`,
    [tenantId, propertyId, itemId],
  );
}

export async function listAssignmentsForItems(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  itemIds: readonly string[],
): Promise<RoomAssignmentRow[]> {
  if (itemIds.length === 0) return [];
  return rows<RoomAssignmentRow>(
    em,
    `select ${assignmentColumns} from "room_assignment"
      where "tenant_id" = ? and "property_id" = ?
        and "item_id" = any(string_to_array(?, ',')::uuid[])
        and "state" in ('PLANNED', 'ACTIVE')
      order by "item_id", case when "state" = 'ACTIVE' then 0 else 1 end,
               "assigned_at" desc, "id" desc`,
    [tenantId, propertyId, itemIds.join(',')],
  );
}

export async function listLiveRoomAssignments(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<RoomAssignmentRow[]> {
  return rows<RoomAssignmentRow>(
    em,
    `select ${assignmentColumns} from "room_assignment"
      where "tenant_id" = ? and "property_id" = ?
        and "state" in ('PLANNED', 'ACTIVE')
      order by "assigned_at" desc, "id" desc`,
    [tenantId, propertyId],
  );
}

export async function cancelPlannedAssignmentsForItem(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  itemId: string,
): Promise<string[]> {
  const cancelled = await rows<{ id: string }>(
    em,
    `update "room_assignment"
        set "state" = 'CANCELLED', "version" = "version" + 1,
            "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "item_id" = ?
        and "state" = 'PLANNED'
      returning "id"`,
    [tenantId, propertyId, itemId],
  );
  return cancelled.map((row) => row.id);
}

export async function activateRoomAssignment(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  assignmentId: string,
  segmentId: string | null,
): Promise<RoomAssignmentRow | null> {
  return one<RoomAssignmentRow>(
    em,
    `update "room_assignment"
        set "state" = 'ACTIVE', "checked_in_at" = coalesce("checked_in_at", now()),
            "segment_id" = coalesce(?, "segment_id"),
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'PLANNED'
      returning ${assignmentColumns}`,
    [segmentId, assignmentId, tenantId, propertyId],
  );
}

export async function updateRoomAssignmentPeriod(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    assignmentId: string;
    endDate: string;
    state?: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
    expectedState: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  },
): Promise<RoomAssignmentRow | null> {
  return one<RoomAssignmentRow>(
    em,
    `update "room_assignment"
        set "end_date" = ?::date,
            "state" = coalesce(?, "state"),
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = ?
      returning ${assignmentColumns}`,
    [
      input.endDate,
      input.state ?? null,
      input.assignmentId,
      input.tenantId,
      input.propertyId,
      input.expectedState,
    ] as never[],
  );
}

export async function completeLiveAssignmentsForItem(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    itemId: string;
  },
): Promise<RoomAssignmentRow[]> {
  return rows<RoomAssignmentRow>(
    em,
    `update "room_assignment"
        set "state" = 'COMPLETED',
            "checked_out_at" = coalesce("checked_out_at", now()),
            "version" = "version" + 1, "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "item_id" = ?
        and "state" in ('PLANNED', 'ACTIVE')
      returning ${assignmentColumns}`,
    [input.tenantId, input.propertyId, input.itemId],
  );
}

export async function markRoomHousekeepingDirty(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceId: string;
  },
): Promise<BoardRoomRow | null> {
  return one<BoardRoomRow>(
    em,
    `update "resource"
        set "housekeeping_state" = 'DIRTY',
            "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      returning "id", "code", "resource_type", "state", "housekeeping_state",
                "maintenance_state", "version",
                null::text as "parent_code", null::text as "parent_state",
                null::text as "parent_housekeeping_state",
                null::text as "parent_maintenance_state"`,
    [input.resourceId, input.tenantId, input.propertyId],
  );
}

export async function listOverlappingAssignments(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceIds: readonly string[];
    startDate: string;
    endDate: string;
    excludeItemId: string | null;
  },
): Promise<RoomAssignmentRow[]> {
  if (input.resourceIds.length === 0) return [];
  return rows<RoomAssignmentRow>(
    em,
    `select ${assignmentColumns} from "room_assignment"
      where "tenant_id" = ? and "property_id" = ?
        and "state" in ('PLANNED', 'ACTIVE')
        and "resource_id" = any(string_to_array(?, ',')::uuid[])
        and (?::uuid is null or "item_id" <> ?::uuid)
        and daterange("start_date", "end_date", '[)')
            && daterange(?::date, ?::date, '[)')`,
    [
      input.tenantId,
      input.propertyId,
      input.resourceIds.join(','),
      input.excludeItemId,
      input.excludeItemId,
      input.startDate,
      input.endDate,
    ] as never[],
  );
}

export async function listBlockedResourceIds(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceIds: readonly string[];
    startDate: string;
    endDate: string;
  },
): Promise<string[]> {
  if (input.resourceIds.length === 0) return [];
  const blocked = await rows<{ resource_id: string }>(
    em,
    `select distinct r."resource_id" from "inventory_block_resource" r
       join "inventory_block" b
         on b."id" = r."block_id"
        and b."tenant_id" = r."tenant_id"
        and b."property_id" = r."property_id"
      where r."tenant_id" = ? and r."property_id" = ?
        and r."resource_id" = any(string_to_array(?, ',')::uuid[])
        and b."state" = 'ACTIVE'
        and b."mode" in ('PLANNED', 'EMERGENCY')
        and daterange(b."start_date", b."end_date", '[)')
            && daterange(?::date, ?::date, '[)')`,
    [
      input.tenantId,
      input.propertyId,
      input.resourceIds.join(','),
      input.startDate,
      input.endDate,
    ],
  );
  return blocked.map((row) => row.resource_id);
}

export async function listArrivalItems(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  date: string,
): Promise<ReservationItemRow[]> {
  return rows<ReservationItemRow>(
    em,
    `select * from "reservation_item"
      where "tenant_id" = ? and "property_id" = ?
        and "state" = 'CONFIRMED' and "arrival" = ?::date
      order by "arrival", "created_at", "id"`,
    [tenantId, propertyId, date],
  );
}

export async function listDepartureItems(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  date: string,
): Promise<ReservationItemRow[]> {
  return rows<ReservationItemRow>(
    em,
    `select * from "reservation_item"
      where "tenant_id" = ? and "property_id" = ?
        and "state" = 'IN_HOUSE' and "departure" = ?::date
      order by "departure", "created_at", "id"`,
    [tenantId, propertyId, date],
  );
}

export async function listInHouseItems(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<ReservationItemRow[]> {
  return rows<ReservationItemRow>(
    em,
    `select * from "reservation_item"
      where "tenant_id" = ? and "property_id" = ? and "state" = 'IN_HOUSE'
      order by "arrival", "created_at", "id"`,
    [tenantId, propertyId],
  );
}

export async function listReservationsByIds(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  reservationIds: readonly string[],
): Promise<ReservationRow[]> {
  if (reservationIds.length === 0) return [];
  return rows<ReservationRow>(
    em,
    `select * from "reservation"
      where "tenant_id" = ? and "property_id" = ?
        and "id" = any(string_to_array(?, ',')::uuid[])`,
    [tenantId, propertyId, reservationIds.join(',')],
  );
}

export async function listBoardResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<BoardRoomRow[]> {
  return rows<BoardRoomRow>(
    em,
    `select r."id", r."code", r."display_label",
            ${resourceLocationPathSql} as "location_path",
            p."display_label" as "parent_display_label", r."resource_type", r."state",
            r."housekeeping_state", r."maintenance_state", r."version",
            p."code" as "parent_code",
            p."state" as "parent_state",
            p."housekeeping_state" as "parent_housekeeping_state",
            p."maintenance_state" as "parent_maintenance_state"
       from "resource" r
       left join "resource" p
         on p."id" = r."parent_resource_id"
        and p."tenant_id" = r."tenant_id"
        and p."property_id" = r."property_id"
      where r."tenant_id" = ? and r."property_id" = ?
        and not exists (
          select 1 from "resource" child
           where child."parent_resource_id" = r."id"
             and child."tenant_id" = r."tenant_id"
             and child."property_id" = r."property_id"
        )
      order by r."code", r."id"`,
    [tenantId, propertyId],
  );
}

export async function listProductsByIds(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productIds: readonly string[],
): Promise<Array<{ id: string; kind: string; sharing_scope: string | null }>> {
  if (productIds.length === 0) return [];
  return rows<{ id: string; kind: string; sharing_scope: string | null }>(
    em,
    `select "id", "kind", "sharing_scope" from "product"
      where "tenant_id" = ? and "property_id" = ?
        and "id" = any(string_to_array(?, ',')::uuid[])`,
    [tenantId, propertyId, productIds.join(',')],
  );
}

export async function listCandidateResourceIdsForProduct(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<string[]> {
  const candidates = await rows<{ resource_id: string }>(
    em,
    `select "resource_id" from "product_resource_candidate"
      where "tenant_id" = ? and "property_id" = ? and "product_id" = ?
      order by "resource_id"`,
    [tenantId, propertyId, productId],
  );
  return candidates.map((row) => row.resource_id);
}

export async function listActiveItemCommitmentIds(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  itemIds: readonly string[],
): Promise<Array<{ source_id: string; id: string }>> {
  if (itemIds.length === 0) return [];
  return rows<{ source_id: string; id: string }>(
    em,
    `select "source_id", "id" from "commitment"
      where "tenant_id" = ? and "property_id" = ?
        and "source_kind" = 'ITEM' and "state" = 'ACTIVE'
        and "source_id" = any(string_to_array(?, ',')::uuid[])`,
    [tenantId, propertyId, itemIds.join(',')],
  );
}

export async function listActiveItemAllocations(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  itemIds: readonly string[],
): Promise<ActiveItemAllocationRow[]> {
  if (itemIds.length === 0) return [];
  return rows<ActiveItemAllocationRow>(
    em,
    `select c."source_id", c."id" as "commitment_id", a."resource_id",
            a."start_date"::text as "start_date",
            a."end_date"::text as "end_date"
       from "commitment" c
       join "plan_allocation" a
         on a."commitment_id" = c."id"
        and a."tenant_id" = c."tenant_id"
        and a."property_id" = c."property_id"
      where c."tenant_id" = ? and c."property_id" = ?
        and c."source_kind" = 'ITEM' and c."state" = 'ACTIVE'
        and a."state" = 'ACTIVE'
        and c."source_id" = any(string_to_array(?, ',')::uuid[])
      order by c."source_id", a."resource_id", a."start_date"`,
    [tenantId, propertyId, itemIds.join(',')],
  );
}
