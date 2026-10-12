import type { EntityManager } from '@mikro-orm/postgresql';
import { rows } from '../../../persistence/sql.js';

export interface CandidateResourceRow {
  resource_id: string;
  source: 'CANDIDATE' | 'POOL' | 'COMPOSITION';
}

export interface SearchResourceRow {
  id: string;
  code: string;
  resource_type: string;
  capacity: number;
  state: string;
  maintenance_state: string;
}

export async function listCompositionCoverage(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
  arrival: string,
  departure: string,
): Promise<Array<{ version_id: string; resource_id: string }>> {
  return rows(
    em,
    `select l."version_id", l."resource_id"
       from "composition_leaf" l
       join "composition_version" v
         on v."id" = l."version_id"
        and v."tenant_id" = l."tenant_id"
        and v."property_id" = l."property_id"
      where l."tenant_id" = ? and l."property_id" = ?
        and v."product_id" = ?
        and v."status" = 'ACTIVE'
        and v."effective_from" <= ?::date
        and (v."effective_to" is null or v."effective_to" >= ?::date)
        and not exists (
          select 1 from "resource" child
           where child."parent_resource_id" = l."resource_id"
             and child."tenant_id" = l."tenant_id"
             and child."property_id" = l."property_id"
        )
      order by l."resource_id"`,
    [tenantId, propertyId, productId, arrival, departure],
  );
}

export async function countActiveCompositions(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<number> {
  const result = await rows<{ count: number }>(
    em,
    `select count(*)::int as "count"
       from "composition_version"
      where "tenant_id" = ? and "property_id" = ? and "product_id" = ?
        and "status" = 'ACTIVE'`,
    [tenantId, propertyId, productId],
  );
  return result[0]?.count ?? 0;
}

export async function listCandidateResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
  arrival: string,
  departure: string,
): Promise<CandidateResourceRow[]> {
  return rows<CandidateResourceRow>(
    em,
    `select c."resource_id", 'CANDIDATE' as "source"
       from "product_resource_candidate" c
      where c."tenant_id" = ? and c."property_id" = ? and c."product_id" = ?
      union all
     select m."resource_id", 'POOL' as "source"
       from "product" p
       join "pool_member" m
         on m."pool_id" = p."pool_id" and m."tenant_id" = p."tenant_id"
        and m."property_id" = p."property_id"
      where p."tenant_id" = ? and p."property_id" = ? and p."id" = ?
        and m."effective_from" <= ?::date
        and (m."effective_to" is null or m."effective_to" >= ?::date)
        and not exists (
          select 1 from "resource" child
           where child."parent_resource_id" = m."resource_id"
             and child."tenant_id" = m."tenant_id"
             and child."property_id" = m."property_id"
        )
      order by "resource_id"`,
    [
      tenantId,
      propertyId,
      productId,
      tenantId,
      propertyId,
      productId,
      arrival,
      departure,
    ] as never[],
  );
}

export async function listSearchResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceIds: readonly string[],
): Promise<SearchResourceRow[]> {
  return rows<SearchResourceRow>(
    em,
    `select r."id", r."code", r."resource_type", r."capacity",
            case
              when p."id" is null then r."state"
              when p."state" <> 'ACTIVE' then p."state"
              else r."state"
            end as "state",
            case
              when p."id" is null then r."maintenance_state"
              when p."maintenance_state" <> 'NONE' then p."maintenance_state"
              else r."maintenance_state"
            end as "maintenance_state"
       from "resource" r
       left join "resource" p
         on p."id" = r."parent_resource_id"
        and p."tenant_id" = r."tenant_id"
        and p."property_id" = r."property_id"
      where r."tenant_id" = ? and r."property_id" = ?
        and r."id" = any(string_to_array(?, ',')::uuid[])
      order by r."code", r."id"`,
    [tenantId, propertyId, resourceIds.join(',')] as never[],
  );
}

export async function findReadyResource(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceId: string,
): Promise<SearchResourceRow | null> {
  const result = await rows<SearchResourceRow>(
    em,
    `select r."id", r."code", r."resource_type", r."capacity",
            case
              when p."id" is null then r."state"
              when p."state" <> 'ACTIVE' then p."state"
              else r."state"
            end as "state",
            case
              when p."id" is null then r."maintenance_state"
              when p."maintenance_state" <> 'NONE' then p."maintenance_state"
              else r."maintenance_state"
            end as "maintenance_state"
       from "resource" r
       left join "resource" p
         on p."id" = r."parent_resource_id"
        and p."tenant_id" = r."tenant_id"
        and p."property_id" = r."property_id"
      where r."tenant_id" = ? and r."property_id" = ? and r."id" = ?`,
    [tenantId, propertyId, resourceId],
  );
  return result[0] ?? null;
}
