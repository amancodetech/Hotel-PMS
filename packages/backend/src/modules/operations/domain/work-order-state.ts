import { PropertyError } from '../../property/domain/errors.js';

export const workOrderCategories = [
  'GENERAL',
  'PLUMBING',
  'ELECTRICAL',
  'HVAC',
  'SAFETY',
  'OTHER',
] as const;
export type WorkOrderCategory = (typeof workOrderCategories)[number];

export const workOrderSeverities = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;
export type WorkOrderSeverity = (typeof workOrderSeverities)[number];

export const workOrderImpacts = ['NONE', 'OOS', 'OOO'] as const;
export type WorkOrderImpact = (typeof workOrderImpacts)[number];

export const workOrderStatuses = [
  'OPEN',
  'TRIAGED',
  'ASSIGNED',
  'IN_PROGRESS',
  'RESOLVED',
  'VERIFIED',
  'CLOSED',
] as const;
export type WorkOrderStatus = (typeof workOrderStatuses)[number];

const workOrderTransitions: Record<
  WorkOrderStatus,
  readonly WorkOrderStatus[]
> = {
  OPEN: ['TRIAGED', 'ASSIGNED'],
  TRIAGED: ['ASSIGNED', 'IN_PROGRESS'],
  ASSIGNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['VERIFIED'],
  VERIFIED: ['CLOSED'],
  CLOSED: ['OPEN'],
};

export const impactRank: Record<WorkOrderImpact, number> = {
  NONE: 0,
  OOS: 1,
  OOO: 2,
};

export function maxImpact(
  impacts: readonly WorkOrderImpact[],
): WorkOrderImpact {
  let best: WorkOrderImpact = 'NONE';
  for (const impact of impacts)
    if (impactRank[impact] > impactRank[best]) best = impact;
  return best;
}

export function isWorkOrderCategory(value: string): value is WorkOrderCategory {
  return (workOrderCategories as readonly string[]).includes(value);
}

export function isWorkOrderSeverity(value: string): value is WorkOrderSeverity {
  return (workOrderSeverities as readonly string[]).includes(value);
}

export function isWorkOrderImpact(value: string): value is WorkOrderImpact {
  return (workOrderImpacts as readonly string[]).includes(value);
}

export function isWorkOrderStatus(value: string): value is WorkOrderStatus {
  return (workOrderStatuses as readonly string[]).includes(value);
}

export function assertWorkOrderTransition(
  from: WorkOrderStatus,
  to: WorkOrderStatus,
): void {
  if (from === to) return;
  if (!workOrderTransitions[from].includes(to))
    throw new PropertyError('INVALID_STATE_TRANSITION', { from, to });
}
