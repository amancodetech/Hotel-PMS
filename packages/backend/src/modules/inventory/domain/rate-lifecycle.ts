import { PropertyError } from '../../property/domain/errors.js';
import { mealPlans, type MealPlan } from '../../property/domain/lifecycle.js';

export const ratePlanStatuses = [
  'DRAFT',
  'ACTIVE',
  'SUSPENDED',
  'RETIRED',
] as const;
export type RatePlanStatus = (typeof ratePlanStatuses)[number];

const transitions: Record<RatePlanStatus, readonly RatePlanStatus[]> = {
  DRAFT: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['SUSPENDED', 'RETIRED'],
  SUSPENDED: ['ACTIVE', 'RETIRED'],
  RETIRED: [],
};

export function isRatePlanStatus(value: string): value is RatePlanStatus {
  return (ratePlanStatuses as readonly string[]).includes(value);
}

export function assertRatePlanTransition(
  from: RatePlanStatus,
  to: RatePlanStatus,
): void {
  if (from === to) return;
  if (!transitions[from].includes(to))
    throw new PropertyError('INVALID_STATE_TRANSITION', { from, to });
}

export function assertRatePlanMutable(status: RatePlanStatus): void {
  if (status === 'RETIRED')
    throw new PropertyError('INVALID_STATE_TRANSITION', {
      from: status,
      to: 'RETIRED',
    });
}

export function isMealPlanValue(value: string): value is MealPlan {
  return (mealPlans as readonly string[]).includes(value);
}

export function assertInclusions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20)
    throw new PropertyError('INVALID_REQUEST', { field: 'inclusions' });
  const result: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      entry.trim().length === 0 ||
      entry.length > 120
    )
      throw new PropertyError('INVALID_REQUEST', { field: 'inclusions' });
    result.push(entry);
  }
  return result;
}

export function assertPolicyObject(
  value: unknown,
  field: string,
  maxKeys = 20,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > maxKeys
  )
    throw new PropertyError('INVALID_REQUEST', { field });
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    )
      result[key] = entry;
    else throw new PropertyError('INVALID_REQUEST', { field });
  }
  return result;
}
