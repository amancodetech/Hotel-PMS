import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import { PropertyError } from '../domain/errors.js';
import type {
  Currency,
  PropertyStatus,
  Timezone,
} from '../domain/lifecycle.js';
import type { PropertyRow, PropertyViewRow } from './types.js';

export async function insertProperty(
  em: EntityManager,
  input: {
    id?: string;
    tenantId: string;
    groupId: string | null;
    code: string;
    name: string;
    timezone: Timezone;
    baseCurrency: Currency;
  },
): Promise<PropertyViewRow> {
  const row = await one<PropertyRow>(
    em,
    `insert into "property"
       ("id", "tenant_id", "group_id", "code", "name", "timezone",
        "base_currency", "limits_profile_id")
     values (?, ?, ?, ?, ?, ?, ?,
        (select "id" from "property_limits_profile" where "code" = 'PERF-01'))
     returning *`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.groupId,
      input.code,
      input.name,
      input.timezone,
      input.baseCurrency,
    ],
  );
  if (!row) throw new Error('Property insert returned no row');
  const view = await findPropertyView(em, input.tenantId, row.id);
  if (!view) throw new Error('Property insert could not be re-read');
  return view;
}

export async function findPropertyView(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<PropertyViewRow | null> {
  return one<PropertyViewRow>(
    em,
    `select p.*, l."code" as "limits_profile_code"
       from "property" p
       join "property_limits_profile" l on l."id" = p."limits_profile_id"
      where p."id" = ? and p."tenant_id" = ?`,
    [propertyId, tenantId],
  );
}

export async function listPropertyViews(
  em: EntityManager,
  tenantId: string,
): Promise<PropertyViewRow[]> {
  return rows<PropertyViewRow>(
    em,
    `select p.*, l."code" as "limits_profile_code"
       from "property" p
       join "property_limits_profile" l on l."id" = p."limits_profile_id"
      where p."tenant_id" = ?
      order by p."code"`,
    [tenantId],
  );
}

export async function lockProperty(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<PropertyRow> {
  const row = await one<PropertyRow>(
    em,
    `select * from "property"
      where "id" = ? and "tenant_id" = ?
      for update`,
    [propertyId, tenantId],
  );
  if (!row) throw new PropertyError('NOT_FOUND');
  return row;
}

export async function updateProperty(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    version: number;
    name?: string;
    groupId?: string | null;
    status?: PropertyStatus;
  },
): Promise<PropertyRow | null> {
  const hasGroup = input.groupId !== undefined;
  return one<PropertyRow>(
    em,
    `update "property"
        set "name" = coalesce(?, "name"),
            "group_id" = case when ? then ?::uuid else "group_id" end,
            "status" = coalesce(?, "status"),
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "version" = ?
      returning *`,
    [
      input.name ?? null,
      hasGroup,
      hasGroup ? input.groupId : null,
      input.status ?? null,
      input.propertyId,
      input.tenantId,
      input.version,
    ] as never[],
  );
}

export async function updatePropertyCoreFromSetup(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    name: string;
    timezone: Timezone;
    baseCurrency: Currency;
  },
): Promise<PropertyRow | null> {
  return one<PropertyRow>(
    em,
    `update "property"
        set "name" = ?,
            "timezone" = ?,
            "base_currency" = ?,
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "status" = 'SETUP'
      returning *`,
    [
      input.name,
      input.timezone,
      input.baseCurrency,
      input.propertyId,
      input.tenantId,
    ] as never[],
  );
}

export async function bumpPropertyInventoryVersion(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<void> {
  await em.execute(
    `update "property"
        set "inventory_version" = "inventory_version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ?`,
    [propertyId, tenantId] as never[],
  );
}
