import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { one, rows, toJson } from '../../../persistence/sql.js';
import type { Currency, MealPlan } from '../../property/domain/lifecycle.js';
import type { RatePlanStatus } from '../domain/rate-lifecycle.js';
import type {
  NightlyPriceRow,
  PriceQuoteRow,
  RatePlanRow,
  RatePolicyVersionRow,
} from './types.js';

export async function insertRatePlan(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    productId: string;
    code: string;
    name: string;
    currency: Currency;
    occupancyBasis: number;
    mealPlan: MealPlan;
    inclusions: string[];
    cancellationPolicy: Record<string, unknown>;
    freePolicy: boolean;
  },
): Promise<RatePlanRow> {
  const row = await one<RatePlanRow>(
    em,
    `insert into "rate_plan"
       ("id", "tenant_id", "property_id", "product_id", "code", "name",
        "currency", "occupancy_basis", "meal_plan", "inclusions",
        "cancellation_policy", "free_policy")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.productId,
      input.code,
      input.name,
      input.currency,
      input.occupancyBasis,
      input.mealPlan,
      toJson(input.inclusions),
      toJson(input.cancellationPolicy),
      input.freePolicy,
    ],
  );
  if (!row) throw new Error('Rate plan insert returned no row');
  return row;
}

export async function findRatePlan(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  ratePlanId: string,
): Promise<RatePlanRow | null> {
  return one<RatePlanRow>(
    em,
    `select * from "rate_plan"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [ratePlanId, tenantId, propertyId],
  );
}

export async function listRatePlans(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<RatePlanRow[]> {
  return rows<RatePlanRow>(
    em,
    `select * from "rate_plan"
      where "tenant_id" = ? and "property_id" = ?
      order by "code"`,
    [tenantId, propertyId],
  );
}

export async function updateRatePlan(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    ratePlanId: string;
    version: number;
    name?: string;
    occupancyBasis?: number;
    mealPlan?: MealPlan;
    inclusions?: string[];
    cancellationPolicy?: Record<string, unknown>;
    freePolicy?: boolean;
    status?: RatePlanStatus;
    policyChanged: boolean;
  },
): Promise<RatePlanRow | null> {
  return one<RatePlanRow>(
    em,
    `update "rate_plan"
        set "name" = case when ? then ? else "name" end,
            "occupancy_basis" = case when ? then ?::int else "occupancy_basis" end,
            "meal_plan" = case when ? then ?::varchar else "meal_plan" end,
            "inclusions" = case when ? then ?::jsonb else "inclusions" end,
            "cancellation_policy" = case when ? then ?::jsonb else "cancellation_policy" end,
            "free_policy" = case when ? then ?::boolean else "free_policy" end,
            "status" = case when ? then ?::varchar else "status" end,
            "policy_version" = "policy_version" + case when ? then 1 else 0 end,
            "version" = "version" + 1,
            "updated_at" = now()
      where "id" = ? and "tenant_id" = ? and "property_id" = ? and "version" = ?
      returning *`,
    [
      input.name !== undefined,
      input.name ?? null,
      input.occupancyBasis !== undefined,
      input.occupancyBasis ?? null,
      input.mealPlan !== undefined,
      input.mealPlan ?? null,
      input.inclusions !== undefined,
      input.inclusions === undefined ? null : toJson(input.inclusions),
      input.cancellationPolicy !== undefined,
      input.cancellationPolicy === undefined
        ? null
        : toJson(input.cancellationPolicy),
      input.freePolicy !== undefined,
      input.freePolicy ?? null,
      input.status !== undefined,
      input.status ?? null,
      input.policyChanged,
      input.ratePlanId,
      input.tenantId,
      input.propertyId,
      input.version,
    ] as never[],
  );
}

export async function insertPolicyVersion(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    ratePlanId: string;
    versionNumber: number;
    occupancyBasis: number;
    mealPlan: MealPlan;
    inclusions: string[];
    cancellationPolicy: Record<string, unknown>;
    freePolicy: boolean;
  },
): Promise<RatePolicyVersionRow> {
  const row = await one<RatePolicyVersionRow>(
    em,
    `insert into "rate_policy_version"
       ("id", "tenant_id", "property_id", "rate_plan_id", "version_number",
        "occupancy_basis", "meal_plan", "inclusions", "cancellation_policy",
        "free_policy")
     values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.ratePlanId,
      input.versionNumber,
      input.occupancyBasis,
      input.mealPlan,
      toJson(input.inclusions),
      toJson(input.cancellationPolicy),
      input.freePolicy,
    ],
  );
  if (!row) throw new Error('Rate policy insert returned no row');
  return row;
}

export async function findPolicyVersion(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  policyVersionId: string,
): Promise<RatePolicyVersionRow | null> {
  return one<RatePolicyVersionRow>(
    em,
    `select * from "rate_policy_version"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [policyVersionId, tenantId, propertyId],
  );
}

export async function findPolicyByNumber(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  ratePlanId: string,
  versionNumber: number,
): Promise<RatePolicyVersionRow | null> {
  return one<RatePolicyVersionRow>(
    em,
    `select * from "rate_policy_version"
      where "rate_plan_id" = ? and "version_number" = ?
        and "tenant_id" = ? and "property_id" = ?`,
    [ratePlanId, versionNumber, tenantId, propertyId],
  );
}

export async function findLimitsProfile(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<{
  max_resources: number;
  max_composition_depth: number;
  max_leaves_per_product: number;
  max_items_per_request: number;
  horizon_nights: number;
  max_stay_nights: number;
  search_budget_ms: number;
  lock_wait_ms: number;
} | null> {
  return one(
    em,
    `select l."max_resources", l."max_composition_depth", l."max_leaves_per_product",
            l."max_items_per_request", l."horizon_nights", l."max_stay_nights",
            l."search_budget_ms", l."lock_wait_ms"
       from "property" p
       join "property_limits_profile" l on l."id" = p."limits_profile_id"
      where p."id" = ? and p."tenant_id" = ?`,
    [propertyId, tenantId],
  );
}

export async function upsertNightlyPrice(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    ratePlanId: string;
    policyVersionId: string;
    stayDate: string;
    occupancy: number;
    amount: string;
    currency: Currency;
  },
): Promise<NightlyPriceRow> {
  const row = await one<NightlyPriceRow>(
    em,
    `insert into "nightly_price"
       ("id", "tenant_id", "property_id", "rate_plan_id", "policy_version_id",
        "stay_date", "occupancy", "amount", "currency")
     values (?, ?, ?, ?, ?, ?, ?, ?::numeric, ?)
     on conflict ("rate_plan_id", "stay_date", "occupancy")
     do update set
       "amount" = excluded."amount",
       "currency" = excluded."currency",
       "policy_version_id" = excluded."policy_version_id",
       "version" = "nightly_price"."version" + 1,
       "updated_at" = now()
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.ratePlanId,
      input.policyVersionId,
      input.stayDate,
      input.occupancy,
      input.amount,
      input.currency,
    ],
  );
  if (!row) throw new Error('Nightly price upsert returned no row');
  return row;
}

export async function listNightlyPrices(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  from: string,
  to: string,
): Promise<NightlyPriceRow[]> {
  return rows<NightlyPriceRow>(
    em,
    `select p.*
       from "nightly_price" p
      where p."tenant_id" = ? and p."property_id" = ?
        and p."stay_date" >= ? and p."stay_date" <= ?
      order by p."stay_date", p."rate_plan_id", p."occupancy"`,
    [tenantId, propertyId, from, to],
  );
}

export async function insertPriceQuote(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    ratePlanId: string;
    policyVersionId: string;
    productId: string;
    currency: Currency;
    startDate: string;
    endDate: string;
    quantity: number;
    adults: number;
    childAges: number[];
    totalAmount: string;
    cells: unknown;
    inventoryVersion: number;
    expiresAt: string | null;
  },
): Promise<PriceQuoteRow> {
  const row = await one<PriceQuoteRow>(
    em,
    `insert into "price_quote"
       ("id", "tenant_id", "property_id", "rate_plan_id", "policy_version_id",
        "product_id", "currency", "start_date", "end_date", "quantity",
        "adults", "child_ages", "total_amount", "cells", "inventory_version",
        "expires_at")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::numeric, ?::jsonb, ?, ?)
     returning *`,
    [
      randomUUID(),
      input.tenantId,
      input.propertyId,
      input.ratePlanId,
      input.policyVersionId,
      input.productId,
      input.currency,
      input.startDate,
      input.endDate,
      input.quantity,
      input.adults,
      toJson(input.childAges),
      input.totalAmount,
      toJson(input.cells),
      input.inventoryVersion,
      input.expiresAt,
    ],
  );
  if (!row) throw new Error('Price quote insert returned no row');
  return row;
}

export async function findPriceQuote(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  quoteId: string,
): Promise<PriceQuoteRow | null> {
  return one<PriceQuoteRow>(
    em,
    `select * from "price_quote"
      where "id" = ? and "tenant_id" = ? and "property_id" = ?`,
    [quoteId, tenantId, propertyId],
  );
}

export async function listQuotesForProduct(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
  productId: string,
): Promise<PriceQuoteRow[]> {
  return rows<PriceQuoteRow>(
    em,
    `select * from "price_quote"
      where "tenant_id" = ? and "property_id" = ? and "product_id" = ?
      order by "created_at" desc`,
    [tenantId, propertyId, productId],
  );
}
