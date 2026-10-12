import { PropertyError } from '../../property/domain/errors.js';

export const taskTypes = ['HOUSEKEEPING', 'GUEST_REQUEST'] as const;
export type TaskType = (typeof taskTypes)[number];

export const taskStatuses = [
  'PENDING',
  'ASSIGNED',
  'IN_PROGRESS',
  'CLEAN',
  'INSPECTED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'PENDING', 'CANCELLED'],
  IN_PROGRESS: ['CLEAN', 'CANCELLED'],
  CLEAN: ['INSPECTED'],
  INSPECTED: [],
  CANCELLED: [],
};

export const assignableStatuses: readonly TaskStatus[] = [
  'PENDING',
  'ASSIGNED',
  'IN_PROGRESS',
];

export function isTaskType(value: string): value is TaskType {
  return (taskTypes as readonly string[]).includes(value);
}

export function isTaskStatus(value: string): value is TaskStatus {
  return (taskStatuses as readonly string[]).includes(value);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!taskTransitions[from].includes(to))
    throw new PropertyError('INVALID_STATE_TRANSITION', { from, to });
}

export function assertTaskAssignable(status: TaskStatus): void {
  if (!assignableStatuses.includes(status))
    throw new PropertyError('INVALID_STATE_TRANSITION', {
      from: status,
      to: 'ASSIGNED',
    });
}
