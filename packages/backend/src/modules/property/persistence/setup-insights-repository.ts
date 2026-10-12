import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import type {
  CommitmentCoverageGapRow,
  CompositionSummaryRow,
  CompositionWindowRow,
  SetupChangeEventRow,
  SharedResourceRow,
} from './types.js';

export interface SetupCountsRow {
  locations: number;
  resources: number;
  resources_active: number;
  resources_retired: number;
  products: number;
  products_active: number;
  products_draft: number;
  compositions_active: number;
  compositions_draft: number;
}

export async function readSetupCounts(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<SetupCountsRow> {
  const row = await one<SetupCountsRow>(
    em,
    `select
       (select count(*)::int from "location"
         where "tenant_id" = ? and "property_id" = ?) as "locations",
       (select count(*)::int from "resource"
         where "tenant_id" = ? and "property_id" = ?) as "resources",
       (select count(*)::int from "resource"
         where "tenant_id" = ? and "property_id" = ?
           and "state" = 'ACTIVE') as "resources_active",
       (select count(*)::int from "resource"
         where "tenant_id" = ? and "property_id" = ?
           and "state" = 'RETIRED') as "resources_retired",
       (select count(*)::int from "product"
         where "tenant_id" = ? and "property_id" = ?) as "products",
       (select count(*)::int from "product"
         where "tenant_id" = ? and "property_id" = ?
           and "status" = 'ACTIVE') as "products_active",
       (select count(*)::int from "product"
         where "tenant_id" = ? and "property_id" = ?
           and "status" = 'DRAFT') as "products_draft",
       (select count(*)::int from "composition_version"
         where "tenant_id" = ? and "property_id" = ?
           and "status" = 'ACTIVE') as "compositions_active",
       (select count(*)::int from "composition_version"
         where "tenant_id" = ? and "property_id" = ?
           and "status" = 'DRAFT') as "compositions_draft"`,
    [
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
    ],
  );
  if (!row) throw new Error('Setup counts query returned no row');
  return row;
}

export async function listScheduledCompositionWindows(
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
        and v."effective_from" > current_date
      order by v."effective_from", p."code"`,
    [tenantId, propertyId],
  );
}

export async function listSetupChangeEvents(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    limit: number;
    cursor: { createdAt: string; id: string } | null;
  },
): Promise<SetupChangeEventRow[]> {
  return rows<SetupChangeEventRow>(
    em,
    `select a."id", a."property_id", a."actor_type", a."actor_id",
            a."actor_label", a."action", a."resource_type", a."resource_id",
            a."outcome", a."before_safe", a."after_safe", a."reason",
            a."correlation_id", a."created_at"
       from "audit_event" a
      where a."tenant_id" = ? and a."property_id" = ?
        and (a."action" like 'setup%' or a."action" like 'composition%')
        and (
          ?::timestamptz is null
          or (a."created_at", a."id") < (?::timestamptz, ?::uuid)
        )
      order by a."created_at" desc, a."id" desc
      limit ?`,
    [
      input.tenantId,
      input.propertyId,
      input.cursor?.createdAt ?? null,
      input.cursor?.createdAt ?? null,
      input.cursor?.id ?? null,
      input.limit,
    ],
  );
}

export async function listCompositionSummaryRows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<CompositionSummaryRow[]> {
  return rows<CompositionSummaryRow>(
    em,
    `select p."id" as "product_id", p."code" as "product_code",
            p."name" as "product_name", p."status",
            (select count(*)::int from "composition_version" v
              where v."tenant_id" = p."tenant_id"
                and v."property_id" = p."property_id"
                and v."product_id" = p."id"
                and v."status" = 'ACTIVE') as "active_versions",
            (select count(distinct l."resource_id")::int
               from "composition_leaf" l
               join "composition_version" v
                 on v."id" = l."version_id"
                and v."tenant_id" = l."tenant_id"
                and v."property_id" = l."property_id"
              where v."product_id" = p."id"
                and v."status" = 'ACTIVE') as "leaf_count",
            (select min(v."effective_from")::text
               from "composition_version" v
              where v."tenant_id" = p."tenant_id"
                and v."property_id" = p."property_id"
                and v."product_id" = p."id"
                and v."status" = 'ACTIVE') as "effective_from",
            (select max(coalesce(v."effective_to", 'infinity'::date))::text
               from "composition_version" v
              where v."tenant_id" = p."tenant_id"
                and v."property_id" = p."property_id"
                and v."product_id" = p."id"
                and v."status" = 'ACTIVE') as "effective_to"
       from "product" p
      where p."tenant_id" = ? and p."property_id" = ?
      order by p."code"`,
    [tenantId, propertyId],
  );
}

export async function listOverlappingActiveWindows(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<Array<{ product_id: string; product_code: string }>> {
  return rows(
    em,
    `select distinct a."product_id", p."code" as "product_code"
       from "composition_version" a
       join "composition_version" b
         on b."product_id" = a."product_id"
        and b."id" <> a."id"
        and b."status" = 'ACTIVE'
        and daterange(a."effective_from", coalesce(a."effective_to", 'infinity'::date), '[]')
         && daterange(b."effective_from", coalesce(b."effective_to", 'infinity'::date), '[]')
       join "product" p
         on p."id" = a."product_id"
        and p."tenant_id" = a."tenant_id"
        and p."property_id" = a."property_id"
      where a."tenant_id" = ? and a."property_id" = ?
        and a."status" = 'ACTIVE'
      order by p."code"`,
    [tenantId, propertyId],
  );
}

export async function listSharedActiveResources(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<SharedResourceRow[]> {
  return rows<SharedResourceRow>(
    em,
    `select l."resource_id", r."code" as "resource_code",
            count(distinct v."product_id")::int as "product_count",
            string_agg(distinct p."code", ',' order by p."code") as "product_codes"
       from "composition_leaf" l
       join "composition_version" v
         on v."id" = l."version_id"
        and v."tenant_id" = l."tenant_id"
        and v."property_id" = l."property_id"
       join "resource" r
         on r."id" = l."resource_id"
        and r."tenant_id" = l."tenant_id"
        and r."property_id" = l."property_id"
       join "product" p
         on p."id" = v."product_id"
        and p."tenant_id" = v."tenant_id"
        and p."property_id" = v."property_id"
      where l."tenant_id" = ? and l."property_id" = ?
        and v."status" = 'ACTIVE'
      group by l."resource_id", r."code"
      having count(distinct v."product_id") > 1
      order by r."code"
      limit 50`,
    [tenantId, propertyId],
  );
}

export async function listCommitmentCoverageGaps(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<CommitmentCoverageGapRow[]> {
  return rows<CommitmentCoverageGapRow>(
    em,
    `select c."id" as "commitment_id", c."source_kind",
            pa."resource_id", r."code" as "resource_code",
            coalesce(i."product_id", ga."product_id") as "product_id",
            p."code" as "product_code",
            pa."start_date", pa."end_date"
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
       join "product" p
         on p."id" = coalesce(i."product_id", ga."product_id")
        and p."tenant_id" = c."tenant_id"
        and p."property_id" = c."property_id"
      where pa."tenant_id" = ? and pa."property_id" = ?
        and pa."state" = 'ACTIVE' and c."state" = 'ACTIVE'
        and pa."start_date" > current_date
        and not exists (
          select 1 from "composition_version" v
           where v."tenant_id" = pa."tenant_id"
             and v."property_id" = pa."property_id"
             and v."product_id" = coalesce(i."product_id", ga."product_id")
             and v."status" = 'ACTIVE'
             and v."effective_from" <= pa."start_date"
             and (v."effective_to" is null or v."effective_to" >= pa."end_date")
        )
      order by pa."start_date", r."code"
      limit 50`,
    [tenantId, propertyId],
  );
}

export interface MigrationCountsRow {
  resources: number;
  future_commitments: number;
  active_compositions: number;
  product_active_versions: number;
}

export async function readMigrationCounts(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<MigrationCountsRow> {
  const row = await one<MigrationCountsRow>(
    em,
    `select
       (select count(*)::int from "resource"
         where "tenant_id" = ? and "property_id" = ?) as "resources",
       (select count(*)::int from "commitment" c
         where c."tenant_id" = ? and c."property_id" = ? and c."state" = 'ACTIVE'
           and (c."expires_at" is null or c."expires_at" > now())
           and exists (
             select 1 from "plan_allocation" pa
              where pa."commitment_id" = c."id"
                and pa."state" = 'ACTIVE'
                and pa."end_date" > current_date
           )) as "future_commitments",
       (select count(*)::int from "composition_version"
         where "tenant_id" = ? and "property_id" = ?
           and "status" = 'ACTIVE') as "active_compositions",
       (select count(*)::int from "composition_version"
         where "tenant_id" = ? and "property_id" = ? and "product_id" = ?
           and "status" = 'ACTIVE') as "product_active_versions"`,
    [
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      tenantId,
      propertyId,
      productId,
    ],
  );
  if (!row) throw new Error('Migration counts query returned no row');
  return row;
}

export async function countFutureActiveCommitments(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<number> {
  const row = await one<{ count: number }>(
    em,
    `select count(*)::int as "count" from "commitment" c
      where c."tenant_id" = ? and c."property_id" = ? and c."state" = 'ACTIVE'
        and (c."expires_at" is null or c."expires_at" > now())
        and exists (
          select 1 from "plan_allocation" pa
           where pa."commitment_id" = c."id"
             and pa."state" = 'ACTIVE'
             and pa."end_date" > current_date
        )`,
    [tenantId, propertyId],
  );
  return row?.count ?? 0;
}

export async function listResourceIds(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<string[]> {
  const result = await rows<{ id: string }>(
    em,
    `select "id" from "resource"
      where "tenant_id" = ? and "property_id" = ?
      order by "id"`,
    [tenantId, propertyId],
  );
  return result.map((row) => row.id);
}
