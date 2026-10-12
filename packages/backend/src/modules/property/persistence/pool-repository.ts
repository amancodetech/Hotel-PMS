import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import type { PoolStatus, ResourceKind } from '../domain/lifecycle.js';
import type { InventoryPoolRow, PoolMemberRow } from './types.js';

export async function insertPool(
  em: EntityManager,
  input: {
    id?: string;
    tenantId: string;
    propertyId: string;
    code: string;
    name: string;
    resourceType: ResourceKind;
  },
): Promise<InventoryPoolRow> {
  const row = await one<InventoryPoolRow>(
    em,
    `insert into "inventory_pool"
       ("id", "tenant_id", "property_id", "code", "name", "resource_type")
     values (?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.propertyId,
      input.code,
      input.name,
      input.resourceType,
    ],
  );
  if (!row) throw new Error('Pool insert returned no row');
  return row;
}

export async function findPool(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  poolId: string,
): Promise<InventoryPoolRow | null> {
  return one<InventoryPoolRow>(
    em,
    `select * from "inventory_pool"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [poolId, tenantId, propertyId],
  );
}

export async function listPools(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<InventoryPoolRow[]> {
  return rows<InventoryPoolRow>(
    em,
    `select * from "inventory_pool"
      where "tenant_id" = ? and "property_id" = ?
      order by "code"`,
    [tenantId, propertyId],
  );
}

export async function updatePool(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    poolId: string;
    version: number;
    name?: string;
    status?: PoolStatus;
  },
): Promise<InventoryPoolRow | null> {
  return one<InventoryPoolRow>(
    em,
    `update "inventory_pool"
        set "name" = coalesce(?, "name"),
            "status" = coalesce(?, "status"),
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ? and "version" = ?
      returning *`,
    [
      input.name ?? null,
      input.status ?? null,
      input.poolId,
      input.tenantId,
      input.propertyId,
      input.version,
    ],
  );
}

export async function listPoolMembers(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  poolId: string,
): Promise<PoolMemberRow[]> {
  return rows<PoolMemberRow>(
    em,
    `select * from "pool_member"
      where "pool_id" = ? and "tenant_id" = ? and "property_id" = ?
      order by "created_at", "resource_id"`,
    [poolId, tenantId, propertyId],
  );
}

export async function findPoolMember(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  poolId: string,
  resourceId: string,
): Promise<PoolMemberRow | null> {
  return one<PoolMemberRow>(
    em,
    `select * from "pool_member"
      where "pool_id" = ? and "resource_id" = ?
        and "tenant_id" = ? and "property_id" = ?`,
    [poolId, resourceId, tenantId, propertyId],
  );
}

export async function insertPoolMember(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    poolId: string;
    resourceId: string;
    resourceType: ResourceKind;
    effectiveFrom: string;
  },
): Promise<PoolMemberRow> {
  const row = await one<PoolMemberRow>(
    em,
    `insert into "pool_member"
       ("pool_id", "tenant_id", "property_id", "resource_type", "resource_id",
        "effective_from")
     values (?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.poolId,
      input.tenantId,
      input.propertyId,
      input.resourceType,
      input.resourceId,
      input.effectiveFrom,
    ],
  );
  if (!row) throw new Error('Pool member insert returned no row');
  return row;
}

export async function endPoolMember(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    poolId: string;
    resourceId: string;
    effectiveTo: string;
  },
): Promise<PoolMemberRow | null> {
  return one<PoolMemberRow>(
    em,
    `update "pool_member"
        set "effective_to" = ?::date,
            "updated_at" = now()
      where "pool_id" = ? and "resource_id" = ?
        and "tenant_id" = ? and "property_id" = ?
      returning *`,
    [
      input.effectiveTo,
      input.poolId,
      input.resourceId,
      input.tenantId,
      input.propertyId,
    ],
  );
}

export async function countActivePoolMembers(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  poolId: string,
): Promise<number> {
  const row = await one<{ count: number }>(
    em,
    `select count(*)::int as "count"
       from "pool_member" m
       join "resource" r
         on r."id" = m."resource_id"
        and r."tenant_id" = m."tenant_id"
        and r."property_id" = m."property_id"
      where m."pool_id" = ? and m."tenant_id" = ? and m."property_id" = ?
        and (m."effective_to" is null or m."effective_to" >= current_date)
        and r."state" <> 'RETIRED'`,
    [poolId, tenantId, propertyId],
  );
  return row?.count ?? 0;
}
