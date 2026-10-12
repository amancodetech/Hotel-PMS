import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
const moneyAmount = z.string().regex(/^\d{1,18}(\.\d{1,6})?$/);
const money = z
  .object({ amount: moneyAmount, currency: z.enum(['IDR', 'USD']) })
  .strict();

export const businessDayQuery = z.object({ date: isoDate.optional() }).strict();

export const nightAuditBody = z.object({ business_date: isoDate }).strict();

export const openFolioBody = z
  .object({
    reservation_id: uuid.optional(),
    kind: z.enum(['GUEST', 'COMPANY', 'HOUSE', 'OWNER']).optional(),
    payer_label: z.string().min(1).max(200),
    currency: z.enum(['IDR', 'USD']),
  })
  .strict();

export const listFoliosQuery = z
  .object({
    reservation_id: uuid.optional(),
    state: z.enum(['OPEN', 'CLOSED']).optional(),
  })
  .strict();

export const postChargeBody = z
  .object({
    folio_id: uuid,
    business_date: isoDate,
    money,
    tax_money: money.optional(),
    tax_policy: z.record(z.string(), z.unknown()).optional(),
    policy_snapshot_id: uuid.optional(),
    account_code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,31}$/)
      .optional(),
    source_ref: z.string().min(1).max(200),
    memo: z.string().max(500).optional(),
  })
  .strict();

export const routeChargeBody = z
  .object({
    allocations: z
      .array(z.object({ payer_folio_id: uuid, money }).strict())
      .min(1)
      .max(20),
    memo: z.string().max(500).optional(),
  })
  .strict();

export const createScheduleBody = z
  .object({
    code: z.string().min(1).max(32),
    account_code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,31}$/)
      .optional(),
    quantity: z.number().int().min(1).max(1000).optional(),
    money,
    tax_money: money.optional(),
    tax_policy: z.record(z.string(), z.unknown()).optional(),
    currency: z.enum(['IDR', 'USD']).optional(),
    interval: z.enum(['DAY', 'WEEK', 'MONTH']),
    starts_on: isoDate,
    ends_on: isoDate.optional(),
  })
  .strict();

export const postSchedulePeriodBody = z
  .object({
    business_date: isoDate,
    period_start: isoDate.optional(),
  })
  .strict();

export const createPackageBody = z
  .object({
    code: z.string().min(1).max(32),
    account_code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,31}$/)
      .optional(),
    quantity_total: z.number().int().min(1).max(10000),
    unit_money: money,
    unit_tax_money: money.optional(),
    tax_policy: z.record(z.string(), z.unknown()).optional(),
    currency: z.enum(['IDR', 'USD']).optional(),
  })
  .strict();

export const consumePackageBody = z
  .object({
    quantity: z.number().int().min(1).max(10000),
    source_ref: z.string().min(1).max(200),
    business_date: isoDate,
  })
  .strict();

export const collectDepositBody = z
  .object({
    kind: z.enum(['DEPOSIT', 'DAMAGE']),
    method: z.enum(['CASH', 'BANK_TRANSFER', 'EXTERNAL_POS']),
    money,
    business_date: isoDate,
    external_reference: z.string().min(1).max(200),
    source_ref: z.string().min(1).max(200),
    evidence_ref: uuid.optional(),
  })
  .strict();

export const applyDepositBody = z
  .object({
    charge_id: uuid,
    money,
    business_date: isoDate,
    reason: z.string().min(1).max(500),
  })
  .strict();

export const releaseDepositBody = z
  .object({
    money,
    business_date: isoDate,
    reason: z.string().min(1).max(500),
  })
  .strict();

export const recordPaymentBody = z
  .object({
    folio_id: uuid,
    method: z.enum(['CASH', 'BANK_TRANSFER', 'OTA_SETTLEMENT', 'EXTERNAL_POS']),
    money,
    currency: z.enum(['IDR', 'USD']).optional(),
    gross_money: money.optional(),
    commission_money: money.optional(),
    business_date: isoDate,
    external_reference: z.string().min(1).max(200),
    evidence_ref: uuid.optional(),
    source_ref: z.string().min(1).max(200),
    certainty: z.enum(['CONFIRMED', 'UNKNOWN']).optional(),
  })
  .strict();

export const reconcilePaymentBody = z
  .object({
    outcome: z.enum(['SUCCEEDED', 'FAILED']),
    reconciliation_reference: z.string().max(200).optional(),
  })
  .strict();

export const listPaymentsQuery = z
  .object({
    folio_id: uuid.optional(),
    state: z.enum(['UNKNOWN', 'SUCCEEDED', 'FAILED']).optional(),
  })
  .strict();

export const requestRefundBody = z
  .object({ money, reason: z.string().min(1).max(500) })
  .strict();

export const resolveRefundBody = z
  .object({
    outcome: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']),
    approval_id: uuid.optional(),
    evidence_ref: uuid.optional(),
    external_reference: z.string().max(200).optional(),
    reconciliation_reference: z.string().max(200).optional(),
  })
  .strict();

export const reverseChargeBody = z
  .object({ reason: z.string().min(1).max(500) })
  .strict();

export const adjustmentBody = z
  .object({
    money,
    direction: z.enum(['INCREASE', 'DECREASE']),
    account_code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,31}$/)
      .optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();

export const fxSnapshotBody = z
  .object({
    pair: z.enum(['IDR/USD', 'USD/IDR']),
    rate: z.string().regex(/^\d{1,12}(\.\d{1,8})?$/),
    effective_at: z.string().datetime(),
    source: z.string().min(1).max(200),
  })
  .strict();

export const recordFxSnapshotBody = fxSnapshotBody
  .extend({ approval_id: uuid })
  .strict();

export const issueInvoiceBody = z
  .object({
    folio_id: uuid,
    series: z.string().min(1).max(8),
    kind: z.enum(['SYNTHETIC', 'PRODUCTION']).optional(),
    source_ref: z.string().min(1).max(200),
    business_date: isoDate,
    money,
    tax_money: money.optional(),
    tax_policy: z.record(z.string(), z.unknown()).optional(),
    account_code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,31}$/)
      .optional(),
  })
  .strict();

export const creditNoteBody = z
  .object({
    money,
    reason: z.string().min(1).max(500),
    source_ref: z.string().min(1).max(200),
  })
  .strict();

export const openCashierBody = z
  .object({
    currency: z.enum(['IDR', 'USD']).optional(),
    opening_float: moneyAmount.optional(),
  })
  .strict();

export const countCashierBody = z
  .object({ counted_money: moneyAmount })
  .strict();

export const settleClearanceBody = z
  .object({
    version: z.number().int().min(1),
    basis: z.enum(['SETTLED', 'TRANSFER_TO_PAYER']),
    payer_folio_id: uuid.optional(),
    collection_plan_ref: z.string().min(1).max(200).optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export const listExternalSettlementsQuery = z
  .object({
    reservation_id: uuid.optional(),
    state: z.enum(['UNKNOWN', 'SUCCEEDED', 'FAILED']).optional(),
  })
  .strict();
