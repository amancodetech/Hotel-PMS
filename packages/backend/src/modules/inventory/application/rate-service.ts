import type { MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { applyInventoryTimeouts } from './timeouts.js';
import { recordAudit } from '../../identity/application/audit-service.js';
import { auditActor, authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import {
  assertCode,
  assertIsoDate,
  assertName,
  assertPropertyConfigurable,
  isCurrency,
  isMealPlan,
} from '../../property/domain/lifecycle.js';
import type { Currency, MealPlan } from '../../property/domain/lifecycle.js';
import { findProduct } from '../../property/persistence/product-repository.js';
import {
  bumpPropertyInventoryVersion,
  lockProperty,
} from '../../property/persistence/property-repository.js';
import { translatePropertyWrite } from '../../property/persistence/db.js';
import { formatDecimal, parseDecimal } from '../domain/pricing.js';
import {
  assertInclusions,
  assertPolicyObject,
  assertRatePlanMutable,
  assertRatePlanTransition,
  isMealPlanValue,
  isRatePlanStatus,
  type RatePlanStatus,
} from '../domain/rate-lifecycle.js';
import * as repo from '../persistence/rate-repository.js';
import type { NightlyPriceRow, RatePlanRow } from '../persistence/types.js';

export interface RatePlanInput {
  code: string;
  name: string;
  productId: string;
  currency: Currency;
  occupancyBasis?: number;
  mealPlan?: MealPlan;
  inclusions?: string[];
  cancellationPolicy?: Record<string, unknown>;
  freePolicy?: boolean;
}

export interface RatePlanPatch {
  version: number;
  name?: string;
  occupancyBasis?: number;
  mealPlan?: MealPlan;
  inclusions?: string[];
  cancellationPolicy?: Record<string, unknown>;
  freePolicy?: boolean;
  status?: RatePlanStatus;
}

export interface RateCellInput {
  ratePlanId: string;
  date: string;
  occupancy: number;
  amount: string;
  currency: Currency;
}

function planAudit(plan: RatePlanRow): Record<string, unknown> {
  return {
    code: plan.code,
    name: plan.name,
    product_id: plan.product_id,
    currency: plan.currency,
    occupancy_basis: plan.occupancy_basis,
    meal_plan: plan.meal_plan,
    free_policy: plan.free_policy,
    status: plan.status,
    policy_version: plan.policy_version,
    version: plan.version,
  };
}

function normalizeInclusions(
  value: string[] | undefined,
): string[] | undefined {
  return value === undefined ? undefined : assertInclusions(value);
}

export async function readRatePlans(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
): Promise<RatePlanRow[]> {
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'rate.manage', propertyId);
      const plans = await repo.listRatePlans(em, context.tenantId, propertyId);
      return plans;
    },
  );
}

export async function createRatePlan(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: RatePlanInput,
): Promise<RatePlanRow> {
  const code = assertCode(input.code, 80);
  const name = assertName(input.name);
  if (!isCurrency(input.currency))
    throw new PropertyError('INVALID_REQUEST', { field: 'currency' });
  const occupancyBasis = input.occupancyBasis ?? 2;
  if (
    !Number.isInteger(occupancyBasis) ||
    occupancyBasis < 1 ||
    occupancyBasis > 100
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'occupancy_basis' });
  const mealPlan = input.mealPlan ?? 'NONE';
  if (!isMealPlan(mealPlan))
    throw new PropertyError('INVALID_REQUEST', { field: 'meal_plan' });
  const inclusions = normalizeInclusions(input.inclusions) ?? [];
  const cancellationPolicy = assertPolicyObject(
    input.cancellationPolicy ?? {},
    'cancellation_policy',
  );
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'rate.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const product = await findProduct(
        em,
        context.tenantId,
        propertyId,
        input.productId,
      );
      if (!product) throw new PropertyError('CROSS_SCOPE_REFERENCE');
      if (product.status === 'RETIRED')
        throw new PropertyError('INVALID_STATE_TRANSITION', {
          from: product.status,
          to: 'ACTIVE',
        });
      const plan = await translatePropertyWrite(() =>
        repo.insertRatePlan(em, {
          tenantId: context.tenantId,
          propertyId,
          productId: input.productId,
          code,
          name,
          currency: input.currency,
          occupancyBasis,
          mealPlan,
          inclusions,
          cancellationPolicy,
          freePolicy: input.freePolicy === true,
        }),
      );
      await repo.insertPolicyVersion(em, {
        tenantId: context.tenantId,
        propertyId,
        ratePlanId: plan.id,
        versionNumber: 1,
        occupancyBasis,
        mealPlan,
        inclusions,
        cancellationPolicy,
        freePolicy: input.freePolicy === true,
      });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'rate_plan.created',
        resourceType: 'RatePlan',
        resourceId: plan.id,
        outcome: 'SUCCESS',
        afterSafe: planAudit(plan),
        correlationId: context.correlationId,
      });
      return plan;
    },
  );
}

export async function updateRatePlanById(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  ratePlanId: string,
  patch: RatePlanPatch,
): Promise<RatePlanRow> {
  const name = patch.name === undefined ? undefined : assertName(patch.name);
  if (patch.occupancyBasis !== undefined) {
    if (
      !Number.isInteger(patch.occupancyBasis) ||
      patch.occupancyBasis < 1 ||
      patch.occupancyBasis > 100
    )
      throw new PropertyError('INVALID_REQUEST', { field: 'occupancy_basis' });
  }
  if (patch.mealPlan !== undefined && !isMealPlanValue(patch.mealPlan))
    throw new PropertyError('INVALID_REQUEST', { field: 'meal_plan' });
  if (patch.status !== undefined && !isRatePlanStatus(patch.status))
    throw new PropertyError('INVALID_REQUEST', { field: 'status' });
  if (!Number.isInteger(patch.version) || patch.version < 1)
    throw new PropertyError('INVALID_REQUEST', { field: 'version' });
  const inclusions = normalizeInclusions(patch.inclusions);
  const cancellationPolicy =
    patch.cancellationPolicy === undefined
      ? undefined
      : assertPolicyObject(patch.cancellationPolicy, 'cancellation_policy');
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'rate.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const current = await repo.findRatePlan(
        em,
        context.tenantId,
        propertyId,
        ratePlanId,
      );
      if (!current) throw new PropertyError('NOT_FOUND');
      assertRatePlanMutable(current.status);
      if (patch.status !== undefined)
        assertRatePlanTransition(current.status, patch.status);
      if (patch.status === 'ACTIVE') {
        const product = await findProduct(
          em,
          context.tenantId,
          propertyId,
          current.product_id,
        );
        if (!product || product.status !== 'ACTIVE')
          throw new PropertyError('PRODUCT_INCOMPLETE');
      }
      const policyChanged =
        (patch.occupancyBasis !== undefined &&
          patch.occupancyBasis !== current.occupancy_basis) ||
        (patch.mealPlan !== undefined &&
          patch.mealPlan !== current.meal_plan) ||
        (inclusions !== undefined &&
          JSON.stringify(inclusions) !== JSON.stringify(current.inclusions)) ||
        (cancellationPolicy !== undefined &&
          JSON.stringify(cancellationPolicy) !==
            JSON.stringify(current.cancellation_policy)) ||
        (patch.freePolicy !== undefined &&
          patch.freePolicy !== current.free_policy);
      const updated = await repo.updateRatePlan(em, {
        tenantId: context.tenantId,
        propertyId,
        ratePlanId,
        version: patch.version,
        name,
        occupancyBasis: patch.occupancyBasis,
        mealPlan: patch.mealPlan,
        inclusions,
        cancellationPolicy,
        freePolicy: patch.freePolicy,
        status: patch.status,
        policyChanged,
      });
      if (!updated) throw new PropertyError('STALE_VERSION');
      if (policyChanged)
        await repo.insertPolicyVersion(em, {
          tenantId: context.tenantId,
          propertyId,
          ratePlanId,
          versionNumber: updated.policy_version,
          occupancyBasis: updated.occupancy_basis,
          mealPlan: updated.meal_plan,
          inclusions: updated.inclusions,
          cancellationPolicy: updated.cancellation_policy,
          freePolicy: updated.free_policy,
        });
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'rate_plan.updated',
        resourceType: 'RatePlan',
        resourceId: ratePlanId,
        outcome: 'SUCCESS',
        beforeSafe: planAudit(current),
        afterSafe: planAudit(updated),
        correlationId: context.correlationId,
      });
      return updated;
    },
  );
}

export async function setRates(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  cells: RateCellInput[],
): Promise<{ updated: number; inventoryVersion: number }> {
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > 1000)
    throw new PropertyError('INVALID_REQUEST', { field: 'cells' });
  const parsed = cells.map((cell) => {
    assertIsoDate(cell.date, 'date');
    if (
      !Number.isInteger(cell.occupancy) ||
      cell.occupancy < 1 ||
      cell.occupancy > 100
    )
      throw new PropertyError('INVALID_REQUEST', { field: 'occupancy' });
    if (!isCurrency(cell.currency))
      throw new PropertyError('INVALID_REQUEST', { field: 'currency' });
    const amount = parseDecimal(cell.amount, 'amount');
    return { ...cell, amount };
  });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'rate.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      assertPropertyConfigurable(property.status);
      const plans = await repo.listRatePlans(em, context.tenantId, propertyId);
      const planById = new Map(plans.map((plan) => [plan.id, plan]));
      const limits = await repo.findLimitsProfile(
        em,
        context.tenantId,
        propertyId,
      );
      const todayRow = (await em.execute(
        `select current_date::text as today`,
      )) as Array<{
        today: string;
      }>;
      const today = todayRow[0]?.today;
      if (!today) throw new Error('Could not read database date');
      const horizon = limits?.horizon_nights ?? 365;
      for (const cell of parsed) {
        const plan = planById.get(cell.ratePlanId);
        if (!plan) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        assertRatePlanMutable(plan.status);
        if (cell.currency !== plan.currency)
          throw new PropertyError('INVALID_REQUEST', { field: 'currency' });
        if (cell.occupancy > plan.occupancy_basis)
          throw new PropertyError('INVALID_REQUEST', {
            field: 'occupancy',
            occupancy_basis: plan.occupancy_basis,
          });
        if (cell.amount === 0n && !plan.free_policy)
          throw new PropertyError('ZERO_PRICE_POLICY', {
            rate_plan_id: plan.id,
            date: cell.date,
          });
        if (cell.date < today)
          throw new PropertyError('INVALID_REQUEST', {
            field: 'date',
            today,
          });
        if (cell.date > addDays(today, horizon))
          throw new PropertyError('LIMIT_EXCEEDED', {
            field: 'date',
            horizon_nights: horizon,
          });
      }
      let updated = 0;
      for (const cell of parsed) {
        const plan = planById.get(cell.ratePlanId);
        if (!plan) throw new PropertyError('CROSS_SCOPE_REFERENCE');
        const policy = await repo.findPolicyByNumber(
          em,
          context.tenantId,
          propertyId,
          plan.id,
          plan.policy_version,
        );
        if (!policy) throw new Error('Rate plan policy snapshot missing');
        await translatePropertyWrite(() =>
          repo.upsertNightlyPrice(em, {
            tenantId: context.tenantId,
            propertyId,
            ratePlanId: plan.id,
            policyVersionId: policy.id,
            stayDate: cell.date,
            occupancy: cell.occupancy,
            amount: formatDecimal(cell.amount),
            currency: cell.currency,
          }),
        );
        updated += 1;
      }
      await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const versionRow = (await em.execute(
        `select "inventory_version" from "property" where "id" = ? and "tenant_id" = ?`,
        [propertyId, context.tenantId] as never[],
      )) as Array<{ inventory_version: number }>;
      const inventoryVersion = versionRow[0]?.inventory_version ?? 0;
      await recordAudit(em, {
        tenantId: context.tenantId,
        propertyId,
        ...auditActor(context),
        action: 'rates.updated',
        resourceType: 'NightlyPrice',
        resourceId: propertyId,
        outcome: 'SUCCESS',
        afterSafe: { cells: updated, inventory_version: inventoryVersion },
        correlationId: context.correlationId,
      });
      return { updated, inventoryVersion };
    },
  );
}

export async function readRateCalendar(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  from: string,
  to: string,
): Promise<{
  plans: RatePlanRow[];
  prices: NightlyPriceRow[];
  inventoryVersion: number;
}> {
  assertIsoDate(from, 'from');
  assertIsoDate(to, 'to');
  if (to <= from)
    throw new PropertyError('INVALID_REQUEST', { field: 'period' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'rate.manage', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const plans = await repo.listRatePlans(em, context.tenantId, propertyId);
      const prices = await repo.listNightlyPrices(
        em,
        context.tenantId,
        propertyId,
        from,
        to,
      );
      return { plans, prices, inventoryVersion: property.inventory_version };
    },
  );
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
