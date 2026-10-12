import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import type { ResourceKind } from '../domain/lifecycle.js';
import type { ResourceRow, UnitDetails } from './types.js';

export async function insertResource(
  em: EntityManager,
  input: {
    id?: string;
    tenantId: string;
    propertyId: string;
    code: string;
    resourceType: ResourceKind;
    capacity: number;
    locationId: string | null;
    parentResourceId?: string | null;
    display_label?: string | null;
    unit_details?: UnitDetails;
  },
): Promise<ResourceRow> {
  const row = await one<ResourceRow>(
    em,
    `insert into "resource"
       ("id", "tenant_id", "property_id", "code", "resource_type",
        "capacity", "location_id", "parent_resource_id", "display_label", "unit_details")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
     returning *`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.propertyId,
      input.code,
      input.resourceType,
      input.capacity,
      input.locationId,
      input.parentResourceId ?? null,
      input.display_label ?? null,
      JSON.stringify(input.unit_details ?? {}),
    ],
  );
  if (!row) throw new Error('Resource insert returned no row');
  return row;
}

export async function findResource(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceId: string,
): Promise<ResourceRow | null> {
  return one<ResourceRow>(
    em,
    `select * from "resource"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [resourceId, tenantId, propertyId],
  );
}

export async function lockResource(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceId: string,
): Promise<ResourceRow | null> {
  return one<ResourceRow>(
    em,
    `select * from "resource"
      where "id" = ? and "tenant_id" = ? and "property_id" = ? for update`,
    [resourceId, tenantId, propertyId],
  );
}

export async function findResourceByCode(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  code: string,
): Promise<ResourceRow | null> {
  return one<ResourceRow>(
    em,
    `select * from "resource"
      where "code" = ? and "tenant_id" = ? and "property_id" = ?`,
    [code, tenantId, propertyId],
  );
}

export async function listParentResourceIds(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceIds: readonly string[],
): Promise<Set<string>> {
  if (resourceIds.length === 0) return new Set();
  const found = await rows<{ parent_resource_id: string }>(
    em,
    `select distinct "parent_resource_id"
       from "resource"
      where "tenant_id" = ? and "property_id" = ?
        and "parent_resource_id" = any(string_to_array(?, ',')::uuid[])`,
    [tenantId, propertyId, resourceIds.join(',')],
  );
  return new Set(found.map((row) => row.parent_resource_id));
}

export async function listChildResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  parentResourceId: string,
): Promise<ResourceRow[]> {
  return rows<ResourceRow>(
    em,
    `select * from "resource"
      where "tenant_id" = ? and "property_id" = ? and "parent_resource_id" = ?
      order by "code"`,
    [tenantId, propertyId, parentResourceId],
  );
}

export async function listDescendantResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceIds: readonly string[],
): Promise<ResourceRow[]> {
  if (resourceIds.length === 0) return [];
  return rows<ResourceRow>(
    em,
    `with recursive tree as (
       select * from "resource"
        where "tenant_id" = ? and "property_id" = ?
          and "id" = any(string_to_array(?, ',')::uuid[])
       union all
       select child.*
         from "resource" child
         join tree parent on child."parent_resource_id" = parent."id"
        where child."tenant_id" = ? and child."property_id" = ?
     )
     select * from tree order by "code"`,
    [
      tenantId,
      propertyId,
      resourceIds.join(','),
      tenantId,
      propertyId,
    ] as never[],
  );
}

export async function listAncestorResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceIds: readonly string[],
): Promise<Array<ResourceRow & { origin_id: string }>> {
  if (resourceIds.length === 0) return [];
  return rows<ResourceRow & { origin_id: string }>(
    em,
    `with recursive tree as (
       select r.*, r."id" as "origin_id" from "resource" r
        where r."tenant_id" = ? and r."property_id" = ?
          and r."id" = any(string_to_array(?, ',')::uuid[])
       union all
       select parent.*, tree."origin_id"
         from "resource" parent
         join tree on tree."parent_resource_id" = parent."id"
        where parent."tenant_id" = ? and parent."property_id" = ?
     )
     select * from tree where "id" <> "origin_id" order by "code"`,
    [
      tenantId,
      propertyId,
      resourceIds.join(','),
      tenantId,
      propertyId,
    ] as never[],
  );
}

export async function listResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  options: { limit: number; cursor: string | null },
): Promise<ResourceRow[]> {
  let afterCreatedAt: string | null = null;
  let afterId: string | null = null;
  if (options.cursor) {
    const separator = options.cursor.lastIndexOf('|');
    if (separator > 0) {
      afterCreatedAt = options.cursor.slice(0, separator);
      afterId = options.cursor.slice(separator + 1);
    }
  }
  return rows<ResourceRow>(
    em,
    `select * from "resource"
      where "tenant_id" = ? and "property_id" = ?
        and (
          ?::timestamptz is null
          or ("created_at", "id") > (?::timestamptz, ?::uuid)
        )
      order by "created_at", "id"
      limit ?`,
    [
      tenantId,
      propertyId,
      afterCreatedAt,
      afterCreatedAt,
      afterId,
      options.limit,
    ],
  );
}

export async function updateResourceMaintenance(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceId: string;
    version: number;
    maintenanceState: 'NONE' | 'OOO' | 'OOS';
  },
): Promise<ResourceRow | null> {
  return one<ResourceRow>(
    em,
    `update "resource"
        set "maintenance_state" = ?,
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ? and "version" = ?
      returning *`,
    [
      input.maintenanceState,
      input.resourceId,
      input.tenantId,
      input.propertyId,
      input.version,
    ] as never[],
  );
}

export async function updateResourceHousekeeping(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceId: string;
    housekeepingState: 'CLEAN' | 'DIRTY' | 'CLEANING' | 'INSPECTED';
  },
): Promise<ResourceRow | null> {
  return one<ResourceRow>(
    em,
    `update "resource"
        set "housekeeping_state" = ?,
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
      returning *`,
    [
      input.housekeepingState,
      input.resourceId,
      input.tenantId,
      input.propertyId,
    ],
  );
}

export async function updateResource(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceId: string;
    version: number;
    capacity?: number;
    locationId?: string | null;
    state?: string;
    display_label?: string | null;
    unit_details?: UnitDetails;
  },
): Promise<ResourceRow | null> {
  const hasLocation = input.locationId !== undefined;
  return one<ResourceRow>(
    em,
    `update "resource"
        set "capacity" = coalesce(?, "capacity"),
            "location_id" = case when ? then ?::uuid else "location_id" end,
            "state" = coalesce(?, "state"),
            "display_label" = case when ? then ?::text else "display_label" end,
            "unit_details" = coalesce(?::jsonb, "unit_details"),
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ? and "version" = ?
      returning *`,
    [
      input.capacity ?? null,
      hasLocation,
      hasLocation ? input.locationId : null,
      input.state ?? null,
      input.display_label !== undefined,
      input.display_label ?? null,
      input.unit_details === undefined
        ? null
        : JSON.stringify(input.unit_details),
      input.resourceId,
      input.tenantId,
      input.propertyId,
      input.version,
    ] as never[],
  );
}
