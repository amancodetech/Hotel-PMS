import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';

export interface CommitmentRow {
  id: string;
  tenant_id: string;
  property_id: string;
  source_kind: 'HOLD' | 'ITEM' | 'GROUP';
  source_id: string;
  state: 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'CONVERTED';
  expires_at: string | null;
  inventory_version: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PlanAllocationRow {
  id: string;
  commitment_id: string;
  tenant_id: string;
  property_id: string;
  resource_id: string;
  start_date: string;
  end_date: string;
  state: 'ACTIVE' | 'RELEASED';
  created_at: string;
  updated_at: string;
}

export interface InventoryBlockRow {
  id: string;
  tenant_id: string;
  property_id: string;
  mode: 'PLANNED' | 'EMERGENCY';
  reason: string;
  state: 'ACTIVE' | 'RELEASED';
  start_date: string;
  end_date: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryDisruptionRow {
  id: string;
  tenant_id: string;
  property_id: string;
  block_id: string;
  allocation_id: string;
  resource_id: string;
  start_date: string;
  end_date: string;
  state: 'OPEN' | 'RESOLVED';
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface OccupancyConflictRow {
  resource_id: string;
  kind: 'ALLOCATION' | 'BLOCK' | 'EXPOSURE';
  ref_id: string;
  start_date: string;
  end_date: string;
}

export async function insertCommitment(
  em: EntityManager,
  input: {
    id?: string;
    tenantId: string;
    propertyId: string;
    sourceKind: 'HOLD' | 'ITEM' | 'GROUP';
    sourceId: string;
    expiresAt: string | null;
    inventoryVersion: number;
  },
): Promise<CommitmentRow> {
  const row = await one<CommitmentRow>(
    em,
    `insert into "commitment"
       ("id", "tenant_id", "property_id", "source_kind", "source_id",
        "expires_at", "inventory_version")
     values (?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.propertyId,
      input.sourceKind,
      input.sourceId,
      input.expiresAt,
      input.inventoryVersion,
    ],
  );
  if (!row) throw new Error('Commitment insert returned no row');
  return row;
}

export async function insertPlanAllocation(
  em: EntityManager,
  input: {
    id?: string;
    commitmentId: string;
    tenantId: string;
    propertyId: string;
    resourceId: string;
    startDate: string;
    endDate: string;
  },
): Promise<PlanAllocationRow> {
  const row = await one<PlanAllocationRow>(
    em,
    `insert into "plan_allocation"
       ("id", "commitment_id", "tenant_id", "property_id", "resource_id",
        "start_date", "end_date")
     values (?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.id ?? randomUUID(),
      input.commitmentId,
      input.tenantId,
      input.propertyId,
      input.resourceId,
      input.startDate,
      input.endDate,
    ],
  );
  if (!row) throw new Error('Plan allocation insert returned no row');
  return row;
}

export async function findCommitment(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  commitmentId: string,
): Promise<CommitmentRow | null> {
  return one<CommitmentRow>(
    em,
    `select * from "commitment"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [commitmentId, tenantId, propertyId],
  );
}

export async function listCommitments(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  states: readonly string[] = ['ACTIVE'],
): Promise<CommitmentRow[]> {
  return rows<CommitmentRow>(
    em,
    `select * from "commitment"
      where "tenant_id" = ? and "property_id" = ?
        and "state" = any(string_to_array(?, ',')::varchar[])
      order by "created_at" desc`,
    [tenantId, propertyId, states.join(',')],
  );
}

export async function listAllocationsForCommitment(
  em: EntityManager,
  commitmentId: string,
): Promise<PlanAllocationRow[]> {
  return rows<PlanAllocationRow>(
    em,
    `select * from "plan_allocation"
      where "commitment_id" = ?
      order by "resource_id", "start_date"`,
    [commitmentId],
  );
}

export async function expireDueHolds(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<number> {
  const expired = await rows<{ id: string }>(
    em,
    `update "commitment"
        set "state" = 'EXPIRED', "version" = "version" + 1, "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ?
        and "source_kind" = 'HOLD' and "state" = 'ACTIVE'
        and "expires_at" is not null and "expires_at" <= now()
      returning "id"`,
    [tenantId, propertyId],
  );
  if (expired.length === 0) return 0;
  const ids = expired.map((row) => row.id);
  await em.execute(
    `update "plan_allocation"
        set "state" = 'RELEASED', "updated_at" = now()
      where "commitment_id" = any(string_to_array(?, ',')::uuid[])
        and "state" = 'ACTIVE'`,
    [ids.join(',')] as never[],
  );
  return expired.length;
}

export async function releaseCommitment(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    commitmentId: string;
    state: 'RELEASED' | 'CONVERTED';
  },
): Promise<CommitmentRow | null> {
  const row = await one<CommitmentRow>(
    em,
    `update "commitment"
        set "state" = ?, "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'ACTIVE'
      returning *`,
    [input.state, input.commitmentId, input.tenantId, input.propertyId],
  );
  if (!row) return null;
  await em.execute(
    `update "plan_allocation"
        set "state" = 'RELEASED', "updated_at" = now()
      where "commitment_id" = ? and "state" = 'ACTIVE'`,
    [input.commitmentId] as never[],
  );
  return row;
}

export async function listOccupancyConflicts(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceIds: readonly string[];
    arrival: string;
    departure: string;
    includeCommitmentId?: string | null;
  },
): Promise<OccupancyConflictRow[]> {
  return rows<OccupancyConflictRow>(
    em,
    `select a."resource_id", 'ALLOCATION' as "kind", a."id" as "ref_id",
            a."start_date"::text, a."end_date"::text
       from "plan_allocation" a
      where a."tenant_id" = ? and a."property_id" = ?
        and a."resource_id" = any(string_to_array(?, ',')::uuid[])
        and a."state" = 'ACTIVE'
        and (?::uuid is null or a."commitment_id" <> ?::uuid)
        and daterange(a."start_date", a."end_date", '[)') && daterange(?::date, ?::date, '[)')
      union all
     select r."resource_id", 'BLOCK' as "kind", b."id" as "ref_id",
            b."start_date"::text, b."end_date"::text
       from "inventory_block_resource" r
       join "inventory_block" b
         on b."id" = r."block_id" and b."tenant_id" = r."tenant_id"
        and b."property_id" = r."property_id"
      where r."tenant_id" = ? and r."property_id" = ?
        and r."resource_id" = any(string_to_array(?, ',')::uuid[])
        and b."state" = 'ACTIVE'
        and daterange(b."start_date", b."end_date", '[)') && daterange(?::date, ?::date, '[)')
      union all
     select e."resource_id", 'EXPOSURE' as "kind", e."exposure_id" as "ref_id",
            e."start_date"::text, e."end_date"::text
       from "exposure_allocation" e
      where e."tenant_id" = ? and e."property_id" = ?
        and e."resource_id" = any(string_to_array(?, ',')::uuid[])
        and e."state" = 'RESERVED'
        and daterange(e."start_date", e."end_date", '[)') && daterange(?::date, ?::date, '[)')`,
    [
      input.tenantId,
      input.propertyId,
      input.resourceIds.join(','),
      input.includeCommitmentId ?? null,
      input.includeCommitmentId ?? null,
      input.arrival,
      input.departure,
      input.tenantId,
      input.propertyId,
      input.resourceIds.join(','),
      input.arrival,
      input.departure,
      input.tenantId,
      input.propertyId,
      input.resourceIds.join(','),
      input.arrival,
      input.departure,
    ] as never[],
  );
}

export async function listAllocationConflictsForResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceIds: readonly string[],
  arrival: string,
  departure: string,
): Promise<PlanAllocationRow[]> {
  return rows<PlanAllocationRow>(
    em,
    `select * from "plan_allocation"
      where "tenant_id" = ? and "property_id" = ?
        and "resource_id" = any(string_to_array(?, ',')::uuid[])
        and "state" = 'ACTIVE'
        and daterange("start_date", "end_date", '[)') && daterange(?::date, ?::date, '[)')`,
    [
      tenantId,
      propertyId,
      resourceIds.join(','),
      arrival,
      departure,
    ] as never[],
  );
}

export interface AssignedAllocationConflictRow extends PlanAllocationRow {
  assigned_resource_id: string;
}

export async function listAssignedAllocationConflictsForResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceIds: readonly string[],
  arrival: string,
  departure: string,
): Promise<AssignedAllocationConflictRow[]> {
  if (resourceIds.length === 0) return [];
  return rows<AssignedAllocationConflictRow>(
    em,
    `select distinct a.*, ra."resource_id"::text as "assigned_resource_id"
       from "room_assignment" ra
       join "commitment" c
         on c."tenant_id" = ra."tenant_id" and c."property_id" = ra."property_id"
        and c."source_kind" = 'ITEM' and c."source_id" = ra."item_id"
        and c."state" = 'ACTIVE'
       join "plan_allocation" a
         on a."tenant_id" = c."tenant_id" and a."property_id" = c."property_id"
        and a."commitment_id" = c."id" and a."state" = 'ACTIVE'
      where ra."tenant_id" = ? and ra."property_id" = ?
        and ra."resource_id" = any(string_to_array(?, ',')::uuid[])
        and ra."state" in ('PLANNED', 'ACTIVE')
        and daterange(ra."start_date", ra."end_date", '[)')
            && daterange(?::date, ?::date, '[)')
        and daterange(a."start_date", a."end_date", '[)')
            && daterange(ra."start_date", ra."end_date", '[)')`,
    [
      tenantId,
      propertyId,
      resourceIds.join(','),
      arrival,
      departure,
    ] as never[],
  );
}

export async function insertInventoryBlock(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    mode: 'PLANNED' | 'EMERGENCY';
    reason: string;
    startDate: string;
    endDate: string;
  },
): Promise<InventoryBlockRow> {
  const row = await one<InventoryBlockRow>(
    em,
    `insert into "inventory_block"
       ("id", "tenant_id", "property_id", "mode", "reason", "start_date", "end_date")
     values (?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.mode,
      input.reason,
      input.startDate,
      input.endDate,
    ],
  );
  if (!row) throw new Error('Inventory block insert returned no row');
  return row;
}

export async function insertBlockResources(
  em: EntityManager,
  input: {
    blockId: string;
    tenantId: string;
    propertyId: string;
    resourceIds: readonly string[];
  },
): Promise<void> {
  for (const resourceId of input.resourceIds)
    await em.execute(
      `insert into "inventory_block_resource"
         ("block_id", "tenant_id", "property_id", "resource_id")
       values (?, ?, ?, ?)`,
      [input.blockId, input.tenantId, input.propertyId, resourceId] as never[],
    );
}

export async function findBlock(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  blockId: string,
): Promise<InventoryBlockRow | null> {
  return one<InventoryBlockRow>(
    em,
    `select * from "inventory_block"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [blockId, tenantId, propertyId],
  );
}

export async function listBlocks(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<Array<InventoryBlockRow & { resource_ids: string[] }>> {
  return rows(
    em,
    `select b.*, coalesce(array_agg(r."resource_id") filter (where r."resource_id" is not null), '{}') as "resource_ids"
       from "inventory_block" b
       left join "inventory_block_resource" r
         on r."block_id" = b."id" and r."tenant_id" = b."tenant_id"
      where b."tenant_id" = ? and b."property_id" = ?
      group by b."id"
      order by b."start_date", b."created_at"`,
    [tenantId, propertyId],
  );
}

export async function releaseBlockById(
  em: EntityManager,
  input: { tenantId: string; propertyId: string; blockId: string },
): Promise<InventoryBlockRow | null> {
  return one<InventoryBlockRow>(
    em,
    `update "inventory_block"
        set "state" = 'RELEASED', "version" = "version" + 1, "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "state" = 'ACTIVE'
      returning *`,
    [input.blockId, input.tenantId, input.propertyId],
  );
}

export async function insertDisruption(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    blockId: string;
    allocationId: string;
    resourceId: string;
    startDate: string;
    endDate: string;
    note: string;
  },
): Promise<InventoryDisruptionRow> {
  const row = await one<InventoryDisruptionRow>(
    em,
    `insert into "inventory_disruption"
       ("id", "tenant_id", "property_id", "block_id", "allocation_id",
        "resource_id", "start_date", "end_date", "note")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.blockId,
      input.allocationId,
      input.resourceId,
      input.startDate,
      input.endDate,
      input.note,
    ],
  );
  if (!row) throw new Error('Disruption insert returned no row');
  return row;
}

export async function listDisruptions(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<InventoryDisruptionRow[]> {
  return rows<InventoryDisruptionRow>(
    em,
    `select * from "inventory_disruption"
      where "tenant_id" = ? and "property_id" = ?
      order by "created_at"`,
    [tenantId, propertyId],
  );
}

export async function resolveDisruptionsForBlock(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    blockId: string;
    note: string;
  },
): Promise<InventoryDisruptionRow[]> {
  return rows<InventoryDisruptionRow>(
    em,
    `update "inventory_disruption"
        set "state" = 'RESOLVED',
            "resolved_at" = now(),
            "note" = coalesce("note", ?)
      where "tenant_id" = ? and "property_id" = ? and "block_id" = ?
        and "state" = 'OPEN'
      returning *`,
    [input.note, input.tenantId, input.propertyId, input.blockId],
  );
}

export async function releaseAllocationsForCommitment(
  em: EntityManager,
  commitmentId: string,
): Promise<void> {
  await em.execute(
    `update "plan_allocation"
        set "state" = 'RELEASED', "updated_at" = now()
      where "commitment_id" = ? and "state" = 'ACTIVE'`,
    [commitmentId] as never[],
  );
}

export async function touchCommitmentVersion(
  em: EntityManager,
  commitmentId: string,
  inventoryVersion: number,
): Promise<void> {
  await em.execute(
    `update "commitment"
        set "version" = "version" + 1, "inventory_version" = ?, "updated_at" = now()
      where "id" = ?`,
    [inventoryVersion, commitmentId] as never[],
  );
}

export async function moveAllocationsToCommitment(
  em: EntityManager,
  input: { fromCommitmentId: string; toCommitmentId: string },
): Promise<number> {
  const moved = await rows<{ id: string }>(
    em,
    `update "plan_allocation"
        set "commitment_id" = ?, "updated_at" = now()
      where "commitment_id" = ? and "state" = 'ACTIVE'
      returning "id"`,
    [input.toCommitmentId, input.fromCommitmentId],
  );
  return moved.length;
}
