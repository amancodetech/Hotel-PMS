import { z } from 'zod';

export const nightAuditOverviewQuery = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .partial()
  .strict();

export const startNightAuditBody = z
  .object({
    business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export const retryNightAuditBody = z.object({}).strict();

export const resolveExceptionBody = z
  .object({
    owner_membership_id: z.string().uuid().optional(),
    owner_label: z.string().min(1).max(200).optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();

export const listRunsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
