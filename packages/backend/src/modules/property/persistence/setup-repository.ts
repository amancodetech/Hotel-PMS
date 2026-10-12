import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import type { VersionedSetupInput } from '../domain/setup-v2.js';
import type {
  PropertySetupDraftRow,
  PropertySetupLimitsRow,
  ResourceRow,
} from './types.js';

export async function findSetupDraft(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<PropertySetupDraftRow | null> {
  return one<PropertySetupDraftRow>(
    em,
    `select * from "property_setup_draft"
      where "tenant_id" = ? and "property_id" = ?`,
    [tenantId, propertyId],
  );
}

export async function insertSetupDraft(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    draft: VersionedSetupInput;
    updatedByUserId: string | null;
  },
): Promise<PropertySetupDraftRow> {
  const row = await one<PropertySetupDraftRow>(
    em,
    `insert into "property_setup_draft"
        ("id", "tenant_id", "property_id", "revision", "input", "updated_by_user_id")
     values (?, ?, ?, 1, ?::jsonb, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      JSON.stringify(input.draft),
      input.updatedByUserId,
    ],
  );
  if (!row) throw new Error('Setup draft insert returned no row');
  return row;
}

export async function updateSetupDraft(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    revision: number;
    draft: VersionedSetupInput;
    updatedByUserId: string | null;
  },
): Promise<PropertySetupDraftRow | null> {
  return one<PropertySetupDraftRow>(
    em,
    `update "property_setup_draft"
        set "input" = ?::jsonb,
            "completed" = false,
            "revision" = "revision" + 1,
            "updated_by_user_id" = ?,
            "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ? and "revision" = ? and "completed" = false
      returning *`,
    [
      JSON.stringify(input.draft),
      input.updatedByUserId,
      input.tenantId,
      input.propertyId,
      input.revision,
    ],
  );
}

export async function markSetupDraftCompleted(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  completed: boolean,
): Promise<PropertySetupDraftRow | null> {
  return one<PropertySetupDraftRow>(
    em,
    `update "property_setup_draft"
        set "completed" = ?,
            "updated_at" = now()
      where "tenant_id" = ? and "property_id" = ?
      returning *`,
    [completed, tenantId, propertyId],
  );
}

export async function deleteSetupDraft(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<boolean> {
  const row = await one<{ id: string }>(
    em,
    `delete from "property_setup_draft"
      where "tenant_id" = ? and "property_id" = ?
      returning "id"`,
    [tenantId, propertyId],
  );
  return row !== null;
}

export async function readSetupLimits(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<PropertySetupLimitsRow | null> {
  return one<PropertySetupLimitsRow>(
    em,
    `select l."max_resources" as "max_resources",
            l."max_setup_units_inline" as "max_setup_units_inline",
            l."horizon_nights" as "horizon_nights",
            p."inventory_version" as "inventory_version"
       from "property" p
       join "property_limits_profile" l on l."id" = p."limits_profile_id"
      where p."id" = ? and p."tenant_id" = ?`,
    [propertyId, tenantId],
  );
}

export async function countPropertyResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<number> {
  const row = await one<{ count: string }>(
    em,
    `select count(*)::text as "count" from "resource"
      where "tenant_id" = ? and "property_id" = ? and "state" <> 'RETIRED'`,
    [tenantId, propertyId],
  );
  return Number(row?.count ?? 0);
}

export async function lockSetupDraftProperty(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<void> {
  await em.execute(
    `select "id" from "property" where "id" = ? and "tenant_id" = ? for update`,
    [propertyId, tenantId],
  );
}

export async function findLocationByCode(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  code: string,
): Promise<{ id: string } | null> {
  return one<{ id: string }>(
    em,
    `select "id" from "location"
      where "tenant_id" = ? and "property_id" = ? and "code" = ?`,
    [tenantId, propertyId, code],
  );
}

export async function listExistingResourceCodes(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  codes: string[],
): Promise<string[]> {
  if (codes.length === 0) return [];
  const found = await one<{ codes: string[] }>(
    em,
    `select coalesce(array_agg("code"), '{}') as "codes"
       from "resource"
      where "tenant_id" = ? and "property_id" = ? and "code" = any(string_to_array(?, ',')::varchar[])`,
    [tenantId, propertyId, codes.join(',')],
  );
  return found?.codes ?? [];
}

export async function listExistingProductCodes(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  codes: string[],
): Promise<string[]> {
  if (codes.length === 0) return [];
  const found = await one<{ codes: string[] }>(
    em,
    `select coalesce(array_agg("code"), '{}') as "codes"
       from "product"
      where "tenant_id" = ? and "property_id" = ? and "code" = any(string_to_array(?, ',')::varchar[])`,
    [tenantId, propertyId, codes.join(',')],
  );
  return found?.codes ?? [];
}

export async function listResourcesByCodes(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  codes: string[],
): Promise<ResourceRow[]> {
  if (codes.length === 0) return [];
  return rows<ResourceRow>(
    em,
    `select * from "resource"
      where "tenant_id" = ? and "property_id" = ?
        and "code" = any(string_to_array(?, ',')::varchar[])
      order by "code"`,
    [tenantId, propertyId, codes.join(',')],
  );
}

export async function listResourcesByCodePrefix(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  unitCode: string,
): Promise<ResourceRow[]> {
  return rows<ResourceRow>(
    em,
    `select * from "resource"
      where "tenant_id" = ? and "property_id" = ?
        and ("code" = ? or "code" like ?)
      order by "code"`,
    [tenantId, propertyId, unitCode, `${unitCode}-%`],
  );
}

export async function listAvailableResourceCodes(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceIds: readonly string[];
    arrival: string;
    departure: string;
  },
): Promise<string[]> {
  if (input.resourceIds.length === 0) return [];
  const found = await rows<{ code: string }>(
    em,
    `select r."code"
       from "resource" r
       left join "resource" p
         on p."id" = r."parent_resource_id"
        and p."tenant_id" = r."tenant_id"
        and p."property_id" = r."property_id"
      where r."tenant_id" = ? and r."property_id" = ?
        and r."id" = any(string_to_array(?, ',')::uuid[])
        and (
          case
            when p."id" is null then r."state"
            when p."state" <> 'ACTIVE' then p."state"
            else r."state"
          end
        ) = 'ACTIVE'
        and (
          case
            when p."id" is null then r."maintenance_state"
            when p."maintenance_state" <> 'NONE' then p."maintenance_state"
            else r."maintenance_state"
          end
        ) = 'NONE'
        and not exists (
          select 1 from "plan_allocation" a
           where a."resource_id" = r."id" and a."state" = 'ACTIVE'
             and daterange(a."start_date", a."end_date", '[)') && daterange(?::date, ?::date, '[)')
        )
        and not exists (
          select 1
            from "inventory_block_resource" br
            join "inventory_block" b
              on b."id" = br."block_id" and b."tenant_id" = br."tenant_id"
             and b."property_id" = br."property_id"
           where br."resource_id" = r."id" and b."state" = 'ACTIVE'
             and daterange(b."start_date", b."end_date", '[)') && daterange(?::date, ?::date, '[)')
        )
        and not exists (
          select 1 from "exposure_allocation" e
           where e."resource_id" = r."id" and e."state" = 'RESERVED'
             and daterange(e."start_date", e."end_date", '[)') && daterange(?::date, ?::date, '[)')
        )
      order by r."code"`,
    [
      input.tenantId,
      input.propertyId,
      input.resourceIds.join(','),
      input.arrival,
      input.departure,
      input.arrival,
      input.departure,
      input.arrival,
      input.departure,
    ] as never[],
  );
  return found.map((row) => row.code);
}

export async function listSetupConflicts(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceIds: readonly string[];
    arrival: string;
    departure: string;
  },
): Promise<Array<{ resource_id: string; kind: string }>> {
  if (input.resourceIds.length === 0) return [];
  return rows<{ resource_id: string; kind: string }>(
    em,
    `select a."resource_id", 'ALLOCATION' as "kind"
       from "plan_allocation" a
      where a."tenant_id" = ? and a."property_id" = ?
        and a."resource_id" = any(string_to_array(?, ',')::uuid[])
        and a."state" = 'ACTIVE'
        and daterange(a."start_date", a."end_date", '[)') && daterange(?::date, ?::date, '[)')
      union all
     select r."resource_id", 'BLOCK' as "kind"
       from "inventory_block_resource" r
       join "inventory_block" b
         on b."id" = r."block_id" and b."tenant_id" = r."tenant_id"
        and b."property_id" = r."property_id"
      where r."tenant_id" = ? and r."property_id" = ?
        and r."resource_id" = any(string_to_array(?, ',')::uuid[])
        and b."state" = 'ACTIVE'
        and daterange(b."start_date", b."end_date", '[)') && daterange(?::date, ?::date, '[)')
      union all
     select e."resource_id", 'EXPOSURE' as "kind"
       from "exposure_allocation" e
      where e."tenant_id" = ? and e."property_id" = ?
        and e."resource_id" = any(string_to_array(?, ',')::uuid[])
        and e."state" = 'RESERVED'
        and daterange(e."start_date", e."end_date", '[)') && daterange(?::date, ?::date, '[)')`,
    [
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
      input.tenantId,
      input.propertyId,
      input.resourceIds.join(','),
      input.arrival,
      input.departure,
    ] as never[],
  );
}
