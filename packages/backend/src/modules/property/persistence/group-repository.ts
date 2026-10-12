import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import type { PropertyGroupStatus } from '../domain/lifecycle.js';
import type { PropertyGroupRow } from './types.js';

export async function insertPropertyGroup(
  em: EntityManager,
  input: { id?: string; tenantId: string; code: string; name: string },
): Promise<PropertyGroupRow> {
  const row = await one<PropertyGroupRow>(
    em,
    `insert into "property_group" ("id", "tenant_id", "code", "name")
     values (?, ?, ?, ?)
     returning *`,
    [input.id ?? randomUUID(), input.tenantId, input.code, input.name],
  );
  if (!row) throw new Error('Property group insert returned no row');
  return row;
}

export async function findPropertyGroup(
  em: EntityManager,
  tenantId: string,
  groupId: string,
): Promise<PropertyGroupRow | null> {
  return one<PropertyGroupRow>(
    em,
    `select * from "property_group" where "id" = ? and "tenant_id" = ?`,
    [groupId, tenantId],
  );
}

export async function listPropertyGroups(
  em: EntityManager,
  tenantId: string,
): Promise<PropertyGroupRow[]> {
  return rows<PropertyGroupRow>(
    em,
    `select * from "property_group" where "tenant_id" = ? order by "code"`,
    [tenantId],
  );
}

export async function updatePropertyGroup(
  em: EntityManager,
  input: {
    tenantId: string;
    groupId: string;
    version: number;
    name?: string;
    status?: PropertyGroupStatus;
  },
): Promise<PropertyGroupRow | null> {
  return one<PropertyGroupRow>(
    em,
    `update "property_group"
        set "name" = coalesce(?, "name"),
            "status" = coalesce(?, "status"),
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "version" = ?
      returning *`,
    [
      input.name ?? null,
      input.status ?? null,
      input.groupId,
      input.tenantId,
      input.version,
    ],
  );
}
