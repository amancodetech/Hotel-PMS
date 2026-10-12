import { z } from 'zod';

const decimal = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,6})?$/, 'decimal string required');

export const createPlanBody = z
  .object({
    code: z.string().min(3).max(64),
    name: z.string().min(2).max(200),
  })
  .strict();

export const createPolicyVersionBody = z
  .object({
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    limits: z
      .record(z.string(), z.number().int().min(0).max(1_000_000))
      .optional(),
    entitlements: z.record(z.string(), z.boolean()).optional(),
    notes: z.string().min(2).max(500).optional(),
  })
  .strict();

export const setEntitlementBody = z
  .object({
    capability_code: z.string().min(3).max(64),
    state: z.enum(['ENABLED', 'DISABLED']),
    limits: z
      .record(z.string(), z.number().int().min(0).max(1_000_000))
      .optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
    effective_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    reason: z.string().min(3).max(500).optional(),
  })
  .strict();

export const recordUsageBody = z
  .object({
    metric: z.string().min(3).max(64),
    quantity: z.number().int().min(1).max(100_000),
  })
  .strict();

export const issueInvoiceBody = z
  .object({
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    currency: z.enum(['IDR', 'USD']),
    lines: z
      .array(
        z
          .object({
            description: z.string().min(2).max(300),
            quantity: decimal,
            unit_amount: decimal,
          })
          .strict(),
      )
      .min(1)
      .max(50),
    notes: z.string().min(2).max(500).optional(),
  })
  .strict();

export const voidInvoiceBody = z
  .object({ reason: z.string().min(3).max(500) })
  .strict();

export const settleInvoiceBody = z
  .object({ reference: z.string().min(3).max(200) })
  .strict();

export const lifecycleReasonBody = z
  .object({ reason: z.string().min(3).max(500) })
  .strict();

export const onboardTenantBody = z
  .object({
    name: z.string().min(2).max(200),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    customer_label: z.string().min(2).max(200),
    plan_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    owner_email: z.string().email().max(320).optional(),
    reason: z.string().min(3).max(500).optional(),
  })
  .strict();

export const reactivationBody = z
  .object({
    reason: z.string().min(3).max(500),
    acknowledge_policy_version: z.boolean().optional(),
    resume_sales: z.boolean().optional(),
  })
  .strict();

const uuid = z.string().uuid();

export const supportGrantBody = z
  .object({
    tenant_id: uuid,
    platform_user_email: z.string().email().max(320),
    scopes: z
      .array(z.enum(['tenant.read', 'audit.read']))
      .min(1)
      .max(2),
    reason: z.string().min(3).max(500),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();

export const revokeGrantBody = z
  .object({ reason: z.string().min(3).max(500) })
  .strict();

export const supportTenantBody = z
  .object({
    tenant_id: uuid,
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const platformAuditQuery = z
  .object({
    tenant_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const supportGrantQuery = z
  .object({ tenant_id: uuid.optional() })
  .strict();
