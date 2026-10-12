import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import type { LocationStatus } from '../domain/lifecycle.js';
import type { LocationRow, LocationKind } from './types.js';

export async function insertLocation(
  em: EntityManager,
  input: {
    id?: string;
    tenantId: string;
    propertyId: string;
    code: string;
    name: string;
    parent_id?: string | null;
    kind?: LocationKind | null;
    display_order?: number;
  },
): Promise<LocationRow> {
  const row = await one<LocationRow>(
    em,
    `insert into "location" ("id", "tenant_id", "property_id", "code", "name", "parent_id", "kind", "display_order")
     values (?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.propertyId,
      input.code,
      input.name,
      input.parent_id ?? null,
      input.kind ?? null,
      input.display_order ?? 0,
    ],
  );
  if (!row) throw new Error('Location insert returned no row');
  return row;
}

export async function findLocation(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  locationId: string,
): Promise<LocationRow | null> {
  return one<LocationRow>(
    em,
    `select * from "location"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [locationId, tenantId, propertyId],
  );
}

export async function listLocations(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<LocationRow[]> {
  return rows<LocationRow>(
    em,
    `select * from "location"
      where "tenant_id" = ? and "property_id" = ?
      order by "code"`,
    [tenantId, propertyId],
  );
}

export async function updateLocation(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    locationId: string;
    version: number;
    name?: string;
    parent_id?: string | null;
    kind?: LocationKind | null;
    display_order?: number;
    status?: LocationStatus;
  },
): Promise<LocationRow | null> {
  return one<LocationRow>(
    em,
    `update "location"
        set "name" = coalesce(?, "name"),
            "parent_id" = case when ? then ?::uuid else "parent_id" end,
            "kind" = case when ? then ?::text else "kind" end,
            "display_order" = coalesce(?, "display_order"),
            "status" = coalesce(?, "status"),
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ? and "version" = ?
      returning *`,
    [
      input.name ?? null,
      input.parent_id !== undefined,
      input.parent_id ?? null,
      input.kind !== undefined,
      input.kind ?? null,
      input.display_order ?? null,
      input.status ?? null,
      input.locationId,
      input.tenantId,
      input.propertyId,
      input.version,
    ],
  );
}

export async function locationExists(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  locationId: string,
): Promise<boolean> {
  const row = await one<{ id: string }>(
    em,
    `select "id" from "location"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [locationId, tenantId, propertyId],
  );
  return row !== null;
}
