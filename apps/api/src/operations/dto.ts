import { z } from 'zod';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createTaskBody = z
  .object({
    type: z.enum(['HOUSEKEEPING', 'GUEST_REQUEST', 'MAINTENANCE']),
    description: z.string().min(1).max(1000),
    resource_id: uuid.optional(),
    item_id: uuid.optional(),
    assignee_membership_id: uuid.optional(),
    priority: z.number().int().min(0).max(9).optional(),
    due_date: isoDate.optional(),
  })
  .strict();

export const listTasksQuery = z
  .object({
    status: z
      .enum([
        'PENDING',
        'ASSIGNED',
        'IN_PROGRESS',
        'CLEAN',
        'INSPECTED',
        'CANCELLED',
      ])
      .optional(),
    assignee_membership_id: uuid.optional(),
    resource_id: uuid.optional(),
    item_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const assignTaskBody = z
  .object({
    membership_id: uuid,
    version: z.number().int().min(1),
  })
  .strict();

export const taskCommandBody = z
  .object({
    version: z.number().int().min(1),
    note: z.string().min(1).max(500).optional(),
  })
  .strict();

export const logDndBody = z
  .object({
    resource_id: uuid,
    item_id: uuid.optional(),
    note: z.string().min(1).max(500),
    follow_up_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const followUpDndBody = z
  .object({ note: z.string().min(1).max(500) })
  .strict();

export const listDndQuery = z
  .object({
    resource_id: uuid.optional(),
    state: z.enum(['ACTIVE', 'FOLLOWED_UP']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const setOperationsPolicyBody = z
  .object({
    inspection_required: z.boolean(),
    long_stay_clean_interval_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .nullable()
      .optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict();

export const workOrderPeriod = z
  .object({ arrival: isoDate, departure: isoDate })
  .strict();

export const createWorkOrderBody = z
  .object({
    resource_id: uuid,
    category: z.enum([
      'GENERAL',
      'PLUMBING',
      'ELECTRICAL',
      'HVAC',
      'SAFETY',
      'OTHER',
    ]),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    impact: z.enum(['NONE', 'OOS', 'OOO']),
    emergency: z.boolean().optional(),
    description: z.string().min(1).max(1000),
    period: workOrderPeriod.optional(),
    assignee_membership_id: uuid.optional(),
  })
  .strict();

export const listWorkOrdersQuery = z
  .object({
    status: z
      .enum([
        'OPEN',
        'TRIAGED',
        'ASSIGNED',
        'IN_PROGRESS',
        'RESOLVED',
        'VERIFIED',
        'CLOSED',
      ])
      .optional(),
    resource_id: uuid.optional(),
    assignee_membership_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const assignWorkOrderBody = z
  .object({
    membership_id: uuid,
    version: z.number().int().min(1),
  })
  .strict();

export const transitionWorkOrderBody = z
  .object({
    status: z.enum(['TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'VERIFIED']),
    version: z.number().int().min(1),
    note: z.string().min(1).max(500).optional(),
  })
  .strict();

export const closeWorkOrderBody = z
  .object({
    version: z.number().int().min(1),
    note: z.string().min(1).max(500).optional(),
  })
  .strict();

export const reopenWorkOrderBody = z
  .object({
    reason: z.string().min(1).max(500),
    version: z.number().int().min(1),
  })
  .strict();

export const createShiftHandoverBody = z
  .object({
    shift_date: isoDate.optional(),
    to_membership_id: uuid.optional(),
    follow_up_membership_id: uuid.optional(),
    cashier_session_id: uuid.optional(),
    exceptions_text: z.string().min(1).max(1000).optional(),
    note: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const listLimitQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();
