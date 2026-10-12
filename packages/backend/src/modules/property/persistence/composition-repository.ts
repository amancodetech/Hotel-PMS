import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import type { ResourceKind } from '../domain/lifecycle.js';
import type {
  CompositionEdgeRow,
  CompositionLeafRow,
  CompositionVersionRow,
  CompositionWindowRow,
  PropertyLimitsProfileRow,
  ResourceAllocationRow,
  ResourceBlockRow,
} from './types.js';

export async function findPropertyLimits(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<PropertyLimitsProfileRow | null> {
  return one<PropertyLimitsProfileRow>(
    em,
    `select l.*
       from "property" p
       join "property_limits_profile" l on l."id" = p."limits_profile_id"
      where p."id" = ? and p."tenant_id" = ?`,
    [propertyId, tenantId],
  );
}

export async function findCompositionVersion(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  versionId: string,
): Promise<CompositionVersionRow | null> {
  return one<CompositionVersionRow>(
    em,
    `select * from "composition_version"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [versionId, tenantId, propertyId],
  );
}

export async function listCompositionVersions(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<CompositionVersionRow[]> {
  return rows<CompositionVersionRow>(
    em,
    `select * from "composition_version"
      where "tenant_id" = ? and "property_id" = ?
      order by "product_id", "version_number"`,
    [tenantId, propertyId],
  );
}

export async function nextCompositionVersionNumber(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<number> {
  const row = await one<{ next: number }>(
    em,
    `select coalesce(max("version_number"), 0) + 1 as "next"
       from "composition_version"
      where "tenant_id" = ? and "property_id" = ? and "product_id" = ?`,
    [tenantId, propertyId, productId],
  );
  return row?.next ?? 1;
}

export async function insertCompositionVersion(
  em: EntityManager,
  input: {
    id?: string;
    tenantId: string;
    propertyId: string;
    productId: string;
    versionNumber: number;
    effectiveFrom: string;
    effectiveTo: string | null;
  },
): Promise<CompositionVersionRow> {
  const row = await one<CompositionVersionRow>(
    em,
    `insert into "composition_version"
       ("id", "tenant_id", "property_id", "product_id", "version_number",
        "effective_from", "effective_to")
     values (?, ?, ?, ?, ?, ?::date, ?::date)
     returning *`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.propertyId,
      input.productId,
      input.versionNumber,
      input.effectiveFrom,
      input.effectiveTo,
    ],
  );
  if (!row) throw new Error('Composition insert returned no row');
  return row;
}

export async function insertCompositionEdge(
  em: EntityManager,
  input: {
    versionId: string;
    tenantId: string;
    propertyId: string;
    position: number;
    childKind: 'RESOURCE' | 'COMPOSITION';
    resourceId: string | null;
    childVersionId: string | null;
  },
): Promise<CompositionEdgeRow> {
  const row = await one<CompositionEdgeRow>(
    em,
    `insert into "composition_edge"
       ("id", "version_id", "tenant_id", "property_id", "position",
        "child_kind", "resource_id", "child_version_id")
     values (?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.versionId,
      input.tenantId,
      input.propertyId,
      input.position,
      input.childKind,
      input.resourceId,
      input.childVersionId,
    ],
  );
  if (!row) throw new Error('Composition edge insert returned no row');
  return row;
}

export async function listCompositionEdges(
  em: EntityManager,
  versionId: string,
): Promise<CompositionEdgeRow[]> {
  return rows<CompositionEdgeRow>(
    em,
    `select * from "composition_edge"
      where "version_id" = ?
      order by "position"`,
    [versionId],
  );
}

export async function insertCompositionLeaf(
  em: EntityManager,
  input: {
    versionId: string;
    tenantId: string;
    propertyId: string;
    resourceId: string;
    depth: number;
  },
): Promise<void> {
  await em.execute(
    `insert into "composition_leaf"
       ("version_id", "tenant_id", "property_id", "resource_id", "depth")
     values (?, ?, ?, ?, ?)`,
    [
      input.versionId,
      input.tenantId,
      input.propertyId,
      input.resourceId,
      input.depth,
    ] as never[],
  );
}

export async function listCompositionLeaves(
  em: EntityManager,
  versionId: string,
): Promise<CompositionLeafRow[]> {
  return rows<CompositionLeafRow>(
    em,
    `select * from "composition_leaf"
      where "version_id" = ?
      order by "depth", "resource_id"`,
    [versionId],
  );
}

export async function listActiveCompositionLeafResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
  from: string,
  to: string,
): Promise<Array<{ id: string; code: string; resource_type: ResourceKind }>> {
  return rows<{ id: string; code: string; resource_type: ResourceKind }>(
    em,
    `select r."id", r."code", r."resource_type"
       from "composition_leaf" l
       join "composition_version" v
         on v."id" = l."version_id"
        and v."tenant_id" = l."tenant_id"
        and v."property_id" = l."property_id"
       join "resource" r
         on r."id" = l."resource_id"
        and r."tenant_id" = l."tenant_id"
        and r."property_id" = l."property_id"
      where l."tenant_id" = ? and l."property_id" = ?
        and v."product_id" = ?
        and v."status" = 'ACTIVE'
        and v."effective_from" <= ?::date
        and (v."effective_to" is null or v."effective_to" >= ?::date)
      order by r."code"`,
    [tenantId, propertyId, productId, from, to],
  );
}

export async function listActiveCompositionSiblings(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceId: string,
  from: string,
  to: string,
): Promise<
  Array<{
    product_id: string;
    resource_id: string;
    code: string;
    resource_type: ResourceKind;
  }>
> {
  return rows(
    em,
    `select distinct v."product_id", l2."resource_id", r."code", r."resource_type"
       from "composition_leaf" l
       join "composition_version" v
         on v."id" = l."version_id"
        and v."tenant_id" = l."tenant_id"
        and v."property_id" = l."property_id"
       join "composition_leaf" l2
         on l2."version_id" = l."version_id"
        and l2."tenant_id" = l."tenant_id"
        and l2."property_id" = l."property_id"
       join "resource" r
         on r."id" = l2."resource_id"
        and r."tenant_id" = l2."tenant_id"
        and r."property_id" = l2."property_id"
      where l."tenant_id" = ? and l."property_id" = ?
        and l."resource_id" = ?
        and v."status" = 'ACTIVE'
        and v."effective_from" <= ?::date
        and (v."effective_to" is null or v."effective_to" >= ?::date)
      order by r."code"`,
    [tenantId, propertyId, resourceId, from, to],
  );
}

export async function activateCompositionVersion(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    versionId: string;
    version: number;
  },
): Promise<CompositionVersionRow | null> {
  return one<CompositionVersionRow>(
    em,
    `update "composition_version"
        set "status" = 'ACTIVE',
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "version" = ? and "status" = 'DRAFT'
      returning *`,
    [input.versionId, input.tenantId, input.propertyId, input.version],
  );
}

export async function countActiveCompositionVersions(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<number> {
  const row = await one<{ count: number }>(
    em,
    `select count(*)::int as "count"
       from "composition_version"
      where "tenant_id" = ? and "property_id" = ? and "product_id" = ?
        and "status" = 'ACTIVE'`,
    [tenantId, propertyId, productId],
  );
  return row?.count ?? 0;
}

export async function resourceTypeOf(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  resourceId: string,
): Promise<ResourceKind | null> {
  const row = await one<{ resource_type: ResourceKind }>(
    em,
    `select "resource_type" from "resource"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [resourceId, tenantId, propertyId],
  );
  return row?.resource_type ?? null;
}

export async function findActiveCompositionVersion(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<CompositionVersionRow | null> {
  return one<CompositionVersionRow>(
    em,
    `select * from "composition_version"
      where "tenant_id" = ? and "property_id" = ? and "product_id" = ?
        and "status" = 'ACTIVE'
      order by "effective_from" desc, "version_number" desc
      limit 1`,
    [tenantId, propertyId, productId],
  );
}

export async function closeActiveCompositionVersion(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    versionId: string;
    effectiveTo: string;
  },
): Promise<CompositionVersionRow | null> {
  return one<CompositionVersionRow>(
    em,
    `update "composition_version"
        set "effective_to" = ?::date,
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "status" = 'ACTIVE'
      returning *`,
    [input.effectiveTo, input.versionId, input.tenantId, input.propertyId],
  );
}

export async function retireActiveCompositionVersion(
  em: EntityManager,
  input: { tenantId: string; propertyId: string; versionId: string },
): Promise<CompositionVersionRow | null> {
  return one<CompositionVersionRow>(
    em,
    `update "composition_version"
        set "status" = 'RETIRED',
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ?
        and "status" = 'ACTIVE'
      returning *`,
    [input.versionId, input.tenantId, input.propertyId],
  );
}

export async function listActiveCompositionWindows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<CompositionWindowRow[]> {
  return rows<CompositionWindowRow>(
    em,
    `select v."id", v."product_id", p."code" as "product_code",
            p."name" as "product_name", v."version_number",
            v."effective_from", v."effective_to", v."status"
       from "composition_version" v
       join "product" p
         on p."id" = v."product_id"
        and p."tenant_id" = v."tenant_id"
        and p."property_id" = v."property_id"
      where v."tenant_id" = ? and v."property_id" = ?
        and v."status" = 'ACTIVE'
      order by v."effective_from", p."code"`,
    [tenantId, propertyId],
  );
}

export async function listResourceAllocations(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceIds: string[];
    from: string;
    to: string;
  },
): Promise<ResourceAllocationRow[]> {
  if (input.resourceIds.length === 0) return [];
  return rows<ResourceAllocationRow>(
    em,
    `select c."id" as "commitment_id", c."source_kind",
            pa."resource_id", r."code" as "resource_code",
            pa."start_date", pa."end_date",
            case
              when c."source_kind" = 'ITEM' then i."product_id"
              when c."source_kind" = 'GROUP' then ga."product_id"
              else null
            end as "product_id",
            c."expires_at"
       from "plan_allocation" pa
       join "commitment" c
         on c."id" = pa."commitment_id"
        and c."tenant_id" = pa."tenant_id"
        and c."property_id" = pa."property_id"
       join "resource" r
         on r."id" = pa."resource_id"
        and r."tenant_id" = pa."tenant_id"
        and r."property_id" = pa."property_id"
       left join "reservation_item" i
         on c."source_kind" = 'ITEM'
        and i."id" = c."source_id"
        and i."tenant_id" = c."tenant_id"
        and i."property_id" = c."property_id"
       left join "reservation_group_allotment" ga
         on c."source_kind" = 'GROUP'
        and ga."commitment_id" = c."id"
        and ga."tenant_id" = c."tenant_id"
        and ga."property_id" = c."property_id"
      where pa."tenant_id" = ? and pa."property_id" = ?
        and pa."state" = 'ACTIVE' and c."state" = 'ACTIVE'
        and pa."resource_id" = any(string_to_array(?, ',')::uuid[])
        and pa."start_date" <= ?::date and pa."end_date" > ?::date
        and (c."source_kind" <> 'HOLD' or c."expires_at" > now())
      order by pa."resource_id", pa."start_date"`,
    [
      input.tenantId,
      input.propertyId,
      input.resourceIds.join(','),
      input.to,
      input.from,
    ],
  );
}

export async function listResourceBlocks(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    resourceIds: string[];
    from: string;
    to: string;
  },
): Promise<ResourceBlockRow[]> {
  if (input.resourceIds.length === 0) return [];
  return rows<ResourceBlockRow>(
    em,
    `select b."id" as "block_id", br."resource_id",
            r."code" as "resource_code", b."mode",
            b."start_date", b."end_date"
       from "inventory_block_resource" br
       join "inventory_block" b
         on b."id" = br."block_id"
        and b."tenant_id" = br."tenant_id"
        and b."property_id" = br."property_id"
       join "resource" r
         on r."id" = br."resource_id"
        and r."tenant_id" = br."tenant_id"
        and r."property_id" = br."property_id"
      where br."tenant_id" = ? and br."property_id" = ?
        and b."state" = 'ACTIVE'
        and br."resource_id" = any(string_to_array(?, ',')::uuid[])
        and b."start_date" <= ?::date and b."end_date" > ?::date
      order by br."resource_id", b."start_date"`,
    [
      input.tenantId,
      input.propertyId,
      input.resourceIds.join(','),
      input.to,
      input.from,
    ],
  );
}

export async function listActiveCompositionVersionsForProduct(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
  excludeVersionId: string | null,
): Promise<CompositionVersionRow[]> {
  return rows<CompositionVersionRow>(
    em,
    `select * from "composition_version"
      where "tenant_id" = ? and "property_id" = ? and "product_id" = ?
        and "status" = 'ACTIVE'
        and (?::uuid is null or "id" <> ?::uuid)
      order by "effective_from"`,
    [tenantId, propertyId, productId, excludeVersionId, excludeVersionId],
  );
}
