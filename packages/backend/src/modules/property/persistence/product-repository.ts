import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows } from '../../../persistence/sql.js';
import type {
  MealPlan,
  ProductStatus,
  ResourceKind,
} from '../domain/lifecycle.js';
import type { ProductCandidateRow, ProductRow } from './types.js';

export async function insertProduct(
  em: EntityManager,
  input: {
    id?: string;
    tenantId: string;
    propertyId: string;
    code: string;
    name: string;
    kind: ResourceKind;
    adultsMin: number;
    adultsMax: number;
    childrenMax: number;
    mealPlan: MealPlan;
    sharingScope?: 'MIXED' | 'FEMALE' | 'MALE' | null;
    setupUnitCode?: string | null;
  },
): Promise<ProductRow> {
  const row = await one<ProductRow>(
    em,
    `insert into "product"
       ("id", "tenant_id", "property_id", "code", "name", "kind",
        "occupancy_adults_min", "occupancy_adults_max", "occupancy_children_max",
        "meal_plan", "sharing_scope", "setup_unit_code")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning *`,
    [
      input.id ?? randomUUID(),
      input.tenantId,
      input.propertyId,
      input.code,
      input.name,
      input.kind,
      input.adultsMin,
      input.adultsMax,
      input.childrenMax,
      input.mealPlan,
      input.sharingScope ?? null,
      input.setupUnitCode ?? null,
    ],
  );
  if (!row) throw new Error('Product insert returned no row');
  return row;
}

export async function findProduct(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<ProductRow | null> {
  return one<ProductRow>(
    em,
    `select * from "product"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [productId, tenantId, propertyId],
  );
}

export async function findProductBySetupUnitCode(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  unitCode: string,
): Promise<ProductRow | null> {
  return one<ProductRow>(
    em,
    `select * from "product"
      where "setup_unit_code" = ? and "tenant_id" = ? and "property_id" = ?
      order by "code"
      limit 1`,
    [unitCode, tenantId, propertyId],
  );
}

export async function findProductByCode(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  code: string,
): Promise<ProductRow | null> {
  return one<ProductRow>(
    em,
    `select * from "product"
      where "code" = ? and "tenant_id" = ? and "property_id" = ?`,
    [code, tenantId, propertyId],
  );
}

export async function listProducts(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<ProductRow[]> {
  return rows<ProductRow>(
    em,
    `select * from "product"
      where "tenant_id" = ? and "property_id" = ?
      order by "code"`,
    [tenantId, propertyId],
  );
}

export async function updateProduct(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    productId: string;
    version: number;
    name?: string;
    adultsMin?: number;
    adultsMax?: number;
    childrenMax?: number;
    mealPlan?: MealPlan;
    poolId?: string | null;
    status?: ProductStatus;
  },
): Promise<ProductRow | null> {
  const hasPool = input.poolId !== undefined;
  return one<ProductRow>(
    em,
    `update "product"
        set "name" = coalesce(?, "name"),
            "occupancy_adults_min" = coalesce(?, "occupancy_adults_min"),
            "occupancy_adults_max" = coalesce(?, "occupancy_adults_max"),
            "occupancy_children_max" = coalesce(?, "occupancy_children_max"),
            "meal_plan" = coalesce(?, "meal_plan"),
            "pool_id" = case when ? then ?::uuid else "pool_id" end,
            "status" = coalesce(?, "status"),
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ? and "version" = ?
      returning *`,
    [
      input.name ?? null,
      input.adultsMin ?? null,
      input.adultsMax ?? null,
      input.childrenMax ?? null,
      input.mealPlan ?? null,
      hasPool,
      hasPool ? input.poolId : null,
      input.status ?? null,
      input.productId,
      input.tenantId,
      input.propertyId,
      input.version,
    ] as never[],
  );
}

export async function listProductCandidates(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<ProductCandidateRow[]> {
  return rows<ProductCandidateRow>(
    em,
    `select * from "product_resource_candidate"
      where "tenant_id" = ? and "property_id" = ? and "product_id" = ?
      order by "created_at", "resource_id"`,
    [tenantId, propertyId, productId],
  );
}

export async function insertProductCandidate(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    productId: string;
    resourceId: string;
    resourceType: ResourceKind;
  },
): Promise<ProductCandidateRow> {
  const row = await one<ProductCandidateRow>(
    em,
    `insert into "product_resource_candidate"
       ("product_id", "tenant_id", "property_id", "resource_type", "resource_id")
     values (?, ?, ?, ?, ?)
     returning *`,
    [
      input.productId,
      input.tenantId,
      input.propertyId,
      input.resourceType,
      input.resourceId,
    ],
  );
  if (!row) throw new Error('Product candidate insert returned no row');
  return row;
}

export async function deleteProductCandidate(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    productId: string;
    resourceId: string;
  },
): Promise<boolean> {
  const row = await one<{ product_id: string }>(
    em,
    `delete from "product_resource_candidate"
      where "product_id" = ? and "resource_id" = ?
        and "tenant_id" = ? and "property_id" = ?
      returning "product_id"`,
    [input.productId, input.resourceId, input.tenantId, input.propertyId],
  );
  return row !== null;
}

export async function countUsableCandidates(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<number> {
  const row = await one<{ count: number }>(
    em,
    `select count(*)::int as "count"
       from "product_resource_candidate" c
       join "resource" r
         on r."id" = c."resource_id"
        and r."tenant_id" = c."tenant_id"
        and r."property_id" = c."property_id"
      where c."tenant_id" = ? and c."property_id" = ? and c."product_id" = ?
        and r."state" <> 'RETIRED'`,
    [tenantId, propertyId, productId],
  );
  return row?.count ?? 0;
}
