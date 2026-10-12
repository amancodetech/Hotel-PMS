import { PropertyError } from './errors.js';

export const timezones = [
  'Asia/Jakarta',
  'Asia/Makassar',
  'Asia/Jayapura',
] as const;
export type Timezone = (typeof timezones)[number];

export const currencies = ['IDR', 'USD'] as const;
export type Currency = (typeof currencies)[number];

export const resourceKinds = [
  'ROOM',
  'BED',
  'VILLA',
  'APARTMENT',
  'HOUSE',
  'SITE',
  'TENT',
  'CABIN',
] as const;
export type ResourceKind = (typeof resourceKinds)[number];

export type PropertyStatus = 'SETUP' | 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export type PropertyGroupStatus = 'ACTIVE' | 'ARCHIVED';
export type LocationStatus = 'ACTIVE' | 'INACTIVE';
export type ResourceState = 'ACTIVE' | 'INACTIVE' | 'RETIRED';
export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
export type PoolStatus = 'ACTIVE' | 'INACTIVE';
export const mealPlans = ['NONE', 'BREAKFAST'] as const;
export type MealPlan = (typeof mealPlans)[number];
export type CompositionStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';
export const housekeepingStates = [
  'CLEAN',
  'DIRTY',
  'CLEANING',
  'INSPECTED',
] as const;
export type HousekeepingState = (typeof housekeepingStates)[number];
export const maintenanceStates = ['NONE', 'OOO', 'OOS'] as const;
export type MaintenanceState = (typeof maintenanceStates)[number];

const propertyTransitions: Record<PropertyStatus, readonly PropertyStatus[]> = {
  SETUP: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['SUSPENDED', 'ARCHIVED'],
  SUSPENDED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

const groupTransitions: Record<
  PropertyGroupStatus,
  readonly PropertyGroupStatus[]
> = {
  ACTIVE: ['ARCHIVED'],
  ARCHIVED: [],
};

const locationTransitions: Record<LocationStatus, readonly LocationStatus[]> = {
  ACTIVE: ['INACTIVE'],
  INACTIVE: ['ACTIVE'],
};

const resourceTransitions: Record<ResourceState, readonly ResourceState[]> = {
  ACTIVE: ['INACTIVE', 'RETIRED'],
  INACTIVE: ['ACTIVE', 'RETIRED'],
  RETIRED: [],
};

const productTransitions: Record<ProductStatus, readonly ProductStatus[]> = {
  DRAFT: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['SUSPENDED', 'RETIRED'],
  SUSPENDED: ['ACTIVE', 'RETIRED'],
  RETIRED: [],
};

const poolTransitions: Record<PoolStatus, readonly PoolStatus[]> = {
  ACTIVE: ['INACTIVE'],
  INACTIVE: ['ACTIVE'],
};

const compositionTransitions: Record<
  CompositionStatus,
  readonly CompositionStatus[]
> = {
  DRAFT: ['ACTIVE', 'RETIRED'],
  ACTIVE: ['RETIRED'],
  RETIRED: [],
};

export function isTimezone(value: string): value is Timezone {
  return (timezones as readonly string[]).includes(value);
}

export function isCurrency(value: string): value is Currency {
  return (currencies as readonly string[]).includes(value);
}

export function isResourceKind(value: string): value is ResourceKind {
  return (resourceKinds as readonly string[]).includes(value);
}

export function isPropertyStatus(value: string): value is PropertyStatus {
  return ['SETUP', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(value);
}

export function isPropertyGroupStatus(
  value: string,
): value is PropertyGroupStatus {
  return value === 'ACTIVE' || value === 'ARCHIVED';
}

export function isLocationStatus(value: string): value is LocationStatus {
  return value === 'ACTIVE' || value === 'INACTIVE';
}

export function isResourceState(value: string): value is ResourceState {
  return value === 'ACTIVE' || value === 'INACTIVE' || value === 'RETIRED';
}

export function assertPropertyTransition(
  from: PropertyStatus,
  to: PropertyStatus,
): void {
  if (from === to) return;
  if (!propertyTransitions[from].includes(to))
    throw new PropertyError('INVALID_STATE_TRANSITION', { from, to });
}

export function assertGroupTransition(
  from: PropertyGroupStatus,
  to: PropertyGroupStatus,
): void {
  if (from === to) return;
  if (!groupTransitions[from].includes(to))
    throw new PropertyError('INVALID_STATE_TRANSITION', { from, to });
}

export function assertLocationTransition(
  from: LocationStatus,
  to: LocationStatus,
): void {
  if (from === to) return;
  if (!locationTransitions[from].includes(to))
    throw new PropertyError('INVALID_STATE_TRANSITION', { from, to });
}

export function assertResourceTransition(
  from: ResourceState,
  to: ResourceState,
): void {
  if (from === to) return;
  if (!resourceTransitions[from].includes(to))
    throw new PropertyError('INVALID_STATE_TRANSITION', { from, to });
}

export function isProductStatus(value: string): value is ProductStatus {
  return (
    value === 'DRAFT' ||
    value === 'ACTIVE' ||
    value === 'SUSPENDED' ||
    value === 'RETIRED'
  );
}

export function isPoolStatus(value: string): value is PoolStatus {
  return value === 'ACTIVE' || value === 'INACTIVE';
}

export function isMealPlan(value: string): value is MealPlan {
  return (mealPlans as readonly string[]).includes(value);
}

export function assertProductTransition(
  from: ProductStatus,
  to: ProductStatus,
): void {
  if (from === to) return;
  if (!productTransitions[from].includes(to))
    throw new PropertyError('INVALID_STATE_TRANSITION', { from, to });
}

export function assertProductMutable(status: ProductStatus): void {
  if (status === 'RETIRED')
    throw new PropertyError('INVALID_STATE_TRANSITION', {
      from: status,
      to: 'RETIRED',
    });
}

export function assertPoolTransition(from: PoolStatus, to: PoolStatus): void {
  if (from === to) return;
  if (!poolTransitions[from].includes(to))
    throw new PropertyError('INVALID_STATE_TRANSITION', { from, to });
}

export function assertOccupancy(input: {
  adultsMin: number;
  adultsMax: number;
  childrenMax: number;
}): void {
  const valid =
    Number.isInteger(input.adultsMin) &&
    Number.isInteger(input.adultsMax) &&
    Number.isInteger(input.childrenMax) &&
    input.adultsMin >= 0 &&
    input.adultsMax <= 100 &&
    input.childrenMax >= 0 &&
    input.childrenMax <= 100 &&
    input.adultsMin <= input.adultsMax;
  if (!valid)
    throw new PropertyError('INVALID_REQUEST', { field: 'occupancy' });
}

export function assertIsoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new PropertyError('INVALID_REQUEST', { field });
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()))
    throw new PropertyError('INVALID_REQUEST', { field });
  return value;
}

export function isCompositionStatus(value: string): value is CompositionStatus {
  return value === 'DRAFT' || value === 'ACTIVE' || value === 'RETIRED';
}

export function assertCompositionTransition(
  from: CompositionStatus,
  to: CompositionStatus,
): void {
  if (from === to) return;
  if (!compositionTransitions[from].includes(to))
    throw new PropertyError('INVALID_STATE_TRANSITION', { from, to });
}

export function assertPeriod(
  from: string,
  to: string | null,
  field = 'effective_period',
): void {
  assertIsoDate(from, `${field}.arrival`);
  if (to !== null) {
    assertIsoDate(to, `${field}.departure`);
    if (to <= from) throw new PropertyError('INVALID_REQUEST', { field });
  }
}

export function periodWithin(
  child: { from: string; to: string | null },
  parent: { from: string; to: string | null },
): boolean {
  if (child.from < parent.from) return false;
  if (parent.to === null) return true;
  return child.to !== null && child.to <= parent.to;
}

export function assertPropertyConfigurable(status: PropertyStatus): void {
  if (status === 'ARCHIVED') throw new PropertyError('PROPERTY_ARCHIVED');
}

export function assertResourceMutable(state: ResourceState): void {
  if (state === 'RETIRED') throw new PropertyError('RESOURCE_RETIRED');
}

export function assertCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100)
    throw new PropertyError('INVALID_REQUEST', { field: 'capacity' });
}

export function assertCode(code: string, maxLength = 40): string {
  const trimmed = code.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'code' });
  return trimmed;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export function assertName(name: string, maxLength = 160): string {
  const trimmed = name.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > maxLength ||
    hasControlCharacters(trimmed)
  )
    throw new PropertyError('INVALID_REQUEST', { field: 'name' });
  return trimmed;
}

export function assertSafeText(
  value: string,
  field: string,
  maxLength = 1000,
): string {
  if (typeof value !== 'string')
    throw new PropertyError('INVALID_REQUEST', { field });
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > maxLength ||
    hasControlCharacters(trimmed)
  )
    throw new PropertyError('INVALID_REQUEST', { field });
  return trimmed;
}
