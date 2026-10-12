import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { runScopedTransaction } from '../../../persistence/tenant-context.js';
import { applyInventoryTimeouts } from './timeouts.js';
import { authorize } from '../../property/application/context.js';
import type { ServiceContext } from '../../property/application/context.js';
import { PropertyError } from '../../property/domain/errors.js';
import { assertIsoDate } from '../../property/domain/lifecycle.js';
import { findProduct } from '../../property/persistence/product-repository.js';
import {
  bumpPropertyInventoryVersion,
  lockProperty,
} from '../../property/persistence/property-repository.js';
import type { ProductRow } from '../../property/persistence/types.js';
import {
  expireDueHolds,
  listOccupancyConflicts,
} from '../persistence/guarantee-repository.js';
import type { OccupancyConflictRow } from '../persistence/guarantee-repository.js';
import {
  countActiveCompositions,
  listCandidateResources,
  listCompositionCoverage,
  listSearchResources,
} from '../persistence/availability-repository.js';
import { findLimitsProfile } from '../persistence/rate-repository.js';

export interface PeriodInput {
  arrival: string;
  departure: string;
}

export interface OccupancyInput {
  adults: number;
  childAges: number[];
}

export type OfferResult =
  'AVAILABLE' | 'UNAVAILABLE' | 'SPLIT_REQUIRED' | 'UNDETERMINED';

export interface Offer {
  productId: string;
  result: OfferResult;
  reasonCodes: string[];
}

export interface ResolvedUnit {
  productId: string;
  resources: Array<{ resourceId: string; code: string }>;
}

export interface ResolvedProduct {
  result: OfferResult;
  reasonCodes: string[];
  units: ResolvedUnit[];
}

export interface SearchBudget {
  deadline: number;
}

export async function searchBudgetForProperty(
  em: EntityManager,
  tenantId: string,
  propertyId: string,
): Promise<SearchBudget> {
  const limits = await findLimitsProfile(em, tenantId, propertyId);
  return { deadline: Date.now() + (limits?.search_budget_ms ?? 500) };
}

function assertOccupancy(occupancy: OccupancyInput): void {
  if (
    !Number.isInteger(occupancy.adults) ||
    occupancy.adults < 0 ||
    occupancy.adults > 100 ||
    !Array.isArray(occupancy.childAges) ||
    occupancy.childAges.length > 100 ||
    occupancy.childAges.some(
      (age) => !Number.isInteger(age) || age < 0 || age > 17,
    )
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'occupancy' });
}

function assertPeriod(period: PeriodInput): void {
  assertIsoDate(period.arrival, 'period.arrival');
  assertIsoDate(period.departure, 'period.departure');
  if (period.departure <= period.arrival)
    throw new PropertyError('INVALID_REQUEST', { field: 'period' });
}

function nights(period: PeriodInput): number {
  const arrival = Date.parse(`${period.arrival}T00:00:00Z`);
  const departure = Date.parse(`${period.departure}T00:00:00Z`);
  return Math.round((departure - arrival) / 86_400_000);
}

function budgetExceeded(budget: SearchBudget): boolean {
  return Date.now() > budget.deadline;
}

function conflictReasons(conflicts: readonly OccupancyConflictRow[]): string[] {
  const reasons = new Set<string>();
  for (const conflict of conflicts) {
    if (conflict.kind === 'EXPOSURE') reasons.add('EXPOSURE_PROTECTED');
    else if (conflict.kind === 'BLOCK') reasons.add('BLOCKED');
    else reasons.add('COMMITTED');
  }
  return [...reasons];
}

export async function resolveAvailabilityForProduct(
  em: EntityManager,
  input: {
    tenantId: string;
    propertyId: string;
    product: ProductRow;
    period: PeriodInput;
    occupancy: OccupancyInput;
    quantity: number;
    budget: SearchBudget;
  },
): Promise<ResolvedProduct> {
  const { product } = input;
  if (product.status !== 'ACTIVE')
    return {
      result: 'UNAVAILABLE',
      reasonCodes: ['PRODUCT_INACTIVE'],
      units: [],
    };
  // SET-07.6: restricted FEMALE/MALE sharing scopes are enforced where the
  // guests are known (reservation draft/confirm and check-in), not during the
  // guest-less availability search.
  const totalPersons =
    input.occupancy.adults + input.occupancy.childAges.length;
  if (
    input.occupancy.adults < product.occupancy_adults_min ||
    input.occupancy.adults > product.occupancy_adults_max ||
    input.occupancy.childAges.length > product.occupancy_children_max
  )
    return {
      result: 'UNAVAILABLE',
      reasonCodes: ['OCCUPANCY_UNSUPPORTED'],
      units: [],
    };

  const compositionCount = await countActiveCompositions(
    em,
    input.tenantId,
    input.propertyId,
    product.id,
  );
  let resourceIds: string[];
  let compositionLeafIds: string[] | null = null;
  if (compositionCount > 0) {
    const coverage = await listCompositionCoverage(
      em,
      input.tenantId,
      input.propertyId,
      product.id,
      input.period.arrival,
      input.period.departure,
    );
    if (coverage.length > 0) {
      compositionLeafIds = [
        ...new Set(coverage.map((row) => row.resource_id)),
      ].sort();
    }
  }
  if (compositionLeafIds) resourceIds = compositionLeafIds;
  else {
    const candidates = await listCandidateResources(
      em,
      input.tenantId,
      input.propertyId,
      product.id,
      input.period.arrival,
      input.period.departure,
    );
    resourceIds = [...new Set(candidates.map((row) => row.resource_id))].sort();
  }
  if (resourceIds.length === 0)
    return { result: 'UNAVAILABLE', reasonCodes: ['NO_RESOURCE'], units: [] };
  if (budgetExceeded(input.budget))
    return {
      result: 'UNDETERMINED',
      reasonCodes: ['BUDGET_EXCEEDED'],
      units: [],
    };

  const resources = await listSearchResources(
    em,
    input.tenantId,
    input.propertyId,
    resourceIds,
  );
  const active = resources.filter((resource) => resource.state === 'ACTIVE');
  if (active.length === 0)
    return {
      result: 'UNAVAILABLE',
      reasonCodes: resources.some((row) => row.maintenance_state !== 'NONE')
        ? ['MAINTENANCE']
        : ['RESOURCE_INACTIVE'],
      units: [],
    };
  const serviceable = active.filter(
    (resource) => resource.maintenance_state === 'NONE',
  );
  if (serviceable.length === 0)
    return { result: 'UNAVAILABLE', reasonCodes: ['MAINTENANCE'], units: [] };
  const capacious =
    compositionLeafIds === null
      ? serviceable.filter((resource) => resource.capacity >= totalPersons)
      : serviceable;
  if (compositionLeafIds === null && capacious.length === 0)
    return { result: 'UNAVAILABLE', reasonCodes: ['CAPACITY'], units: [] };
  if (budgetExceeded(input.budget))
    return {
      result: 'UNDETERMINED',
      reasonCodes: ['BUDGET_EXCEEDED'],
      units: [],
    };

  const conflicts = await listOccupancyConflicts(em, {
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    resourceIds: capacious.map((resource) => resource.id),
    arrival: input.period.arrival,
    departure: input.period.departure,
  });
  if (budgetExceeded(input.budget))
    return {
      result: 'UNDETERMINED',
      reasonCodes: ['BUDGET_EXCEEDED'],
      units: [],
    };
  const conflicted = new Set(conflicts.map((row) => row.resource_id));
  const available = capacious.filter(
    (resource) => !conflicted.has(resource.id),
  );
  const conflictCodes = conflictReasons(conflicts);

  if (compositionLeafIds) {
    if (input.quantity > 1)
      return {
        result: 'UNAVAILABLE',
        reasonCodes: ['QUANTITY_UNSUPPORTED', ...conflictCodes],
        units: [],
      };
    if (available.length < compositionLeafIds.length)
      return {
        result: 'UNAVAILABLE',
        reasonCodes:
          conflictCodes.length > 0 ? conflictCodes : ['RESOURCE_UNAVAILABLE'],
        units: [],
      };
    return {
      result: 'AVAILABLE',
      reasonCodes: [],
      units: [
        {
          productId: product.id,
          resources: available.map((resource) => ({
            resourceId: resource.id,
            code: resource.code,
          })),
        },
      ],
    };
  }

  if (available.length < input.quantity)
    return {
      result: 'UNAVAILABLE',
      reasonCodes:
        conflictCodes.length > 0
          ? [...conflictCodes, 'INSUFFICIENT']
          : ['INSUFFICIENT'],
      units: [],
    };
  const chosen = available.slice(0, input.quantity);
  return {
    result: 'AVAILABLE',
    reasonCodes: [],
    units: chosen.map((resource) => ({
      productId: product.id,
      resources: [{ resourceId: resource.id, code: resource.code }],
    })),
  };
}

export async function searchAvailability(
  orm: MikroORM,
  context: ServiceContext,
  propertyId: string,
  input: {
    productIds: string[];
    period: PeriodInput;
    occupancy: OccupancyInput;
    quantity: number;
  },
): Promise<{ inventoryVersion: number; offers: Offer[] }> {
  if (!Array.isArray(input.productIds) || input.productIds.length === 0)
    throw new PropertyError('INVALID_REQUEST', { field: 'product_ids' });
  const uniqueProducts = [...new Set(input.productIds)];
  if (uniqueProducts.length !== input.productIds.length)
    throw new PropertyError('INVALID_REQUEST', { field: 'product_ids' });
  assertPeriod(input.period);
  assertOccupancy(input.occupancy);
  if (
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 20
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'quantity' });
  return runScopedTransaction(
    orm,
    { tenantId: context.tenantId, userId: context.actor.userId },
    async (em) => {
      await applyInventoryTimeouts(em);
      await authorize(em, context, 'reservation.read', propertyId);
      const property = await lockProperty(em, context.tenantId, propertyId);
      const expired = await expireDueHolds(em, context.tenantId, propertyId);
      if (expired > 0)
        await bumpPropertyInventoryVersion(em, context.tenantId, propertyId);
      const inventoryVersion =
        property.inventory_version + (expired > 0 ? 1 : 0);
      const limits = await findLimitsProfile(em, context.tenantId, propertyId);
      const maxItems = limits?.max_items_per_request ?? 20;
      if (uniqueProducts.length > maxItems)
        throw new PropertyError('LIMIT_EXCEEDED', {
          field: 'product_ids',
          max_items_per_request: maxItems,
        });
      const stayNights = nights(input.period);
      const maxStay = limits?.max_stay_nights ?? 365;
      const horizon = limits?.horizon_nights ?? 365;
      if (stayNights > maxStay)
        throw new PropertyError('LIMIT_EXCEEDED', {
          field: 'period',
          max_stay_nights: maxStay,
        });
      const today = new Date().toISOString().slice(0, 10);
      const horizonDate = new Date();
      horizonDate.setUTCDate(horizonDate.getUTCDate() + horizon);
      if (input.period.arrival < today)
        throw new PropertyError('INVALID_REQUEST', {
          field: 'period',
          today,
        });
      if (input.period.departure > horizonDate.toISOString().slice(0, 10))
        throw new PropertyError('LIMIT_EXCEEDED', {
          field: 'period',
          horizon_nights: horizon,
        });
      const budget: SearchBudget = {
        deadline: Date.now() + (limits?.search_budget_ms ?? 500),
      };
      const offers: Offer[] = [];
      for (const productId of uniqueProducts) {
        if (budgetExceeded(budget)) {
          offers.push({
            productId,
            result: 'UNDETERMINED',
            reasonCodes: ['BUDGET_EXCEEDED'],
          });
          continue;
        }
        const product = await findProduct(
          em,
          context.tenantId,
          propertyId,
          productId,
        );
        if (!product) {
          offers.push({
            productId,
            result: 'UNAVAILABLE',
            reasonCodes: ['PRODUCT_NOT_FOUND'],
          });
          continue;
        }
        const resolved = await resolveAvailabilityForProduct(em, {
          tenantId: context.tenantId,
          propertyId,
          product,
          period: input.period,
          occupancy: input.occupancy,
          quantity: input.quantity,
          budget,
        });
        offers.push({
          productId,
          result: resolved.result,
          reasonCodes: resolved.reasonCodes,
        });
      }
      return { inventoryVersion, offers };
    },
  );
}
